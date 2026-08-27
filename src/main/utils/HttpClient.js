// 公共 HTTP 客户端
// Main-process HTTP client shared by metadata, source-pack and resolver services.
//   - https/http 自动选择
//   - 重定向跟随（上限 5 次）
//   - gzip/deflate/br 解压
//   - charset 检测（auto 模式从 content-type 推断 gbk/utf8）
//   - 超时控制
//
// 用法：
//   const httpClient = new HttpClient({ timeout: 15000 });
//   const text = await httpClient.fetch(url, {
//     headers: { 'Accept': 'application/json' },
//     referer: 'https://example.com/',
//     charset: 'auto'   // 'auto' | 'utf8' | 'gbk'，默认 'utf8'
//   });

const https = require('https');
const http = require('http');
const zlib = require('zlib');
// v5 为 CJS，默认导出构造函数；v7+ 为 ESM only（Electron 主进程无法 require）
const HttpsProxyAgent = require('https-proxy-agent');

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function createAbortError() {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

class HttpClient {
  constructor(defaults = {}) {
    this.timeout = Math.max(3000, parseInt(defaults.timeout, 10) || DEFAULT_TIMEOUT);
    this.defaultHeaders = defaults.headers || {};
    this.defaultReferer = defaults.referer || '';
    this.defaultCharset = defaults.charset || 'utf8';
    // 代理地址，如 'http://127.0.0.1:7890'；为空则不走代理
    this.proxy = defaults.proxy || '';
    this._proxyAgent = null;
    this._inFlight = new Map();
    this._maxInFlight = Math.max(20, parseInt(defaults.maxInFlight, 10) || 120);
    this.maxResponseBytes = Math.max(
      64 * 1024,
      parseInt(defaults.maxResponseBytes, 10) || DEFAULT_MAX_RESPONSE_BYTES
    );
  }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, parseInt(timeout, 10) || DEFAULT_TIMEOUT);
  }

  /**
   * 设置/更新代理
   * @param {string} proxyUrl - 代理地址，如 'http://127.0.0.1:7890'；空字符串表示禁用
   */
  setProxy(proxyUrl) {
    const newProxy = proxyUrl || '';
    // 代理地址变化时，销毁旧 agent 释放底层 socket 连接，避免连接泄漏
    if (this._proxyAgent && this.proxy !== newProxy) {
      try { this._proxyAgent.destroy && this._proxyAgent.destroy(); } catch (e) { /* ignore */ }
    }
    this.proxy = newProxy;
    this._inFlight.clear();
    this._proxyAgent = null; // 重置缓存的 agent
  }

  // 获取代理 agent（懒加载，复用连接池）
  _getProxyAgent() {
    if (!this.proxy) return null;
    if (!this._proxyAgent) {
      this._proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    return this._proxyAgent;
  }

  /**
   * 发起 GET 请求并返回解码后的字符串
   * @param {string} url - 请求地址
   * @param {object} options - { headers?, referer?, charset?, timeout? }
   * @param {number} _redirectCount - 内部递归用，外部不要传
   */
  fetch(url, options = {}, _redirectCount = 0) {
    if (process.env.SAKURAFALL_OFFLINE_MODE === '1') {
      const error = new Error('Network request blocked by offline mode');
      error.code = 'OFFLINE_MODE';
      return Promise.reject(error);
    }
    const dedupeKey = this._getDedupeKey(url, options, _redirectCount);
    if (dedupeKey) {
      const existing = this._inFlight.get(dedupeKey);
      if (existing) return existing;

      if (this._inFlight.size >= this._maxInFlight) {
        const oldestKey = this._inFlight.keys().next().value;
        if (oldestKey) this._inFlight.delete(oldestKey);
      }

      const pending = this._fetchRaw(url, options, _redirectCount)
        .finally(() => this._inFlight.delete(dedupeKey));
      this._inFlight.set(dedupeKey, pending);
      return pending;
    }

    return this._fetchRaw(url, options, _redirectCount);
  }

  _getDedupeKey(url, options = {}, _redirectCount = 0) {
    if (_redirectCount > 0 || options.signal || options.noDedupe) return '';
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' || options.body) return '';

    return JSON.stringify({
      url,
      method,
      referer: options.referer !== undefined ? options.referer : this.defaultReferer,
      charset: options.charset || this.defaultCharset,
      timeout: options.timeout || this.timeout,
      maxResponseBytes: options.maxResponseBytes || this.maxResponseBytes,
      headers: this._stableObject(options.headers || {}),
      proxy: this.proxy || ''
    });
  }

  _stableObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value || {};
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        const item = value[key];
        acc[key] = item && typeof item === 'object' && !Array.isArray(item)
          ? this._stableObject(item)
          : item;
        return acc;
      }, {});
  }

  _fetchRaw(url, options = {}, _redirectCount = 0) {
    if (_redirectCount > MAX_REDIRECTS) {
      return Promise.reject(new Error(`重定向次数超过上限: ${MAX_REDIRECTS}`));
    }
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const headers = {
      'User-Agent': DEFAULT_UA,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...this.defaultHeaders,
      ...(options.headers || {})
    };
    if (options.referer || this.defaultReferer) {
      headers['Referer'] = options.referer !== undefined ? options.referer : this.defaultReferer;
    }

    const timeout = options.timeout || this.timeout;
    const charset = options.charset || this.defaultCharset;
    const signal = options.signal;
    const maxResponseBytes = Math.max(
      64 * 1024,
      parseInt(options.maxResponseBytes, 10) || this.maxResponseBytes
    );

    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const method = (options.method || 'GET').toUpperCase();
      let body = options.body;
      if (body && typeof body !== 'string' && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      if (body) {
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const reqOptions = { headers, timeout, method };
      // 注入代理 agent（对 http 和 https 请求都生效）
      const proxyAgent = this._getProxyAgent();
      if (proxyAgent) {
        reqOptions.agent = proxyAgent;
      }

      // 确保 Promise 只 settle 一次（超时/错误/正常完成可能竞争）
      let settled = false;
      let cleanupSignal = () => {};
      const resolveOnce = (v) => { if (!settled) { settled = true; cleanupSignal(); resolve(v); } };
      const rejectOnce = (e) => { if (!settled) { settled = true; cleanupSignal(); reject(e); } };

      const req = client.request(url, reqOptions, (res) => {
        // 处理重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 消费重定向响应体，释放 keep-alive socket 供复用
          res.resume();
          const location = res.headers.location;
          const newUrl = location.startsWith('http')
            ? location
            : new URL(location, url).toString();
          cleanupSignal();
          this.fetch(newUrl, options, _redirectCount + 1).then(resolveOnce).catch(rejectOnce);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`HTTP ${res.statusCode || 0}`);
          error.code = 'HTTP_STATUS';
          error.statusCode = res.statusCode || 0;
          error.url = url;
          res.resume();
          rejectOnce(error);
          return;
        }

        const declaredLength = parseInt(res.headers['content-length'], 10) || 0;
        if (declaredLength > maxResponseBytes) {
          const error = new Error(`Response exceeds ${maxResponseBytes} byte limit`);
          error.code = 'RESPONSE_TOO_LARGE';
          res.destroy(error);
          rejectOnce(error);
          return;
        }

        res.on('error', rejectOnce);
        const chunks = [];
        let receivedBytes = 0;
        res.on('data', chunk => {
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            const error = new Error(`Response exceeds ${maxResponseBytes} byte limit`);
            error.code = 'RESPONSE_TOO_LARGE';
            res.destroy(error);
            rejectOnce(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const buffer = Buffer.concat(chunks);
            const encoding = (res.headers['content-encoding'] || '').toLowerCase();
            const decode = (buf) => this._decodeCharset(buf, res.headers['content-type'], charset);

            if (encoding === 'gzip') {
              zlib.gunzip(buffer, { maxOutputLength: maxResponseBytes }, (err, decoded) => {
                if (err) rejectOnce(err);
                else resolveOnce(decode(decoded));
              });
            } else if (encoding === 'deflate') {
              zlib.inflate(buffer, { maxOutputLength: maxResponseBytes }, (err, decoded) => {
                if (err) {
                  // 兼容 raw deflate
                  zlib.inflateRaw(buffer, { maxOutputLength: maxResponseBytes }, (e2, d2) => e2 ? rejectOnce(e2) : resolveOnce(decode(d2)));
                } else {
                  resolveOnce(decode(decoded));
                }
              });
            } else if (encoding === 'br') {
              zlib.brotliDecompress(buffer, { maxOutputLength: maxResponseBytes }, (err, decoded) => {
                if (err) rejectOnce(err);
                else resolveOnce(decode(decoded));
              });
            } else {
              resolveOnce(decode(buffer));
            }
          } catch (e) {
            rejectOnce(e);
          }
        });
      });

      if (signal) {
        const onAbort = () => {
          req.destroy(createAbortError());
          rejectOnce(createAbortError());
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        cleanupSignal = () => signal.removeEventListener('abort', onAbort);
      }

      req.on('error', rejectOnce);
      req.on('timeout', () => {
        // 超时必须销毁请求，否则 socket 挂在 keep-alive 池里泄漏
        req.destroy();
        rejectOnce(new Error('Request timeout'));
      });
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * 按指定 charset 解码 Buffer
   * @param {Buffer} buf
   * @param {string} contentType - 响应头 content-type
   * @param {string} charset - 'auto' | 'utf8' | 'gbk'
   */
  _decodeCharset(buf, contentType, charset) {
    let used = charset;
    if (charset === 'auto') {
      const ct = (contentType || '').toLowerCase();
      used = ct.includes('charset=gb') ? 'gbk' : 'utf8';
    }
    return buf.toString(used === 'gbk' ? 'gbk' : 'utf8');
  }
}

module.exports = HttpClient;
