// 列表页 aired-eps 快照批量预取
//
// 背景：SubjectService._toSubjectSummary 需要读 `bangumi:aired-eps:v2:<bgmId>`
// 缓存来补全集数；列表页逐条调用会退化成 N+1 次同步查询（better-sqlite3 同步 API，
// 一页 24 条 = 24 次查询，时间表单次上百次），阻塞主进程。
// 这里把整页的键一次 IN 查询取回，调用方再按条目取值。

const SNAPSHOT_PREFIX = 'bangumi:aired-eps:v2:';

function airedEpisodeSnapshotKey(bgmId) {
  return `${SNAPSHOT_PREFIX}${bgmId}`;
}

/**
 * 批量预取 aired-eps 快照
 * @param {object} db - AnimeDatabase 实例（需要 getCacheAnyMany）
 * @param {Array} items - 原始列表项
 * @returns {Map<string, {content: any, expired: boolean}>|null} key 为快照缓存键；
 *   db 不支持批量读时返回 null，调用方回退为逐条查询
 */
function prefetchAiredEpisodeSnapshots(db, items = []) {
  if (!db?.getCacheAnyMany) return null;
  const snapshots = new Map();
  if (!Array.isArray(items) || !items.length) return snapshots;
  const keys = [];
  for (const item of items) {
    // AniList 条目没有 bgm_id，也不会读该快照
    if (!item || item.source === 'anilist' || item.anilistId || item.anilist_id) continue;
    const bgmId = item.bgm_id || item.id;
    if (bgmId) keys.push(airedEpisodeSnapshotKey(bgmId));
  }
  return db.getCacheAnyMany(keys) || snapshots;
}

module.exports = { SNAPSHOT_PREFIX, airedEpisodeSnapshotKey, prefetchAiredEpisodeSnapshots };