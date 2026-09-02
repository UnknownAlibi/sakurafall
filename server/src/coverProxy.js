const { fetchBuffer, sendBuffer, sendJson } = require('./httpUtils');

const ALLOWED_IMAGE_HOSTS = new Set([
  'lain.bgm.tv',
  'bgmimg.anibt.net',
  'lain.bangumi.lol'
]);

// 三个域名镜像同一套 Bangumi 图片（路径一致）。国内服务器上 lain.bgm.tv
// 可能被 DNS 污染不可达，抓取失败时按序换白名单里的其他主机重试；
// 缓存键始终用原始 URL，客户端后续请求同一 URL 直接命中。

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '[::1]' || value === '::1';
}

class CoverProxy {
  constructor(options) {
    this.cache = options.cache;
    this.timeoutMs = options.timeoutMs;
    this.maxBytes = options.maxBytes;
    this.inflight = new Map();
  }

  parseTarget(raw) {
    let target;
    try { target = new URL(String(raw || '')); } catch (_) { return null; }
    const hostname = target.hostname.toLowerCase();
    if (!ALLOWED_IMAGE_HOSTS.has(hostname)) return null;
    // 回环地址（测试 mock 图床）放行 http，其余一律升级到 https。
    const loopback = isLoopbackHost(hostname);
    if (target.protocol === 'http:' && !loopback) target.protocol = 'https:';
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) return null;
    target.hash = '';
    return target;
  }

  async _load(target) {
    const key = target.toString();
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this._loadWithHostFallback(target)
      .then(async ({ contentType, body }) => {
        const headers = { 'Content-Type': contentType };
        await this.cache.set('covers', key, body, {
          ttlMs: 30 * 24 * 60 * 60_000,
          staleTtlMs: 90 * 24 * 60 * 60_000,
          status: 200,
          headers
        });
        return { body, headers };
      }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async _loadWithHostFallback(target) {
    const primary = target.hostname.toLowerCase();
    const hosts = [primary, ...[...ALLOWED_IMAGE_HOSTS].filter(h => h !== primary)];
    let lastError;
    for (const host of hosts) {
      const candidate = new URL(target.toString());
      candidate.hostname = host;
      try {
        const { response, body } = await fetchBuffer(candidate.toString(), {
          timeoutMs: this.timeoutMs,
          maxBytes: this.maxBytes,
          headers: {
            Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
            'User-Agent': 'SakuraFall-Service/1.0',
            Referer: 'https://bgm.tv/'
          }
        });
        const finalUrl = this.parseTarget(response.url);
        const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!response.ok || !finalUrl || !contentType.startsWith('image/')) {
          throw new Error(`invalid image response (${response.status})`);
        }
        return { contentType, body };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('no cover host is reachable');
  }

  // 后台预热：命中缓存则跳过，否则与真实请求共用 inflight 去重抓取。
  // 失败静默忽略——客户端随后发起的真实请求会自行重试并返回 502/缓存。
  async warm(rawUrl) {
    const target = this.parseTarget(rawUrl);
    if (!target) return;
    const key = target.toString();
    const cached = await this.cache.get('covers', key);
    if (cached) return;
    try { await this._load(target); } catch (_) { /* 预热失败忽略 */ }
  }

  async handle(req, res, url) {
    if (url.pathname !== '/cover') return false;
    if (!['GET', 'HEAD'].includes(req.method)) {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return true;
    }
    const target = this.parseTarget(url.searchParams.get('url'));
    if (!target) {
      sendJson(res, 400, { error: 'unsupported_cover_url' });
      return true;
    }
    const key = target.toString();
    const cached = await this.cache.get('covers', key, { allowStale: true });
    if (cached) {
      if (cached.stale) this._load(target).catch(() => {});
      sendBuffer(res, 200, cached.body, {
        ...cached.meta.headers,
        'Cache-Control': 'public, max-age=2592000, immutable',
        'X-SakuraFall-Cache': cached.stale ? 'STALE' : 'HIT'
      }, req.method);
      return true;
    }
    try {
      const result = await this._load(target);
      sendBuffer(res, 200, result.body, {
        ...result.headers,
        'Cache-Control': 'public, max-age=2592000, immutable',
        'X-SakuraFall-Cache': 'MISS'
      }, req.method);
    } catch (error) {
      sendJson(res, 502, { error: 'cover_upstream_unavailable', message: error.message });
    }
    return true;
  }
}

module.exports = { CoverProxy, ALLOWED_IMAGE_HOSTS, isLoopbackHost };
