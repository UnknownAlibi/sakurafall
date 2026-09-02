/**
 * SubjectService — Bangumi 资料主干服务
 *
 * 职责：
 * 1. 封装 BangumiApi，对外提供标准化的 SubjectSummary / SubjectDetail 数据模型
 * 2. 统一缓存读写与过期缓存兜底（网络失败时已缓存内容仍可见）
 * 3. 作为 SourceSearchService / PlaybackResolver 的聚合键来源（bgm_id）
 *
 * 数据模型参见 docs/desktop-modernization-plan.md 第 5 节。
 */

const bangumiApi = require('./BangumiApi');
// 备用元数据源：Bangumi 不可达时自动回退
const anilistProvider = require('./AniListProvider');
// P0：本地索引服务（fire-and-forget 写入，不阻塞主流程）
const subjectIndexService = require('./SubjectIndexService');
const {
  isSubjectCatalogEligible,
  subjectReleaseState
} = require('./SubjectCatalogPolicy');

// AniList ID 标识：'anilist:123' / 'anilist_123'
function parseAniListId(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/^anilist(?::|_)(\d+)$/i);
  return match ? Number(match[1]) : null;
}

class SubjectService {
  constructor() {
    // 内存缓存：name → bgm_id 映射（避免重复 subjectSearch）
    this._nameToBgmIdCache = new Map();
    // 内存缓存：bgm_id → SubjectDetail（避免重复 subjectDetail）
    this._detailCache = new Map();
    this._detailCacheTTL = 30 * 60 * 1000; // 30 分钟
    this._memoryCache = new Map();
    this._memoryCacheMax = 200;
    this._releasedCatalogScans = new Map();
    this._releasedCatalogScanMax = 12;
    this._browseCollectionInflight = new Map();
    this._catalogScopeTotals = new Map();
  }

  /**
   * 将 SubjectSummary 列表 fire-and-forget 写入本地索引（不阻塞返回）
   * 失败忽略，不影响主流程
   */
  _indexUpsert(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    Promise.resolve(subjectIndexService.upsertSubjects(items)).catch(() => {});
  }

  /**
   * 将单个详情 fire-and-forget 写入本地索引
   */
  _indexUpsertDetail(detail) {
    if (!detail) return;
    Promise.resolve(subjectIndexService.upsertDetail(detail)).catch(() => {});
  }

  setDatabase(db) {
    this.db = db;
    bangumiApi.setDatabase(db);
    anilistProvider.setDatabase(db);
  }

  setProxy(proxyUrl) {
    bangumiApi.setProxy(proxyUrl);
    anilistProvider.setProxy(proxyUrl);
  }

  setBangumiMirror(url) {
    bangumiApi.setBaseUrl(url);
  }

  setTimeout(timeout) {
    bangumiApi.setTimeout(timeout);
    anilistProvider.setTimeout(timeout);
  }

