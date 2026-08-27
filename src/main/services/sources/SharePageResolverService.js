const HttpClient = require('../../utils/HttpClient');

const DEFAULT_TIMEOUT = 12000;
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function normalizeUrl(value, baseUrl = '') {
  const url = String(value || '').trim().replace(/\\\//g, '/');
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  try {
    return new URL(url, baseUrl || undefined).toString();
  } catch (_) {
    return '';
  }
}

function normalizeHeaders(headers = {}) {
  const allowed = new Set(['referer', 'origin', 'user-agent']);
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalizedKey = String(key).toLowerCase();
    if (!allowed.has(normalizedKey)) continue;
    const outputKey = normalizedKey === 'user-agent'
      ? 'User-Agent'
      : `${normalizedKey.charAt(0).toUpperCase()}${normalizedKey.slice(1)}`;
    result[outputKey] = String(value || '').slice(0, 500);
  }
  return result;
}

function extractMediaUrl(html, pageUrl) {
  const text = String(html || '');
  const candidates = [
    /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>]*)?/i,
    /(?:const|let|var)\s+(?:url|playUrl|videoUrl)\s*=\s*["']([^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i,
    /["'](?:url|play_url|video_url)["']\s*:\s*["']([^"']+?\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/i
  ];

  for (const pattern of candidates) {
    const match = text.match(pattern);
    const raw = match?.[1] || match?.[0] || '';
    const normalized = normalizeUrl(raw, pageUrl);
    if (normalized) return normalized;
  }
  return '';
}

class SharePageResolverService {
  constructor(options = {}) {
    this.http = options.httpClient || new HttpClient({ timeout: DEFAULT_TIMEOUT });
    this.timeout = DEFAULT_TIMEOUT;
    this.cacheTtl = DEFAULT_CACHE_TTL;
    this.resolvers = [];
    this.cache = new Map();
    this.cacheLimit = 200;
  }

  setResolvers(resolvers = []) {
    this.resolvers = Array.isArray(resolvers) ? resolvers.map(rule => ({ ...rule })) : [];
    this.clearCache();
  }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, Number.parseInt(timeout, 10) || DEFAULT_TIMEOUT);
    this.http.setTimeout(this.timeout);
  }

  setProxy(proxyUrl) {
    this.http.setProxy(proxyUrl || '');
  }

  clearCache() {
    this.cache.clear();
  }

  listResolvers() {
    return this.resolvers.map(rule => ({
      id: rule.id,
      name: rule.name,
      hosts: [...(rule.hosts || [])],
      sourcePackId: rule.sourcePackId || ''
    }));
  }

  exportResolvers() {
    return this.resolvers.map(rule => ({
      id: rule.id,
      name: rule.name,
      hosts: [...(rule.hosts || [])],
      pathPrefixes: [...(rule.pathPrefixes || [])],
      requestHeaders: { ...(rule.requestHeaders || {}) },
      playbackHeaders: { ...(rule.playbackHeaders || {}) }
    }));
  }

  findResolver(url, resolverId = '') {
    let parsed;
    try {
      parsed = new URL(normalizeUrl(url));
    } catch (_) {
      return null;
    }

    if (resolverId) {
      const exact = this.resolvers.find(rule => rule.id === resolverId);
      if (exact && this._matches(exact, parsed)) return exact;
    }
    return this.resolvers.find(rule => this._matches(rule, parsed)) || null;
  }

  canResolve(url, resolverId = '') {
    return !!this.findResolver(url, resolverId);
  }

  getRequestHeaders(url, resolverId = '') {
    const resolver = this.findResolver(url, resolverId);
    return resolver ? normalizeHeaders(resolver.requestHeaders) : {};
  }

  getPlaybackHeaders(url, resolverId = '') {
    const resolver = this.findResolver(url, resolverId);
    if (!resolver) return {};
    return {
      'User-Agent': DEFAULT_USER_AGENT,
      ...normalizeHeaders(resolver.playbackHeaders)
    };
  }

  async resolve(url, options = {}) {
    const pageUrl = normalizeUrl(url);
    const resolver = this.findResolver(pageUrl, options.resolverId);
    if (!resolver) throw new Error('没有与该分享页匹配的解析规则');

    const cached = this._readCache(pageUrl);
    if (cached) return { ...cached, fromCache: true };

    const headers = normalizeHeaders(resolver.requestHeaders);
    const html = await this.http.fetch(pageUrl, {
      headers,
      referer: headers.Referer || '',
      timeout: options.timeout || this.timeout,
      maxResponseBytes: 2 * 1024 * 1024,
      signal: options.signal
    });
    const mediaUrl = extractMediaUrl(html, pageUrl);
    if (!mediaUrl) throw new Error('分享页中没有找到可播放媒体地址');

    const result = {
      url: mediaUrl,
      resolverId: resolver.id,
      headers: this.getPlaybackHeaders(pageUrl, resolver.id),
      resolvedAt: Date.now(),
      fromCache: false
    };
    this._writeCache(pageUrl, result);
    return result;
  }

  _matches(rule, parsedUrl) {
    const host = parsedUrl.hostname.toLowerCase();
    const hosts = Array.isArray(rule.hosts) ? rule.hosts : [];
    if (!hosts.some(value => host === value || host.endsWith(`.${value}`))) return false;

    const prefixes = Array.isArray(rule.pathPrefixes) ? rule.pathPrefixes : [];
    return prefixes.length === 0 || prefixes.some(prefix => parsedUrl.pathname.startsWith(prefix));
  }

  _readCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  _writeCache(key, value) {
    if (this.cache.size >= this.cacheLimit) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value: { ...value }, expiresAt: Date.now() + this.cacheTtl });
  }
}

module.exports = {
  SharePageResolverService,
  extractMediaUrl,
  normalizeHeaders,
  normalizeUrl
};
