/**
 * 弹幕 API 服务
 *
 * 数据来源：
 *   1. dandanplay（弹弹play）API —— 需要用户在设置中配置 AppID / AppSecret
 *      文档：https://github.com/kaedei/dandanplay-apiindex
 *      搜索：GET /Search/Anime?anime={keyword}
 *      弹幕：GET /Comment/{animeId}?withRelated=true
 *   2. 本地 XML 文件导入（B 站标准格式，用户可从各类渠道下载）
 *
 * 统一弹幕对象格式：
 *   { time: 秒, color: 0xFFFFFF, text: '文本', type: 'scroll'|'top'|'bottom' }
 */

const HttpClient = require('../utils/HttpClient');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

class DanmakuApi {
  constructor() {
    this.baseUrl = 'https://api.dandanplay.net';
    this.timeout = 10000;
    // dandanplay 认证凭证（由用户在设置中配置）
    this.appId = '';
    this.appSecret = '';
    this.db = null; // AnimeDatabase 实例，用于缓存
    this.http = new HttpClient({
      timeout: this.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });
  }

  setDatabase(db) { this.db = db; }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, parseInt(timeout, 10) || 10000);
    this.http.setTimeout(this.timeout);
  }

  setProxy(proxyUrl) { this.http.setProxy(proxyUrl); }

  /**
   * 设置 dandanplay 认证凭证
   */
  setCredentials(appId, appSecret) {
    this.appId = (appId || '').trim();
    this.appSecret = (appSecret || '').trim();
  }

  /**
   * dandanplay 认证是否就绪
   */
  isReady() {
    return !!(this.appId && this.appSecret);
  }

  // ── 缓存辅助 ──
  _readCache(key) {
    if (!this.db) return null;
    try { return this.db.getCache(key); } catch (e) { return null; }
  }

  _writeCache(key, kind, content, ttl) {
    if (!this.db) return;
    try { this.db.setCache(key, 'danmaku', kind, content, ttl); } catch (e) { /* ignore */ }
  }

  /**
   * 生成弹弹play开放弹幕网络 v2 签名。
   * X-Signature = base64(sha256(AppId + Timestamp + path + AppSecret))
   */
  _buildAuthHeaders(apiPath) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const raw = this.appId + timestamp + String(apiPath || '').toLowerCase() + this.appSecret;
    const signature = crypto.createHash('sha256').update(raw, 'utf8').digest('base64');
    return {
      'X-AppId': this.appId,
      'X-Timestamp': timestamp,
      'X-Signature': signature
    };
  }

  async request(url, apiPath, options = {}) {
    if (!this.isReady()) {
      const error = new Error('未配置弹弹play AppID 和 AppSecret');
      error.code = 'DANMAKU_NOT_CONFIGURED';
      throw error;
    }
    const authHeaders = this._buildAuthHeaders(apiPath);
    const merged = {
      ...options,
      headers: { ...(options.headers || {}), ...authHeaders }
    };
    const text = await this.http.fetch(url, merged);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`弹幕 API JSON 解析失败: ${e.message}`);
    }
  }

  /**
   * 搜索 dandanplay 番剧库
   * 返回: [{ animeId, title, type, episodes: [{ episodeId, episodeTitle }] }]
   */
  async searchAnime(keyword) {
    if (!keyword) return [];
    const apiPath = '/api/v2/search/anime';
    const cacheKey = `danmaku:v2:search:${keyword}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}${apiPath}?keyword=${encodeURIComponent(keyword)}&v2=true`;
    console.log(`[DanmakuApi] 搜索番剧: ${url}`);

    try {
      const data = await this.request(url, apiPath);
      if (data?.success === false) {
        throw new Error(data.errorMessage || '弹幕搜索失败');
      }
      const animes = data?.animes || data?.Animes || data?.data?.animes || [];
      const result = animes.map(a => ({
        animeId: a.animeId ?? a.AnimeId ?? a.id ?? '',
        title: a.animeTitle || a.title || a.Title || '',
        type: a.type || a.Type || a.typeDescription || '',
        episodes: (a.episodes || a.Episodes || []).map(ep => ({
          episodeId: ep.episodeId ?? ep.EpisodeId ?? ep.id ?? '',
          episodeTitle: ep.episodeTitle || ep.title || ep.EpisodeTitle || '',
          episodeNumber: ep.episodeNumber ?? ep.episode ?? ep.sort ?? 0
        }))
      }));
      // 搜索结果缓存 30 分钟
      this._writeCache(cacheKey, 'search', result, 30 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[DanmakuApi] 搜索番剧失败:', err.message);
      throw err;
    }
  }

  /**
   * 获取某番剧的弹幕池（含相关分集）
   * GET /Comment/{animeId}?withRelated=true
   * 返回统一格式的弹幕数组: [{ time, color, text, type }]
   */
  async getComments(episodeId) {
    if (!episodeId) return [];
    const apiPath = `/api/v2/comment/${episodeId}`;
    const cacheKey = `danmaku:v2:comments:${episodeId}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}${apiPath}?withRelated=true`;
    console.log(`[DanmakuApi] 获取弹幕: ${url}`);

    try {
      const data = await this.request(url, apiPath);
      if (data?.success === false) {
        throw new Error(data.errorMessage || '弹幕获取失败');
      }
      const comments = data?.comments || data?.Comments || data?.data?.comments || [];
      const result = comments.map(c => this._parseDandanComment(c)).filter(Boolean);
      // 弹幕池缓存 24 小时（内容稳定）
      this._writeCache(cacheKey, 'comments', result, 24 * 60 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[DanmakuApi] 获取弹幕失败:', err.message);
      throw err;
    }
  }

  /**
   * 解析 dandanplay 单条弹幕为统一格式
   * 弹弹play: { cid, p: "时间,模式,颜色,用户ID", m: "文本" }
   * 模式与 B 站弹幕格式一致：1/6=滚动，4=底部，5=顶部。
   */
  _parseDandanComment(c) {
    try {
      const p = String(c.p || c.P || '').split(',');
      const time = parseFloat(p[0]) || 0;
      const rawType = parseInt(p[1], 10) || 1;
      const color = parseInt(p[2], 10) || 0xFFFFFF;
      let type = 'scroll';
      if (rawType === 4) type = 'bottom';
      else if (rawType === 5) type = 'top';
      const text = String(c.m || c.M || '').trim();
      if (!text) return null;
      return { time, color, text, type };
    } catch (e) {
      return null;
    }
  }

  /**
   * 解析本地 XML 弹幕文件（B 站标准格式）
   * <d p="时间,类型,颜色,用户ID,时间戳,池,用户Hash">文本</d>
   * 类型: 1=滚动 4=底部 5=顶部
   *
   * @param {string} filePath - XML 文件路径
   * @returns {Array} 统一格式弹幕数组
   */
  parseLocalXmlFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('弹幕文件不存在');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.xml') {
      throw new Error('仅支持 .xml 格式的弹幕文件');
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return this._parseXmlContent(content);
  }

  /**
   * 解析 XML 字符串内容
   */
  _parseXmlContent(content) {
    if (!content) return [];
    const result = [];
    // 用正则提取 <d p="...">文本</d>，避免依赖 XML 解析库
    const regex = /<d\s+[^>]*p="([^"]+)"[^>]*>([^<]*)<\/d>/gi;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const p = match[1].split(',');
      const text = (match[2] || '').trim();
      if (!text) continue;
      const time = parseFloat(p[0]) || 0;
      const rawType = parseInt(p[1], 10) || 1;
      const color = parseInt(p[2], 10) || 0xFFFFFF;
      let type = 'scroll';
      if (rawType === 4) type = 'bottom';
      else if (rawType === 5) type = 'top';
      result.push({ time, color, text, type });
    }
    return result;
  }

  /**
   * 测试 API 连通性
   */
  async test() {
    if (!this.isReady()) {
      return { ok: false, msg: '未配置 dandanplay AppID/AppSecret' };
    }
    try {
      const result = await this.searchAnime('测试');
      return { ok: true, count: result.length };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = new DanmakuApi();
module.exports.DanmakuApi = DanmakuApi;
