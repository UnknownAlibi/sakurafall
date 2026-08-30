/**
 * SubjectIndexService — Bangumi 本地索引服务（P0）
 *
 * 职责：
 * 1. 维护 bangumi_subjects / bangumi_subject_tags / bangumi_sync_state 三张本地表
 * 2. 提供本地查询（keyword/tag/year/month/sort/分页），几十毫秒内返回
 * 3. 协调后台同步：catalog 页、季度、详情过期补全
 * 4. 对外输出与 SubjectService 一致的 SubjectSummary 数据模型，便于 UI 层无缝切换
 *
 * 设计原则（见 docs/next-stage-rebuild-plan.md P0）：
 * - 本地查询为主，网络同步为辅，不阻塞 UI
 * - 同步结果写入本地索引，下次查询直接命中
 * - "最新"和"热门"只是排序不同，共用同一套索引
 */

const bangumiApi = require('./BangumiApi');
const { subjectYearHints } = require('./SubjectCatalogPolicy');

function resolveSubjectYear(item, airDate = '') {
  const explicit = Number(item?.year) || Number(String(airDate || '').match(/^(?:19|20)\d{2}/)?.[0]) || 0;
  if (explicit >= 1900 && explicit <= 2100) return explicit;
  return subjectYearHints(item)[0] || null;
}

class SubjectIndexService {
  constructor() {
    this.db = null;
    // 同步状态内存缓存（避免每次查表）
    this._syncStateCache = new Map();
    // 详情过期阈值：7 天（详情数据稳定，不必频繁刷新）
    this.DETAIL_STALE_MS = 7 * 24 * 60 * 60 * 1000;
    // 列表过期阈值：6 小时（新番数据可能更新）
    this.LIST_STALE_MS = 6 * 60 * 60 * 1000;
    this.DEFAULT_PAGE_SIZE = 24;
  }

  setDatabase(db) {
    this.db = db && typeof db.prepare === 'function'
      ? db
      : (db && db.db && typeof db.db.prepare === 'function' ? db.db : null);
  }

  // ── 写入：upsert ────────────────────────────────────────

  /**
   * 批量 upsert SubjectSummary 列表到本地索引
   * @param {Array} subjects - SubjectSummary 数组（来自 BangumiApi._normalizeItem / SubjectService._toSubjectSummary）
   */
  async upsertSubjects(subjects) {
    if (!this.db || !Array.isArray(subjects) || subjects.length === 0) return 0;
    const now = Date.now();
    let count = 0;
    const insertStmt = this.db.prepare(`
      INSERT INTO bangumi_subjects (
        bgm_id, name, name_cn, aliases, summary, cover_url, cover_local,
        rating, rank, votes, eps, air_date, air_weekday, year, month,
        type, nsfw, popularity, updated_at, raw_json, platform
      ) VALUES (
        @bgmId, @name, @nameCn, @aliases, @summary, @coverUrl, @coverLocal,
        @rating, @rank, @votes, @eps, @airDate, @airWeekday, @year, @month,
        @type, @nsfw, @popularity, @updatedAt, @rawJson, @platform
      )
      ON CONFLICT(bgm_id) DO UPDATE SET
        name = excluded.name,
        name_cn = excluded.name_cn,
        aliases = excluded.aliases,
        cover_url = excluded.cover_url,
        rating = excluded.rating,
        rank = excluded.rank,
        votes = excluded.votes,
        eps = excluded.eps,
        air_date = excluded.air_date,
        air_weekday = excluded.air_weekday,
        year = excluded.year,
        month = excluded.month,
        type = excluded.type,
        nsfw = excluded.nsfw,
        popularity = excluded.popularity,
        updated_at = excluded.updated_at,
        raw_json = excluded.raw_json,
        platform = excluded.platform
    `);
    const tagStmt = this.db.prepare(`
      INSERT INTO bangumi_subject_tags (bgm_id, tag, count)
      VALUES (?, ?, ?)
      ON CONFLICT(bgm_id, tag) DO UPDATE SET count = excluded.count
    `);
    const deleteTagsStmt = this.db.prepare(`DELETE FROM bangumi_subject_tags WHERE bgm_id = ?`);

    const tx = this.db.transaction((items) => {
      for (const item of items) {
        const bgmId = item.bgmId || item.bgm_id || item.id;
        if (!bgmId) continue;
        const airDate = String(item.airDate || item.air_date || '');
        const year = resolveSubjectYear(item, airDate);
        const month = airDate ? parseInt(airDate.slice(5, 7), 10) || null : null;
        insertStmt.run({
          bgmId: Number(bgmId),
          name: item.nameRaw || item.name_raw || item.name || '',
          nameCn: item.name || '',
          aliases: Array.isArray(item.aliases) ? JSON.stringify(item.aliases) : '',
          summary: item.intro || item.summary || '',
          coverUrl: item.cover || '',
          coverLocal: '',
          rating: Number(item.rating) || 0,
          rank: Number(item.rank) || 0,
          votes: Number(item.votes) || 0,
          eps: Number(item.planned_episode_count || item.total_episode_count || item.episode_count || item.eps || 0),
          airDate,
          airWeekday: Number(item.air_weekday || item.airWeekday || 0),
          year: year || null,
          month: month || null,
          type: Array.isArray(item.type) ? 2 : (Number(item.type) || 2),
          nsfw: item.nsfw ? 1 : 0,
          popularity: Number(item.popularity || 0),
          updatedAt: now,
          rawJson: '',
          platform: item.platform || item.area || ''
        });
        // 标签：先删后插（保持标签新鲜）
        if (Array.isArray(item.tags) && item.tags.length > 0) {
          deleteTagsStmt.run(Number(bgmId));
          for (const t of item.tags) {
            const tagObj = typeof t === 'string' ? { name: t, count: 0 } : t;
            const tagName = tagObj.name || tagObj.tag || '';
            if (tagName) tagStmt.run(Number(bgmId), tagName, Number(tagObj.count) || 0);
          }
        }
        count++;
      }
    });
    try {
      tx(subjects);
    } catch (e) {
      console.error('[SubjectIndex] upsert 失败:', e.message);
    }
    return count;
  }

