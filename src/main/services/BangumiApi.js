/**
 * Bangumi (番组计划) API 服务
 * 官方 API: https://bangumi.github.io/api/
 * 主要接口: /calendar (季度番剧), /search (搜索)
 */

const HttpClient = require('../utils/HttpClient');

function collectAliasValues(value, output) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectAliasValues(item, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of ['v', 'value', 'name', 'title']) {
    if (value[key] !== undefined) collectAliasValues(value[key], output);
  }
}

function extractSubjectAliases(item = {}) {
  const values = [];
  collectAliasValues(item.aliases, values);
  for (const entry of item.infobox || []) {
    if (!/别名|原名|中文名|日文名|英文名|简称|又名/i.test(String(entry?.key || ''))) continue;
    collectAliasValues(entry?.value, values);
  }
  const primaryNames = new Set([item.name, item.name_cn]
    .filter(Boolean)
    .map(value => String(value).toLocaleLowerCase()));
  return [...new Set(values)]
    .filter(value => !primaryNames.has(value.toLocaleLowerCase()))
    .slice(0, 24);
}

class BangumiApi {
  constructor() {
    // 默认官方 API；直连失败时会自动尝试公开反代镜像。
    this.defaultBaseUrl = 'https://api.bgm.tv';
    this.baseUrl = this.defaultBaseUrl;
    this.publicApiMirrors = [
      'https://bgmapi.anibt.net',
      'https://api.bangumi.lol',
      'https://api.bangumi.one'
    ];
    this.webMirrors = [
      'https://bgm.tv',
      'https://bgmmi.anibt.net'
    ];
    this.enablePublicMirrorFallback = true;
    this._baseCooldownUntil = new Map();
    this._mirrorHealth = new Map();
    this._mirrorHealthLoaded = false;
    this._mirrorHealthCacheKey = 'bangumi:mirror-health:v1';
    this._preferredMirrorBase = '';
    this._mirrorCooldownMs = 5 * 60 * 1000;
    this._baseProbePromises = new Map();
    this._baseSessionSuccessAt = new Map();
    this._baseSessionSuccessTtlMs = 60 * 1000;
    this.timeout = 10000; // 10秒超时
    this.db = null; // AnimeDatabase 实例，由外部注入以启用缓存
    // 缓存 TTL（毫秒）
    this.CALENDAR_CACHE_TTL = 10 * 60 * 1000; // 季度番剧 10 分钟
    this.DETAIL_CACHE_TTL = 30 * 60 * 1000;   // 详情 30 分钟
    // 公共 HTTP 客户端：JSON 接口 + 固定 Referer + 自动重定向/解压
    this.http = new HttpClient({
      timeout: this.timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      referer: 'https://bgm.tv'
    });
  }

