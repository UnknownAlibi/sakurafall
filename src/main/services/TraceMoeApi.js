// trace.moe 以图搜番 API 服务
// 官方文档：https://github.com/soruly/trace.moe-api
//
// 主要接口：
//   POST https://api.trace.moe/search        multipart/form-data, 字段 image
//   GET  https://api.trace.moe/search?url=...
//
// 限制：
//   - 单张图片 < 1MB（大于则用 nativeImage 压缩）
//   - 每分钟 60 次请求（滑动窗口限流）
//
// 返回结果标准化为：
//   { anilistId, filename, episode, from, to, similarity, video, image }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HttpClient = require('../utils/HttpClient');

// 延迟加载 electron 模块（service 可能在 app ready 之前被 require）
function getNativeImage() {
    try {
        return require('electron').nativeImage;
    } catch (e) {
        return null;
    }
}

function getClipboard() {
    try {
        return require('electron').clipboard;
    } catch (e) {
        return null;
    }
}

// trace.moe 限制：图片 < 1MB
const MAX_IMAGE_BYTES = 1024 * 1024;
// 限流：每分钟 60 次
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
// 缓存 TTL：10 分钟
const CACHE_TTL_MS = 10 * 60 * 1000;
// 缓存最大条目
const CACHE_MAX_ENTRIES = 80;

// 压缩目标短边像素（压缩时缩放到该尺寸以内）
const COMPRESS_TARGET_WIDTH = 960;

