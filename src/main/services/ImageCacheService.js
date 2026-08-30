const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const HttpsProxyAgent = require('https-proxy-agent');

const DEFAULT_TIMEOUT = 12000;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);
const CONTENT_TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp'
};

class ImageCacheService {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || '';
    this.indexFile = '';
    this.timeout = Math.max(3000, parseInt(options.timeout, 10) || DEFAULT_TIMEOUT);
    this.maxEntries = Math.max(100, parseInt(options.maxEntries, 10) || DEFAULT_MAX_ENTRIES);
    this.maxBytes = Math.max(50 * 1024 * 1024, parseInt(options.maxBytes, 10) || DEFAULT_MAX_BYTES);
    this.maxImageBytes = Math.max(1024 * 1024, parseInt(options.maxImageBytes, 10) || DEFAULT_MAX_IMAGE_BYTES);
    this.proxy = options.proxy || '';
    this.imageProcessor = options.imageProcessor || null;
    this.publicUrlResolver = options.publicUrlResolver || null;
    this._proxyAgent = null;
    this.pending = new Map();
    this.index = {};
    this.saveDelay = Math.max(50, parseInt(options.saveDelay, 10) || 500);
    this.saveTimer = null;
    this.indexDirty = false;
    if (this.cacheDir) this.setCacheDir(this.cacheDir);
  }

  setCacheDir(cacheDir) {
    this.flushIndex();
    this.cacheDir = cacheDir;
    this.indexFile = path.join(this.cacheDir, 'index.json');
    this._ensureCacheDir();
    this._loadIndex();
  }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, parseInt(timeout, 10) || DEFAULT_TIMEOUT);
  }

  setProxy(proxyUrl) {
    const nextProxy = String(proxyUrl || '').trim();
    if (this._proxyAgent && this.proxy !== nextProxy) {
      try { this._proxyAgent.destroy && this._proxyAgent.destroy(); } catch (_error) { /* ignore */ }
    }
    this.proxy = nextProxy;
    this._proxyAgent = null;
  }

  setImageProcessor(processor) {
    this.imageProcessor = typeof processor === 'function' ? processor : null;
  }

  setPublicUrlResolver(resolver) {
    this.publicUrlResolver = typeof resolver === 'function' ? resolver : null;
  }

  _publicUrl(filePath) {
    return this.publicUrlResolver
      ? this.publicUrlResolver(filePath)
      : pathToFileURL(filePath).toString();
  }

  normalizeImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    const normalized = value.startsWith('//') ? `https:${value}` : value;
    try {
      const parsed = new URL(normalized);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
    } catch (_error) {
      return '';
    }
  }

  async getCover(url, options = {}) {
    const normalizedUrl = this.normalizeImageUrl(url);
    if (!normalizedUrl) {
      return { success: false, error: 'invalid image url', originalUrl: url || '' };
    }
    if (!this.cacheDir) {
      return { success: false, error: 'image cache directory is not configured', originalUrl: normalizedUrl };
    }

    const variant = options?.variant === 'thumbnail'
      ? { type: 'thumbnail', width: Math.min(720, Math.max(160, parseInt(options.width, 10) || 360)) }
      : { type: 'original' };
    const key = this._variantCacheKey(normalizedUrl, variant);
    const existing = this._getExistingEntry(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.index[key] = existing;
      this._scheduleSaveIndex();
      this._touch(existing.filePath);
      return this._toResult(existing, normalizedUrl, true);
    }

    if (this.pending.has(key)) return this.pending.get(key);
    const promise = this._downloadAndStore(normalizedUrl, key, variant)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  /**
   * 批量查询已缓存的封面 URL（同步，仅返回已存在的本地文件）
   * 用于启动时预加载到渲染进程内存，实现毫秒级显示
   */
  batchLookupCachedUrls(urls, options = {}) {
    const result = {};
    if (!this.cacheDir || !Array.isArray(urls)) return result;
    const variant = options?.variant === 'thumbnail'
      ? { type: 'thumbnail', width: Math.min(720, Math.max(160, parseInt(options.width, 10) || 360)) }
      : { type: 'original' };
    for (const rawUrl of urls) {
      const normalizedUrl = this.normalizeImageUrl(rawUrl);
      if (!normalizedUrl) continue;
      const key = this._variantCacheKey(normalizedUrl, variant);
      const entry = this.index[key];
      if (!entry?.fileName) continue;
      const filePath = path.join(this.cacheDir, entry.fileName);
      if (fs.existsSync(filePath)) {
        result[this._rendererCacheKey(normalizedUrl, variant)] = this._publicUrl(filePath);
      }
    }
    return result;
  }

  /**
   * 获取所有已缓存条目的 url → fileUrl 映射（用于启动预加载）
   */
  getAllCachedUrls() {
    const result = {};
    if (!this.cacheDir) return result;
    for (const entry of Object.values(this.index)) {
      if (!entry?.fileName || !entry.url) continue;
      const filePath = path.join(this.cacheDir, entry.fileName);
      if (fs.existsSync(filePath)) {
        const variant = entry.variant === 'thumbnail'
          ? { type: 'thumbnail', width: entry.variantWidth || 360 }
          : { type: 'original' };
        result[this._rendererCacheKey(entry.url, variant)] = this._publicUrl(filePath);
      }
    }
    return result;
  }

  clear() {
    this._cancelScheduledSave();
    const entries = Object.values(this.index || {});
    let bytes = 0;
    entries.forEach(entry => { bytes += entry.size || 0; });
    if (this.cacheDir && fs.existsSync(this.cacheDir)) {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
    }
    this.index = {};
    this._ensureCacheDir();
    this._saveIndex();
    return { removed: entries.length, bytes };
  }

  _ensureCacheDir() {
    if (!this.cacheDir) return;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  _loadIndex() {
    this.index = {};
    if (!this.indexFile || !fs.existsSync(this.indexFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      this.index = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      this.index = {};
    }
  }

  _saveIndex() {
    if (!this.indexFile) return;
    this.indexDirty = false;
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8');
    } catch (_error) {
      this.indexDirty = true;
      // Cache metadata is best effort; a failed write should not break image loading.
    }
  }

  _scheduleSaveIndex() {
    this.indexDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.indexDirty) this._saveIndex();
    }, this.saveDelay);
    if (typeof this.saveTimer.unref === 'function') {
      this.saveTimer.unref();
    }
  }

  _cancelScheduledSave() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  flushIndex() {
    this._cancelScheduledSave();
    if (this.indexDirty) this._saveIndex();
  }

  _hash(value) {
    return crypto.createHash('sha1').update(value).digest('hex');
  }

  _variantCacheKey(url, variant = { type: 'original' }) {
    return variant.type === 'thumbnail'
      ? this._hash(`${url}|thumbnail:${variant.width}`)
      : this._hash(url);
  }

  _rendererCacheKey(url, variant = { type: 'original' }) {
    return variant.type === 'thumbnail'
      ? `${url}::thumbnail:${variant.width}`
      : url;
  }

  _getExistingEntry(key) {
    const entry = this.index[key];
    if (!entry?.fileName) return null;
    const filePath = path.join(this.cacheDir, entry.fileName);
    if (!fs.existsSync(filePath)) {
      delete this.index[key];
      return null;
    }
    return { ...entry, filePath };
  }

  _toResult(entry, originalUrl, fromCache) {
    return {
      success: true,
      url: this._publicUrl(entry.filePath),
      originalUrl,
      fromCache,
      size: entry.size || 0,
      contentType: entry.contentType || ''
    };
  }

  async _downloadAndStore(url, key, variant = { type: 'original' }) {
    try {
      const variantSourceUrl = this._variantSourceUrl(url, variant);
      let response;
      let receivedUpstreamThumbnail = false;
      const originalEntry = variant.type === 'thumbnail'
        ? this._getExistingEntry(this._variantCacheKey(url, { type: 'original' }))
        : null;
      if (originalEntry) {
        response = {
          buffer: await fs.promises.readFile(originalEntry.filePath),
          contentType: originalEntry.contentType || ''
        };
      } else {
        try {
          response = await this._fetchBuffer(variantSourceUrl);
          receivedUpstreamThumbnail = variantSourceUrl !== url;
        } catch (error) {
          if (variantSourceUrl === url) throw error;
          response = await this._fetchBuffer(url);
        }
      }
      let storedBuffer = response.buffer;
      let storedContentType = response.contentType || '';
      let ext = this._extensionFor(url, response.contentType);

      // Bangumi mirrors already return a bounded 200/400/800px image. Decoding
      // that image into nativeImage only to shave a few pixels off duplicates a
      // full bitmap allocation in the main process for every visible card.
      if (variant.type === 'thumbnail' && this.imageProcessor && !receivedUpstreamThumbnail) {
        const processed = await this.imageProcessor(response.buffer, variant);
        if (!processed?.buffer?.length) throw new Error('thumbnail generation failed');
        storedBuffer = processed.buffer;
        storedContentType = processed.contentType || 'image/jpeg';
        ext = processed.ext || '.jpg';
      }

      const fileName = `${key}${ext}`;
      const filePath = path.join(this.cacheDir, fileName);
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

      fs.writeFileSync(tmpPath, storedBuffer);
      fs.renameSync(tmpPath, filePath);

      const now = Date.now();
      const entry = {
        url,
        fileName,
        size: storedBuffer.length,
        contentType: storedContentType,
        variant: variant.type,
        variantWidth: variant.width || 0,
        createdAt: now,
        lastUsedAt: now
      };
      this.index[key] = entry;
      this._enforceLimits();
      this._scheduleSaveIndex();
      return this._toResult({ ...entry, filePath }, url, false);
    } catch (error) {
      return { success: false, error: error.message, originalUrl: url };
    }
  }

  _extensionFor(url, contentType) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (CONTENT_TYPE_EXT[type]) return CONTENT_TYPE_EXT[type];

    try {
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) return ext;
    } catch (_error) {
      // Fall through to default.
    }
    return '.jpg';
  }

  _variantSourceUrl(url, variant = { type: 'original' }) {
    if (variant.type !== 'thumbnail') return url;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const supportsResize = host === 'lain.bgm.tv' ||
        host.endsWith('.lain.bgm.tv') ||
        host === 'lain.bangumi.lol' ||
        host === 'bgmimg.anibt.net';
      if (!supportsResize || !parsed.pathname.includes('/pic/')) return url;

      const requestedWidth = parseInt(variant.width, 10) || 360;
      const resizeWidth = requestedWidth <= 160 ? 200 : (requestedWidth <= 360 ? 400 : 800);
      const originalPath = parsed.pathname.replace(/^\/r\/\d+\//, '/');
      parsed.protocol = 'https:';
      parsed.pathname = `/r/${resizeWidth}${originalPath}`;
      return parsed.toString();
    } catch (_error) {
      return url;
    }
  }

  _refererFor(url) {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host.includes('bgm.tv') || host.includes('bangumi.tv') || host.includes('bangumi.lol') || host.includes('anibt.net')) return 'https://bgm.tv/';
      return `${parsed.protocol}//${parsed.host}/`;
    } catch (_error) {
      return '';
    }
  }

  _shouldUseProxy(url) {
    if (!this.proxy) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'api.bgm.tv' ||
        host === 'bgm.tv' ||
        host.endsWith('.bgm.tv') ||
        host === 'bangumi.tv' ||
        host.endsWith('.bangumi.tv') ||
        host === 'lain.bgm.tv' ||
        host.endsWith('.lain.bgm.tv');
    } catch (_error) {
      return false;
    }
  }

  _getProxyAgent() {
    if (!this.proxy) return null;
    if (!this._proxyAgent) {
      this._proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    return this._proxyAgent;
  }

  _fetchBuffer(url, redirectCount = 0) {
    if (redirectCount > MAX_REDIRECTS) {
      return Promise.reject(new Error(`too many redirects: ${MAX_REDIRECTS}`));
    }

    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const headers = {
        'User-Agent': DEFAULT_UA,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': this._refererFor(url)
      };
      const reqOptions = { headers, timeout: this.timeout };
      if (this._shouldUseProxy(url)) {
        reqOptions.agent = this._getProxyAgent();
      }

      const req = client.get(url, reqOptions, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          this._fetchBuffer(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`image request failed: ${res.statusCode}`));
          return;
        }

        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        if (contentType && !contentType.startsWith('image/')) {
          res.resume();
          reject(new Error(`unexpected image content-type: ${contentType}`));
          return;
        }

        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > this.maxImageBytes) {
            req.destroy(new Error('image is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          this._decodeContent(buffer, res.headers['content-encoding'])
            .then(decoded => {
              if (decoded.length > this.maxImageBytes) {
                reject(new Error('image is too large'));
                return;
              }
              resolve({ buffer: decoded, contentType });
            })
            .catch(reject);
        });
      });

      req.on('timeout', () => req.destroy(new Error('image request timeout')));
      req.on('error', reject);
    });
  }

  _decodeContent(buffer, encoding) {
    const enc = String(encoding || '').toLowerCase();
    if (enc === 'gzip') {
      return new Promise((resolve, reject) => zlib.gunzip(buffer, (err, out) => err ? reject(err) : resolve(out)));
    }
    if (enc === 'deflate') {
      return new Promise((resolve, reject) => {
        zlib.inflate(buffer, (err, out) => {
          if (!err) return resolve(out);
          zlib.inflateRaw(buffer, (rawErr, rawOut) => rawErr ? reject(rawErr) : resolve(rawOut));
        });
      });
    }
    if (enc === 'br') {
      return new Promise((resolve, reject) => zlib.brotliDecompress(buffer, (err, out) => err ? reject(err) : resolve(out)));
    }
    return Promise.resolve(buffer);
  }

  _touch(filePath) {
    try {
      const now = new Date();
      fs.utimesSync(filePath, now, now);
    } catch (_error) {
      // Best effort only.
    }
  }

  /**
   * 主动收缩缓存：按 LRU 淘汰到目标条数/字节数以下（比 maxEntries/maxBytes 更激进）
   * 用于播放窗口关闭等场景，把主进程内存占用降下来
   * @param {Object} target - { maxEntries, maxBytes }，缺省为当前上限的 1/2
   */
  trim(target = {}) {
    if (!this.cacheDir) return;
    const nextMaxEntries = Math.max(100, parseInt(target.maxEntries, 10) || Math.floor(this.maxEntries / 2));
    const nextMaxBytes = Math.max(16 * 1024 * 1024, parseInt(target.maxBytes, 10) || Math.floor(this.maxBytes / 2));
    this._enforceLimits(nextMaxEntries, nextMaxBytes);
    this._scheduleSaveIndex();
  }

  _enforceLimits(nextMaxEntries = this.maxEntries, nextMaxBytes = this.maxBytes) {
    const entries = Object.entries(this.index)
      .map(([key, entry]) => ({ key, ...entry, filePath: path.join(this.cacheDir, entry.fileName || '') }))
      .filter(entry => entry.fileName);

    let totalBytes = 0;
    const existing = [];
    for (const entry of entries) {
      if (fs.existsSync(entry.filePath)) {
        totalBytes += entry.size || 0;
        existing.push(entry);
      } else {
        delete this.index[entry.key];
      }
    }

    existing.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
    while (existing.length > nextMaxEntries || totalBytes > nextMaxBytes) {
      const entry = existing.shift();
      if (!entry) break;
      try { fs.unlinkSync(entry.filePath); } catch (_error) { /* ignore */ }
      totalBytes -= entry.size || 0;
      delete this.index[entry.key];
    }
  }
}

const imageCacheService = new ImageCacheService();
module.exports = imageCacheService;
module.exports.ImageCacheService = ImageCacheService;
