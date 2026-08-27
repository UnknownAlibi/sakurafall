/**
 * AniList 元数据服务
 *
 * 公开 GraphQL API：https://graphql.anilist.co（免 API Key）
 * 作为 Bangumi 不可达时的备用元数据源，输出与 BangumiApi 一致的
 * SubjectSummary / SubjectDetail 数据模型，便于 SubjectService 无缝聚合。
 *
 * 注意：
 * - AniList 无分集列表接口，分集由可搜索片源（SourceProvider）按名称匹配提供。
 * - 与 Bangumi 的 bgm_id 为不同 ID 空间，条目统一携带 anilistId，
 *   由 SubjectService 用 'anilist:' 前缀区分路由。
 */

const HttpClient = require('../utils/HttpClient');

const ANILIST_API = 'https://graphql.anilist.co';

function pickTitle(title = {}) {
  return {
    native: String(title.native || '').trim(),
    romaji: String(title.romaji || '').trim(),
    english: String(title.english || '').trim()
  };
}

function formatDate(date = {}) {
  if (!date || !date.year) return '';
  const month = String(date.month || 1).padStart(2, '0');
  const day = String(date.day || 1).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

const SEASON_BY_QUARTER = {
  1: 'WINTER', // 1-3月
  2: 'SPRING', // 4-6月
  3: 'SUMMER', // 7-9月
  4: 'FALL'    // 10-12月
};

const LIST_FRAGMENT = `
  id
  idMal
  title { romaji english native }
  coverImage { extraLarge large medium }
  bannerImage
  description
  episodes
  status
  averageScore
  genres
  tags { name }
  startDate { year month day }
  endDate { year month day }
  format
  seasonYear
  nextAiringEpisode { episode airingAt }
  isAdult
`;

class AniListProvider {
  constructor() {
    this.apiUrl = ANILIST_API;
    this.timeout = 10000;
    this.db = null;
    this.http = new HttpClient({
      timeout: this.timeout,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    // 缓存 TTL（毫秒）
    this.SEARCH_CACHE_TTL = 30 * 60 * 1000;
    this.DETAIL_CACHE_TTL = 30 * 60 * 1000;
  }

  setDatabase(db) {
    this.db = db;
  }

  setProxy(proxyUrl) {
    this.http.setProxy(proxyUrl || '');
  }

  setTimeout(timeout) {
    this.timeout = Math.max(3000, parseInt(timeout, 10) || 10000);
    this.http.setTimeout(this.timeout);
  }

  // ── 缓存辅助（复用 AnimeDatabase 的 cms_cache 表，键加 anilist: 前缀避免冲突）──

  _readCache(key) {
    if (!this.db) return null;
    try {
      return this.db.getCache(key);
    } catch (e) {
      console.error('[AniListProvider] 读取缓存失败:', e.message);
      return null;
    }
  }

  _writeCache(key, kind, content, ttl) {
    if (!this.db) return;
    try {
      this.db.setCache(key, 'anilist', kind, content, ttl);
    } catch (e) {
      console.error('[AniListProvider] 写入缓存失败:', e.message);
    }
  }

  /**
   * 发起 GraphQL 请求
   */
  async _graphql(query, variables) {
    const text = await this.http.fetch(this.apiUrl, {
      method: 'POST',
      body: { query, variables }
    });
    const data = JSON.parse(text);
    if (data?.errors?.length) {
      const error = new Error(data.errors.map(item => item.message).join('; '));
      error.code = 'ANILIST_GRAPHQL_ERROR';
      throw error;
    }
    return data;
  }

  /**
   * 搜索动漫
   * @returns { data, total, page, totalPages, error? }
   */
  async search(keyword, page = 1) {
    const safeKeyword = String(keyword || '').trim();
    const cacheKey = `anilist:search:${safeKeyword.toLowerCase()}:${page}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const perPage = 20;
    const query = `query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage }
        media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
          ${LIST_FRAGMENT}
        }
      }
    }`;

    try {
      const data = await this._graphql(query, { search: safeKeyword, page, perPage });
      const pageData = data?.data?.Page || {};
      const result = {
        data: (pageData.media || []).map(item => this._normalizeItem(item)).filter(Boolean),
        total: pageData.pageInfo?.total || 0,
        page,
        totalPages: pageData.pageInfo?.lastPage || 1
      };
      this._writeCache(cacheKey, 'search', result, this.SEARCH_CACHE_TTL);
      return result;
    } catch (err) {
      console.warn('[AniListProvider] 搜索失败:', err.message);
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
   * 获取动漫详情
   * @param {number} id - AniList 条目 ID
   */
  async getDetail(id) {
    const cacheKey = `anilist:detail:${id}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const query = `query ($id: Int) {
      Media(id: $id, type: ANIME) {
        ${LIST_FRAGMENT}
        studios(isMain: true) { nodes { name } }
      }
    }`;

    try {
      const data = await this._graphql(query, { id });
      const media = data?.data?.Media;
      const detail = this._normalizeDetail(media);
      if (detail && detail.name) {
        this._writeCache(cacheKey, 'detail', detail, this.DETAIL_CACHE_TTL);
      }
      return detail;
    } catch (err) {
      console.warn(`[AniListProvider] 获取详情失败(id=${id}):`, err.message);
      if (this.db) {
        const fallback = this.db.getCacheAny(cacheKey);
        if (fallback && fallback.content) {
          return { ...fallback.content, _fromExpiredCache: true, error: err.message };
        }
      }
      throw err;
    }
  }

  /**
   * 获取指定季度番剧列表（支持分页）
   * @param {number} year - 年份，如 2025
   * @param {number} quarter - 1=冬 2=春 3=夏 4=秋
   * @param {number} page - 页码，从 1 开始
   */
  async getSeasonAnime(year, quarter, page = 1) {
    const season = SEASON_BY_QUARTER[quarter];
    const cacheKey = `anilist:season:${year}:${quarter}:${page}`;
    const cached = this._readCache(cacheKey);
    if (cached) return { ...cached, _fromCache: true };

    const perPage = 24;
    const query = `query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage }
        media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
          ${LIST_FRAGMENT}
        }
      }
    }`;

    try {
      const data = await this._graphql(query, {
        season,
        seasonYear: year,
        page,
        perPage
      });
      const pageData = data?.data?.Page || {};
      const result = {
        data: (pageData.media || []).map(item => this._normalizeItem(item)).filter(Boolean),
        total: pageData.pageInfo?.total || 0,
        page,
        totalPages: pageData.pageInfo?.lastPage || 1,
        year,
        quarter
      };
      this._writeCache(cacheKey, 'season', result, 30 * 60 * 1000);
      return result;
    } catch (err) {
      console.warn('[AniListProvider] 获取季度番剧失败:', err.message);
      return { data: [], total: 0, page, totalPages: 0, year, quarter, error: err.message };
    }
  }

  /**
   * 获取热门番剧（趋势榜）
   * @returns { Array } SubjectSummary 数组
   */
  async getTrending(limit = 12) {
    const cacheKey = `anilist:trending:${limit}`;
    const cached = this._readCache(cacheKey);
    if (cached) return cached;

    const perPage = Math.max(1, Math.min(50, parseInt(limit, 10) || 12));
    const query = `query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total }
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
          ${LIST_FRAGMENT}
        }
      }
    }`;

    try {
      const data = await this._graphql(query, { page: 1, perPage });
      const items = ((data?.data?.Page || {}).media || [])
        .map(item => this._normalizeItem(item))
        .filter(Boolean);
      this._writeCache(cacheKey, 'trending', items, 30 * 60 * 1000);
      return items;
    } catch (err) {
      console.warn('[AniListProvider] 获取热门番剧失败:', err.message);
      return [];
    }
  }

  // ── 标准化 ────────────────────────────────────────────────

  /**
   * 标准化列表条目（SubjectSummary 形状，source: 'anilist'）
   */
  _normalizeItem(item) {
    if (!item || !item.id) return null;
    const title = pickTitle(item.title);
    const airDate = formatDate(item.startDate);
    const status = String(item.status || '');
    const planned = Number(item.episodes) || 0;
    const nextAiring = Number(item.nextAiringEpisode?.episode) || 0;
    let aired = status === 'FINISHED' ? planned : 0;
    if (nextAiring > 0) aired = Math.max(0, nextAiring - 1);
    const genres = Array.isArray(item.genres) ? item.genres : [];
    const tags = [
      ...genres,
      ...(Array.isArray(item.tags) ? item.tags.map(tag => tag && tag.name).filter(Boolean) : [])
    ];

    return {
      id: `anilist_${item.id}`,
      anilistId: item.id,
      anilist_id: item.id,
      bgm_id: null,
      bgmId: null,
      name: title.native || title.romaji || title.english || '未知',
      name_raw: title.romaji || title.english || title.native || '',
      nameRaw: title.romaji || title.english || title.native || '',
      aliases: [title.romaji, title.english].filter(Boolean),
      cover: item.coverImage?.large || item.coverImage?.extraLarge || item.coverImage?.medium || '',
      type: ['动漫'],
      year: airDate ? airDate.split('-')[0] : (item.seasonYear ? String(item.seasonYear) : ''),
      area: item.format || '',
      intro: stripHtml(item.description),
      remarks: status || '',
      episode_count: planned,
      planned_episode_count: planned,
      total_episode_count: planned,
      aired_episode_count: aired,
      rating: item.averageScore ? Number(item.averageScore) / 10 : 0,
      rank: 0,
      votes: 0,
      url: `https://anilist.co/anime/${item.id}`,
      air_date: airDate,
      air_weekday: 0,
      tags,
      platform: item.format || '',
      source: 'anilist'
    };
  }

  /**
   * 标准化详情（SubjectDetail 形状）
   */
  _normalizeDetail(item) {
    if (!item || !item.id) return null;
    const summary = this._normalizeItem(item);
    if (!summary) return null;
    const studios = Array.isArray(item.studios?.nodes)
      ? item.studios.nodes.map(node => node && node.name).filter(Boolean)
      : [];

    return {
      ...summary,
      summary: summary.intro || '',
      episodes: {},
      official_episodes: [],
      characters: [],
      staff: [],
      comments: [],
      infobox: [],
      collection: {},
      actor: '',
      director: '',
      rating_total: 0,
      rating_histogram: {},
      tags_with_count: (Array.isArray(item.tags) ? item.tags : [])
        .map(tag => ({ name: tag?.name || '', count: tag?.rank || 0 })),
      studios,
      end_date: formatDate(item.endDate),
      banner: item.bannerImage || ''
    };
  }
}

module.exports = new AniListProvider();
module.exports.AniListProvider = AniListProvider;