class TraceMoeApi {
    constructor() {
        this.baseUrl = 'https://api.trace.moe';
        this.timeout = 20000;
        // 公共 HTTP 客户端：JSON 接口 + 自动重定向/解压
        this.http = new HttpClient({
            timeout: this.timeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        // 内存缓存：key -> { content, expiresAt }
        this._cache = new Map();
        // 滑动窗口限流时间戳
        this._requestTimestamps = [];
    }

    setTimeout(timeout) {
        this.timeout = Math.max(5000, parseInt(timeout, 10) || 20000);
        this.http.setTimeout(this.timeout);
    }

    // 设置代理（空字符串表示禁用，直连）
    setProxy(proxyUrl) {
        this.http.setProxy(proxyUrl);
    }

    // ── 限流 ───────────────────────────────────────────────
    _checkRateLimit() {
        const now = Date.now();
        // 清理过期时间戳
        this._requestTimestamps = this._requestTimestamps.filter(
            ts => now - ts < RATE_LIMIT_WINDOW_MS
        );
        if (this._requestTimestamps.length >= RATE_LIMIT_MAX) {
            throw new Error('trace.moe 请求过于频繁，请稍后再试（每分钟限制 60 次）');
        }
        this._requestTimestamps.push(now);
    }

    // ── 缓存 ───────────────────────────────────────────────
    _cacheKey(prefix, data) {
        const hash = crypto.createHash('sha1').update(data).digest('hex');
        return `tracemoe:${prefix}:${hash}`;
    }

    _readCache(key) {
        const entry = this._cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._cache.delete(key);
            return null;
        }
        return entry.content;
    }

    _writeCache(key, content) {
        // 简单的 LRU：超过容量时删除最早的条目
        if (this._cache.size >= CACHE_MAX_ENTRIES) {
            const firstKey = this._cache.keys().next().value;
            if (firstKey) this._cache.delete(firstKey);
        }
        this._cache.set(key, { content, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    // ── 图片处理 ───────────────────────────────────────────

    /**
     * 读取图片文件，必要时压缩到 < 1MB
     * @param {string} imagePath - 图片绝对路径
     * @returns {Promise<{buffer: Buffer, mime: string}>}
     */
    async _readAndCompressImage(imagePath) {
        const ext = path.extname(imagePath).toLowerCase();
        let buffer = fs.readFileSync(imagePath);

        // 已经够小，直接返回
        if (buffer.length <= MAX_IMAGE_BYTES) {
            return { buffer, mime: this._mimeFromExt(ext) };
        }

        const nativeImage = getNativeImage();
        if (!nativeImage) {
            // 没有 nativeImage 可用，截断到 1MB（trace.moe 会自己处理）
            throw new Error('图片过大且无法压缩（nativeImage 不可用）');
        }

        const img = nativeImage.createFromBuffer(buffer);
        if (img.isEmpty()) {
            throw new Error('图片格式无法识别');
        }
        const size = img.getSize();
        // 按比例缩小到 COMPRESS_TARGET_WIDTH 以内
        const scale = size.width > COMPRESS_TARGET_WIDTH
            ? COMPRESS_TARGET_WIDTH / size.width
            : 1;
        const targetWidth = Math.max(1, Math.round(size.width * scale));
        const targetHeight = Math.max(1, Math.round(size.height * scale));
        const resized = img.resize({ width: targetWidth, height: targetHeight });

        // 逐级降低 JPEG 质量直到 < 1MB
        let quality = 85;
        let jpegBuf = resized.toJPEG(quality);
        while (jpegBuf.length > MAX_IMAGE_BYTES && quality > 20) {
            quality -= 15;
            jpegBuf = resized.toJPEG(quality);
        }
        if (jpegBuf.length > MAX_IMAGE_BYTES) {
            throw new Error('图片压缩后仍超过 1MB 限制');
        }
        return { buffer: jpegBuf, mime: 'image/jpeg' };
    }

    _mimeFromExt(ext) {
        const map = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.bmp': 'image/bmp'
        };
        return map[ext] || 'image/jpeg';
    }

    /**
     * 构造 multipart/form-data 请求体
     */
    _buildMultipartBody(buffer, mime, filename = 'image.jpg') {
        const boundary = '----TraceMoeBoundary' + crypto.randomBytes(8).toString('hex');
        const headerPart = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
            `Content-Type: ${mime}\r\n\r\n`,
            'utf8'
        );
        const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        return {
            body: Buffer.concat([headerPart, buffer, footerPart]),
            contentType: `multipart/form-data; boundary=${boundary}`
        };
    }

    // ── 结果标准化 ─────────────────────────────────────────
    _normalizeResult(raw) {
        if (!raw) return null;
        const anilist = raw.anilist && typeof raw.anilist === 'object'
            ? raw.anilist.id
            : raw.anilist;
        return {
            anilistId: anilist || null,
            filename: raw.filename || '',
            episode: raw.episode != null ? raw.episode : null,
            from: typeof raw.from === 'number' ? raw.from : null,
            to: typeof raw.to === 'number' ? raw.to : null,
            similarity: typeof raw.similarity === 'number' ? raw.similarity : 0,
            video: raw.video || '',
            image: raw.image || ''
        };
    }

    _normalizeResponse(resp) {
        if (!resp) return { results: [], frameCount: 0, error: '空响应' };
        if (resp.error) return { results: [], frameCount: 0, error: resp.error };
        const rawResults = Array.isArray(resp.result) ? resp.result : [];
        const results = rawResults
            .map(this._normalizeResult)
            .filter(Boolean)
            .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
        return {
            results,
            frameCount: resp.frameCount || results.length,
            error: ''
        };
    }

    // ── 对外 API ───────────────────────────────────────────

    /**
     * 通过本地图片文件搜索
     * @param {string} imagePath - 图片绝对路径
     * @returns {Promise<{results: Array, frameCount: number, error: string}>}
     */
    async searchByImage(imagePath) {
        if (!imagePath) throw new Error('图片路径为空');
        if (!fs.existsSync(imagePath)) throw new Error('图片文件不存在');

        const { buffer, mime } = await this._readAndCompressImage(imagePath);
        const cacheKey = this._cacheKey('file', buffer);
        const cached = this._readCache(cacheKey);
        if (cached) return cached;

        this._checkRateLimit();
        const { body, contentType } = this._buildMultipartBody(buffer, mime);
        const text = await this.http.fetch(`${this.baseUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body,
            noDedupe: true
        });
        let resp;
        try {
            resp = JSON.parse(text);
        } catch (e) {
            throw new Error(`trace.moe 响应解析失败: ${e.message}`);
        }
        const normalized = this._normalizeResponse(resp);
        this._writeCache(cacheKey, normalized);
        return normalized;
    }

    /**
     * 通过图片 URL 搜索
     * @param {string} imageUrl
     */
    async searchByUrl(imageUrl) {
        if (!imageUrl) throw new Error('图片 URL 为空');

        const cacheKey = this._cacheKey('url', Buffer.from(imageUrl, 'utf8'));
        const cached = this._readCache(cacheKey);
        if (cached) return cached;

        this._checkRateLimit();
        const requestUrl = `${this.baseUrl}/search?url=${encodeURIComponent(imageUrl)}`;
        const text = await this.http.fetch(requestUrl, { noDedupe: true });
        let resp;
        try {
            resp = JSON.parse(text);
        } catch (e) {
            throw new Error(`trace.moe 响应解析失败: ${e.message}`);
        }
        const normalized = this._normalizeResponse(resp);
        this._writeCache(cacheKey, normalized);
        return normalized;
    }

    /**
     * 从剪贴板读取图片搜索
     */
    async searchByClipboard() {
        const clipboard = getClipboard();
        if (!clipboard) throw new Error('剪贴板不可用');

        const nativeImage = getNativeImage();
        if (!nativeImage) throw new Error('nativeImage 不可用');

        const img = clipboard.readImage();
        if (img.isEmpty()) {
            throw new Error('剪贴板中没有图片');
        }

        // 直接生成 JPEG buffer，复用文件搜索逻辑
        let jpegBuf = img.toJPEG(85);
        if (jpegBuf.length > MAX_IMAGE_BYTES) {
            const size = img.getSize();
            const scale = size.width > COMPRESS_TARGET_WIDTH
                ? COMPRESS_TARGET_WIDTH / size.width
                : 1;
            const targetWidth = Math.max(1, Math.round(size.width * scale));
            const targetHeight = Math.max(1, Math.round(size.height * scale));
            const resized = img.resize({ width: targetWidth, height: targetHeight });
            let quality = 85;
            jpegBuf = resized.toJPEG(quality);
            while (jpegBuf.length > MAX_IMAGE_BYTES && quality > 20) {
                quality -= 15;
                jpegBuf = resized.toJPEG(quality);
            }
            if (jpegBuf.length > MAX_IMAGE_BYTES) {
                throw new Error('剪贴板图片压缩后仍超过 1MB 限制');
            }
        }

        const cacheKey = this._cacheKey('clip', jpegBuf);
        const cached = this._readCache(cacheKey);
        if (cached) return cached;

        this._checkRateLimit();
        const { body, contentType } = this._buildMultipartBody(jpegBuf, 'image/jpeg', 'clipboard.jpg');
        const text = await this.http.fetch(`${this.baseUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body,
            noDedupe: true
        });
        let resp;
        try {
            resp = JSON.parse(text);
        } catch (e) {
            throw new Error(`trace.moe 响应解析失败: ${e.message}`);
        }
        const normalized = this._normalizeResponse(resp);
        this._writeCache(cacheKey, normalized);
        return normalized;
    }

    /**
     * 通过图片 Buffer 搜索（给渲染进程传 dataURL 时使用）
     * @param {Buffer} buffer
     * @param {string} mime
     */
    async searchByBuffer(buffer, mime = 'image/jpeg') {
        if (!buffer) throw new Error('图片数据为空');

        let buf = buffer;
        if (buf.length > MAX_IMAGE_BYTES) {
            const nativeImage = getNativeImage();
            if (!nativeImage) throw new Error('图片过大且无法压缩');
            const img = nativeImage.createFromBuffer(buf);
            if (img.isEmpty()) throw new Error('图片格式无法识别');
            const size = img.getSize();
            const scale = size.width > COMPRESS_TARGET_WIDTH
                ? COMPRESS_TARGET_WIDTH / size.width
                : 1;
            const resized = img.resize({
                width: Math.max(1, Math.round(size.width * scale)),
                height: Math.max(1, Math.round(size.height * scale))
            });
            let quality = 85;
            buf = resized.toJPEG(quality);
            while (buf.length > MAX_IMAGE_BYTES && quality > 20) {
                quality -= 15;
                buf = resized.toJPEG(quality);
            }
            mime = 'image/jpeg';
        }

        const cacheKey = this._cacheKey('buf', buf);
        const cached = this._readCache(cacheKey);
        if (cached) return cached;

        this._checkRateLimit();
        const { body, contentType } = this._buildMultipartBody(buf, mime, 'image.jpg');
        const text = await this.http.fetch(`${this.baseUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body,
            noDedupe: true
        });
        let resp;
        try {
            resp = JSON.parse(text);
        } catch (e) {
            throw new Error(`trace.moe 响应解析失败: ${e.message}`);
        }
        const normalized = this._normalizeResponse(resp);
        this._writeCache(cacheKey, normalized);
        return normalized;
    }

    // 测试连通性
    async test() {
        try {
            // 用一张测试图片 URL 探活
            const text = await this.http.fetch(
                `${this.baseUrl}/search?url=${encodeURIComponent('https://upload.wikimedia.org/wikipedia/commons/0/0c/Toriyama_Akira.JPG')}`
            );
            const data = JSON.parse(text);
            return {
                ok: !data.error,
                msg: data.error || `trace.moe 可用（frameCount=${data.frameCount || 0}）`
            };
        } catch (e) {
            return { ok: false, msg: e.message };
        }
    }
}

module.exports = new TraceMoeApi();