  /**
   * upsert 单个详情（包含 summary 等完整字段）
   */
  async upsertDetail(detail) {
    if (!this.db || !detail) return;
    const bgmId = detail.bgmId || detail.bgm_id || detail.id;
    if (!bgmId) return;
    const now = Date.now();
    const airDate = String(detail.airDate || detail.air_date || '');
    const year = resolveSubjectYear(detail, airDate);
    const month = airDate ? parseInt(airDate.slice(5, 7), 10) || null : null;
    try {
      this.db.prepare(`
        INSERT INTO bangumi_subjects (
          bgm_id, name, name_cn, aliases, summary, cover_url, cover_local,
          rating, rank, votes, eps, air_date, air_weekday, year, month,
          type, nsfw, popularity, updated_at, raw_json, platform
        ) VALUES (
          @bgmId, @name, @nameCn, @aliases, @summary, @coverUrl, @coverLocal,
          @rating, @rank, @votes, @eps, @airDate, @airWeekday, @year, @month,
          @type, @nsfw, @popularity, @updatedAt, @rawJson, @platform
        )
        ON CONFLICT(bgm_id) DO UPDATE SET
          name = excluded.name,
          name_cn = excluded.name_cn,
          aliases = excluded.aliases,
          summary = excluded.summary,
          cover_url = excluded.cover_url,
          rating = excluded.rating,
          rank = excluded.rank,
          votes = excluded.votes,
          eps = excluded.eps,
          air_date = excluded.air_date,
          air_weekday = excluded.air_weekday,
          year = excluded.year,
          month = excluded.month,
          type = excluded.type,
          nsfw = excluded.nsfw,
          popularity = excluded.popularity,
          updated_at = excluded.updated_at,
          raw_json = excluded.raw_json,
          platform = excluded.platform
      `).run({
        bgmId: Number(bgmId),
        name: detail.nameRaw || detail.name_raw || detail.name || '',
        nameCn: detail.name || '',
        aliases: Array.isArray(detail.aliases) ? JSON.stringify(detail.aliases) : '',
        summary: detail.summary || detail.intro || '',
        coverUrl: detail.cover || '',
        coverLocal: '',
        rating: Number(detail.rating) || 0,
        rank: Number(detail.rank) || 0,
        votes: Number(detail.rating_total || detail.votes) || 0,
        eps: Number(detail.planned_episode_count || detail.plannedEpisodeCount ||
          detail.total_episode_count || detail.totalEpisodeCount || detail.episode_count || detail.episodeCount || 0),
        airDate,
        airWeekday: Number(detail.air_weekday || detail.airWeekday || 0),
        year: year || null,
        month: month || null,
        type: Array.isArray(detail.type) ? 2 : (Number(detail.type) || 2),
        nsfw: detail.nsfw ? 1 : 0,
        popularity: Number(detail.popularity || 0),
        updatedAt: now,
        rawJson: '',
        platform: detail.platform || detail.area || ''
      });
    } catch (e) {
      console.error('[SubjectIndex] upsertDetail 失败:', e.message);
    }
  }

