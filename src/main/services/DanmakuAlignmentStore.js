// 弹幕时间轴对齐的持久化
//
// 一个校准结果归属于「剧集身份 + 播放源 + 弹幕源」（同一集换源/换弹幕源都需要各自的偏移）。
// 语义（cuts/inserts 的方向、单位）见 src/renderer/utils/danmakuAlignment.js；
// 主进程只做轻量清洗与存取，真正的映射计算在渲染层完成。

const MAX_RANGES = 20;          // 单侧区间条数上限，防脏数据
const MAX_RANGE_SECONDS = 1800; // 单个区间上限 30 分钟

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sanitizeRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .slice(0, MAX_RANGES)
    .map(range => {
      const start = Math.max(0, toFiniteNumber(range?.start, 0));
      const end = Math.min(Math.max(start, toFiniteNumber(range?.end, start)), start + MAX_RANGE_SECONDS);
      return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
    })
    .filter(range => range.end - range.start >= 0.2)
    .sort((a, b) => a.start - b.start);
}

function sanitizeAlignment(alignment) {
  const source = alignment && typeof alignment === 'object' ? alignment : {};
  const offset = Math.max(-MAX_RANGE_SECONDS, Math.min(MAX_RANGE_SECONDS, toFiniteNumber(source.offset, 0)));
  return {
    offset: Math.round(offset * 10) / 10,
    cuts: sanitizeRanges(source.cuts),
    inserts: sanitizeRanges(source.inserts)
  };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

function normalizeKey(value) {
  return String(value || '').trim().slice(0, 300);
}

class DanmakuAlignmentStore {
  constructor() {
    this.db = null;
  }

  setDatabase(db) {
    this.db = db && typeof db.prepare === 'function'
      ? db
      : (db && db.db && typeof db.db.prepare === 'function' ? db.db : null);
  }

  _rowToRecord(row) {
    if (!row) return null;
    return {
      episodeKey: row.episode_key,
      workKey: row.work_key || '',
      sourceId: row.source_id || '',
      providerId: row.provider_id || '',
      alignment: {
        offset: toFiniteNumber(row.offset, 0),
        cuts: parseJsonArray(row.cuts),
        inserts: parseJsonArray(row.inserts)
      },
      updatedAt: row.updated_at || 0
    };
  }

  /** 读取某集某源某弹幕源的校准；不存在返回 null */
  get({ episodeKey, sourceId = '', providerId = '' } = {}) {
    if (!this.db) return null;
    const key = normalizeKey(episodeKey);
    if (!key) return null;
    try {
      const row = this.db.prepare(
        `SELECT * FROM danmaku_alignments WHERE episode_key = ? AND source_id = ? AND provider_id = ?`
      ).get(key, normalizeKey(sourceId), normalizeKey(providerId));
      return this._rowToRecord(row);
    } catch (error) {
      console.error('[DanmakuAlignment] 读取失败:', error.message);
      return null;
    }
  }

  /** 保存（upsert）一份校准；alignment 全空时等价于删除，避免留下无意义记录 */
  save({ episodeKey, workKey = '', bgmId = null, episodeNumber = null, sourceId = '', providerId = '', alignment } = {}) {
    if (!this.db) return { ok: false, error: '数据库未就绪' };
    const key = normalizeKey(episodeKey);
    if (!key) return { ok: false, error: '缺少剧集身份' };
    const clean = sanitizeAlignment(alignment);
    const isEmpty = clean.offset === 0 && clean.cuts.length === 0 && clean.inserts.length === 0;
    if (isEmpty) return this.remove({ episodeKey: key, sourceId, providerId });

    const now = Date.now();
    const sid = normalizeKey(sourceId);
    const pid = normalizeKey(providerId);
    try {
      this.db.prepare(`
        INSERT INTO danmaku_alignments
          (episode_key, work_key, bgm_id, episode_number, source_id, provider_id, offset, cuts, inserts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(episode_key, source_id, provider_id) DO UPDATE SET
          work_key = excluded.work_key,
          bgm_id = excluded.bgm_id,
          episode_number = excluded.episode_number,
          offset = excluded.offset,
          cuts = excluded.cuts,
          inserts = excluded.inserts,
          updated_at = excluded.updated_at
      `).run(
        key,
        normalizeKey(workKey),
        Number.isFinite(Number(bgmId)) ? Number(bgmId) : null,
        Number.isFinite(Number(episodeNumber)) ? Number(episodeNumber) : null,
        sid,
        pid,
        clean.offset,
        JSON.stringify(clean.cuts),
        JSON.stringify(clean.inserts),
        now,
        now
      );
      return { ok: true, record: this.get({ episodeKey: key, sourceId: sid, providerId: pid }) };
    } catch (error) {
      console.error('[DanmakuAlignment] 保存失败:', error.message);
      return { ok: false, error: error.message };
    }
  }

  remove({ episodeKey, sourceId = '', providerId = '' } = {}) {
    if (!this.db) return { ok: false, error: '数据库未就绪' };
    const key = normalizeKey(episodeKey);
    if (!key) return { ok: false, error: '缺少剧集身份' };
    try {
      const result = this.db.prepare(
        `DELETE FROM danmaku_alignments WHERE episode_key = ? AND source_id = ? AND provider_id = ?`
      ).run(key, normalizeKey(sourceId), normalizeKey(providerId));
      return { ok: true, removed: result.changes || 0 };
    } catch (error) {
      console.error('[DanmakuAlignment] 删除失败:', error.message);
      return { ok: false, error: error.message };
    }
  }

  /**
   * 同作品同源的历史偏移建议：≥2 集校准过、且偏移足够一致时给一个初值，
   * 让下一集不用从零手调（思路与 Episode DNA 的三集稳定自动跳过一致）。
   */
  getWorkSuggestion({ workKey = '', sourceId = '', excludeEpisodeKey = '' } = {}) {
    if (!this.db) return null;
    const work = normalizeKey(workKey);
    if (!work) return null;
    try {
      const rows = this.db.prepare(
        `SELECT episode_key, offset FROM danmaku_alignments
         WHERE work_key = ? AND source_id = ? AND episode_key != ?`
      ).all(work, normalizeKey(sourceId), normalizeKey(excludeEpisodeKey));
      const offsets = rows.map(row => toFiniteNumber(row.offset, 0)).sort((a, b) => a - b);
      if (offsets.length < 2) return null;
      const median = offsets[Math.floor(offsets.length / 2)];
      const spread = Math.max(...offsets.map(value => Math.abs(value - median)));
      if (spread > 3) return null;
      return { offset: Math.round(median * 10) / 10, sampleCount: offsets.length };
    } catch (error) {
      console.error('[DanmakuAlignment] 历史偏移统计失败:', error.message);
      return null;
    }
  }
}

module.exports = new DanmakuAlignmentStore();
module.exports.DanmakuAlignmentStore = DanmakuAlignmentStore;