  // 注入数据库实例以启用接口缓存
  setDatabase(db) {
    this.db = db;
    this._loadMirrorHealth();
  }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, parseInt(timeout, 10) || 10000);
    this.http.setTimeout(this.timeout);
  }

  // 设置代理（空字符串表示禁用代理，直连）
  setProxy(proxyUrl) {
    const nextProxy = proxyUrl || '';
    if (this.http.proxy === nextProxy) return;
    this.http.setProxy(nextProxy);
    this._baseProbePromises.clear();
    this._baseSessionSuccessAt.clear();
  }

  /**
   * 设置 API 基址（用于切换镜像）
   * 传入空值恢复官方 API，并在失败时自动尝试公开反代镜像。
   * 支持的取值：
   *   - https://api.bgm.tv   （官方 API）
   *   - https://api.bangumi.lol / https://bgmapi.anibt.net 等公开反代
   *   - https://your-worker.example.com （自建反代）
   * @param {string} url
   */
  setBaseUrl(url) {
    const trimmed = String(url || '').trim().replace(/\/+$/, '');
    const nextBaseUrl = trimmed || this.defaultBaseUrl;
    const nextFallbackMode = !trimmed;
    if (
      this.baseUrl === nextBaseUrl &&
      this.enablePublicMirrorFallback === nextFallbackMode
    ) return;
    this.baseUrl = nextBaseUrl;
    this.enablePublicMirrorFallback = nextFallbackMode;
    this._preferredMirrorBase = '';
    this._baseProbePromises.clear();
    this._baseSessionSuccessAt.clear();
    console.log(`[BangumiApi] API 基址切换为: ${this.baseUrl}`);
  }

  _unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  _isBaseOnCooldown(base) {
    return (this._baseCooldownUntil.get(base) || 0) > Date.now();
  }

  _markBaseFailure(base) {
    if (!base) return;
    this._baseCooldownUntil.set(base, Date.now() + this._mirrorCooldownMs);
    const record = this._getMirrorHealth(base);
    record.failureCount += 1;
    record.lastFailureAt = Date.now();
    record.cooldownUntil = Date.now() + this._mirrorCooldownMs;
    this._mirrorHealth.set(base, record);
    this._saveMirrorHealth();
  }

  _markBaseSuccess(base, elapsedMs) {
    if (!base) return;
    const record = this._getMirrorHealth(base);
    record.successCount += 1;
    record.lastSuccessAt = Date.now();
    record.cooldownUntil = 0;
    const latency = Math.max(1, Number(elapsedMs) || 1);
    record.averageLatency = record.averageLatency
      ? Math.round(record.averageLatency * 0.7 + latency * 0.3)
      : latency;
    this._mirrorHealth.set(base, record);
    this._baseSessionSuccessAt.set(base, Date.now());
    this._baseCooldownUntil.delete(base);
    this._saveMirrorHealth();
  }

  async _withBaseProbe(base, task) {
    if (!base) return task();

    const lastSessionSuccess = this._baseSessionSuccessAt.get(base) || 0;
    if (Date.now() - lastSessionSuccess < this._baseSessionSuccessTtlMs) {
      return task();
    }

    const activeProbe = this._baseProbePromises.get(base);
    if (activeProbe) {
      const available = await activeProbe;
      if (!available) {
        const error = new Error(`Bangumi endpoint unavailable: ${base}`);
        error.code = 'BANGUMI_BASE_UNAVAILABLE';
        throw error;
      }
      return task();
    }

    let finishProbe;
    const probe = new Promise(resolve => {
      finishProbe = resolve;
    });
    this._baseProbePromises.set(base, probe);

    try {
      const result = await task();
      finishProbe(true);
      return result;
    } catch (error) {
      finishProbe(false);
      throw error;
    } finally {
      if (this._baseProbePromises.get(base) === probe) {
        this._baseProbePromises.delete(base);
      }
    }
  }

  _getMirrorHealth(base) {
    return {
      successCount: 0,
      failureCount: 0,
      averageLatency: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      cooldownUntil: 0,
      ...(this._mirrorHealth.get(base) || {})
    };
  }

  _mirrorScore(base) {
    const health = this._getMirrorHealth(base);
    const total = health.successCount + health.failureCount;
    const successRate = total > 0 ? health.successCount / total : 0.5;
    const latencyScore = health.averageLatency > 0
      ? Math.max(0, 30 - Math.min(30, health.averageLatency / 180))
      : 12;
    const officialBias = base === this.defaultBaseUrl ? (this.http.proxy ? 4 : -10) : 0;
    const publicMirrorBias = !this.http.proxy && this.publicApiMirrors.includes(base) ? 6 : 0;
    const freshnessBonus = health.lastSuccessAt && Date.now() - health.lastSuccessAt < 10 * 60 * 1000 ? 8 : 0;
    const cooldownPenalty = health.cooldownUntil && health.cooldownUntil > Date.now() ? 100 : 0;
    return successRate * 60 + latencyScore + officialBias + publicMirrorBias + freshnessBonus - cooldownPenalty;
  }

  _loadMirrorHealth() {
    if (!this.db || this._mirrorHealthLoaded) return;
    this._mirrorHealthLoaded = true;
    try {
      const cached = this.db.getCacheAny(this._mirrorHealthCacheKey);
      const content = cached?.content;
      if (!content || typeof content !== 'object') return;
      Object.entries(content).forEach(([base, record]) => {
        if (!base || !record || typeof record !== 'object') return;
        this._mirrorHealth.set(base, record);
        if (record.cooldownUntil && record.cooldownUntil > Date.now()) {
          this._baseCooldownUntil.set(base, record.cooldownUntil);
        }
      });
    } catch (e) {
      console.warn('[BangumiApi] 读取镜像健康记录失败:', e.message);
    }
  }

  _saveMirrorHealth() {
    if (!this.db) return;
    try {
      const content = Object.fromEntries(this._mirrorHealth.entries());
      this.db.setCache(this._mirrorHealthCacheKey, 'bangumi', 'mirror-health', content, 30 * 24 * 60 * 60 * 1000);
    } catch (e) {
      console.warn('[BangumiApi] 保存镜像健康记录失败:', e.message);
    }
  }

  _baseOfUrl(url) {
    const bases = this._unique([
      this.baseUrl,
      this.defaultBaseUrl,
      ...this.publicApiMirrors
    ]).sort((a, b) => b.length - a.length);
    return bases.find(base => String(url).startsWith(base)) || '';
  }

  _buildApiCandidates(url, options = {}) {
    if (options.disableMirrorFallback || !this.enablePublicMirrorFallback) return [url];
    const matchedBase = this._baseOfUrl(url);
    if (!matchedBase) return [url];

    const path = String(url).slice(matchedBase.length);
    const bases = this._unique([
      matchedBase,
      this._preferredMirrorBase,
      ...this.publicApiMirrors
    ]);
    const activeBases = bases
      .filter(base => base && !this._isBaseOnCooldown(base))
      .sort((a, b) => this._mirrorScore(b) - this._mirrorScore(a));
    // 无代理环境下，官方 API 在 cooldown 中时不再作为末尾兜底候选，
    // 避免每次请求都浪费时间尝试已知的不可用地址（4.5s 超时）。
    // 有代理时官方 API 可能通过代理可用，仍保留兜底。
    const cooledPrimary = (activeBases.includes(matchedBase) || this.http.proxy)
      ? (activeBases.includes(matchedBase) ? [] : [matchedBase])
      : [];
    return this._unique([...activeBases, ...cooledPrimary])
      .map(base => base === matchedBase ? url : `${base}${path}`);
  }

  /**
   * 标准化图片 URL：
   * 1. http://lain.bgm.tv → https://lain.bgm.tv
   * 2. 配置了非官方镜像时，把 lain.bgm.tv 图片改写到镜像对应的图片域名
   *    （bgmapi.anibt.net → bgmimg.anibt.net，api.bangumi.lol → lain.bangumi.lol）
   *    镜像图片域名与 API 镜像同源，比第三方公共代理 wsrv.nl 更快更稳定
   */
  _normalizeImageUrl(url) {
    if (!url) return '';
    let normalized = String(url).trim();
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;
    normalized = normalized.replace(/^http:\/\/lain\.bgm\.tv/i, 'https://lain.bgm.tv');
    normalized = normalized.replace(/^http:\/\/(lain\.bangumi\.lol|bgmimg\.anibt\.net)/i, 'https://$1');
    // 配置了镜像且镜像不是官方 api.bgm.tv 时，lain.bgm.tv 图片改写到镜像对应的图片域名
    if (this.baseUrl && this.baseUrl !== 'https://api.bgm.tv') {
      if (/^https:\/\/lain\.bgm\.tv/i.test(normalized)) {
        const imageHost = this._imageMirrorForApiMirror(this.baseUrl) || 'lain.bgm.tv';
        normalized = normalized.replace(/^https:\/\/lain\.bgm\.tv/i, `https://${imageHost}`);
      }
    }
    return normalized;
  }

  /**
   * 根据当前 API 镜像返回对应的图片镜像域名。
   * 各镜像站的 API 域名和图片域名通常配套：
   *   bgmapi.anibt.net  → bgmimg.anibt.net
   *   api.bangumi.lol   → lain.bangumi.lol
   *   api.bangumi.one   → lain.bangumi.lol（同一套镜像）
   */
  _imageMirrorForApiMirror(apiBase) {
    const map = {
      'https://bgmapi.anibt.net': 'bgmimg.anibt.net',
      'https://api.bangumi.lol': 'lain.bangumi.lol',
      'https://api.bangumi.one': 'lain.bangumi.lol'
    };
    return map[apiBase] || '';
  }

  // ── 缓存辅助（复用 AnimeDatabase 的 cms_cache 表，键加 bangumi: 前缀避免冲突）──

  _readCache(key) {
    if (!this.db) return null;
    try {
      return this.db.getCache(key);
    } catch (e) {
      console.error('[BangumiApi] 读取缓存失败:', e.message);
      return null;
    }
  }

  _writeCache(key, kind, content, ttl) {
    if (!this.db) return;
    try {
      this.db.setCache(key, 'bangumi', kind, content, ttl);
    } catch (e) {
      console.error('[BangumiApi] 写入缓存失败:', e.message);
    }
  }

  /**
   * 发起 HTTP 请求并解析 JSON
   */
  async request(url, options = {}) {
    const candidates = this._buildApiCandidates(url, options);
    let lastError = null;

    for (const candidate of candidates) {
      const base = this._baseOfUrl(candidate);
      const startedAt = Date.now();
      try {
        const requestOptions = { ...options };
        if (
          candidates.length > 1 &&
          candidate !== candidates[candidates.length - 1] &&
          base === this.defaultBaseUrl &&
          !this.http.proxy
        ) {
          requestOptions.timeout = Math.min(Number(options.timeout) || this.timeout, 4500);
        }
        const data = await this._withBaseProbe(base, async () => {
          const text = await this.http.fetch(candidate, requestOptions);
          try {
            return JSON.parse(text);
          } catch (e) {
            throw new Error(`JSON解析失败: ${e.message}`);
          }
        });
        this._markBaseSuccess(base, Date.now() - startedAt);
        if (candidate !== url && base) {
          const mirrorChanged = this._preferredMirrorBase !== base;
          this._preferredMirrorBase = base;
          if (mirrorChanged) {
            console.warn(`[BangumiApi] 官方 API 不可用，已使用镜像: ${base}`);
          }
        }
        return data;
      } catch (e) {
        lastError = e;
        const skippedBySharedProbe = e?.code === 'BANGUMI_BASE_UNAVAILABLE';
        if (!skippedBySharedProbe) {
          this._markBaseFailure(base);
        }
        if (!skippedBySharedProbe && candidate !== candidates[candidates.length - 1]) {
          console.warn(`[BangumiApi] 请求失败，尝试备用 API: ${candidate} -> ${e.message}`);
        }
      }
    }

    throw lastError || new Error('Bangumi 请求失败');
  }

  _normalizeWebUrl(url) {
    if (!url) return '';
    return String(url).replace(/^http:\/\/bgm\.tv/i, 'https://bgm.tv');
  }

  _weekdayLabel(weekday, fallback = '') {
    if (!weekday) return fallback;
    if (typeof weekday === 'string') return weekday;
    return weekday.cn || weekday.en || fallback;
  }

  /**
   * 获取当前季度的番剧列表 (Calendar API)
   * 返回: 按星期分组的新番列表
   * 策略：有效缓存 → 返回；请求失败 → 用过期缓存兜底；无缓存 → 重试一次后抛错
   */
  async getCalendar() {
    const cacheKey = 'bangumi:calendar';
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/calendar`;
    console.log(`[BangumiApi] 请求季度番剧: ${url}`);

    // 最多重试 2 次
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await this.request(url);
        if (Array.isArray(data) && data.length > 0) {
          this._writeCache(cacheKey, 'list', data, this.CALENDAR_CACHE_TTL);
          return data;
        }
        throw new Error('返回数据为空或格式异常');
      } catch (e) {
        lastError = e;
        console.warn(`[BangumiApi] 请求季度番剧失败(第${attempt}次): ${e.message}`);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1500)); // 间隔 1.5s 重试
        }
      }
    }

    // 全部失败：尝试用过期缓存兜底
    if (this.db) {
      const fallback = this.db.getCacheAny(cacheKey);
      if (fallback && fallback.content) {
        console.warn(`[BangumiApi] 网络失败，使用${fallback.expired ? '过期' : ''}缓存兜底季度番剧`);
        return fallback.content;
      }
    }
    throw lastError || new Error('获取季度番剧失败');
  }

  /**
   * 获取按星期分组的新番时间表（标准化格式，适合前端按 tab 展示）
   */
  async getSchedule() {
    const calendar = await this.getCalendar();
    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    return calendar.map((day, index) => {
      const weekday = day.weekday || weekdayNames[index];
      return {
        weekday: {
          en: weekday.en || weekday,
          cn: weekday.cn || weekdayNames[index] || weekday,
          id: weekday.id || index
        },
        items: (day.items || []).map(item => this._normalizeItem(item, weekday.cn || weekdayNames[index]))
      };
    });
  }

  /**
   * 获取所有季度番剧（扁平化列表）
   * 用于展示动漫网格
   */
  async getAllAnime() {
    const calendar = await this.getCalendar();
    
    const animeList = [];
    const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    
    calendar.forEach((day, index) => {
      day.items.forEach(item => {
        animeList.push(this._normalizeItem(item, day.weekday || weekdayNames[index]));
      });
    });
    
    return animeList;
  }

  /**
   * 搜索番剧
   * 注意: Bangumi 搜索 API 需要特殊格式
   */
  async search(keyword, page = 1) {
    const offset = (page - 1) * 20;
    const cacheKey = `bangumi:search:${String(keyword || '').trim().toLowerCase()}:${page}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/v0/search/subjects?limit=20&offset=${offset}`;
    console.log(`[BangumiApi] 搜索: ${url}`);

    try {
      const data = await this.request(url, {
        method: 'POST',
        body: {
          keyword,
          sort: 'match',
          filter: {
            type: [2]
          }
        }
      });

      const allItems = (data.data || []).map(item => this._normalizeItem(item));
      // Bangumi 搜索 API 服务端会对关键词分词后做 OR 匹配，
      // 导致搜索"一个"会返回"一起"等不包含完整关键词的结果。
      // 这里对返回结果做二次过滤，只保留标题/原名/别名中真正包含完整关键词的结果。
      const filteredItems = this._filterByKeyword(allItems, keyword);

      const result = {
        data: filteredItems,
        total: data.total || 0,
        page,
        totalPages: Math.ceil((data.total || 0) / 20) || 1
      };
      this._writeCache(cacheKey, 'search', result, 30 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[BangumiApi] 搜索失败:', err);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return { ...fallback.content, _fromExpiredCache: true, error: err.message };
        }
      }
      return { data: [], total: 0, error: err.message };
    }
  }

  /**
   * 按关键词二次过滤搜索结果。
   * 检查 name、name_raw、aliases 中是否至少有一个包含完整的搜索关键词。
   * 空关键词或单字符不过滤（单字符 Bangumi 已能合理匹配）。
   */
  _filterByKeyword(items, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw || kw.length < 2) return items;
    return items.filter(item => {
      if (String(item.name || '').toLowerCase().includes(kw)) return true;
      if (String(item.name_raw || '').toLowerCase().includes(kw)) return true;
      const aliases = Array.isArray(item.aliases) ? item.aliases : [];
      return aliases.some(alias => String(alias || '').toLowerCase().includes(kw));
    });
  }

  /**
   * 按季度获取番剧列表（支持历史季度 + 分页）
   * 利用 v0 搜索 API 的 air_date 过滤，按播出日期范围筛选
   * @param {number} year - 年份，如 2025
   * @param {number} season - 季度序号: 1=冬(1-3月) 2=春(4-6月) 3=夏(7-9月) 4=秋(10-12月)
   * @param {number} page - 页码，从 1 开始
   */
  async getSeasonAnime(year, season, page = 1) {
    const limit = 24;
    const offset = (page - 1) * limit;

    // 季度对应的月份范围
    const seasonMonths = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };
    const [startMonth, endMonth] = seasonMonths[season] || [1, 12];
    const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`;
    // 月份末尾日期
    const endDay = new Date(year, endMonth, 0).getDate();
    const endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

    const cacheKey = `bangumi:season:${year}:${season}:${page}`;
    const cached = this._readCache(cacheKey);
    if (cached) {
      return { ...cached, _fromCache: true };
    }

    const url = `${this.baseUrl}/v0/search/subjects?limit=${limit}&offset=${offset}`;
    console.log(`[BangumiApi] 获取季度番剧: ${year}年第${season}季度, ${url}`);

    try {
      const data = await this.request(url, {
        method: 'POST',
        body: {
          keyword: '',
          sort: 'rank',
          filter: {
            type: [2],
            air_date: [`>=${startDate}`, `<=${endDate}`]
          }
        }
      });

      const result = {
        data: (data.data || []).map(item => this._normalizeItem(item)),
        total: data.total || 0,
        page,
        totalPages: Math.ceil((data.total || 0) / limit) || 1,
        year,
        season
      };

      // 季度番剧缓存 30 分钟（历史季度数据不变，缓存可更长）
      this._writeCache(cacheKey, 'season', result, 30 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[BangumiApi] 获取季度番剧失败:', err);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return { ...fallback.content, _fromExpiredCache: true, error: err.message };
        }
      }
      return { data: [], total: 0, page, totalPages: 0, year, season, error: err.message };
    }
  }

  /**
   * 获取番剧详情
   */
  async getDetail(bgmId) {
    const cacheKey = `bangumi:detail:${bgmId}`;
    const cached = this._readCache(cacheKey);
    if (cached) return { ...cached, cover: this._normalizeImageUrl(cached.cover), url: this._normalizeWebUrl(cached.url) };

    const url = `${this.baseUrl}/v0/subjects/${bgmId}`;
    console.log(`[BangumiApi] 获取详情: ${url}`);

    try {
      let data;
      try {
        data = await this.request(url);
      } catch (err) {
        console.error('[BangumiApi] v0 详情失败，尝试旧接口:', err.message);
        data = await this.request(`${this.baseUrl}/subject/${bgmId}`);
      }
      const detail = this._normalizeDetail(data);
      if (detail && detail.name) {
        this._writeCache(cacheKey, 'detail', detail, this.DETAIL_CACHE_TTL);
      }
      return detail;
    } catch (err) {
      console.error('[BangumiApi] 获取详情失败:', err);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return {
            ...fallback.content,
            cover: this._normalizeImageUrl(fallback.content.cover),
            url: this._normalizeWebUrl(fallback.content.url),
            _fromExpiredCache: true
          };
        }
      }
      throw err;
    }
  }

  /**
   * 获取番剧已更新集数（基于 /v0/episodes 本篇剧集的 airdate 统计）
   * 用于列表页显示"更新至X集"，比资源站搜索更权威且不消耗限流预算。
   * 缓存 24 小时（集数开播日期稳定，日更番每天最多变一次）。
   * 返回: { count, planned, total } 或 null（请求失败）
   */
  async getAiredEpisodeCount(bgmId) {
    if (!bgmId) return null;
    const cacheKey = `bangumi:aired-eps:v2:${bgmId}`;
    const cached = this._readCache(cacheKey);
    if (cached) {
      console.log(`[BangumiApi] 已更新集数命中缓存(bgmId=${bgmId}):`, cached.count);
      return cached;
    }

    const url = `${this.baseUrl}/v0/episodes?subject_id=${bgmId}&type=0&limit=200`;
    console.log(`[BangumiApi] 获取已更新集数: ${url}`);
    try {
      const data = await this.request(url);
      const episodes = Array.isArray(data?.data) ? data.data : [];
      const today = new Date();
      const todayKey = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      let count = 0;
      let hasAnyAirdate = false;
      for (const ep of episodes) {
        const airDate = String(ep?.airdate || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(airDate)) continue;
        hasAnyAirdate = true;
        const ts = new Date(`${airDate}T00:00:00`).getTime();
        if (Number.isFinite(ts) && ts <= todayKey) count += 1;
      }
      // Bangumi 数据库中很多条目的 episode 未维护 airdate（全空字符串）。
      // 此时无法按日期判断已更新集数，但既然 episode 记录已存在，说明已更新到这些集数，
      // 直接用 episode 列表总数作为已更新集数。
      if (!hasAnyAirdate && episodes.length > 0) {
        count = episodes.length;
      }
      const result = {
        count,
        planned: episodes.length || count,
        total: data?.total || episodes.length || 0
      };
      this._writeCache(cacheKey, 'aired-eps', result, 24 * 60 * 60 * 1000);
      return result;
    } catch (err) {
      console.warn(`[BangumiApi] 获取已更新集数失败(bgmId=${bgmId}):`, err.message);
      return null;
    }
  }

  /**
   * 获取番剧角色（含声优）
   * GET /v0/subjects/{id}/characters
   * 返回: [{ id, name, name_cn, type, relation, images, actors: [{id, name, name_cn, images}] }]
   */
  async getCharacters(bgmId) {
    const cacheKey = `bangumi:characters:${bgmId}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/v0/subjects/${bgmId}/characters`;
    console.log(`[BangumiApi] 获取角色: ${url}`);

    try {
      const data = await this.request(url);
      if (!Array.isArray(data)) return [];

      const result = data
        .filter(item => item.type === 1) // 1=角色
        .map(item => ({
          id: item.id,
          name: item.name,
          name_cn: item.name_cn || '',
          relation: item.relation, // 1=主角 2=配角 3=客串
          images: this._normalizeImageUrl(item.images?.large || item.images?.medium || ''),
          actors: (item.actors || []).map(a => ({
            id: a.id,
            name: a.name,
            name_cn: a.name_cn || '',
            images: this._normalizeImageUrl(a.images?.large || a.images?.medium || '')
          }))
        }));

      // 缓存 1 小时（角色数据稳定）
      this._writeCache(cacheKey, 'characters', result, 60 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[BangumiApi] 获取角色失败:', err);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) return fallback.content;
      }
      return [];
    }
  }

  /**
   * 获取制作人员（导演/编剧/音乐等）
   * GET /v0/subjects/{id}/persons
   * 返回: [{ id, name, name_cn, images, positions: ['导演', '脚本', ...], type_cn }]
   */
  async getStaff(bgmId) {
    const cacheKey = `bangumi:staff:${bgmId}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/v0/subjects/${bgmId}/persons`;
    console.log(`[BangumiApi] 获取制作人员: ${url}`);

    try {
      const data = await this.request(url);
      if (!Array.isArray(data)) return [];

      const result = data.map(item => ({
        id: item.id,
        name: item.name,
        name_cn: item.name_cn || '',
        images: this._normalizeImageUrl(item.images?.large || item.images?.medium || ''),
        positions: (item.positions || []).map(p => p.cn || p.name || '').filter(Boolean),
        type_cn: (item.positions?.[0]?.type?.cn) || ''
      }));

      this._writeCache(cacheKey, 'staff', result, 60 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[BangumiApi] 获取制作人员失败:', err);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) return fallback.content;
      }
      return [];
    }
  }

  /**
   * 获取番剧短评（吐槽）
   * Bangumi v0 API 无此端点，改从网页版抓取 HTML 解析
   * URL: https://bgm.tv/subject/{id}/comments?page={page}
   * 返回: { data: [...], total, page, totalPages }
   */
  async getComments(bgmId, page = 1) {
    const limit = 20;
    const cacheKey = `bangumi:comments:${bgmId}:${page}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const urls = this._unique(this.webMirrors.map(base => `${base}/subject/${bgmId}/comments?page=${page}`));
    console.log(`[BangumiApi] 获取短评(HTML): ${urls[0]}`);

    try {
      let comments = [];
      let lastError = null;
      for (const url of urls) {
        try {
          const html = await this.http.fetch(url, {
            headers: { 'Accept': 'text/html,application/xhtml+xml' },
            referer: 'https://bgm.tv'
          });
          comments = this._parseCommentsHtml(html);
          if (comments.length > 0 || html.includes('id="comment_box"')) break;
          throw new Error('吐槽页结构异常或被拦截');
        } catch (error) {
          lastError = error;
          console.warn(`[BangumiApi] 短评源失败，尝试下一个: ${url} -> ${error.message}`);
        }
      }

      if (comments.length === 0 && lastError) {
        throw lastError;
      }

      const result = {
        data: comments,
        total: comments.length, // 网页版不返回 total，用当前页条数近似
        page,
        totalPages: comments.length < limit ? page : page + 1
      };

      this._writeCache(cacheKey, 'comments', result, 10 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[BangumiApi] 获取短评失败:', err);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return { ...fallback.content, _fromExpiredCache: true, error: err.message };
        }
      }
      return { data: [], total: 0, page, totalPages: 0, error: err.message };
    }
  }

  /**
   * 解析 Bangumi 网页版吐槽页 HTML
   * 结构: #comment_box 下多个 .item，每个含 .avatar img、.inner .text、.user_info a
   */
  _parseCommentsHtml(html) {
    if (!html || typeof html !== 'string') return [];
    const comments = [];
    const itemRegex = /<div[^>]*class="[^"]*\bitem\b[^"]*\bclearit\b[^"]*"[^>]*>/g;
    const starts = [];
    let match;
    while ((match = itemRegex.exec(html)) !== null) starts.push(match.index);

    starts.forEach((start, index) => {
      const boxEnd = html.indexOf('</div><!-- #comment_box -->', start);
      const end = starts[index + 1] || (boxEnd >= 0 ? boxEnd : html.length);
      const block = html.slice(start, end);
      const userMatch = block.match(/<a[^>]*href="\/user\/([^"/]+)"[^>]*class="[^"]*\bl\b[^"]*"[^>]*>([\s\S]*?)<\/a>/)
        || block.match(/<a[^>]*class="[^"]*\bl\b[^"]*"[^>]*href="\/user\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/)
        || block.match(/<a[^>]*href="\/user\/([^"/]+)"[^>]*>([\s\S]*?)<\/a>/);
      const avatarMatch = block.match(/background-image:\s*url\((['"]?)(.*?)\1\)/i)
        || block.match(/<img[^>]*src="([^"]+)"/i);
      const textMatch = block.match(/<p[^>]*class="[^"]*\bcomment\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const timeMatch = block.match(/<small[^>]*class="[^"]*grey[^"]*"[^>]*>\s*@\s*([\s\S]*?)<\/small>/i);
      const rateMatch = block.match(/\bstars(\d+)\b/i);
      const comment = this._stripHtml(textMatch ? textMatch[1] : '').trim();
      const username = userMatch ? userMatch[1] : '';
      const nickname = userMatch ? this._stripHtml(userMatch[2]).trim() : '';

      if (!comment && !username && !nickname) return;
      comments.push({
        id: comments.length + 1,
        comment,
        rate: rateMatch ? parseInt(rateMatch[1], 10) : 0,
        user: {
          id: null,
          username,
          nickname,
          avatar: this._normalizeImageUrl(avatarMatch ? (avatarMatch[2] || avatarMatch[1]) : '')
        },
        updated_at: timeMatch ? this._stripHtml(timeMatch[1]).replace(/\s+/g, ' ').trim() : ''
      });
    });

    if (comments.length === 0) {
      const legacyRegex = /<p[^>]*class="[^"]*\bcomment\b[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
      while ((match = legacyRegex.exec(html)) !== null) {
        comments.push({
          id: comments.length + 1,
          comment: this._stripHtml(match[1]).trim(),
          rate: 0,
          user: { id: null, username: '', nickname: 'Bangumi 用户', avatar: '' },
          updated_at: ''
        });
      }
    }

    console.log(`[BangumiApi] 短评解析完成: ${comments.length} 条`);
    return comments;
  }

  _stripHtml(str) {
    return String(str || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }

  _isEpisodeAired(episode) {
    const airDate = String(episode?.airdate || episode?.air_date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(airDate)) return false;
    const date = new Date(`${airDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) return false;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return date <= today;
  }

  _countAiredEpisodes(episodes) {
    if (!Array.isArray(episodes)) return 0;
    return episodes.reduce((count, episode) => count + (this._isEpisodeAired(episode) ? 1 : 0), 0);
  }

  /**
   * 标准化列表条目
   */
  _normalizeItem(item, weekday = '') {
    // 处理 Calendar API 和 Search API 不同的字段
    const name = item.name_cn || item.name || '未知';
    const cover = this._normalizeImageUrl(item.images?.large || item.images?.medium || item.images?.common || item.images?.grid || '');
    const rating = item.rating?.score || item.score || 0;
    const rank = item.rating?.rank || item.rank || 0;
    const airDate = item.air_date || item.date || '';
    const weekdayLabel = this._weekdayLabel(weekday);
    const tags = Array.isArray(item.tags)
      ? item.tags.map(tag => typeof tag === 'string' ? tag : tag.name).filter(Boolean)
      : [];
    const listedEpisodeCount = Array.isArray(item.eps) ? item.eps.length : item.eps;
    const plannedEpisodeCount = Number(item.total_episodes || listedEpisodeCount || 0) || 0;
    const airedEpisodeCount = this._countAiredEpisodes(item.eps);
    
    return {
      id: `bangumi_${item.id}`,
      bgm_id: item.id,
      name: name,
      name_raw: item.name || '',
      nameRaw: item.name || '',
      aliases: extractSubjectAliases(item),
      cover: cover,
      type: ['动漫'],
      year: airDate ? airDate.split('-')[0] : '',
      area: item.platform || '',
      intro: item.summary || item.short_summary || '',
      remarks: weekdayLabel ? `${weekdayLabel}更新` : (item.air_weekday ? `周${['日','一','二','三','四','五','六'][item.air_weekday - 1]}更新` : ''),
      episode_count: plannedEpisodeCount,
      planned_episode_count: plannedEpisodeCount,
      total_episode_count: plannedEpisodeCount,
      aired_episode_count: airedEpisodeCount,
      rating: rating,
      rank: rank,
      votes: item.rating?.total || item.collection_total || 0,
      url: this._normalizeWebUrl(item.url || `https://bgm.tv/subject/${item.id}`),
      air_date: airDate,
      air_weekday: item.air_weekday || 0,
      week_day_cn: weekdayLabel,
      tags,
      platform: item.platform || '',
      collection_total: item.collection_total || 0,
      source: 'bangumi'
    };
  }

  /**
   * 标准化详情数据
   */
  _normalizeDetail(item) {
    const episodes = {};
    const name = item.name_cn || item.name || '未知';
    const airDate = item.air_date || item.date || '';
    
    // 如果有 Episodes 数据
    if (item.eps && item.eps.length > 0) {
      episodes['line_1'] = item.eps.map((ep, index) => ({
        id: `bangumi_eps_${ep.id || index}`,
        title: ep.name_cn || ep.name || `第${ep.sort || index + 1}集`,
        episode_number: ep.sort || index + 1,
        air_date: ep.airdate || '',
        url: ep.url || ''
      }));
      episodes['line_1']._lineName = '官方分集';
    }
    
    const listedEpisodeCount = Array.isArray(item.eps) ? item.eps.length : item.eps;
    const plannedEpisodeCount = Number(item.total_episodes || listedEpisodeCount || 0) || 0;
    const airedEpisodeCount = this._countAiredEpisodes(item.eps);

    return {
      id: `bangumi_${item.id}`,
      bgm_id: item.id,
      name: name,
      name_raw: item.name || '',
      nameRaw: item.name || '',
      aliases: extractSubjectAliases(item),
      cover: this._normalizeImageUrl(item.images?.large || item.images?.medium || item.images?.common || item.images?.grid || ''),
      type: ['动漫'],
      year: airDate ? airDate.split('-')[0] : '',
      area: item.platform || '',
      intro: item.summary || '',
      actor: this._formatPersons(item.crt || []),
      director: this._formatPersons(item.directors || []),
      rating: item.rating?.score || 0,
      // 评分分布：{ 1: count, 2: count, ..., 10: count }，total 为总评分人数
      rating_total: item.rating?.total || 0,
      rating_histogram: item.rating?.count || {},
      rank: item.rank || 0,
      url: this._normalizeWebUrl(item.url || `https://bgm.tv/subject/${item.id}`),
      episodes: episodes,
      official_episodes: episodes.line_1 || [],
      episode_count: plannedEpisodeCount,
      planned_episode_count: plannedEpisodeCount,
      total_episode_count: plannedEpisodeCount,
      aired_episode_count: airedEpisodeCount,
      // 额外信息
      tags: item.tags?.map(t => t.name) || [],
      // 带 count 的 tags 列表（用于详情页展示标签热度）
      tags_with_count: (item.tags || []).map(t => ({ name: t.name || '', count: t.count || 0 })),
      // 收藏统计：{ wish, collect, doing, on_hold, dropped }
      collection: item.collection || {},
      // Bangumi 平台信息
      platform: item.platform || '',
      infobox: Array.isArray(item.infobox) ? item.infobox : [],
      _raw: item // 保留原始数据
    };
  }

  /**
   * 格式化人物列表
   */
  _formatPersons(persons) {
    if (!persons || !Array.isArray(persons)) return '';
    return persons.map(p => p.name || p.id || '').filter(Boolean).join(', ');
  }

  /**
   * 测试 API 连通性
   */
  async test() {
    try {
      const data = await this.request(`${this.baseUrl}/calendar`);
      return {
        ok: Array.isArray(data) && data.length > 0,
        total: data.reduce ? data.reduce((sum, day) => sum + day.items.length, 0) : 0
      };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  }
}

module.exports = new BangumiApi();
module.exports.BangumiApi = BangumiApi;
