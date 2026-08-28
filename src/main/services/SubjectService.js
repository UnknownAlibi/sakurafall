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

    const cacheKey = `bangumi:catalog:v3:${releaseScope}:${normalizedSort}:${safeCat ?? 'all'}:${safeYear || 'all-years'}:${safeMonth || 'all-months'}:${safePage}:${safeLimit}`;
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
          _staleWhileRevalidate: true
        };
      }
    }

    // The public catalog endpoint only accepts rank/date. Score sorting for
    // platform categories must use the numeric ratings already in our index.
    if (normalizedSort === 'score') {
      const indexed = this._readCatalogPageFromIndex({
        page: safePage,
        limit: safeLimit,
        sort: normalizedSort,
        year: safeYear,
        month: safeMonth,
        cat: safeCat
      });
      if (indexed?.data?.length > 0) {
        const result = {
          ...indexed,
          includeFuture: false,
          releaseDate: todayKey,
          futureFiltered: true,
          _servedFromIndex: true,
          _indexBackedScoreSort: true
        };
        this._writeCache(cacheKey, 'catalog', result, 30 * 60 * 1000);
        return result;
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

      const result = {
        data: pageData.data || [],
        total: pageData.total || 0,
        page: safePage,
        totalPages: Math.ceil((pageData.total || 0) / safeLimit) || 1,
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
    const params = new URLSearchParams({
      type: '2',
      sort,
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

  _readCatalogPageFromIndex({ page, limit, sort, year, month, cat }) {
    if (!subjectIndexService?.querySubjects) return null;
    const platformByCategory = {
      1: 'TV',
      2: 'OVA',
      3: '剧场版',
      5: 'WEB'
    };
    const platform = Number.isFinite(cat) ? platformByCategory[cat] : '';
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
        requireDated: sort === 'date',
        requireRated: sort === 'score'
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
        requireDated: sort === 'date',
        requireRated: sort === 'score'
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
          if (!isSubjectCatalogEligible(item, { sort, todayKey })) {
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

  async _requestBrowsePage({ keyword = '', userTags = [], officialMetaTags = [], year = null, sort = 'score', limit = 50, offset = 0 }) {
    const filter = { type: [2] };
    if (userTags.length > 0) filter.tag = userTags;
    if (officialMetaTags.length > 0) filter.meta_tags = officialMetaTags;
    const todayKey = this._todayDateKey();
    if (year && year >= 1900 && year <= 2100) {
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

  async _getReleasedBrowseCollection({ keyword = '', userTags = [], officialMetaTags = [], year = null, refresh = false }) {
    const todayKey = this._todayDateKey();
    const cacheKey = `bangumi:browse-collection:v5:${todayKey}:${userTags.join(',') || 'all'}:${officialMetaTags.join(',') || 'all-platforms'}:${year || 'all-years'}:${keyword || ''}`;
    if (!refresh) {
      const cached = this._readCache(cacheKey);
      if (cached?.data) return cached;
    }

    if (this._browseCollectionInflight.has(cacheKey)) {
      return this._browseCollectionInflight.get(cacheKey);
    }

    const pending = (async () => {
      const requestLimit = 50;
      const first = await this._requestBrowsePage({ keyword, userTags, officialMetaTags, year, limit: requestLimit, offset: 0 });
      // This is only a cold-index fallback for date sorting. Keep it bounded so a
      // single filter click can never expand into hundreds of network requests.
      const maxPages = Math.min(8, Math.ceil(first.total / requestLimit));
      const pages = [first];

      for (let pageStart = 1; pageStart < maxPages; pageStart += 4) {
        const requests = [];
        for (let pageIndex = pageStart; pageIndex < Math.min(pageStart + 4, maxPages); pageIndex += 1) {
          requests.push(this._requestBrowsePage({
            keyword,
            userTags,
            officialMetaTags,
            year,
            limit: requestLimit,
            offset: pageIndex * requestLimit
          }));
        }
        pages.push(...await Promise.all(requests));
      }

      const seen = new Set();
      const items = [];
      for (const item of pages.flatMap(result => result.data || [])) {
        if (!isSubjectCatalogEligible(item, { sort: 'date', todayKey })) continue;
        const identity = String(item.bgm_id || item.bgmId || item.id || `${item.name}:${item.air_date}`);
        if (seen.has(identity)) continue;
        seen.add(identity);
        items.push(item);
      }

      const collection = {
        data: items,
        total: items.length,
        sourceTotal: first.total,
        releaseDate: todayKey,
        futureFiltered: true,
        truncated: maxPages * requestLimit < first.total
      };
      this._writeCache(cacheKey, 'browse-collection', collection, 6 * 60 * 60 * 1000);
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

  _sortBrowseCollection(items, sort) {
    const data = [...items];
    if (sort === 'date') {
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

    const cacheKey = `bangumi:browse:v7:${normalizedSort}:${userTags.join(',') || 'all'}:${officialMetaTags.join(',') || 'all-platforms'}:${safeYear || 'all-years'}:${keyword || ''}:${safePage}:${safeLimit}`;
    const cached = refresh ? null : this._readCache(cacheKey);
    if (cached) return cached;

    // date 排序 + 收窄筛选（年份/标签）必须走网络集合路径：本地索引是
    // 增量子集，直接读首屏只会返回几条（首屏残缺 bug 的根源）。
    // 无筛选默认视图由日历同步喂养，索引完整，允许直读。
    const dateNeedsCollection = normalizedSort === 'date' && !keyword && (userTags.length > 0 || officialMetaTags.length > 0 || !!safeYear);

    if (!refresh && staleWhileRevalidate) {
      const stale = this._readAnyCache(cacheKey);
      if (stale && stale.content) {
        return {
          ...stale.content,
          _fromExpiredCache: stale.expired,
          _staleWhileRevalidate: true
        };
      }

      if (!dateNeedsCollection) {
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
    if (normalizedSort === 'date' && !dateNeedsCollection) {
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
      if (!keyword && normalizedSort === 'date' && (userTags.length > 0 || officialMetaTags.length > 0 || safeYear)) {
        const collection = await this._getReleasedBrowseCollection({
          keyword,
          userTags,
          officialMetaTags,
          year: safeYear,
          refresh
        });
        const sorted = this._sortBrowseCollection(collection.data || [], normalizedSort);
        const result = {
          data: sorted.slice(offset, offset + safeLimit),
          total: sorted.length,
          page: safePage,
          totalPages: Math.ceil(sorted.length / safeLimit) || 1,
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
        this._writeCache(cacheKey, 'browse', result, 30 * 60 * 1000);
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
        ? normalizedItems.filter(item => isSubjectCatalogEligible(item, { sort: normalizedSort, todayKey }))
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
