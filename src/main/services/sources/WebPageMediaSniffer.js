const HLS_MIME = /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i;
const VIDEO_MIME = /^video\//i;
const MEDIA_EXTENSION = /\.(?:m3u8|mp4|m4v|webm)(?:[?#]|$)/i;
const HLS_PATH = /(?:\/hls(?:[/?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$))/i;
const LOW_VALUE_URL = /(?:^|[._/?=&-])(?:ad|ads|advert|commercial|preroll|midroll)(?:[._/?=&-]|$)/i;
const MIN_EPISODE_DURATION_SECONDS = 45;
const DIRECT_MEDIA_SETTLE_MS = 5500;
const HLS_SETTLE_MS = 900;

function normalizeCandidateUrl(url) {
  const value = String(url || '').trim();
  if (!value || /^(?:blob|data|file):/i.test(value)) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function scoreMediaCandidate(candidate = {}) {
  const url = normalizeCandidateUrl(candidate.url);
  if (!url) return -1;
  const mimeType = String(candidate.mimeType || '');
  const resourceType = String(candidate.resourceType || '').toLowerCase();
  const isHls = /\.m3u8(?:[?#]|$)/i.test(url) || HLS_PATH.test(url) || HLS_MIME.test(mimeType);
  const isVideo = MEDIA_EXTENSION.test(url) || VIDEO_MIME.test(mimeType) || resourceType === 'media';
  if (!isHls && !isVideo) return -1;

  const duration = Number(candidate.duration);
  if (!isHls && Number.isFinite(duration) && duration > 0 && duration < MIN_EPISODE_DURATION_SECONDS) {
    return -1;
  }

  let score = isHls ? 220 : 130;
  if (HLS_MIME.test(mimeType) || VIDEO_MIME.test(mimeType)) score += 35;
  if (resourceType === 'media') score += 20;
  if (LOW_VALUE_URL.test(url)) score -= 100;
  if (Number.isFinite(duration) && duration >= MIN_EPISODE_DURATION_SECONDS) {
    score += duration >= 10 * 60 ? 120 : 70;
  }
  const pixels = Math.max(0, Number(candidate.videoWidth) || 0) * Math.max(0, Number(candidate.videoHeight) || 0);
  if (pixels >= 1280 * 720) score += 45;
  return score;
}

function selectBestMediaCandidate(candidates = []) {
  return candidates
    .map(candidate => ({ ...candidate, score: scoreMediaCandidate(candidate) }))
    .filter(candidate => candidate.score >= 0)
    .sort((a, b) => b.score - a.score || b.discoveredAt - a.discoveredAt)[0] || null;
}

function mergeMediaElementMetadata(candidates = [], mediaElements = []) {
  const metadataFields = item => ({
    duration: Number(item?.duration) || 0,
    videoWidth: Number(item?.videoWidth) || 0,
    videoHeight: Number(item?.videoHeight) || 0,
    readyState: Number(item?.readyState) || 0
  });
  const metadataByUrl = new Map(
    mediaElements
      .map(item => ({ ...item, url: normalizeCandidateUrl(item?.url) }))
      .filter(item => item.url)
      .map(item => [item.url, item])
  );
  const enriched = candidates.map(candidate => ({
    ...candidate,
    ...(metadataByUrl.has(normalizeCandidateUrl(candidate.url))
      ? metadataFields(metadataByUrl.get(normalizeCandidateUrl(candidate.url)))
      : {})
  }));

  // Some players expose a blob URL on the media element even though the
  // underlying request is a direct MP4. Associate that measured duration with
  // the most recently observed direct-media request so a pre-roll cannot win.
  const measured = mediaElements
    .filter(item => Number.isFinite(Number(item?.duration)) && Number(item.duration) > 0)
    .sort((a, b) => (Number(b.readyState) || 0) - (Number(a.readyState) || 0))[0];
  if (!measured) return enriched;

  const latestDirectIndex = enriched
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => {
      const mimeType = String(candidate.mimeType || '');
      return !/\.m3u8(?:[?#]|$)/i.test(candidate.url)
        && !HLS_PATH.test(candidate.url)
        && !HLS_MIME.test(mimeType);
    })
    .sort((a, b) => (Number(b.candidate.discoveredAt) || 0) - (Number(a.candidate.discoveredAt) || 0))[0]?.index;
  if (latestDirectIndex == null || enriched[latestDirectIndex].duration > 0) return enriched;
  enriched[latestDirectIndex] = {
    ...enriched[latestDirectIndex],
    ...metadataFields(measured)
  };
  return enriched;
}

function serializeExtraHeaders(headers = {}) {
  return Object.entries(headers)
    .filter(([name, value]) => name && value != null && String(value).trim())
    .map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]+/g, ' ')}`)
    .join('\n');
}

class WebPageMediaSniffer {
  constructor(options = {}) {
    this.defaultTimeout = Math.max(5000, Number(options.timeout) || 15000);
    this.proxy = '';
    this._activeCleanup = null;
    this._partitionCounter = 0;
  }

  setProxy(proxy) {
    this.proxy = String(proxy || '').trim();
  }

  cancel() {
    this._activeCleanup?.(new Error('MEDIA_SNIFFER_CANCELLED'));
  }

  async resolve(pageUrl, options = {}) {
    const normalizedPageUrl = normalizeCandidateUrl(pageUrl);
    if (!normalizedPageUrl) throw new Error('INVALID_SNIFFER_PAGE_URL');
    this.cancel();

    const { BrowserWindow, session } = require('electron');
    const partition = `sakurafall-media-sniffer-${Date.now()}-${++this._partitionCounter}`;
    const isolatedSession = session.fromPartition(partition, { cache: false });
    await isolatedSession.setProxy(this.proxy
      ? { mode: 'fixed_servers', proxyRules: this.proxy }
      : { mode: 'direct' });
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);

    const win = new BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      webPreferences: {
        session: isolatedSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    });
    const webContents = win.webContents;
    webContents.setAudioMuted(true);
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (options.headers?.['User-Agent']) {
      webContents.setUserAgent(String(options.headers['User-Agent']));
    }

    return new Promise((resolve, reject) => {
      const candidates = new Map();
      const timeoutMs = Math.max(5000, Number(options.timeout) || this.defaultTimeout);
      let settled = false;
      let settleTimer = null;
      let timeoutTimer = null;
      let cancellationTimer = null;
      let finishing = false;

      const cleanup = async (error, result) => {
        if (settled) return;
        settled = true;
        this._activeCleanup = null;
        clearTimeout(settleTimer);
        clearTimeout(timeoutTimer);
        clearInterval(cancellationTimer);
        try { isolatedSession.webRequest.onBeforeRequest(null); } catch (_) { /* ignore */ }
        try { isolatedSession.webRequest.onHeadersReceived(null); } catch (_) { /* ignore */ }
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch (_) { /* ignore */ }
        try { await isolatedSession.clearStorageData(); } catch (_) { /* ignore */ }
        if (error) reject(error);
        else resolve(result);
      };
      this._activeCleanup = cleanup;

      const collectMediaElementMetadata = async () => {
        if (webContents.isDestroyed()) return [];
        try {
          return await Promise.race([
            webContents.executeJavaScript(`Array.from(document.querySelectorAll('video, audio')).map(media => ({
              url: media.currentSrc || media.src || '',
              duration: Number.isFinite(media.duration) ? media.duration : 0,
              videoWidth: Number(media.videoWidth) || 0,
              videoHeight: Number(media.videoHeight) || 0,
              readyState: Number(media.readyState) || 0
            }))`, true),
            new Promise(resolve => setTimeout(() => resolve([]), 1200))
          ]);
        } catch (_) {
          return [];
        }
      };

      const finishFromCandidates = async (allowEmpty = false) => {
        if (settled) return;
        if (finishing) {
          if (allowEmpty) cleanup(new Error('MEDIA_SNIFFER_METADATA_TIMEOUT'));
          return;
        }
        finishing = true;
        const mediaElements = await collectMediaElementMetadata();
        if (settled) return;
        const enriched = mergeMediaElementMetadata([...candidates.values()], mediaElements);
        const best = selectBestMediaCandidate(enriched);
        finishing = false;
        if (best) {
          cleanup(null, best);
        } else if (allowEmpty) {
          cleanup(new Error('MEDIA_SNIFFER_NO_EPISODE_MEDIA'));
        }
      };

      const record = (url, mimeType = '', resourceType = '') => {
        if (settled) return;
        const normalized = normalizeCandidateUrl(url);
        if (!normalized) return;
        options.onObservation?.({ url: normalized, mimeType, resourceType });
        const next = {
          url: normalized,
          mimeType,
          resourceType,
          discoveredAt: Date.now()
        };
        if (scoreMediaCandidate(next) < 0) return;
        const existing = candidates.get(normalized);
        if (!existing || scoreMediaCandidate(next) > scoreMediaCandidate(existing)) {
          candidates.set(normalized, next);
        }
        clearTimeout(settleTimer);
        const isHls = /\.m3u8(?:[?#]|$)/i.test(normalized) || HLS_PATH.test(normalized) || HLS_MIME.test(mimeType);
        settleTimer = setTimeout(() => finishFromCandidates(false), isHls ? HLS_SETTLE_MS : DIRECT_MEDIA_SETTLE_MS);
      };

      isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        record(details.url, '', details.resourceType);
        callback({});
      });
      isolatedSession.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
        const contentTypeHeader = details.responseHeaders?.['content-type']
          || details.responseHeaders?.['Content-Type']
          || [];
        record(details.url, Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader, details.resourceType);
        callback({ responseHeaders: details.responseHeaders });
      });

      timeoutTimer = setTimeout(() => finishFromCandidates(true), timeoutMs);
      if (typeof options.isLatest === 'function') {
        cancellationTimer = setInterval(() => {
          if (!options.isLatest()) cleanup(new Error('MEDIA_SNIFFER_CANCELLED'));
        }, 100);
      }

      const extraHeaders = serializeExtraHeaders(options.headers);
      win.loadURL(normalizedPageUrl, extraHeaders ? { extraHeaders } : undefined)
        .catch(error => {
          if (candidates.size === 0) cleanup(error);
        });
    });
  }
}

module.exports = {
  WebPageMediaSniffer,
  normalizeCandidateUrl,
  scoreMediaCandidate,
  selectBestMediaCandidate,
  mergeMediaElementMetadata,
  serializeExtraHeaders
};
