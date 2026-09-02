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
const MAX_HLS_MANIFEST_BYTES = 2 * 1024 * 1024;

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

function isHlsTarget(targetUrl, contentType = '') {
  const target = String(targetUrl || '');
  return /\.m3u8(?:[?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$)/i.test(target)
    || /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(String(contentType || ''));
}

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
  const params = new URLSearchParams();
  if (referer) params.set('referer', referer);
  if (options.mediaType === 'hls' || isHlsTarget(target)) params.set('media', 'hls');
  const queryString = params.toString();
  const query = queryString ? `?${queryString}` : '';
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
    const mediaType = url.searchParams.get('media') || '';
    return { target, referer, mediaType };
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

// 大量 CMS 片源的 m3u8/mp4 直链是 302 跳转到带签名的 CDN 地址。
// 渲染层 hls.js/video 无法跟随代理响应里的重定向（自定义协议下 302 无 location
// 会被当作加载失败，触发自动换源），必须由代理在主进程侧跟随。
const MAX_STREAM_REDIRECTS = 5;

function rewriteHlsManifest(manifest, playlistUrl, referer = '') {
  const rewriteUri = (rawUri) => {
    const value = String(rawUri || '').trim();
    if (!value || /^(?:data:|blob:|sakurafall-media:)/i.test(value)) return value;
    try {
      return buildProxyUrl(new URL(value, playlistUrl).toString(), { referer });
    } catch (_) {
      return value;
    }
  };

  return String(manifest || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/\bURI=(['"])(.*?)\1/gi, (_match, quote, uri) => (
          `URI=${quote}${rewriteUri(uri)}${quote}`
        ));
      }
      const leading = line.match(/^\s*/)?.[0] || '';
      const trailing = line.match(/\s*$/)?.[0] || '';
      return `${leading}${rewriteUri(trimmed)}${trailing}`;
    })
    .join('\n');
}

function readLimitedBody(stream, limit = MAX_HLS_MANIFEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        stream.destroy(new Error('HLS manifest is too large'));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

function proxyRemoteStream(request, { target, referer, mediaType = '' }, redirectCount = 0) {
  if (redirectCount > MAX_STREAM_REDIRECTS) {
    return Promise.resolve(new Response('Too many redirects', { status: 502 }));
  }

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
      const status = res.statusCode || 502;

      // 跟随上游重定向（与 HttpClient 解析侧行为保持一致），Range 等头原样带到新地址
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        const nextTarget = /^https?:\/\//i.test(location)
          ? location
          : new URL(location, target).toString();
        resolve(proxyRemoteStream(request, { target: nextTarget, referer, mediaType }, redirectCount + 1));
        return;
      }

      // 部分 OSS/CDN 的 Referer 反盗链白名单不含源站页面域（如 agedm → 阿里云 OSS），
      // 带 Referer 反而 403。命中 403 且本次带了 Referer 时去 Referer 重试一次；
      // referer 为空的递归不会再次进入此分支，无死循环。
      if (status === 403 && referer) {
        res.resume();
        resolve(proxyRemoteStream(request, { target, referer: '', mediaType }, redirectCount));
        return;
      }

      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'range, content-type',
        'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges'
      };
      for (const name of FORWARD_RESPONSE_HEADERS) {
        const value = res.headers[name];
        if (value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
      }

      // 上游 4xx/5xx 直接透传状态与少量 body，不做重试（播放器自身有换源/重试逻辑）
      if (method === 'HEAD' || status === 204 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }

      const contentType = String(res.headers['content-type'] || '');
      if (status >= 200 && status < 300 && (mediaType === 'hls' || isHlsTarget(target, contentType))) {
        readLimitedBody(res)
          .then((body) => {
            const rewritten = Buffer.from(rewriteHlsManifest(body.toString('utf8'), target, referer), 'utf8');
            responseHeaders['content-type'] = contentType || 'application/vnd.apple.mpegurl';
            responseHeaders['content-length'] = String(rewritten.length);
            delete responseHeaders['content-range'];
            delete responseHeaders['accept-ranges'];
            resolve(new Response(rewritten, { status, headers: responseHeaders }));
          })
          .catch((error) => {
            resolve(new Response(`HLS proxy error: ${error.message || 'unknown'}`, { status: 502 }));
          });
        return;
      }

      const body = require('stream').Readable.toWeb(res);
      // 诊断日志：定位"视频格式或地址不受支持"(video code 4)的真实原因——
      // 403/404=地址失效或被拒，text/html=上游返回网页而非视频，502=连接失败
      if (status >= 400 || /^text\/html/i.test(String(res.headers['content-type'] || ''))) {
        try {
          console.warn(`[VideoStreamProxy] 上游异常: status=${status} type=${res.headers['content-type'] || 'none'} target=${target.slice(0, 120)}${referer ? ` referer=${referer.slice(0, 60)}` : ''}`);
        } catch (_e) { /* EPIPE ignored */ }
      }
      // Response 构造后若渲染层中断（seek 产生新 Range），Chromium 会 cancel
      // 该 fetch，这里通过 body 流的 cancel 级联销毁上游连接
      resolve(new Response(body, { status, headers: responseHeaders }));
    });

    upstream.on('error', (error) => {
      try {
        console.warn(`[VideoStreamProxy] 上游连接失败: ${error.message || 'unknown'} target=${target.slice(0, 120)}`);
      } catch (_e) { /* EPIPE ignored */ }
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
  isHlsTarget,
  rewriteHlsManifest,
  PROXY_HOST
};
