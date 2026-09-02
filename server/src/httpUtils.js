const fs = require('node:fs');
const path = require('node:path');

function applyCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  applyCommonHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendBuffer(res, status, body, headers = {}, method = 'GET') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  applyCommonHeaders(res);
  res.writeHead(status, { 'Content-Length': payload.length, ...headers });
  res.end(method === 'HEAD' ? undefined : payload);
}

async function readBody(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchBuffer(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 12_000);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body?.length ? options.body : undefined,
      redirect: options.redirect || 'follow',
      signal: controller.signal
    });
    const declaredSize = Number(response.headers.get('content-length')) || 0;
    const maxBytes = Number(options.maxBytes) || 10 * 1024 * 1024;
    if (declaredSize > maxBytes) throw new Error('upstream response is too large');
    const reader = response.body?.getReader();
    const chunks = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error('upstream response is too large');
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { response, body: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timeout);
  }
}

function safeFileName(value) {
  const name = path.basename(String(value || ''));
  return /^[a-z0-9][a-z0-9._-]{0,180}$/i.test(name) ? name : '';
}

function serveFile(req, res, filePath, contentType = 'application/octet-stream') {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return false; }
  if (!stat.isFile()) return false;
  const etag = `W/\"${stat.size}-${Math.floor(stat.mtimeMs)}\"`;
  if (req.headers['if-none-match'] === etag) {
    applyCommonHeaders(res);
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Number(range[2]) : end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
      applyCommonHeaders(res);
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return true;
    }
    end = Math.min(end, stat.size - 1);
    status = 206;
  }
  applyCommonHeaders(res);
  const headers = {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=300',
    ETag: etag
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(filePath, { start, end }).pipe(res);
  return true;
}

module.exports = {
  applyCommonHeaders,
  sendJson,
  sendBuffer,
  readBody,
  fetchBuffer,
  safeFileName,
  serveFile
};
