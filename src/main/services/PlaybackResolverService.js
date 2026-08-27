// 播放解析状态机服务（Phase 5）
// 接收 PlayableSource + episode，解析最终 m3u8/mp4，附带 headers/referer/user-agent，
// 缓存短期解析结果，超时和取消。
//
// 返回标准 ResolvedVideo：
// {
//   url: "https://...m3u8",
//   headers: { Referer, "User-Agent" },
//   sourceId, episodeId, qualityHint,
//   requiresProxy, resolvedAt
// }
//
// 失败时返回结构化错误：
// {
//   error, reason, category, hint, userMessage, elapsedMs
// }
// category ∈ invalid-source | network-blocked | cors-referer | format-unsupported | resolver-timeout | cancelled | unknown

const PLAYABLE_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'data:', 'file:', 'sakurafall-media:']);

const HttpClient = require('../utils/HttpClient');
const { extractMediaUrl } = require('./sources/SharePageResolverService');
const { WebPageMediaSniffer } = require('./sources/WebPageMediaSniffer');

// 短期解析结果缓存 TTL（毫秒）
const RESOLVE_CACHE_TTL = 5 * 60 * 1000;
// 默认解析超时（毫秒）
const DEFAULT_RESOLVE_TIMEOUT = 12000;

const DEFAULT_PLAYBACK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
};

function safeLog(...args) {
  try { console.log(...args); } catch (_) { /* ignore */ }
}
function safeError(...args) {
  try { console.error(...args); } catch (_) { /* ignore */ }
}

function normalizeUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  const normalized = value.startsWith('//') ? `https:${value}` : value;
  try {
    return new URL(normalized).toString();
  } catch (_) {
    return normalized;
  }
}

function isSharePageUrl(url) {
  return normalizeUrl(url).includes('/share/');
}

function isPlayableVideoUrl(url) {
  const normalized = normalizeUrl(url);
  if (!normalized || isSharePageUrl(normalized)) return false;
  try {
    const parsed = new URL(normalized);
    return PLAYABLE_PROTOCOLS.has(parsed.protocol);
  } catch (_) {
    return false;
  }
}