  // ── 读取：本地查询 ────────────────────────────────────────

  /**
   * 本地索引查询（支持 keyword/tag/year/month/sort/分页/releasedOnly）
   * 返回 { data, total, page, pageSize, fromIndex: true }
   */
  querySubjects(filters = {}) {
    if (!this.db) return { data: [], total: 0, page: 1, pageSize: this.DEFAULT_PAGE_SIZE, fromIndex: true };
    const {
      keyword = '',
      tag = '',
      tags = [],
      year = null,
      month = null,
      sort = 'popular',
      page = 1,
      pageSize = this.DEFAULT_PAGE_SIZE,
      releasedOnly = false,
      requireDated = false,
      requireRated = false,
      type = null,
      platform = ''
    } = filters;

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safePageSize = Math.max(1, Math.min(50, parseInt(pageSize, 10) || this.DEFAULT_PAGE_SIZE));
    const offset = (safePage - 1) * safePageSize;

    const conditions = [];
    const params = [];
    const tagList = Array.from(new Set([
      ...(Array.isArray(tags) ? tags : []),
      ...(tag ? [tag] : [])
    ].map(v => String(v || '').trim()).filter(Boolean)));

    if (keyword) {
      conditions.push('(s.name_cn LIKE ? OR s.name LIKE ? OR s.aliases LIKE ?)');
      const kw = `%${keyword}%`;
      params.push(kw, kw, kw);
    }
    if (year && year >= 1900 && year <= 2100) {
      conditions.push('s.year = ?');
      params.push(Number(year));
    }
    if (month && month >= 1 && month <= 12) {
      conditions.push('s.month = ?');
      params.push(Number(month));
    }
    if (type !== null && type !== undefined && type !== '') {
      conditions.push('s.type = ?');
      params.push(Number(type));
    }
    if (platform) {
      conditions.push('s.platform = ?');
      params.push(String(platform));
    }
    if (requireDated) {
      const today = this._todayKey();
      conditions.push("(s.air_date GLOB '????-??-??' AND s.air_date <= ?)");
      params.push(today);
    } else if (releasedOnly) {
      const today = this._todayKey();
      const currentYear = Number(today.slice(0, 4));
      conditions.push(`(
        (s.air_date GLOB '????-??-??' AND s.air_date <= ?)
        OR ((s.air_date IS NULL OR s.air_date = '' OR s.air_date NOT GLOB '????-??-??')
          AND s.year IS NOT NULL AND s.year <= ?)
      )`);
      params.push(today, currentYear);
    }
    if (requireRated) {
      conditions.push('(s.rating > 0 AND (s.votes >= 10 OR s.rank > 0))');
    }

    const orderBy = this._resolveOrderBy(sort);

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const tagJoin = tagList.length > 0
      ? `JOIN (SELECT bgm_id FROM bangumi_subject_tags WHERE tag IN (${tagList.map(() => '?').join(',')}) GROUP BY bgm_id HAVING COUNT(DISTINCT tag) = ?) AS t ON s.bgm_id = t.bgm_id`
      : '';
    const tagParams = tagList.length > 0 ? [...tagList, tagList.length] : [];

    // 计算总数
    const countSql = `SELECT COUNT(*) as n FROM bangumi_subjects s ${tagJoin} ${where}`;
    const countRow = this.db.prepare(countSql).get(...tagParams, ...params);
    const total = countRow ? countRow.n : 0;

    // 查询数据
    const dataSql = `SELECT s.* FROM bangumi_subjects s ${tagJoin} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(dataSql).all(...tagParams, ...params, safePageSize, offset);

    return {
      data: rows.map(row => this._rowToSummary(row)),
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages: Math.ceil(total / safePageSize) || 1,
      fromIndex: true
    };
  }

  /**
   * 按 bgm_id 查询单个条目
   */
  getSubjectByBgmId(bgmId) {
    if (!this.db || !bgmId) return null;
    const row = this.db.prepare(`SELECT * FROM bangumi_subjects WHERE bgm_id = ?`).get(Number(bgmId));
    return row ? this._rowToSummary(row) : null;
  }

  /**
   * 按星期查询（新番时间表）
   * weekday: 1=周一 ... 7=周日（Bangumi 约定）
   */
  queryByWeekday(weekday) {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT * FROM bangumi_subjects WHERE air_weekday = ? ORDER BY rating DESC`
    ).all(Number(weekday));
    return rows.map(row => this._rowToSummary(row));
  }

  /**
   * 获取所有已索引的条目数
   */
  getIndexCount() {
    if (!this.db) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM bangumi_subjects`).get();
    return row ? row.n : 0;
  }

  // ── 后台同步 ────────────────────────────────────────────

  /**
   * 同步季度番剧（写入索引）
   * @param {number} year
   * @param {number} season - 1=冬 2=春 3=夏 4=秋
   */
  async syncSeason(year, season) {
    if (!this.db) return { synced: 0, fromCache: false };
    try {
      const result = await bangumiApi.getSeasonAnime(year, season, 1);
      const subjects = (result.data || []).map(item => this._normalizeForIndex(item));
      const synced = await this.upsertSubjects(subjects);
      this._setSyncState(`season:${year}:${season}`, { synced, at: Date.now() });
      console.log(`[SubjectIndex] 同步季度 ${year}Q${season}: ${synced} 条`);
      return { synced, fromCache: false };
    } catch (e) {
      console.warn(`[SubjectIndex] 同步季度 ${year}Q${season} 失败:`, e.message);
      return { synced: 0, fromCache: false, error: e.message };
    }
  }

  /**
   * 同步日历（当前季度所有番剧）
   */
  async syncCalendar() {
    if (!this.db) return { synced: 0, fromCache: false };
    try {
      const schedule = await bangumiApi.getSchedule();
      const subjects = [];
      (schedule || []).forEach(day => {
        (day.items || []).forEach(item => subjects.push(this._normalizeForIndex(item, day.weekday)));
      });
      const synced = await this.upsertSubjects(subjects);
      this._setSyncState('calendar', { synced, at: Date.now() });
      console.log(`[SubjectIndex] 同步日历: ${synced} 条`);
      return { synced, fromCache: false };
    } catch (e) {
      console.warn('[SubjectIndex] 同步日历失败:', e.message);
      return { synced: 0, fromCache: false, error: e.message };
    }
  }

  /**
   * 同步搜索结果（keyword 搜索时顺带写入索引）
   */
  async syncSearch(keyword) {
    if (!this.db || !keyword) return { synced: 0 };
    try {
      const result = await bangumiApi.search(keyword, 1);
      const subjects = (result.data || []).map(item => this._normalizeForIndex(item));
      const synced = await this.upsertSubjects(subjects);
      return { synced };
    } catch (e) {
      return { synced: 0, error: e.message };
    }
  }

  /**
   * 详情过期则同步（不阻塞，静默补全）
   */
  async syncDetailIfStale(bgmId) {
    if (!this.db || !bgmId) return null;
    const existing = this.getSubjectByBgmId(bgmId);
    const now = Date.now();
    // 详情未过期：直接返回
    if (existing && existing.updated_at && (now - existing.updated_at < this.DETAIL_STALE_MS)) {
      return existing;
    }
    try {
      const detail = await bangumiApi.getDetail(bgmId);
      if (detail) {
        await this.upsertDetail(this._normalizeForIndex(detail));
        return this.getSubjectByBgmId(bgmId);
      }
    } catch (e) {
      console.warn(`[SubjectIndex] 详情同步失败 ${bgmId}:`, e.message);
    }
    return existing;
  }

  /**
   * 获取同步状态
   */
  getSyncStatus() {
    if (!this.db) return { indexed: 0, lastSync: {} };
    const indexed = this.getIndexCount();
    const rows = this.db.prepare(`SELECT key, value, updated_at FROM bangumi_sync_state`).all();
    const lastSync = {};
    for (const row of rows) {
      try {
        lastSync[row.key] = { ...JSON.parse(row.value), updatedAt: row.updated_at };
      } catch (_e) {
        lastSync[row.key] = { updatedAt: row.updated_at };
      }
    }
    return { indexed, lastSync };
  }

  // ── 内部辅助 ────────────────────────────────────────────

  _todayKey() {
    const now = new Date();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${m}-${d}`;
  }

  /**
   * 将数据库行转换为 SubjectSummary（与 SubjectService._toSubjectSummary 一致）
   */
  _rowToSummary(row) {
    if (!row) return null;
    let aliases = [];
    try { aliases = row.aliases ? JSON.parse(row.aliases) : []; } catch (_e) { aliases = []; }
    return {
      id: `bangumi_${row.bgm_id}`,
      bgmId: row.bgm_id,
      bgm_id: row.bgm_id,
      name: row.name_cn || row.name || '',
      nameRaw: row.name || '',
      name_raw: row.name || '',
      aliases,
      cover: row.cover_url || '',
      rating: row.rating || 0,
      rank: row.rank || 0,
      votes: row.votes || 0,
      airDate: row.air_date || '',
      air_date: row.air_date || '',
      airWeekday: row.air_weekday || 0,
      air_weekday: row.air_weekday || 0,
      tags: [],
      source: 'bangumi',
      // 索引仅存储动画条目（type=2），统一返回 ['动漫'] 与 _normalizeItem 一致
      type: ['动漫'],
      year: row.year || '',
      // platform 存储 TV/OVA/剧场版/WEB 等平台信息，与 _normalizeItem 的 area 字段一致
      area: row.platform || '',
      platform: row.platform || '',
      intro: row.summary || '',
      remarks: '',
      episode_count: row.eps || 0,
      planned_episode_count: row.eps || 0,
      total_episode_count: row.eps || 0,
      available_episode_count: 0,
      url: '',
      week_day_cn: '',
      updated_at: row.updated_at,
      fromIndex: true
    };
  }

  /**
   * 将 BangumiApi._normalizeItem 的输出转换为 upsert 需要的格式
   * （字段名对齐，cover 已经被 _normalizeImageUrl 处理过）
   */
  _normalizeForIndex(item, weekday) {
    const tags = Array.isArray(item.tags)
      ? item.tags.map(t => typeof t === 'string' ? { name: t, count: 0 } : t)
      : [];
    return {
      bgmId: item.bgm_id || item.id,
      bgm_id: item.bgm_id || item.id,
      name: item.name || '',
      name_raw: item.name_raw || item.nameRaw || '',
      aliases: item.aliases || [],
      cover: item.cover || '',
      rating: item.rating || 0,
      rank: item.rank || 0,
      votes: item.votes || 0,
      air_date: item.air_date || item.airDate || '',
      air_weekday: item.air_weekday || item.airWeekday || (weekday && weekday.id) || 0,
      tags,
      type: item.type || ['动漫'],
      episode_count: item.episode_count || item.eps || 0,
      planned_episode_count: item.planned_episode_count || item.total_episode_count || item.episode_count || item.eps || 0,
      total_episode_count: item.total_episode_count || item.planned_episode_count || item.episode_count || item.eps || 0,
      intro: item.intro || item.summary || '',
      year: resolveSubjectYear(item, item.air_date || item.airDate || ''),
      nsfw: item.nsfw || false,
      // 保留 platform 和 area，upsertSubjects/upsertDetail 会通过 item.platform || item.area fallback 写入 DB
      platform: item.platform || item.area || '',
      area: item.area || item.platform || ''
    };
  }

  _resolveOrderBy(sort = 'popular') {
    if (sort === 'latest') {
      return "CASE WHEN s.air_date GLOB '????-??-??' THEN 0 ELSE 1 END ASC, s.air_date DESC, CASE WHEN s.rank > 0 THEN s.rank ELSE 2147483647 END ASC, s.bgm_id DESC";
    }
    if (sort === 'rating') {
      return 'CASE WHEN s.rating > 0 THEN 0 ELSE 1 END ASC, s.rating DESC, s.votes DESC, CASE WHEN s.rank > 0 THEN s.rank ELSE 2147483647 END ASC, s.bgm_id ASC';
    }
    return 'CASE WHEN s.rank > 0 THEN 0 ELSE 1 END ASC, s.rank ASC, s.rating DESC, s.votes DESC, s.bgm_id ASC';
  }

  _setSyncState(key, value) {
    if (!this.db) return;
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO bangumi_sync_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), now);
    } catch (e) {
      // ignore
    }
  }
}

module.exports = new SubjectIndexService();
