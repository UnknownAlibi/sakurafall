const crypto = require('node:crypto');
const { fetchBuffer, readBody, sendBuffer, sendJson } = require('./httpUtils');
const { ALLOWED_IMAGE_HOSTS, isLoopbackHost } = require('./coverProxy');

const ALLOWED_PATH = /^\/(?:calendar|v0\/(?:subjects?|episodes|search\/subjects)(?:\/[^?#]*)?|subject\/\d+)(?:$|\/)/;

// 封面 URL 判定走共享主机白名单（测试可注入 mock 主机）。
function isCoverUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function rewriteCoverUrls(value, coverProxyBase, depth = 0) {
  if (!coverProxyBase || depth > 20 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (!isCoverUrl(value)) return value;
    // 与 parseTarget 的规范化保持一致（回环测试主机保留 http），否则
    // 客户端请求的缓存键与预热的缓存键对不上。
    let normalized = value;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
        normalized = value.replace(/^http:/i, 'https:');
      }
    } catch (_) { /* 保持原样 */ }
    return `${coverProxyBase}/cover?url=${encodeURIComponent(normalized)}`;
  }
  if (Array.isArray(value)) return value.map(item => rewriteCoverUrls(item, coverProxyBase, depth + 1));
  if (typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = rewriteCoverUrls(item, coverProxyBase, depth + 1);
  }
  return output;
}

// 从搜索/列表响应里收集原始封面 URL，并转换成客户端列表卡片实际请求的
// r/400 缩略变体（与渲染端 getRemoteImagePreviewUrl 的改写规则一致）。
function collectCoverUrls(value, out, depth = 0) {
  if (out.length >= 120 || depth > 24 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    // 协议规范化交给 CoverProxy.parseTarget（http 统一升级 https），此处原样收集。
    if (isCoverUrl(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCoverUrls(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectCoverUrls(item, out, depth + 1);
  }
}

function coverWarmUrls(value) {
  const raw = [];
  collectCoverUrls(value, raw);
  const variants = new Set();
  for (const url of raw) {
    try {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/pic/')) {
        parsed.pathname = `/r/400${parsed.pathname.replace(/^\/r\/\d+/, '')}`;
      }
      variants.add(parsed.toString());
    } catch (_) { /* 无效 URL 忽略 */ }
  }
  return [...variants];
}

// 搜索翻页预取：客户端（SubjectService）把 limit/offset 放在 URL query 上，
// 其他调用方可能放在请求体里，两种形式都要能算出下一页请求。
// limit<=1 的总数探测请求不预取，避免给镜像翻倍加压。
function nextSearchRequest(url, body) {
  let parsed = null;
  if (body?.length) {
    try { parsed = JSON.parse(body.toString('utf8')); } catch (_) { return null; }
  }
  if (parsed && typeof parsed.limit === 'number' && typeof parsed.offset === 'number') {
    if (parsed.limit <= 1) return null;
    return {
      url,
      body: Buffer.from(JSON.stringify({ ...parsed, offset: parsed.offset + parsed.limit }))
    };
  }
  const limit = Number(url.searchParams.get('limit'));
  const offset = Number(url.searchParams.get('offset'));
  if (!Number.isFinite(limit) || !Number.isFinite(offset) || limit <= 1) return null;
  const next = new URL(url.toString());
  next.searchParams.set('offset', String(offset + limit));
  return { url: next, body };
}

function cachePolicy(pathname) {
  if (pathname === '/calendar') return { ttlMs: 10 * 60_000, staleTtlMs: 24 * 60 * 60_000 };
  if (/\/characters$|\/persons$/.test(pathname)) return { ttlMs: 24 * 60 * 60_000, staleTtlMs: 14 * 24 * 60 * 60_000 };
  if (/episodes/.test(pathname)) return { ttlMs: 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 };
  if (/^\/v0\/subjects\/\d+$/.test(pathname)) return { ttlMs: 24 * 60 * 60_000, staleTtlMs: 30 * 24 * 60 * 60_000 };
  if (/search\/subjects|^\/v0\/subjects$/.test(pathname)) return { ttlMs: 6 * 60 * 60_000, staleTtlMs: 7 * 24 * 60 * 60_000 };
  return { ttlMs: 30 * 60_000, staleTtlMs: 24 * 60 * 60_000 };
}

class BangumiProxy {
  constructor(options) {
    this.cache = options.cache;
    this.upstreams = options.upstreams;
    this.timeoutMs = options.timeoutMs;
    this.coverProxyBase = String(options.coverProxyBase || '').replace(/\/+$/, '');
    this.warmCovers = typeof options.warmCovers === 'function' ? options.warmCovers : null;
    this.prefetchNextPage = options.prefetchNextPage !== false;
    this.inflight = new Map();
    this.cooldowns = new Map();
  }

  supports(pathname) {
    return ALLOWED_PATH.test(pathname);
  }

  _cacheKey(method, url, body) {
    const bodyHash = body?.length ? crypto.createHash('sha256').update(body).digest('hex') : '';
    return `${method}:${url.pathname}${url.search}:${bodyHash}`;
  }

  _orderedUpstreams() {
    const now = Date.now();
    return [...this.upstreams].sort((a, b) => (this.cooldowns.get(a) || 0) - (this.cooldowns.get(b) || 0))
      .filter(base => (this.cooldowns.get(base) || 0) <= now)
      .concat(this.upstreams.filter(base => (this.cooldowns.get(base) || 0) > now));
  }

  async _loadUpstream(url, method, body) {
    let lastError;
    for (const base of this._orderedUpstreams()) {
      const target = `${base}${url.pathname}${url.search}`;
      try {
        const { response, body: responseBody } = await fetchBuffer(target, {
          method,
          body,
          timeoutMs: this.timeoutMs,
          maxBytes: 12 * 1024 * 1024,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'SakuraFall-Service/1.0 (+https://github.com/UnknownAlibi/sakurafall)',
            Referer: 'https://bgm.tv/'
          }
        });
        if (!response.ok) throw new Error(`upstream returned ${response.status}`);
        const parsed = JSON.parse(responseBody.toString('utf8'));
        // 列表/搜索响应：后台预热封面（r/400 变体）。客户端的懒加载请求
        // 到达时要么直接命中磁盘缓存，要么通过 inflight 去重搭上同一次
        // 上游抓取，滚动加载不再逐张等 1-2 秒。
        if (this.warmCovers && /search\/subjects/.test(url.pathname)) {
          try { this.warmCovers(coverWarmUrls(parsed)); } catch (_) { /* 预热失败不影响主响应 */ }
        }
        const rewrittenBody = this.coverProxyBase
          ? Buffer.from(JSON.stringify(rewriteCoverUrls(parsed, this.coverProxyBase)))
          : responseBody;
        this.cooldowns.delete(base);
        return {
          status: response.status,
          body: rewrittenBody,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          upstream: base
        };
      } catch (error) {
        lastError = error;
        this.cooldowns.set(base, Date.now() + 60_000);
      }
    }
    throw lastError || new Error('no Bangumi upstream is available');
  }

  async _refresh(key, url, method, body) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this._loadUpstream(url, method, body)
      .then(async result => {
        const policy = cachePolicy(url.pathname);
        await this.cache.set('bangumi', key, result.body, {
          ...policy,
          status: result.status,
          headers: result.headers
        });
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  // 预取仅发生在真实客户端请求上（预取本身不再级联），避免无限预取链。
  async _prefetch(url, method, body) {
    const key = this._cacheKey(method, url, body);
    const cached = await this.cache.get('bangumi', key);
    if (cached) return;
    await this._refresh(key, url, method, body);
  }

  async handle(req, res, url) {
    if (!this.supports(url.pathname)) return false;
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, POST' });
      return true;
    }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let body = Buffer.alloc(0);
    try { if (method === 'POST') body = await readBody(req); }
    catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message });
      return true;
    }
    const key = this._cacheKey(method, url, body);
    // 搜索翻页预取：响应期间顺手把下一页抓回缓存（含封面预热），
    // 客户端滚动触发的下一页请求直接 HIT，滚动加载零等待。
    if (this.prefetchNextPage && method === 'POST' && /search\/subjects/.test(url.pathname)) {
      const next = nextSearchRequest(url, body);
      if (next) {
        this._prefetch(next.url, method, next.body).catch(() => {});
      }
    }
    const cached = await this.cache.get('bangumi', key, { allowStale: true });
    if (cached && !cached.stale) {
      sendBuffer(res, cached.meta.status, cached.body, {
        ...cached.meta.headers,
        'Cache-Control': 'public, max-age=120',
        'X-SakuraFall-Cache': 'HIT'
      }, req.method);
      return true;
    }
    if (cached?.stale) {
      this._refresh(key, url, method, body).catch(() => {});
      sendBuffer(res, cached.meta.status, cached.body, {
        ...cached.meta.headers,
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=300',
        Warning: '110 - stale response',
        'X-SakuraFall-Cache': 'STALE'
      }, req.method);
      return true;
    }
    try {
      const result = await this._refresh(key, url, method, body);
      sendBuffer(res, result.status, result.body, {
        ...result.headers,
        'Cache-Control': 'public, max-age=60',
        'X-SakuraFall-Cache': 'MISS'
      }, req.method);
    } catch (error) {
      sendJson(res, 502, { error: 'bangumi_upstream_unavailable', message: error.message });
    }
    return true;
  }
}

module.exports = {
  BangumiProxy,
  cachePolicy,
  ALLOWED_PATH,
  isCoverUrl,
  rewriteCoverUrls,
  coverWarmUrls,
  nextSearchRequest
};
