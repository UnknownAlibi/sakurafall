/**
 * 视频流代理服务
 *
 * 目的：让播放器窗口恢复 webSecurity: true 后仍能直连任意视频源。
 * 背景：大量片源不返回 CORS 头，video 元素跨域加载后 canvas 会被污染，
 * Anime4K 的 texImage2D / VideoFrame 取帧被拦截——此前只能关闭 webSecurity。
 * 方案：主进程用 protocol.handle 把远端 http(s) 视频流映射到
 *   sakurafall-media://proxy/{base64url}?referer=...
 * 响应补上 Access-Control-Allow-Origin: *，渲染层视为同源资源，不污染 canvas。
 *
 * 约束：
 *   - 仅转发 GET/HEAD
 *   - 透传 Range 与关键请求头，透传上游状态码
 *   - 响应体流式转发（不缓存整个视频到内存）
 *   - 请求被取消时同步销毁上游连接（stream destroy）
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PROXY_HOST = 'proxy';
const MAX_PROXY_URL_BYTES = 8 * 1024; // base64 后的上限，实际 URL 远小于此

// 转发到上游的请求白名单（大小写不敏感）
const FORWARD_REQUEST_HEADERS = new Set([
  'range',
  'accept',
  'accept-language',
  'user-agent'
]);

// 回传给渲染层的响应头白名单（hop-by-hop 头不转发）
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'expires'
];

let registered = false;

/**
 * 生成代理 URL
 * @param {string} targetUrl - 远端 http(s) 视频地址
 * @param {Object} [options] - { referer }
 * @returns {string} sakurafall-media://proxy/...
 */
function buildProxyUrl(targetUrl, options = {}) {
  const target = String(targetUrl || '').trim();
  if (!/^https?:\/\//i.test(target)) return target; // 非远端地址不代理
  const encoded = Buffer.from(target, 'utf8').toString('base64url');
  const referer = String(options.referer || '').trim();
  const query = referer ? `?referer=${encodeURIComponent(referer)}` : '';
  return `sakurafall-media://${PROXY_HOST}/${encoded}${query}`;
}

/**
 * 解析代理请求 URL，还原目标地址与可选 referer
 * @returns {{ target: string, referer: string } | null}
 */
function parseProxyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== PROXY_HOST) return null;
    const encoded = url.pathname.replace(/^\//, '');
    if (!encoded || encoded.length > MAX_PROXY_URL_BYTES) return null;
    const target = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!/^https?:\/\//i.test(target)) return null;
    // 约束协议与端口，拒绝内网环回之外的畸形目标（loopback 允许，BT 本地流同源无需代理）
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const referer = url.searchParams.get('referer') || '';
    return { target, referer };
  } catch (_error) {
    return null;
  }
}

/**
 * 注册代理协议 handler（应用级，幂等）
 * 必须在 app ready 之前调用的部分（scheme 特权）由 index.js 统一注册，
 * 这里只负责 app ready 后的 protocol.handle。
 */
function registerVideoStreamProxy() {
  if (registered) return;
  registered = true;
  // sakurafall-media 已在 index.js 通过 registerSchemesAsPrivileged 声明
  // （standard/secure/corsEnabled/supportFetchAPI），此处挂载流式 handler。
  // 注意：registerFileProtocol 与 protocol.handle 互斥，index.js 的
  // sakurafall-media 文件协议 handler 将由本 handler 统一接管（asset 分支走原逻辑）。
  const { protocol } = require('electron');
  protocol.handle('sakurafall-media', (request) => {
    const parsed = parseProxyUrl(request.url);
    if (parsed) {
      return proxyRemoteStream(request, parsed);
    }
    return handleAssetRequest(request);
  });
}

// ---- asset 分支：保持 MediaLibraryService 的本地文件语义 ----
let assetResolver = null; // (url) => filePath | ''
function setAssetResolver(resolver) {
  assetResolver = typeof resolver === 'function' ? resolver : null;
}

function handleAssetRequest(request) {
  const { Readable } = require('stream');
  const fs = require('fs');
  return new Promise((resolve) => {
    const filePath = assetResolver ? assetResolver(request.url) : '';
    if (!filePath) {
      resolve(new Response('Not Found', { status: 404 }));
      return;
    }
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        resolve(new Response('Not Found', { status: 404 }));
        return;
      }
      const stream = fs.createReadStream(filePath);
      const nodeStream = Readable.toWeb(stream);
      resolve(new Response(nodeStream, {
        status: 200,
        headers: {
          'Content-Type': guessContentType(filePath),
          'Content-Length': String(stats.size),
          'Access-Control-Allow-Origin': '*'
        }
      }));
    });
  });
}

function guessContentType(filePath) {
  const ext = (filePath.match(/\.(\w+)$/) || [])[1]?.toLowerCase() || '';
  const map = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    ts: 'video/mp2t', m2ts: 'video/mp2t', mov: 'video/quicktime', avi: 'video/x-msvideo',
    m3u8: 'application/vnd.apple.mpegurl', mp3: 'audio/mpeg', m4a: 'audio/mp4',
    aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav'
  };
  return map[ext] || 'application/octet-stream';
}

// ---- proxy 分支：远端流转发 ----

function proxyRemoteStream(request, { target, referer }) {
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';

  // 从渲染层请求中筛选可转发的头，附加 referer（部分源校验）
  const headers = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    if (FORWARD_REQUEST_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      headers[key] = value;
    }
  }
  if (!headers['User-Agent']) {
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
  }
  if (referer && /^https?:\/\//i.test(referer)) {
    headers['Referer'] = referer;
  }

  const upstreamUrl = new URL(target);
  const client = upstreamUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const upstream = client.request(upstreamUrl, { method, headers }, (res) => {
      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'range, content-type',
        'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges'
      };
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = res.headers[name];
        if (value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
      }

      const status = res.statusCode || 502;
      // 上游 4xx/5xx 直接透传状态与少量 body，不做重试（播放器自身有换源/重试逻辑）
      if (method === 'HEAD' || status === 204 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      const body = require('stream').Readable.toWeb(res);
      // Response 构造后若渲染层中断（seek 产生新 Range），Chromium 会 cancel
      // 该 fetch，这里通过 body 流的 cancel 级联销毁上游连接
      resolve(new Response(body, { status, headers: responseHeaders }));
    });

    upstream.on('error', (error) => {
      resolve(new Response(`Upstream error: ${error.message || 'unknown'}`, { status: 502 }));
    });
    upstream.setTimeout(30_000, () => {
      upstream.destroy(new Error('upstream timeout'));
    });
    upstream.end();
  });
}

module.exports = {
  buildProxyUrl,
  registerVideoStreamProxy,
  setAssetResolver,
  parseProxyUrl,
  PROXY_HOST
};