function isDirectMediaUrl(url) {
  const normalized = normalizeUrl(url);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:' || parsed.protocol === 'file:' || parsed.protocol === 'sakurafall-media:') {
      return true;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // mkv/mov/avi/ts/m2ts：BT 边播边下走本地 http://127.0.0.1 流服务器，
    // 动漫资源绝大多数是 MKV，Chromium 可直接解码 H.264/AAC 轨道
    return /\.(?:m3u8|mp4|m4v|webm|mkv|mov|avi|ts|m2ts|ogv|ogg)(?:[?#]|$)|\/hls(?:[/?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$)/i.test(normalized);
  } catch (_) {
    return false;
  }
}

function guessQualityFromUrl(url) {
  const u = normalizeUrl(url).toLowerCase();
  if (u.includes('2160') || u.includes('4k')) return '4K';
  if (u.includes('1080')) return '1080P';
  if (u.includes('720')) return '720P';
  if (u.includes('480')) return '480P';
  return '';
}

class PlaybackResolverService {
  constructor() {
    this.cmsApiService = null;
    this.sourceProviderRegistry = null;
    this.db = null;
    this.proxyUrl = '';
    this.timeout = DEFAULT_RESOLVE_TIMEOUT;
    // 短期解析缓存：key = `${sourceId}|${episodeId}|${urlCandidate}`
    this._resolveCache = new Map();
    this._resolveCacheMaxSize = 200;
    // 进行中的请求 token，用于取消旧请求
    this._latestToken = 0;
    // 通用网页抓取用的 HTTP 客户端（用于从播放页 HTML 中提取 m3u8/mp4）
    this._scrapeHttp = new HttpClient({
      timeout: 8000,
      headers: { 'User-Agent': DEFAULT_PLAYBACK_HEADERS['User-Agent'], 'Accept': 'text/html,*/*' }
    });
    this._mediaSniffer = new WebPageMediaSniffer({ timeout: DEFAULT_RESOLVE_TIMEOUT });
  }

  setDatabase(db) { this.db = db; }
  setProxy(proxyUrl) {
    this.proxyUrl = proxyUrl || '';
    this._scrapeHttp.setProxy(proxyUrl || '');
    this._mediaSniffer.setProxy(proxyUrl || '');
  }
  setTimeout(timeout) {
    const n = parseInt(timeout, 10);
    if (Number.isFinite(n) && n >= 3000) this.timeout = n;
  }
  setCmsApiService(cmsApiService) { this.cmsApiService = cmsApiService; }
  setSourceProviderRegistry(registry) { this.sourceProviderRegistry = registry; }

  /**
   * 生成新的请求 token，旧 token 的返回结果会被丢弃
   * @returns {number}
   */
  nextToken() {
    this._latestToken += 1;
    return this._latestToken;
  }

  /**
   * 检查 token 是否仍是最新请求
   * @param {number} token
   * @returns {boolean}
   */
  isLatestToken(token) {
    return token === this._latestToken;
  }

  /**
   * 取消所有进行中的请求（使所有 token 失效）
   */
  cancelAll() {
    this._latestToken += 1;
    this._mediaSniffer.cancel();
  }

  // ===== 短期缓存 =====

  _cacheKey(payload) {
    const sourceId = String(payload?.sourceId || payload?.source?.sourceId || '');
    const episodeId = String(payload?.episode?.id || payload?.episodeId || '');
    const urlCandidate = String(
      payload?.episode?.realUrl ||
      payload?.episode?.real_video_url ||
      payload?.episode?.url ||
      payload?.episode?.play_url ||
      ''
    );
    return `${sourceId}|${episodeId}|${urlCandidate}`;
  }

  _readResolveCache(key) {
    if (!key) return null;
    const entry = this._resolveCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.resolvedAt > RESOLVE_CACHE_TTL) {
      this._resolveCache.delete(key);
      return null;
    }
    return entry;
  }

  _writeResolveCache(key, value) {
    if (!key) return;
    if (this._resolveCache.size >= this._resolveCacheMaxSize) {
      // 淘汰最老的一个
      const firstKey = this._resolveCache.keys().next().value;
      if (firstKey) this._resolveCache.delete(firstKey);
    }
    this._resolveCache.set(key, value);
  }

  clearResolveCache() {
    this._resolveCache.clear();
  }

  // ===== 源 headers =====

  _pickHeaders(sourceId, _sourceType, url = '') {
    const configured = this.sourceProviderRegistry?.getPlaybackHeaders?.(sourceId, url) || {};
    return { ...DEFAULT_PLAYBACK_HEADERS, ...configured };
  }

  _reportPlayback(providerIdentifier, sourceId, result) {
    if (typeof this.sourceProviderRegistry?.reportPlayback === 'function') {
      return this.sourceProviderRegistry.reportPlayback(providerIdentifier || sourceId, result);
    }
    if (sourceId && typeof this.cmsApiService?.recordPlaybackResult === 'function') {
      return this.cmsApiService.recordPlaybackResult(sourceId, result);
    }
    return null;
  }

  // ===== 主入口：解析视频 =====

  /**
   * 解析 PlayableSource + episode 为最终可播放的 ResolvedVideo
   * @param {Object} payload - { sourceId, sourceName, sourceType, sourceAnimeId, episode, anime }
   * @param {Object} [options] - { timeout, token }
   * @returns {Promise<Object>} - ResolvedVideo 或 错误对象
   */
  async resolve(payload, options = {}) {
    const startedAt = Date.now();
    const token = options.token != null ? options.token : this.nextToken();
    const isLatest = () => this.isLatestToken(token);

    const episode = payload?.episode || {};
    const sourceId = String(payload?.sourceId || payload?.source?.sourceId || episode?.sourceId || '');
    const sourceName = String(payload?.sourceName || payload?.source?.sourceName || '');
    const sourceType = String(payload?.sourceType || payload?.source?.type || '');
    const providerId = payload?.providerId || payload?.source?.providerId || sourceId;

    if (!episode || Object.keys(episode).length === 0) {
      return this._failure('剧集信息为空', 'invalid-source', '请重新选择剧集或换源', startedAt);
    }

    // 1. 尝试直接可播放 URL（realUrl > real_video_url > url > play_url）
    const directCandidates = [
      episode.realUrl,
      episode.real_video_url,
      episode.url,
      episode.play_url
    ].filter(Boolean);
    let validationError = null;
    safeLog(`[PlaybackResolver] resolve 开始 source=${sourceName}(${sourceId}) episode=${episode.id || ''} 候选URL=${directCandidates.length}`);

    for (const candidate of directCandidates) {
      const normalized = normalizeUrl(candidate);
      const requiresResolver = isSharePageUrl(normalized)
        || this.sourceProviderRegistry?.canResolveUrl?.(providerId, normalized);
      if (isPlayableVideoUrl(normalized) && !requiresResolver) {
        safeLog(`[PlaybackResolver] 候选直链探测: ${normalized.slice(0, 100)}`);
        try {
          const quality = await this._validateVideoUrl(normalized, providerId || sourceId, sourceType, isLatest);
          if (!isLatest()) {
            return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
          }
          safeLog(`[PlaybackResolver] 解析成功 ${sourceName} -> ${normalized.slice(0, 80)} (${Date.now() - startedAt}ms)`);
          return this._success({
            url: normalized,
            sourceId,
            providerId,
            sourceName,
            sourceType,
            episodeId: episode.id || '',
            qualityHint: quality?.height ? `${quality.height}P` : guessQualityFromUrl(normalized),
            quality,
            requiresProxy: false,
            resolvedAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
            fromCache: false
          });
        } catch (error) {
          validationError = error;
          safeLog(`[PlaybackResolver] 候选直链失败: ${error.message}`);
          this._reportPlayback(providerId, sourceId, {
            success: false,
            reason: 'preflight-failed',
            error: error?.message || String(error)
          });
          continue;
        }
      }
    }

    // 2. 分享页只能由片源包声明的通用解析规则处理。
    const shareUrl = directCandidates.find(candidate => {
      const normalized = normalizeUrl(candidate);
      return isSharePageUrl(normalized)
        || this.sourceProviderRegistry?.canResolveUrl?.(providerId, normalized);
    });
    if (shareUrl) {
      safeLog(`[PlaybackResolver] 进入分享页解析: ${normalizeUrl(shareUrl).slice(0, 100)}`);
      const cacheKey = this._cacheKey(payload);
      const cached = this._readResolveCache(cacheKey);
      if (cached) {
        safeLog('[PlaybackResolver] 命中短期缓存:', sourceName);
        return { ...cached, fromCache: true, elapsedMs: Date.now() - startedAt };
      }

      try {
        if (!this.sourceProviderRegistry) throw new Error('播放源注册表未初始化');
        const result = await this._withTimeout(
          this.sourceProviderRegistry.resolveEpisode(providerId, episode),
          options.timeout || this.timeout,
          () => isLatest()
        );

        if (!isLatest()) {
          return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
        }

        if (!result || !result.url) {
          return this._failure(
            '分享页解析失败，未取到视频地址',
            'invalid-source',
            '该源可能已失效或页面结构变化，建议换源',
            startedAt
          );
        }

        const normalized = normalizeUrl(result.url);
        if (!isPlayableVideoUrl(normalized)) {
          return this._failure(
            '解析得到的地址不可播放',
            'format-unsupported',
            '解析得到的视频地址格式异常，建议换源',
            startedAt
          );
        }

        const quality = await this._validateVideoUrl(normalized, providerId || sourceId, sourceType, isLatest);
        if (!isLatest()) {
          return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
        }
        const resolved = this._success({
          url: normalized,
          sourceId,
          providerId,
          sourceName,
          sourceType,
          episodeId: episode.id || '',
          qualityHint: quality?.height ? `${quality.height}P` : guessQualityFromUrl(normalized),
          quality,
          requiresProxy: false,
          resolvedAt: Date.now(),
          elapsedMs: 0,
          fromCache: false
        });
        // 写入短期缓存
        this._writeResolveCache(cacheKey, { ...resolved, elapsedMs: 0 });
        return { ...resolved, elapsedMs: Date.now() - startedAt };
      } catch (error) {
        this._reportPlayback(providerId, sourceId, {
          success: false,
          reason: 'preflight-or-resolver-failed',
          error: error?.message || String(error)
        });
        if (!isLatest()) {
          return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
        }
        return this._classifyError(error, startedAt);
      }
    }

    // 1.5 通用网页抓取：当 URL 是 http/https 网页（非直链、非分享页）时，
    // 尝试 fetch 页面 HTML，用正则提取 m3u8/mp4 地址。
    // 很多资源站返回的 play_url 是播放页 URL 而非视频直链，
    // 通过抓取页面可以提取出真实的视频地址。
    if (validationError && validationError.message.includes('UNSUPPORTED_DIRECT_MEDIA_URL')) {
      safeLog(`[PlaybackResolver] 进入通用网页抓取: ${directCandidates.length} 个候选`);
      for (const candidate of directCandidates) {
        const normalized = normalizeUrl(candidate);
        if (!/^https?:\/\//i.test(normalized)) continue;
        // 跳过分享页（已在上一步处理）
        if (isSharePageUrl(normalized)) continue;
        // 跳过已配置 resolver 的 URL（已在上一步处理）
        if (this.sourceProviderRegistry?.canResolveUrl?.(providerId, normalized)) continue;

        try {
          const scrapedUrl = await this._scrapeMediaFromPage(normalized, sourceId, isLatest);
          if (!isLatest()) {
            return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
          }
          if (scrapedUrl) {
            safeLog(`[PlaybackResolver] 网页抓取成功: ${normalized.slice(0, 80)} -> ${scrapedUrl.slice(0, 80)}`);
            const quality = await this._validateVideoUrl(scrapedUrl, providerId || sourceId, sourceType, isLatest);
            if (!isLatest()) {
              return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
            }
            return this._success({
              url: scrapedUrl,
              sourceId,
              providerId,
              sourceName,
              sourceType,
              episodeId: episode.id || '',
              qualityHint: quality?.height ? `${quality.height}P` : guessQualityFromUrl(scrapedUrl),
              quality,
              requiresProxy: false,
              resolvedAt: Date.now(),
              elapsedMs: Date.now() - startedAt,
              fromCache: false
            });
          }
        } catch (error) {
          if (!isLatest()) {
            return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
          }
          // 抓取失败，继续尝试下一个候选 URL
        }
      }
    }

    // XPath-style web-scraping providers often build the real media URL in JavaScript.
    // Resolve those pages in an isolated hidden renderer and observe only media
    // network requests. This does not execute extension code or bypass DRM.
    const canSniffPage = sourceType === 'xpath'
      || episode.playbackMode === 'webview-sniff';
    if (canSniffPage) {
      for (const candidate of directCandidates) {
        const normalized = normalizeUrl(candidate);
        if (!/^https?:\/\//i.test(normalized) || isDirectMediaUrl(normalized)) continue;
        try {
          const sniffed = await this._mediaSniffer.resolve(normalized, {
            headers: this._pickHeaders(providerId || sourceId, sourceType, normalized),
            timeout: options.timeout || this.timeout,
            isLatest
          });
          if (!isLatest()) {
            return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
          }
          const mediaUrl = normalizeUrl(sniffed?.url);
          const quality = await this._validateVideoUrl(
            mediaUrl,
            providerId || sourceId,
            sourceType,
            isLatest,
            { confirmedMedia: true }
          );
          return this._success({
            url: mediaUrl,
            sourceId,
            providerId,
            sourceName,
            sourceType,
            episodeId: episode.id || '',
            qualityHint: quality?.height ? `${quality.height}P` : guessQualityFromUrl(mediaUrl),
            quality,
            requiresProxy: false,
            resolvedAt: Date.now(),
            elapsedMs: Date.now() - startedAt,
            fromCache: false,
            resolvedBy: 'webview-sniff'
          });
        } catch (error) {
          validationError = error;
          if (!isLatest()) {
            return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
          }
        }
      }
    }

    if (validationError) {
      return this._classifyError(validationError, startedAt);
    }

    // 3. 没有任何可用 URL 候选
    return this._failure(
      '剧集缺少可解析的视频地址',
      'invalid-source',
      '请尝试换源或重新选择剧集',
      startedAt
    );
  }

  async _validateVideoUrl(url, providerIdentifier, sourceType, isLatest, options = {}) {
    const normalized = normalizeUrl(url);
    if (!isDirectMediaUrl(normalized) && options.confirmedMedia !== true) {
      throw new Error('UNSUPPORTED_DIRECT_MEDIA_URL');
    }
    if (!/^https?:\/\//i.test(normalized) || !/\.m3u8(?:[?#]|$)|\/hls(?:[/?#]|$)/i.test(normalized)) {
      return null;
    }
    if (!this.cmsApiService?.probeStreamQuality) return null;

    const headers = this._pickHeaders(providerIdentifier, sourceType, normalized);
    const quality = await this._withTimeout(
      this.cmsApiService.probeStreamQuality(
        normalized,
        headers.Referer || headers.referer || normalized,
        { headers }
      ),
      Math.min(this.timeout, 8000),
      isLatest
    );
    if (quality?.error || quality?.source === 'probe-failed') {
      const probeError = String(quality?.error || '');
      if (/invalid_m3u8_manifest|html response|不是有效\s*m3u8|返回的不是\s*m3u8/i.test(probeError)) {
        throw new Error(probeError || 'INVALID_M3U8_MANIFEST');
      }
      // 预检失败不阻断播放：probeStreamQuality 仅用于探测画质，
      // 失败原因多为预检请求头（Referer/UA）与真实播放器不一致、
      // 源站临时限流或 5s 超时，并不代表视频本身不可播放。
      // 降级为画质未知，让播放器（hls.js）带正确 headers 自行尝试。
      safeLog(`[PlaybackResolver] 预检失败但不阻断播放，降级为画质未知: ${probeError || 'unknown'}`);
      this._reportPlayback(providerIdentifier, providerIdentifier?.replace(/^cms:/, ''), {
        success: false,
        reason: 'probe-failed-non-blocking',
        error: probeError || 'unknown'
      });
      return null;
    }
    return quality || null;
  }

  /**
   * 通用网页抓取：fetch 播放页 HTML，用正则提取 m3u8/mp4 地址。
   * 用于资源站返回播放页 URL 而非视频直链的场景。
   * 复用 SharePageResolverService 的 extractMediaUrl 提取逻辑。
   */
  async _scrapeMediaFromPage(pageUrl, sourceId, isLatest) {
    if (!pageUrl) return '';
    const headers = this._pickHeaders(sourceId, '', pageUrl);
    const html = await this._withTimeout(
      this._scrapeHttp.fetch(pageUrl, {
        headers: { ...headers, Accept: 'text/html,application/xhtml+xml,*/*' },
        referer: headers.Referer || headers.referer || '',
        timeout: 8000,
        maxResponseBytes: 2 * 1024 * 1024
      }),
      8000,
      isLatest
    );
    if (!html) return '';
    const mediaUrl = extractMediaUrl(html, pageUrl);
    if (mediaUrl && isDirectMediaUrl(mediaUrl)) {
      console.log(`[PlaybackResolver] 通用网页抓取成功: ${pageUrl} -> ${mediaUrl}`);
      return mediaUrl;
    }
    return '';
  }

  // ===== 工具：超时 + 取消 =====

  async _withTimeout(promiseFactory, timeoutMs, isLatest) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 超时后 task 的 then/catch 会因 settled 提前返回，必须在此清理轮询 interval，
        // 否则每次超时解析都泄漏一个永久 setInterval
        if (checkInterval) clearInterval(checkInterval);
        reject(new Error('RESOLVER_TIMEOUT'));
      }, Math.max(1000, timeoutMs));

      const task = Promise.resolve(promiseFactory);
      let checkInterval = null;
      task
        .then(result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (checkInterval) clearInterval(checkInterval);
          resolve(result);
        })
        .catch(err => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (checkInterval) clearInterval(checkInterval);
          reject(err);
        });

      // 定期检查是否被新请求取代（每 500ms）
      if (typeof isLatest === 'function') {
        checkInterval = setInterval(() => {
          if (!isLatest()) {
            if (settled) return;
            settled = true;
            clearInterval(checkInterval);
            clearTimeout(timer);
            reject(new Error('RESOLVER_CANCELLED'));
          }
        }, 500);
      }
    });
  }

  // ===== 工具：错误分类 =====

  _classifyError(error, startedAt) {
    const message = String(error?.message || error || '').toLowerCase();
    const elapsedMs = Date.now() - startedAt;

    // 超时
    if (message.includes('resolver_timeout') || message.includes('timeout') || message.includes('etimedout')) {
      return this._failure(
        '视频解析超时',
        'resolver-timeout',
        '可能是网络被 TUN/VPN 拦截或源站响应过慢，建议检查代理设置或换源',
        startedAt,
        { elapsedMs, originalError: message }
      );
    }

    // 取消
    if (message.includes('resolver_cancelled') || message.includes('aborted')) {
      return this._failure('请求已被取消', 'cancelled', '请重试', startedAt);
    }

    // DNS / 网络不通
    if (message.includes('enotfound') || message.includes('econnrefused') || message.includes('eai_again') || message.includes('getaddrinfo')) {
      return this._failure(
        '网络连接失败：无法解析源站域名',
        'network-blocked',
        '可能是 DNS 被劫持、TUN/VPN 拦截或源站已下线，建议换源或检查网络',
        startedAt,
        { elapsedMs, originalError: message }
      );
    }

    // HTTP 403 - 通常是 Referer/UA 校验失败
    if (message.includes('403') || message.includes('forbidden')) {
      return this._failure(
        '源站拒绝访问（403）',
        'cors-referer',
        '源站可能校验 Referer/User-Agent，浏览器直连无法播放，建议使用增强播放（mpv）或换源',
        startedAt,
        { elapsedMs, originalError: message }
      );
    }

    if (message.includes('invalid_m3u8_manifest')) {
      return this._failure(
        '视频地址返回的不是有效 m3u8 清单',
        'format-unsupported',
        '该线路可能已失效或返回了网页内容，正在尝试其他源',
        startedAt,
        { elapsedMs, originalError: message }
      );
    }

    if (message.includes('unsupported_direct_media_url')) {
      return this._failure(
        '播放地址是网页而不是视频直链',
        'format-unsupported',
        '该线路需要额外解析规则，正在尝试其他源',
        startedAt,
        { elapsedMs, originalError: message }
      );
    }

    // HTTP 其他 4xx/5xx
    if (/\b[45]\d\d\b/.test(message) || message.includes('status code')) {
      return this._failure(
        '源站返回错误状态码',
        'network-blocked',
        '源站可能暂时不可用或已限流，建议稍后重试或换源',
        startedAt,
        { elapsedMs, originalError: message }
      );
    }

    // 默认归类为未知
    return this._failure(
      error?.message || '视频解析失败',
      'unknown',
      '请尝试重试或换源',
      startedAt,
      { elapsedMs, originalError: message }
    );
  }

  // ===== 成功/失败构造 =====

  _success(video) {
    const providerIdentifier = video.providerId || video.sourceId;
    const headers = this._pickHeaders(providerIdentifier, video.sourceType, video.url);
    this.sourceProviderRegistry?.rememberPlaybackHeaders?.(providerIdentifier, video.url, headers);
    return {
      success: true,
      ...video,
      headers
    };
  }

  _failure(message, category, hint, startedAt, extra = {}) {
    safeError(`[PlaybackResolver] 失败 [${category}]: ${message}`);
    return {
      success: false,
      error: message,
      reason: category,
      category,
      hint,
      userMessage: message,
      elapsedMs: Date.now() - startedAt,
      ...extra
    };
  }
}

module.exports = new PlaybackResolverService();
module.exports.PlaybackResolverService = PlaybackResolverService;