  /**
   * 获取热门番剧。公开 API 暂无 trending 排序，直接从带缓存的
   * calendar 数据按评分派生，避免请求不稳定的私有 Next API。
   */
  async getTrendingSubjects({ limit = 12 } = {}) {
    try {
      const schedule = await bangumiApi.getSchedule();
      const all = [];
      schedule.forEach(day => {
        (day.items || []).forEach(item => {
          if (item.rating && item.rating > 0) all.push(item);
        });
      });
      all.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (a.rank || 999) - (b.rank || 999));
      const items = all.slice(0, limit).map(item => this._toSubjectSummary(item));
      this._indexUpsert(items);
      return items;
    } catch (err) {
      // Bangumi 不可达：回退 AniList 热门榜
      console.warn('[SubjectService] 获取热门番剧失败，回退 AniList:', err.message);
      const fallback = await anilistProvider.getTrending(limit);
      return (fallback || []).map(item => this._toSubjectSummary(item));
    }
  }

  /**
   * 获取新番时间表（按星期分组）
   * 直接复用 BangumiApi.getSchedule，但标准化为 SubjectSummary
   */
  async getCalendar() {
    const schedule = await bangumiApi.getSchedule();
    const result = schedule.map(day => ({
      weekday: day.weekday,
      items: (day.items || []).map(item => this._toSubjectSummary(item))
    }));
    // 写入本地索引（fire-and-forget）
    const allItems = result.flatMap(day => day.items || []);
    this._indexUpsert(allItems);
    return result;
  }

  /**
   * 获取季度番剧列表
   * Bangumi 失败/无结果时回退 AniList 季度榜单
   */
  async getSeason(year, quarter, page = 1) {
    const result = await bangumiApi.getSeasonAnime(year, quarter, page);
    if (!result.error && (result.data || []).length > 0) {
      const normalized = {
        ...result,
        data: (result.data || []).map(item => this._toSubjectSummary(item))
      };
      this._indexUpsert(normalized.data);
      return normalized;
    }

    // Bangumi 不可达或无数据：回退 AniList 季度
    console.warn('[SubjectService] 获取季度番剧回退 AniList:',
      result.error || 'Bangumi 无数据');
    const fallback = await anilistProvider.getSeasonAnime(year, quarter, page);
    return {
      ...fallback,
      _fallbackSource: 'anilist',
      data: (fallback.data || []).map(item => this._toSubjectSummary(item))
    };
  }

  /**
   * 搜索番剧
   * 命中缓存时直接返回（用于按名称回查 bgm_id 的场景，避免重复网络请求）
   */
  async search(keyword, page = 1) {
    // 第一页精确匹配走缓存（资源站番剧按名称回查 bgm_id 场景）
    if (page === 1 && keyword) {
      const cacheKey = keyword.trim().toLowerCase();
      const cached = this._nameToBgmIdCache.get(cacheKey);
      if (cached && Date.now() < cached.expiry) {
        return cached.result;
      }
    }

    const result = await bangumiApi.search(keyword, page);
    const bangumiOk = !result.error && (result.data || []).length > 0;
    let normalized;
    if (bangumiOk) {
      normalized = {
        ...result,
        data: (result.data || []).map(item => this._toSubjectSummary(item))
      };
      // 写入本地索引（fire-and-forget）
      this._indexUpsert(normalized.data);
    } else {
      // Bangumi 不可达或无匹配：回退 AniList
      console.warn('[SubjectService] 搜索回退 AniList:', result.error || 'Bangumi 无匹配');
      const fallback = await anilistProvider.search(keyword, page);
      normalized = {
        ...fallback,
        _fallbackSource: 'anilist',
        data: (fallback.data || []).map(item => this._toSubjectSummary(item))
      };
      // AniList 条目 bgm_id 为空，不入 Bangumi 本地索引
    }

    // 缓存第一页结果（30 分钟，避免重复搜索同名番剧）
    if (page === 1 && keyword && normalized.data && normalized.data.length > 0) {
      this._nameToBgmIdCache.set(keyword.trim().toLowerCase(), {
        result: normalized,
        expiry: Date.now() + 30 * 60 * 1000
      });
      // 限制内存缓存大小
      if (this._nameToBgmIdCache.size > 500) {
        const firstKey = this._nameToBgmIdCache.keys().next().value;
        this._nameToBgmIdCache.delete(firstKey);
      }
    }

    return normalized;
  }

  /**
   * 浏览 Bangumi 官方条目目录。
   *
   * 用于主列表默认/年份/动画分类（TV、剧场版、OVA、WEB）。
   * 这条路径走 GET /v0/subjects，是官方公开 API 中的“浏览条目”接口；
   * 标签筛选仍走 search，因为 catalog 不支持 tag。
   */
  async catalog({ page = 1, limit = 24, sort = 'rank', year = null, month = null, cat = null, includeFuture = false, refresh = false, staleWhileRevalidate = false } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 24));
    const offset = (safePage - 1) * safeLimit;
    const normalizedSort = ['date', 'score'].includes(sort) ? sort : 'rank';
    const safeYear = year ? parseInt(year, 10) : null;
    const safeMonth = month ? parseInt(month, 10) : null;
    const safeCat = cat !== null && cat !== undefined && cat !== '' ? parseInt(cat, 10) : null;
    const todayKey = this._todayDateKey();
    const releaseScope = includeFuture ? 'all' : `released-${todayKey}`;

    const cacheKey = `bangumi:catalog:v4:${releaseScope}:${normalizedSort}:${safeCat ?? 'all'}:${safeYear || 'all-years'}:${safeMonth || 'all-months'}:${safePage}:${safeLimit}`;
    const cached = refresh ? null : this._readCache(cacheKey);
    if (cached) return cached;
    if (!refresh && staleWhileRevalidate) {
      const stale = this._readAnyCache(cacheKey);
      if (stale && stale.content) {
        return {
          ...stale.content,
          _fromExpiredCache: stale.expired,
          _staleWhileRevalidate: true
        };
      }
    }

    try {
      const pageData = includeFuture
        ? await this._requestCatalogPage({
            sort: normalizedSort,
            limit: safeLimit,
            offset,
            year: safeYear,
            month: safeMonth,
            cat: safeCat
          })
        : await this._collectReleasedCatalogPage({
            page: safePage,
            limit: safeLimit,
            sort: normalizedSort,
            year: safeYear,
            month: safeMonth,
            cat: safeCat,
            todayKey,
            reset: refresh
          });

      const scopeTotal = normalizedSort === 'score'
        ? await this._getCatalogScopeTotal({
          year: safeYear,
          month: safeMonth,
          cat: safeCat,
          fallback: pageData.total || 0,
          refresh
        })
        : (pageData.total || 0);
      const result = {
        data: pageData.data || [],
        total: scopeTotal,
        page: safePage,
        totalPages: Math.ceil(scopeTotal / safeLimit) || 1,
        sort: normalizedSort,
        year: safeYear,
        month: safeMonth,
        cat: Number.isFinite(safeCat) ? safeCat : null,
        includeFuture: !!includeFuture,
        releaseDate: includeFuture ? null : todayKey,
        futureFiltered: !includeFuture,
        skippedFuture: pageData.skippedFuture || 0,
        // offset 超过 Bangumi API 限制（10000），数据无法获取
        _outOfRange: !!pageData.outOfRange
      };

      this._writeCache(cacheKey, 'catalog', result, safePage === 1 ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
      this._indexUpsert(result.data);
      return result;
    } catch (err) {
      // API 失败时：先尝试过期缓存兜底
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return { ...fallback.content, _fromExpiredCache: true };
        }
      }
      // 再尝试本地索引兜底（索引数据可能缺少 platform/area，但聊胜于无）
      const indexed = this._readCatalogPageFromIndex({
        page: safePage,
        limit: safeLimit,
        sort: normalizedSort,
        year: safeYear,
        month: safeMonth,
        cat: safeCat
      });
      if (indexed?.data?.length > 0) {
        return {
          ...indexed,
          includeFuture: false,
          releaseDate: todayKey,
          futureFiltered: true,
          _servedFromIndex: true,
          error: err.message
        };
      }
      return {
        data: [],
        total: 0,
        page: safePage,
        totalPages: 0,
        sort: normalizedSort,
        year: safeYear,
        month: safeMonth,
        cat: Number.isFinite(safeCat) ? safeCat : null,
        includeFuture: !!includeFuture,
        releaseDate: includeFuture ? null : todayKey,
        futureFiltered: !includeFuture,
        error: err.message
      };
    }
  }

  async _requestCatalogPage({ sort, limit, offset, year, month, cat }) {
    // Bangumi /v0/subjects 限制 offset <= 10000，超出返回 400。
    // 超过时直接返回空数据，由调用方决定是否停止扫描。
    const SUBJECTS_MAX_OFFSET = 10000;
    if (offset > SUBJECTS_MAX_OFFSET) {
      return { data: [], total: 0, _outOfRange: true };
    }
    const apiSort = sort === 'score' ? 'rank' : sort;
    const params = new URLSearchParams({
      type: '2',
      sort: apiSort,
      limit: String(limit),
      offset: String(offset)
    });
    if (Number.isFinite(cat)) params.set('cat', String(cat));
    if (year && year >= 1900 && year <= 2100) params.set('year', String(year));
    if (month && month >= 1 && month <= 12) params.set('month', String(month));

    const url = `${bangumiApi.baseUrl}/v0/subjects?${params.toString()}`;
    const data = await bangumiApi.request(url);
    return {
      data: (data.data || []).map(item => {
        const normalized = typeof bangumiApi._normalizeItem === 'function'
          ? bangumiApi._normalizeItem(item)
          : item;
        return this._toSubjectSummary(normalized);
      }).filter(Boolean),
      total: data.total || 0
    };
  }

  async _getCatalogScopeTotal({ year, month, cat, fallback = 0, refresh = false }) {
    const key = JSON.stringify([year || 0, month || 0, Number.isFinite(cat) ? cat : 'all']);
    const cached = this._catalogScopeTotals.get(key);
    if (!refresh && cached && cached.expiry > Date.now()) return cached.total;
    try {
      const page = await this._requestCatalogPage({ sort: 'date', limit: 1, offset: 0, year, month, cat });
      const total = Number(page.total) || fallback;
      this._catalogScopeTotals.set(key, { total, expiry: Date.now() + 30 * 60 * 1000 });
      return total;
    } catch (_error) {
      return fallback;
    }
  }

  _catalogPlatform(cat) {
    return ({ 1: 'TV', 2: 'OVA', 3: '剧场版', 5: 'WEB' })[cat] || '';
  }

  _readCatalogPageFromIndex({ page, limit, sort, year, month, cat }) {
    if (!subjectIndexService?.querySubjects) return null;
    const platform = Number.isFinite(cat) ? this._catalogPlatform(cat) : '';
    if (Number.isFinite(cat) && !platform) return null;
    try {
      const result = subjectIndexService.querySubjects({
        year,
        month,
        platform,
        sort: sort === 'date' ? 'latest' : sort === 'score' ? 'rating' : 'rank',
        page,
        pageSize: limit,
        releasedOnly: true,
        requireDated: false,
        requireRated: false
      });
      if (!result?.data?.length) return null;
      return {
        ...result,
        limit,
        totalPages: result.totalPages || Math.ceil((result.total || 0) / limit) || 1,
        sort,
        year,
        month,
        cat: Number.isFinite(cat) ? cat : null
      };
    } catch (_error) {
      return null;
    }
  }

  _readBrowsePageFromIndex({ keyword, userTags, officialMetaTags, year, sort, page, limit }) {
    if (!subjectIndexService?.querySubjects) return null;
    try {
      const indexSort = sort === 'date'
        ? 'latest'
        : sort === 'score'
          ? 'rating'
          : 'popular';
      const result = subjectIndexService.querySubjects({
        keyword,
        tags: userTags,
        platform: officialMetaTags[0] || '',
        year,
        sort: indexSort,
        page,
        pageSize: limit,
        releasedOnly: true,
        requireDated: false,
        requireRated: false
      });
      if (!result?.data?.length) return null;
      return {
        ...result,
        limit,
        totalPages: result.totalPages || Math.ceil((result.total || 0) / limit) || 1,
        tags: userTags,
        metaTags: officialMetaTags,
        year,
        sort,
        releaseDate: this._todayDateKey(),
        futureFiltered: true
      };
    } catch (_error) {
      return null;
    }
  }

  async _collectReleasedCatalogPage({ page, limit, sort, year, month, cat, todayKey, reset = false }) {
    const targetStart = (page - 1) * limit;
    const targetEnd = targetStart + limit;
    const scanLimit = sort === 'date' && !year && !month && !Number.isFinite(cat)
      ? Math.max(limit, 100)
      : Math.max(limit, 50);
    const scan = this._getReleasedCatalogScan({ sort, year, month, cat, todayKey, scanLimit, reset });
    const maxRequests = Math.min(60, Math.max(4, Math.ceil(targetEnd / scanLimit) + 8));
    const batchSize = 4;

    while (
      !scan.reachedEnd &&
      !scan.outOfRange &&
      scan.requestCount < maxRequests &&
      scan.items.length < targetEnd
    ) {
      if (scan.pending) {
        await scan.pending;
        continue;
      }

      const requests = [];
      for (let i = 0; i < batchSize && scan.requestCount < maxRequests; i += 1) {
        requests.push(this._requestCatalogPage({
          sort,
          limit: scanLimit,
          offset: scan.rawOffset,
          year,
          month,
          cat
        }));
        scan.rawOffset += scanLimit;
        scan.requestCount += 1;
      }

      scan.pending = Promise.all(requests);
      let pages;
      try {
        pages = await scan.pending;
      } finally {
        scan.pending = null;
      }

      for (const pageData of pages) {
        if (pageData?._outOfRange) {
          scan.outOfRange = true;
          break;
        }
        scan.total = pageData.total || scan.total;
        const items = pageData.data || [];
        if (items.length === 0) {
          scan.reachedEnd = true;
          break;
        }

        for (const item of items) {
          if (!isSubjectCatalogEligible(item, { todayKey })) {
            scan.skippedFuture += 1;
            continue;
          }
          const id = item?.bgm_id || item?.bgmId || item?.id;
          const key = id ? String(id) : `${item?.name || ''}:${item?.air_date || item?.airDate || ''}`;
          if (scan.seen.has(key)) continue;
          scan.seen.add(key);
          scan.items.push(item);
        }

        if (scan.total && scan.rawOffset >= scan.total) {
          scan.reachedEnd = true;
          break;
        }
      }
    }

    scan.lastUsedAt = Date.now();
    return {
      data: scan.items.slice(targetStart, targetEnd),
      total: scan.total,
      skippedFuture: scan.skippedFuture,
      outOfRange: scan.outOfRange
    };
  }

  _getReleasedCatalogScan({ sort, year, month, cat, todayKey, scanLimit, reset = false }) {
    const key = JSON.stringify([
      todayKey,
      sort,
      year || 0,
      month || 0,
      Number.isFinite(cat) ? cat : 'all',
      scanLimit
    ]);
    if (reset) this._releasedCatalogScans.delete(key);
    const existing = this._releasedCatalogScans.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    if (this._releasedCatalogScans.size >= this._releasedCatalogScanMax) {
      const oldest = [...this._releasedCatalogScans.entries()]
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (oldest) this._releasedCatalogScans.delete(oldest[0]);
    }

    const scan = {
      items: [],
      seen: new Set(),
      total: 0,
      skippedFuture: 0,
      rawOffset: 0,
      requestCount: 0,
      reachedEnd: false,
      outOfRange: false,
      pending: null,
      lastUsedAt: Date.now()
    };
    this._releasedCatalogScans.set(key, scan);
    return scan;
  }

  _isReleasedSubject(item, todayKey = this._todayDateKey()) {
    return subjectReleaseState(item, todayKey).state !== 'future';
  }

  _todayDateKey() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  /**
   * 年份分段：官方/镜像搜索接口对单次查询硬性截断 total=1000。
   * 无年份/关键词筛选时，把查询按年份区间拆成若干段，每段独立计数，
   * 段之和即真实总量，扫描也能覆盖截断窗口之外的数据。
   */
  _browseYearSegments(todayKey) {
    const year = Number(String(todayKey || '').slice(0, 4));
    if (!year) return null;
    return [
      { key: 'early', range: [`<=${year - 25}-12-31`] },
      { key: 'y1', range: [`>=${year - 24}-01-01`, `<=${year - 15}-12-31`] },
      { key: 'y2', range: [`>=${year - 14}-01-01`, `<=${year - 8}-12-31`] },
      { key: 'y3', range: [`>=${year - 7}-01-01`, `<=${year - 3}-12-31`] },
      { key: 'y4', range: [`>=${year - 2}-01-01`, `<=${todayKey}`] }
    ];
  }

  /**
   * date 排序的季度扫描窗口（近 3 年，从当前季度往前）。
   * 窗口间日期互斥且按时间从新到旧排列：逐窗完整扫描后，
   * date 降序分页窗口只会被更老的数据延长，不会被顶掉。
   */
  _browseQuarterWindows(todayKey) {
    const key = String(todayKey || '');
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    if (!year || !month) return [];
    const pad = value => String(value).padStart(2, '0');
    const windows = [];
    let y = year;
    let q = Math.ceil(month / 3);
    for (let i = 0; i < 12; i += 1) {
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = q * 3;
      const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
      const start = `${y}-${pad(startMonth)}-01`;
      const end = `${y}-${pad(endMonth)}-${pad(lastDay)}`;
      if (start <= key) {
        windows.push({
          key: `q${y}q${q}`,
          range: [`>=${start}`, `<=${end < key ? end : key}`]
        });
      }
      q -= 1;
      if (q === 0) {
        q = 4;
        y -= 1;
      }
    }
    return windows;
  }

  /**
   * 年份筛选 + date 排序的季度窗口（指定年份 Q4 → Q1）。
   * 与近 3 年季度窗口同理：互斥 + 从新到旧完整扫描，保证
   * date 分页窗口稳定。当年时 Q4 截断到今天。
   */
  _browseYearQuarterWindows(year, todayKey) {
    const key = String(todayKey || '');
    const todayYear = Number(key.slice(0, 4));
    if (!Number(year) || !todayYear) return [];
    const pad = value => String(value).padStart(2, '0');
    const windows = [];
    for (let q = 4; q >= 1; q -= 1) {
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = q * 3;
      const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
      const start = `${year}-${pad(startMonth)}-01`;
      const end = `${year}-${pad(endMonth)}-${pad(lastDay)}`;
      if (start <= key) {
        windows.push({
          key: `q${year}q${q}`,
          range: [`>=${start}`, `<=${end < key ? end : key}`]
        });
      }
    }
    return windows;
  }

  async _requestBrowsePage({ keyword = '', userTags = [], officialMetaTags = [], year = null, sort = 'score', limit = 50, offset = 0, dateRange = null }) {
    const filter = { type: [2] };
    if (userTags.length > 0) filter.tag = userTags;
    if (officialMetaTags.length > 0) filter.meta_tags = officialMetaTags;
    const todayKey = this._todayDateKey();
    if (Array.isArray(dateRange) && dateRange.length > 0) {
      // 年份分段查询：用显式日期区间替代默认的"上映至今"条件
      filter.air_date = dateRange;
    } else if (year && year >= 1900 && year <= 2100) {
      const yearEnd = `${year}-12-31`;
      filter.air_date = [`>=${year}-01-01`, `<=${yearEnd < todayKey ? yearEnd : todayKey}`];
    } else {
      filter.air_date = [`<=${todayKey}`];
    }

    const url = `${bangumiApi.baseUrl}/v0/search/subjects?limit=${limit}&offset=${offset}`;
    const response = await bangumiApi.request(url, {
      method: 'POST',
      body: { keyword, sort, filter }
    });
    return {
      total: response.total || 0,
      data: (response.data || []).map(item => {
        const normalized = typeof bangumiApi._normalizeItem === 'function'
          ? bangumiApi._normalizeItem(item)
          : item;
        return this._toSubjectSummary(normalized);
      }).filter(Boolean)
    };
  }

  async _getReleasedBrowseCollection({ keyword = '', userTags = [], officialMetaTags = [], year = null, refresh = false, minItems = 24, sortHint = '' }) {
    const todayKey = this._todayDateKey();
    const cacheKey = `bangumi:browse-collection:v11:${todayKey}:${userTags.join(',') || 'all'}:${officialMetaTags.join(',') || 'all-platforms'}:${year || 'all-years'}:${keyword || ''}`;
    const targetCount = Math.max(1, Number(minItems) || 24);
    // 集合缓存永续：refresh 只跳过页面缓存，不丢弃已扫描的集合。
    // 丢弃集合会让一次刷新把几百条的积累退化成一轮扫描，并且整轮
    // 重扫会放大镜像限流风险，把集合误判成“已耗尽”。
    // date 排序的“足够”不是条目总数，而是近期条目数：老经典番再多
    // 也顶不上“最新上映”的语义。年份筛选本身就是有限集合，直接按
    // 总条目数判定。
    const recentCutoff = `${String(todayKey).slice(0, 4) - 7}-01-01`;
    const countRecent = list => (list || []).filter(
      item => String(item?.air_date || '') >= recentCutoff
    ).length;
    // score/rank/heat 视图的“足够”是对应排序的覆盖数而非集合总数：
    // 分页窗口必须完全落在该排序的服务端顺序内（append-only），
    // 否则其他排序扫入的条目会先占窗口、后被增长的覆盖推挤造成重叠。
    // 覆盖数达到该排序真实总数（total 已知）时也视为足够。
    const sortCoverageSufficient = (coverage, totalKnown) => {
      if (coverage >= targetCount) return true;
      return totalKnown > 0 && coverage >= totalKnown;
    };
    const scanCoverageOf = collection => {
      const order = collection?.scanOrders?.[sortHint];
      return Array.isArray(order) ? order.length : 0;
    };
    const isSufficient = collection => {
      if (!collection?.data?.length) return false;
      if (collection.complete) return true;
      if (sortHint === 'date' && !year) return countRecent(collection.data) >= targetCount;
      if (['score', 'rank', 'heat'].includes(sortHint)) {
        return sortCoverageSufficient(
          scanCoverageOf(collection),
          Math.max(0, Number(collection?.sourceTotals?.[sortHint]) || 0)
        );
      }
      return collection.data.length >= targetCount;
    };

    let cached = this._readCache(cacheKey);
    if (isSufficient(cached)) return cached;
    if (!cached) {
      const stale = this._readAnyCache(cacheKey);
      if (stale?.content?.data) cached = stale.content;
    }

    if (this._browseCollectionInflight.has(cacheKey)) {
      const inflight = await this._browseCollectionInflight.get(cacheKey);
      if (isSufficient(inflight)) return inflight;
      cached = inflight;
    }

    const pending = (async () => {
      // Public mirrors commonly cap search pages at 20 even when a larger
      // limit is requested. Using the effective size keeps incremental scans
      // from treating a full mirror page as an exhausted result.
      const requestLimit = 20;
      const sortModes = ['score', 'rank', 'heat'];
      const maxPagesPerSort = 50;
      // 镜像限流的典型表现是 HTTP 200 + 空 data。连续无进展的轮次达到
      // 上限后保留 truncated 状态退出，让下一次请求继续扩扫，而不是
      // 把限流误判成结果耗尽并锁进长时间缓存。
      const maxIdleRounds = 3;
      // 并发分批：8 路齐发容易触发镜像限流（表现为后续页变短/变空），
      // 每批 3 路串行推进，牺牲少量延迟换取扫描稳定性。
      const SCAN_CONCURRENCY = 3;
      // 官方/镜像搜索接口单次查询硬上限：total 截断在 1000。
      const SEARCH_TOTAL_CAP = 1000;
      let idleRounds = 0;
      const items = Array.isArray(cached?.data) ? [...cached.data] : [];
      const seen = new Set(items.map(item => String(
        item.bgm_id || item.bgmId || item.id || `${item.name}:${item.air_date}`
      )));
      // 恢复扫描进度：基础排序 + 年份分段键（score@seg），分段进度丢失会导致重扫。
      const scannedPages = {};
      for (const key of Object.keys(cached?.scannedPages || {})) {
        scannedPages[key] = Math.max(0, Number(cached.scannedPages[key]) || 0);
      }
      for (const sort of sortModes) {
        scannedPages[sort] = Math.max(0, Number(scannedPages[sort]) || 0);
      }
      const sourceTotals = Object.fromEntries(sortModes.map(sort => [
        sort,
        Math.max(0, Number(cached?.sourceTotals?.[sort]) || 0)
      ]));
      const exhausted = new Set(Array.isArray(cached?.exhaustedSorts) ? cached.exhaustedSorts : []);
      const excluded = new Set(Array.isArray(cached?.excludedIds) ? cached.excludedIds : []);
      // 服务端扫描顺序：rank/heat 排序必须保留镜像返回的原始顺序。
      // 本地按评分重排会随集合增长洗牌，分页窗口漂移导致翻页丢条目。
      // Set 保持插入序，恢复缓存时数组 → Set。
      const scanOrders = {};
      for (const key of Object.keys(cached?.scanOrders || {})) {
        scanOrders[key] = new Set(
          (Array.isArray(cached.scanOrders[key]) ? cached.scanOrders[key] : [])
            .map(v => String(v))
        );
      }
      const recordScanOrder = (key, item) => {
        const identity = String(
          item.bgm_id || item.bgmId || item.id || `${item.name}:${item.air_date}`
        );
        if (!scanOrders[key]) scanOrders[key] = new Set();
        scanOrders[key].add(identity);
      };

      // 年份分段状态（仅无年份/关键词筛选时可用）
      const segments = (!year && !keyword) ? this._browseYearSegments(todayKey) : null;
      let segmentTotals = { ...(cached?.segmentTotals || {}) };
      let segmentKeys = Array.isArray(cached?.segmentKeys) ? [...cached.segmentKeys] : [];
      // date 排序优先扫近期分段：基础 score/rank/heat 扫描的前几页几乎
      // 都是老经典番，本地按上映日期排序时新番 2-3 页就耗尽。
      // 年份筛选时同样启用（该年 Q4→Q1 季度窗口），保证 date 分页稳定。
      const dateFirst = sortHint === 'date' && (!!segments || !!year);
      if (dateFirst && !year && segmentKeys.length === 0) {
        // segments 顺序为近期 → 远期，扫描优先覆盖近 2-7 年
        segmentKeys = segments.map(seg => `score@${seg.key}`);
      }
      const segmentProbed = () => !!segments && segments.every(seg => segmentTotals[seg.key] !== undefined);
      const segmentTotalOf = key => {
        const segKey = key.slice(key.indexOf('@') + 1);
        return Math.max(0, Number(segmentTotals[segKey]) || 0);
      };
      // 轻量探测（limit=1）各段真实总数，让首页就显示真实总量而不是截断值。
      // 限流的典型表现是空 data + 高 total，空 data 的探测结果不可信，跳过。
      // force：date 排序走分段/季度窗口优先路径，基础 total 未知，需无条件探测。
      const probeSegments = async (force = false) => {
        const targets = segments || (dateFirst && year ? quarterWindows : null);
        if (!targets) return;
        if (segments && segmentProbed()) return;
        // 只在触顶（total 被截断）或强制时探测：未截断的 total 本来就准确
        if (!force && !sortModes.some(sort => (sourceTotals[sort] || 0) >= SEARCH_TOTAL_CAP)) return;
        await Promise.all(targets
          .filter(seg => segmentTotals[seg.key] === undefined)
          .map(seg => this._requestBrowsePage({
            keyword,
            userTags,
            officialMetaTags,
            year: null,
            sort: 'score',
            limit: 1,
            offset: 0,
            dateRange: seg.range
          }).then(probe => {
            if ((probe.data || []).length > 0) {
              segmentTotals[seg.key] = Math.max(0, Number(probe.total) || 0);
            }
          }).catch(() => {})));
      };
      // date 排序用季度窗口（近期在前）逐窗完整扫描：窗口间日期不重叠，
      // 更老窗口的数据只会延长 date 排序的尾部，不会顶掉已展示条目，
      // 分页窗口因此稳定（不随集合增长漂移导致翻页丢条目）。
      // 年份筛选时用该年 Q4→Q1 窗口（不再附加更老分段）。
      const quarterWindows = dateFirst
        ? (year
          ? this._browseYearQuarterWindows(year, todayKey)
          : this._browseQuarterWindows(todayKey))
        : [];
      if (dateFirst && year) {
        segmentKeys = quarterWindows.map(win => `score@${win.key}`);
      } else if (dateFirst) {
        // y4（近 2 年）已被季度窗口覆盖；y3 及更老的分段补充在季度之后
        const olderSegments = segments
          ? segments.filter(seg => seg.key !== 'y4')
          : [];
        segmentKeys = [
          ...quarterWindows.map(win => `score@${win.key}`),
          ...olderSegments.map(seg => `score@${seg.key}`)
        ];
      }
      // key → dateRange 映射（年份分段 + 季度窗口）
      const windowRanges = {};
      if (segments) {
        for (const seg of segments) windowRanges[`score@${seg.key}`] = seg.range;
      }
      for (const win of quarterWindows) windowRanges[`score@${win.key}`] = win.range;

      // 扫描优先级：date 排序先扫近期分段（新番覆盖），其余先扫基础排序。
      // 年份筛选时季度窗口已覆盖全年，基础排序扫描纯属浪费（结果全重复）。
      const allScanKeys = () => {
        if (dateFirst && year) return [...segmentKeys];
        return dateFirst
          ? [...segmentKeys, ...sortModes]
          : [...sortModes, ...segmentKeys];
      };
      // 进度判定：date 排序按近期条目数（年份筛选按总数）；
      // score/rank/heat 按对应排序自身覆盖数（保证分页窗口 append-only），
      // 该排序 total 已知时以 min(覆盖, total) 为准（扫满即完成）
      const progressCount = () => {
        if (dateFirst && !year) return countRecent(items);
        if (['score', 'rank', 'heat'].includes(sortHint)) {
          const coverage = scanOrders[sortHint] ? scanOrders[sortHint].size : 0;
          const totalKnown = Math.max(0, Number(sourceTotals[sortHint]) || 0);
          return totalKnown > 0 ? Math.min(coverage, totalKnown) : coverage;
        }
        return items.length;
      };

      const requestPageOf = (key, pageIndex) => {
        const atIndex = key.indexOf('@');
        const sort = atIndex === -1 ? key : key.slice(0, atIndex);
        const page = pageIndex !== undefined ? pageIndex : (scannedPages[key] || 0);
        return this._requestBrowsePage({
          keyword,
          userTags,
          officialMetaTags,
          year,
          sort,
          limit: requestLimit,
          offset: page * requestLimit,
          dateRange: windowRanges[key] || null
        });
      };

      // 并发取同一键的相邻两页：镜像单请求 1-2s，并发几乎零成本，
      // 页对预取可将串行往返减半。仅当首页满页时才处理预取页。
      const requestPagePairOf = async key => {
        const base = scannedPages[key] || 0;
        const [first, second] = await Promise.all([
          requestPageOf(key, base),
          requestPageOf(key, base + 1)
        ]);
        const progressed = processPage(key, first);
        if ((first.data || []).length >= requestLimit) {
          if (processPage(key, second)) return true;
        }
        return progressed;
      };

      // 处理一页扫描结果：推进 offset、记录顺序与总数、判耗尽。
      // 返回本页是否有进展（非空页）。空页且远端承诺更多数据时不判耗尽，
      // 留给外层退避重试（镜像限流的典型表现是 HTTP 200 + 空 data）。
      const processPage = (key, page) => {
        const pageItems = page.data || [];
        const pageTotal = Number(page.total) || 0;
        const isSegment = key.includes('@');

        if (pageItems.length === 0) {
          const totalKnown = isSegment
            ? Math.max(pageTotal, segmentTotalOf(key))
            : Math.max(pageTotal, sourceTotals[key]);
          if (totalKnown > 0 && (scannedPages[key] || 0) * requestLimit < totalKnown) {
            return false;
          }
          exhausted.add(key);
          return false;
        }

        scannedPages[key] = (scannedPages[key] || 0) + 1;
        if (isSegment) {
          const segKey = key.slice(key.indexOf('@') + 1);
          segmentTotals[segKey] = Math.max(segmentTotalOf(key), pageTotal);
        } else {
          sourceTotals[key] = Math.max(sourceTotals[key], pageTotal);
        }
        for (const item of pageItems) {
          const identity = String(item.bgm_id || item.bgmId || item.id || `${item.name}:${item.air_date}`);
          if (!isSubjectCatalogEligible(item, { todayKey })) {
            excluded.add(identity);
            continue;
          }
          // 记录服务端顺序（无论是否新条目），rank/heat 展示排序依赖它
          recordScanOrder(key, item);
          if (seen.has(identity)) continue;
          seen.add(identity);
          items.push(item);
        }

        const totalKnown = isSegment ? segmentTotalOf(key) : sourceTotals[key];
        // 短页（不满 requestLimit）只有在 total 可验证扫完时才判耗尽：
        // 镜像限流的典型表现之一就是部分返回，误判耗尽会让扫描永久
        // 停滞（后续页全部退化为存量切片）。不可验证时按空轮退避重试。
        if (pageItems.length < requestLimit) {
          const verifiedEnd = totalKnown <= 0 ||
            scannedPages[key] * requestLimit >= totalKnown;
          if (verifiedEnd || scannedPages[key] >= maxPagesPerSort) {
            exhausted.add(key);
          }
        } else if (
          scannedPages[key] >= maxPagesPerSort ||
          (totalKnown > 0 && scannedPages[key] * requestLimit >= totalKnown)
        ) {
          exhausted.add(key);
        }
        return true;
      };

      // 探测与扫描并发：探测是 limit=1 的轻请求，与扫描页并发
      // 发送几乎零成本（镜像并发远快于串行），省一整个串行往返。
      let probePromise = null;
      const ensureProbes = () => {
        if (!probePromise) {
          probePromise = probeSegments(true).catch(() => {});
        }
        return probePromise;
      };

      if (dateFirst) {
        // date 路径：探测年份分段总数（首页显示真实总量）与窗口扫描并发。
        // 每个季度窗口彻底扫完（各季 20-50 条仅 1-3 页，代价很小）：
        // 窗口部分扫描会在窗口边界产生短页（上一窗口剩余 + 下一窗口
        // 首两页凑不满 24 条），滚动翻页时表现为“一次只加载几条”。
        const probing = ensureProbes();
        for (const key of allScanKeys()) {
          if (progressCount() >= targetCount && key.includes('@')) break;
          if (exhausted.has(key)) continue;
          if (progressCount() >= targetCount && !key.includes('@')) continue;
          let windowIdleRounds = 0;
          while (!exhausted.has(key)) {
            const progressed = await requestPagePairOf(key);
            if (!progressed) {
              windowIdleRounds += 1;
              if (windowIdleRounds >= maxIdleRounds) break;
              await new Promise(resolve => setTimeout(resolve, 700));
              continue;
            }
            windowIdleRounds = 0;
            // 基础排序无需扫满：按服务端顺序覆盖 targetCount 即可
            if (!key.includes('@') && progressCount() >= targetCount) break;
          }
        }
        await probing;
      } else {
        const probing = ensureProbes();
        while (progressCount() < targetCount) {
          let active = allScanKeys().filter(key => !exhausted.has(key));
          // 主导排序（与当前视图一致的 sort）优先独占扫描到目标覆盖：
          // 分页窗口必须完全落在该排序的服务端顺序内；也让其他排序
          // 的数据不提前混入集合（减少无谓请求与翻页推挤）。
          if (['score', 'rank', 'heat'].includes(sortHint) && !exhausted.has(sortHint)) {
            active = [sortHint];
          }
          if (active.length === 0) {
            // 基础排序全部扫完但结果触顶（total 被截断在 1000）：
            // 启用年份分段继续扩扫，绕过单查询上限。
            const capped = sortModes.some(sort => (sourceTotals[sort] || 0) >= SEARCH_TOTAL_CAP);
            if (segments && capped && segmentKeys.length === 0) {
              await probing;
              segmentKeys = segments.map(seg => `score@${seg.key}`);
              continue;
            }
            break;
          }

          let progressed = false;
          if (active.length === 1) {
            // 单键（主导排序独占）：页对预取，串行往返减半
            if (await requestPagePairOf(active[0])) progressed = true;
          } else {
            // 多键分批请求：避免全键并发触发镜像限流
            const pages = new Map();
            for (let i = 0; i < active.length; i += SCAN_CONCURRENCY) {
              const batch = active.slice(i, i + SCAN_CONCURRENCY);
              const results = await Promise.all(batch.map(key => requestPageOf(key)));
              batch.forEach((key, j) => pages.set(key, results[j] || {}));
            }
            active.forEach((key) => {
              if (processPage(key, pages.get(key) || {})) progressed = true;
            });
          }

          idleRounds = progressed ? 0 : idleRounds + 1;
          if (idleRounds >= maxIdleRounds) break;
          // 限流退避：空轮后等待再重试，避免连续快速重试加剧限流
          if (!progressed) {
            await new Promise(resolve => setTimeout(resolve, 700));
          }
        }
        await probing;
      }

      const baseTotal = Math.max(0, ...Object.values(sourceTotals));
      // 只汇总互斥的分段/窗口 total：季度窗口与 y4/y3 重叠不能重复计
      const segmentTotalSum = (segments || quarterWindows).reduce((sum, seg) =>
        sum + (Math.max(0, Number(segmentTotals[seg.key]) || 0)), 0
      ) || 0;
      // 分段之和才是真实总量；探测未完成时退回基础 total（至少不小于已加载）。
      const sourceTotal = Math.max(baseTotal, segmentTotalSum, items.length);
      const eligibleTotal = sourceTotal > 0
        ? Math.max(items.length, sourceTotal - excluded.size)
        : items.length;
      // 触顶（total 截断在 1000）时，只有分段全部扫完才能判定完整；
      // 分段自身触顶则无法证明完整，保持 truncated 让后续请求继续扩扫。
      const capped = sortModes.some(sort => (sourceTotals[sort] || 0) >= SEARCH_TOTAL_CAP);
      const segmentCapped = segmentKeys.some(key => segmentTotalOf(key) >= SEARCH_TOTAL_CAP);
      const allScanned = allScanKeys().length > 0 && allScanKeys().every(key => exhausted.has(key));
      const complete = allScanned && !segmentCapped && (!capped || segmentKeys.length > 0);

      const collection = {
        data: items,
        total: eligibleTotal,
        sourceTotal: eligibleTotal,
        releaseDate: todayKey,
        futureFiltered: true,
        scannedPages,
        sourceTotals,
        segmentTotals,
        segmentKeys,
        // dateFirst 扫描（季度窗口从新到旧）的集合：插入序即 date 降序
        // （季度粒度）。date 排序直接用插入序，任何续扫（限流恢复、
        // 翻页扩扫）只会在尾部追加，分页窗口永不漂移。
        dateOrdered: !!dateFirst,
        // 服务端扫描顺序序列化（key → identity 数组，保持插入序）
        scanOrders: Object.fromEntries(
          Object.entries(scanOrders).map(([key, set]) => [key, [...set]])
        ),
        exhaustedSorts: [...exhausted],
        excludedIds: [...excluded],
        complete,
        truncated: !complete
      };
      // 防御：远端总量明显多于已收集数量时，“耗尽”判定可疑（如镜像
      // 短页限流），只写短缓存，避免残缺集合被锁 24 小时。
      const collectedOrExcluded = items.length + excluded.size;
      const suspicious = complete && sourceTotal > 0 && collectedOrExcluded < sourceTotal * 0.6;
      this._writeCache(cacheKey, 'browse-collection', collection, suspicious ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000);
      this._indexUpsert(items);
      return collection;
    })();

    this._browseCollectionInflight.set(cacheKey, pending);
    try {
      return await pending;
    } catch (error) {
      const stale = this._readAnyCache(cacheKey);
      if (stale?.content?.data) return { ...stale.content, _fromExpiredCache: true };
      throw error;
    } finally {
      this._browseCollectionInflight.delete(cacheKey);
    }
  }

  /**
   * 集合展示排序。
   * - date：上映日期降序（新番在前）
   * - score/rank/heat：保留服务端扫描顺序。本地重排会随集合增长
   *   洗牌，分页窗口漂移导致翻页丢条目；顺序必须 append-only。
   *   score 的服务端顺序即评分降序（权威）；未被该排序扫描覆盖的
   *   条目排在其后（按评分降序，语义安全：从头扫描保证已覆盖
   *   条目评分不低于未覆盖条目）。
   */
  _sortBrowseCollection(collectionOrItems, sort) {
    const collection = Array.isArray(collectionOrItems) ? null : collectionOrItems;
    const data = [...(collection?.data || collectionOrItems || [])];

    if (['score', 'rank', 'heat'].includes(sort)) {
      const order = collection?.scanOrders?.[sort];
      if (Array.isArray(order) && order.length > 0) {
        const positionOf = new Map(order.map((identity, index) => [String(identity), index]));
        const identityOf = item => String(
          item.bgm_id || item.bgmId || item.id || `${item.name}:${item.air_date}`
        );
        const inOrder = [];
        const rest = [];
        for (const item of data) {
          if (positionOf.has(identityOf(item))) inOrder.push(item);
          else rest.push(item);
        }
        inOrder.sort((a, b) => positionOf.get(identityOf(a)) - positionOf.get(identityOf(b)));
        rest.sort((a, b) =>
          (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
          (Number(b.votes) || 0) - (Number(a.votes) || 0) ||
          (Number(a.rank) || Number.MAX_SAFE_INTEGER) - (Number(b.rank) || Number.MAX_SAFE_INTEGER)
        );
        return [...inOrder, ...rest];
      }
    }

    if (sort === 'date') {
      // dateFirst 集合：插入序即 date 降序（季度窗口从新到旧扫入），
      // 直接返回插入序。本地按 air_date 重排会在窗口续扫（限流恢复、
      // 翻页扩扫）时把新条目插进已展示区域，分页窗口漂移产生重复。
      if (collection?.dateOrdered) return data;
      data.sort((a, b) => {
        const dateA = /^\d{4}-\d{2}-\d{2}/.test(String(a.air_date || '')) ? a.air_date : '';
        const dateB = /^\d{4}-\d{2}-\d{2}/.test(String(b.air_date || '')) ? b.air_date : '';
        return dateB.localeCompare(dateA) ||
          (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
          (Number(b.bgm_id) || 0) - (Number(a.bgm_id) || 0);
      });
      return data;
    }

    data.sort((a, b) =>
      (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
      (Number(b.votes) || 0) - (Number(a.votes) || 0) ||
      (Number(a.rank) || Number.MAX_SAFE_INTEGER) - (Number(b.rank) || Number.MAX_SAFE_INTEGER)
    );
    return data;
  }

  /**
   * 按 Bangumi 元标签/排序浏览番剧。
   * 用于首页类型筛选：主页只展示 Bangumi 资料，播放源在详情页再匹配。
   *
   * Bangumi v0 search 使用 tag 做用户标签筛选。meta_tags 仅覆盖少量官方元标签，
   * 用它查询“异世界/搞笑/机甲”等常规类型会得到错误的空结果。
   */
  async browse({ keyword = '', tag = '', tags = [], metaTags = [], sort = 'rank', page = 1, limit = 24, year = null, refresh = false, staleWhileRevalidate = false } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 24));
    const safeYear = year ? parseInt(year, 10) : null;
    const offset = (safePage - 1) * safeLimit;
    const normalizedSort = ['date', 'match', 'heat', 'rank', 'score'].includes(sort) ? sort : 'rank';
    const userTags = Array.from(new Set([
      ...(Array.isArray(tags) ? tags : []),
      ...(tag ? [tag] : [])
    ].map(v => String(v || '').trim()).filter(Boolean)));
    const officialMetaTags = Array.from(new Set(
      (Array.isArray(metaTags) ? metaTags : [])
        .map(v => String(v || '').trim())
        .filter(Boolean)
    ));

    const cacheKey = `bangumi:browse:v11:${normalizedSort}:${userTags.join(',') || 'all'}:${officialMetaTags.join(',') || 'all-platforms'}:${safeYear || 'all-years'}:${keyword || ''}:${safePage}:${safeLimit}`;
    const cached = refresh ? null : this._readCache(cacheKey);
    if (cached) return cached;

    // 年份/标签/平台组合先建立一份共享集合，再分别按日期或评分排序。
    // 本地索引是增量子集，不能用它定义远端筛选的成员或总数。
    const needsSharedCollection = !keyword &&
      (userTags.length > 0 || officialMetaTags.length > 0 || !!safeYear) &&
      ['date', 'score', 'rank', 'heat'].includes(normalizedSort);

    if (!refresh && staleWhileRevalidate) {
      const stale = this._readAnyCache(cacheKey);
      if (stale && stale.content) {
        return {
          ...stale.content,
          _fromExpiredCache: stale.expired,
          _staleWhileRevalidate: true
        };
      }

      if (!needsSharedCollection) {
        const indexed = this._readBrowsePageFromIndex({
          keyword,
          userTags,
          officialMetaTags,
          year: safeYear,
          sort: normalizedSort,
          page: safePage,
          limit: safeLimit
        });
        if (indexed) {
          return {
            ...indexed,
            tag: tag || '',
            _servedFromIndex: true,
            _staleWhileRevalidate: true
          };
        }
      }
    }

    // Bangumi search has no date sort. For the default (unfiltered) view the
    // calendar-fed local index is fast and accurate.
    if (normalizedSort === 'date' && !needsSharedCollection) {
      const indexed = this._readBrowsePageFromIndex({
        keyword,
        userTags,
        officialMetaTags,
        year: safeYear,
        sort: normalizedSort,
        page: safePage,
        limit: safeLimit
      });
      if (indexed) {
        const result = {
          ...indexed,
          tag: tag || '',
          _servedFromIndex: true,
          _indexBackedDateSort: true
        };
        this._writeCache(cacheKey, 'browse', result, 30 * 60 * 1000);
        return result;
      }
    }

    const url = `${bangumiApi.baseUrl}/v0/search/subjects?limit=${safeLimit}&offset=${offset}`;
    const filter = { type: [2] };
    if (userTags.length > 0) filter.tag = userTags;
    if (officialMetaTags.length > 0) filter.meta_tags = officialMetaTags;
    const todayKey = this._todayDateKey();
    if (safeYear && safeYear >= 1900 && safeYear <= 2100) {
      const yearEnd = `${safeYear}-12-31`;
      filter.air_date = [`>=${safeYear}-01-01`, `<=${yearEnd < todayKey ? yearEnd : todayKey}`];
    } else if (userTags.length > 0 || officialMetaTags.length > 0) {
      filter.air_date = [`<=${todayKey}`];
    }

    try {
      if (needsSharedCollection) {
        const collection = await this._getReleasedBrowseCollection({
          keyword,
          userTags,
          officialMetaTags,
          year: safeYear,
          refresh,
          minItems: offset + safeLimit,
          // date 排序需要近期分段优先扫描；rank/heat 需要知道用哪个顺序
          sortHint: normalizedSort
        });
        // date→日期降序；score→评分降序；rank/heat→服务端扫描顺序
        const collectionSort = normalizedSort === 'date'
          ? 'date'
          : (['rank', 'heat'].includes(normalizedSort) ? normalizedSort : 'score');
        const sorted = this._sortBrowseCollection(collection, collectionSort);
        if (sorted.length === 0) {
          const indexed = this._readBrowsePageFromIndex({
            keyword,
            userTags,
            officialMetaTags,
            year: safeYear,
            sort: normalizedSort,
            page: safePage,
            limit: safeLimit
          });
          if (indexed?.data?.length > 0) {
            return {
              ...indexed,
              tag: tag || '',
              _servedFromIndex: true,
              _emptyResponseFallback: true
            };
          }
        }
        const result = {
          data: sorted.slice(offset, offset + safeLimit),
          total: collection.sourceTotal || sorted.length,
          page: safePage,
          totalPages: Math.ceil((collection.sourceTotal || sorted.length) / safeLimit) || 1,
          tag: tag || '',
          tags: userTags,
          metaTags: officialMetaTags,
          year: safeYear,
          sort: normalizedSort,
          releaseDate: collection.releaseDate,
          futureFiltered: true,
          _sourceTotal: collection.sourceTotal,
          _truncated: !!collection.truncated,
          _fromExpiredCache: !!collection._fromExpiredCache
        };
        // 不满页且集合未扫满（镜像限流导致扫描中断）时不写页面缓存：
        // 短页一旦锁进 30 分钟缓存，重试永远拿不到完整的一页。
        const fullPage = (result.data || []).length >= safeLimit;
        if (fullPage || !result._truncated) {
          this._writeCache(cacheKey, 'browse', result, 30 * 60 * 1000);
        }
        return result;
      }

      // Bangumi /v0/search/subjects 限制 offset <= 10000，超出会返回 400。
      // 超过时不请求 API，直接返回空数据 + _outOfRange 标记，
      // 保留真实 totalPages 让 UI 能给出"请用筛选缩小范围"的提示。
      const BROWSE_MAX_OFFSET = 10000;
      if (offset > BROWSE_MAX_OFFSET) {
        return {
          data: [],
          total: 0,
          page: safePage,
          totalPages: 0, // 0 表示"未知/超出范围"，UI 不会覆盖已有的 totalPages
          tag: tag || '',
          tags: userTags,
          metaTags: officialMetaTags,
          year: safeYear,
          sort: normalizedSort,
          _outOfRange: true
        };
      }

      const data = await bangumiApi.request(url, {
        method: 'POST',
        body: {
          keyword,
          sort: normalizedSort,
          filter
        }
      });

      const normalizedItems = (data.data || []).map(item => {
        const normalized = typeof bangumiApi._normalizeItem === 'function'
          ? bangumiApi._normalizeItem(item)
          : item;
        return this._toSubjectSummary(normalized);
      }).filter(Boolean);
      const shouldApplyCatalogPolicy = !keyword;
      const resultItems = shouldApplyCatalogPolicy
        ? normalizedItems.filter(item => isSubjectCatalogEligible(item, { todayKey }))
        : normalizedItems;
      const displayItems = normalizedSort === 'score'
        ? this._sortBrowseCollection(resultItems, 'score')
        : resultItems;
      if (displayItems.length === 0 && (userTags.length > 0 || officialMetaTags.length > 0)) {
        const indexed = this._readBrowsePageFromIndex({
          keyword,
          userTags,
          officialMetaTags,
          year: safeYear,
          sort: normalizedSort,
          page: safePage,
          limit: safeLimit
        });
        if (indexed?.data?.length > 0) {
          const fallbackResult = {
            ...indexed,
            tag: tag || '',
            _servedFromIndex: true,
            _emptyResponseFallback: true
          };
          this._writeCache(cacheKey, 'browse', fallbackResult, 30 * 60 * 1000);
          return fallbackResult;
        }
      }
      const skippedIneligible = normalizedItems.length - resultItems.length;
      const realTotal = Math.max(displayItems.length, (data.total || 0) - skippedIneligible);
      const result = {
        data: displayItems,
        total: realTotal,
        page: safePage,
        totalPages: Math.ceil(realTotal / safeLimit) || 1,
        tag: tag || '',
        tags: userTags,
        metaTags: officialMetaTags,
        year: safeYear,
        sort: normalizedSort,
        releaseDate: shouldApplyCatalogPolicy ? todayKey : null,
        futureFiltered: shouldApplyCatalogPolicy,
        skippedIneligible
      };

      this._writeCache(cacheKey, 'browse', result, 30 * 60 * 1000);
      this._indexUpsert(result.data);
      return result;
    } catch (err) {
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return { ...fallback.content, _fromExpiredCache: true };
        }
      }
      return { data: [], total: 0, page: safePage, totalPages: 0, tag: tag || '', tags: userTags, metaTags: officialMetaTags, year: safeYear, sort: normalizedSort, error: err.message };
    }
  }

  /**
   * 获取番剧详情（标准化为 SubjectDetail）
   * 内存缓存 30 分钟，避免重复请求 API。
   * ID 路由：'anilist:123' / 'anilist_123' 走 AniList，其余走 Bangumi。
   */
  async getDetail(bgmId) {
    // 内存缓存命中
    const cacheKey = String(bgmId);
    const cached = this._detailCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.detail;
    }

    const anilistId = parseAniListId(bgmId);
    if (anilistId !== null) {
      const detail = await this._getAniListDetail(anilistId);
      this._detailCache.set(cacheKey, {
        detail,
        expiry: Date.now() + this._detailCacheTTL
      });
      return detail;
    }

    const detail = await bangumiApi.getDetail(bgmId);
    if (!detail) return null;
    const result = this._toSubjectDetail(detail);

    // 写入本地索引（fire-and-forget）
    this._indexUpsertDetail(result);

    // 写入内存缓存
    this._detailCache.set(cacheKey, {
      detail: result,
      expiry: Date.now() + this._detailCacheTTL
    });
    // 限制内存缓存大小
    if (this._detailCache.size > 200) {
      const firstKey = this._detailCache.keys().next().value;
      this._detailCache.delete(firstKey);
    }

    return result;
  }

  /**
   * 获取 AniList 详情（标准化为 SubjectDetail）
   */
  async _getAniListDetail(anilistId) {
    const cacheKey = `anilist:${anilistId}`;
    const cached = this._detailCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.detail;
    }
    const detail = await anilistProvider.getDetail(anilistId);
    if (!detail) return null;
    const result = this._toSubjectDetail(detail);
    this._detailCache.set(cacheKey, {
      detail: result,
      expiry: Date.now() + this._detailCacheTTL
    });
    return result;
  }

  /**
   * 获取番剧分集列表
   * GET /v0/subjects/{id}/episodes
   * 返回标准化的 episode 列表
   */
  async getEpisodes(bgmId, { limit = 100, offset = 0 } = {}) {
    // AniList 不提供分集列表接口，返回空（分集由可搜索片源按名称匹配提供）
    if (parseAniListId(bgmId) !== null) {
      return { data: [], total: 0, limit, offset };
    }
    const cacheKey = `bangumi:episodes:${bgmId}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const url = `${bangumiApi.baseUrl}/v0/subjects/${bgmId}/episodes?limit=${limit}&offset=${offset}`;
    console.log(`[SubjectService] 获取分集: ${url}`);

    try {
      const data = await bangumiApi.request(url);
      const result = {
        data: (data.data || []).map(ep => ({
          id: `ep_${ep.id}`,
          sort: ep.sort || 0,
          ep: ep.ep || 0,
          title: ep.name_cn || ep.name || `第${ep.sort || ep.ep || 0}话`,
          titleRaw: ep.name || '',
          airDate: ep.airdate || '',
          duration: ep.duration_seconds || 0,
          description: ep.desc || ''
        })),
        total: data.total || 0,
        limit,
        offset
      };
      // 分集数据稳定，缓存 1 小时
      this._writeCache(cacheKey, 'episodes', result, 60 * 60 * 1000);
      return result;
    } catch (err) {
      console.error('[SubjectService] 获取分集失败:', err);
      // 尝试从详情页的 episodes 字段兜底
      const detail = await bangumiApi.getDetail(bgmId);
      if (detail && detail.episodes) {
        const fallback = [];
        for (const lineKey of Object.keys(detail.episodes)) {
          const line = detail.episodes[lineKey];
          if (Array.isArray(line)) {
            line.forEach(ep => {
              if (ep && ep.id) {
                fallback.push({
                  id: ep.id,
                  sort: ep.episode_number || 0,
                  ep: ep.episode_number || 0,
                  title: ep.title || '',
                  titleRaw: '',
                  airDate: ep.air_date || '',
                  duration: 0,
                  description: ''
                });
              }
            });
          }
        }
        return { data: fallback, total: fallback.length, limit, offset };
      }
      return { data: [], total: 0, limit, offset, error: err.message };
    }
  }

  // ── 标准化 ────────────────────────────────────────────────

  /**
   * 将 BangumiApi 的列表项标准化为 SubjectSummary
   * 符合 docs/desktop-modernization-plan.md 5.1 节
   */
  _toSubjectSummary(item) {
    if (!item) return null;
    if (item.source === 'anilist' || item.anilistId || item.anilist_id) {
      return this._toAniListSummary(item);
    }
    const bgmId = item.bgm_id || item.id;
    const episodeSnapshotRow = this.db?.getCacheAny?.(`bangumi:aired-eps:v2:${bgmId}`) || null;
    const episodeSnapshot = episodeSnapshotRow?.content || null;
    const plannedEpisodeCount = item.planned_episode_count || item.plannedEpisodeCount ||
      item.total_episode_count || item.totalEpisodeCount || item.episode_count ||
      episodeSnapshot?.planned || episodeSnapshot?.total || 0;
    const airedEpisodeCount = item.aired_episode_count || item.airedEpisodeCount ||
      episodeSnapshot?.count || 0;
    return {
      id: `bangumi_${bgmId}`,
      bgmId: bgmId,
      bgm_id: bgmId,
      name: item.name || '',
      nameRaw: item.nameRaw || item.name_raw || '',
      name_raw: item.name_raw || '',
      aliases: item.aliases || [],
      // 对 cover 再做一次标准化，确保旧缓存里的 lain.bgm.tv URL 也会被改写走 wsrv.nl
      cover: bangumiApi._normalizeImageUrl(item.cover || ''),
      rating: item.rating || 0,
      rank: item.rank || 0,
      votes: item.votes || 0,
      airDate: item.air_date || item.airDate || '',
      air_date: item.air_date || item.airDate || '',
      airWeekday: item.air_weekday || 0,
      air_weekday: item.air_weekday || 0,
      tags: item.tags || [],
      source: 'bangumi',
      // item.type 可能是 _normalizeItem 产出的 ['动漫']，也可能是原始 API 的整数（2=动画）
      // 统一归一化为数组形式，避免数字直接透传到前端显示为 "2"
      type: Array.isArray(item.type) ? item.type : ['动漫'],
      // 兼容字段：保留给现有 UI 使用，逐步迁移后可移除
      year: item.year || (item.air_date ? item.air_date.split('-')[0] : ''),
      // area 优先用已标准化的 item.area，为空时 fallback 到 item.platform（原始 API 字段）
      // 这样绕过 _normalizeItem 直接调用 _toSubjectSummary 的路径（如 Next API）也能拿到平台信息
      area: item.area || item.platform || '',
      // 保留 platform 字段，详情页和索引写入需要
      platform: item.platform || item.area || '',
      intro: item.intro || '',
      remarks: item.remarks || '',
      episode_count: item.episode_count || 0,
      planned_episode_count: plannedEpisodeCount,
      total_episode_count: plannedEpisodeCount,
      aired_episode_count: airedEpisodeCount,
      available_episode_count: item.available_episode_count || item.availableEpisodeCount || 0,
      _airedEpisodeSynced: !!episodeSnapshotRow,
      _airedEpisodeSnapshotExpired: !!episodeSnapshotRow?.expired,
      url: item.url || '',
      week_day_cn: item.week_day_cn || ''
    };
  }

  /**
   * 将 AniList 条目标准化为 SubjectSummary（source: 'anilist'）
   * bgm_id 保持空，使用 anilistId / anilist_id 作为条目标识，
   * 避免与 Bangumi 数字 ID 空间冲突。
   */
  _toAniListSummary(item) {
    const anilistId = item.anilistId || item.anilist_id;
    const plannedEpisodeCount = item.planned_episode_count || item.plannedEpisodeCount ||
      item.total_episode_count || item.totalEpisodeCount || item.episode_count || item.episodeCount || 0;
    return {
      id: `anilist_${anilistId}`,
      anilistId,
      anilist_id: anilistId,
      bgmId: null,
      bgm_id: null,
      name: item.name || '',
      nameRaw: item.nameRaw || item.name_raw || '',
      name_raw: item.name_raw || '',
      aliases: item.aliases || [],
      cover: item.cover || '',
      rating: item.rating || 0,
      rank: 0,
      votes: item.votes || 0,
      airDate: item.air_date || item.airDate || '',
      air_date: item.air_date || item.airDate || '',
      airWeekday: 0,
      air_weekday: 0,
      tags: item.tags || [],
      source: 'anilist',
      type: Array.isArray(item.type) ? item.type : ['动漫'],
      year: item.year || (item.air_date ? String(item.air_date).split('-')[0] : ''),
      area: item.area || item.platform || item.format || '',
      platform: item.platform || item.format || item.area || '',
      intro: item.intro || '',
      remarks: item.remarks || '',
      episode_count: Number(item.episode_count) || 0,
      planned_episode_count: Number(plannedEpisodeCount) || 0,
      total_episode_count: Number(plannedEpisodeCount) || 0,
      aired_episode_count: Number(item.aired_episode_count) || 0,
      available_episode_count: Number(item.available_episode_count) || 0,
      url: item.url || '',
      week_day_cn: item.week_day_cn || ''
    };
  }

  /**
   * 将 BangumiApi 的详情标准化为 SubjectDetail
   * 符合 docs/desktop-modernization-plan.md 5.2 节
   */
  _toSubjectDetail(detail) {
    const plannedEpisodeCount = detail.planned_episode_count || detail.plannedEpisodeCount ||
      detail.total_episode_count || detail.totalEpisodeCount || detail.episode_count || detail.episodeCount || 0;
    return {
      ...this._toSubjectSummary(detail),
      summary: detail.intro || '',
      episodeCount: plannedEpisodeCount,
      plannedEpisodeCount,
      planned_episode_count: plannedEpisodeCount,
      total_episode_count: plannedEpisodeCount,
      aired_episode_count: detail.aired_episode_count || detail.airedEpisodeCount || 0,
      available_episode_count: detail.available_episode_count || detail.availableEpisodeCount || 0,
      episodes: detail.episodes || {},
      official_episodes: detail.official_episodes || [],
      characters: [],      // 由 getCharacters 单独加载
      staff: [],           // 由 getStaff 单独加载
      comments: [],        // 由 getComments 单独加载
      infobox: detail.infobox || [],
      collection: detail.collection || {},
      // 兼容字段
      actor: detail.actor || '',
      director: detail.director || '',
      rating_total: detail.rating_total || 0,
      rating_histogram: detail.rating_histogram || {},
      tags_with_count: detail.tags_with_count || [],
      platform: detail.platform || ''
    };
  }

  // ── 缓存辅助（复用 BangumiApi 的缓存机制）──

  _readCache(key) {
    const memo = this._memoryCache.get(key);
    if (memo) {
      if (memo.expiresAt > Date.now()) return memo.content;
      this._memoryCache.delete(key);
    }
    if (!this.db) return null;
    try {
      return this.db.getCache(key);
    } catch (e) {
      return null;
    }
  }

  _readAnyCache(key) {
    const memo = this._memoryCache.get(key);
    if (memo) {
      return { content: memo.content, expired: memo.expiresAt <= Date.now() };
    }
    if (!this.db) return null;
    try {
      return this.db.getCacheAny(key);
    } catch (e) {
      return null;
    }
  }

  _writeCache(key, kind, content, ttl) {
    this._memoryCache.set(key, {
      content,
      expiresAt: Date.now() + ttl
    });
    if (this._memoryCache.size > this._memoryCacheMax) {
      this._memoryCache.delete(this._memoryCache.keys().next().value);
    }
    if (!this.db) return;
    try {
      this.db.setCache(key, 'bangumi', kind, content, ttl);
    } catch (e) {
      // ignore
    }
  }
}

module.exports = new SubjectService();
module.exports.SubjectService = SubjectService;
