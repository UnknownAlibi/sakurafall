const HLS_MIME = /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i;
const VIDEO_MIME = /^video\//i;
const MEDIA_EXTENSION = /\.(?:m3u8|mp4|m4v|webm)(?:[?#]|$)/i;
const HLS_PATH = /(?:\/hls(?:[/?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$))/i;
const LOW_VALUE_URL = /(?:^|[._/?=&-])(?:ad|ads|advert|commercial|preroll|midroll)(?:[._/?=&-]|$)/i;

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

  let score = isHls ? 220 : 130;
  if (HLS_MIME.test(mimeType) || VIDEO_MIME.test(mimeType)) score += 35;
  if (resourceType === 'media') score += 20;
  if (LOW_VALUE_URL.test(url)) score -= 100;
  return score;
}

function selectBestMediaCandidate(candidates = []) {
  return candidates
    .map(candidate => ({ ...candidate, score: scoreMediaCandidate(candidate) }))
    .filter(candidate => candidate.score >= 0)
    .sort((a, b) => b.score - a.score || a.discoveredAt - b.discoveredAt)[0] || null;
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

      const finishFromCandidates = () => {
        const best = selectBestMediaCandidate([...candidates.values()]);
        if (best) cleanup(null, best);
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
        settleTimer = setTimeout(finishFromCandidates, 650);
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

      timeoutTimer = setTimeout(() => {
        const best = selectBestMediaCandidate([...candidates.values()]);
        if (best) cleanup(null, best);
        else cleanup(new Error('MEDIA_SNIFFER_TIMEOUT'));
      }, timeoutMs);
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
  serializeExtraHeaders
};
