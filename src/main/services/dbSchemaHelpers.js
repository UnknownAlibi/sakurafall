// AnimeDatabase 补充表 DDL
//
// 从 AnimeDatabase 抽离（该文件处于「只缩不涨」的棘轮预算内）：
// 这些建表语句是纯 DDL，与连接/迁移流程无关，放在独立模块便于维护。

/**
 * 观看手帐表（含剧集身份索引）
 * @param {import('better-sqlite3').Database} db
 */
function createViewingNotesTable(db) {
  db.exec(`
            CREATE TABLE IF NOT EXISTS viewing_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_key TEXT NOT NULL,
                work_key TEXT DEFAULT '',
                bgm_id INTEGER DEFAULT NULL,
                anime_name TEXT DEFAULT '',
                episode_number INTEGER DEFAULT NULL,
                episode_title TEXT DEFAULT '',
                position REAL NOT NULL DEFAULT 0,
                duration REAL NOT NULL DEFAULT 0,
                note TEXT DEFAULT '',
                category TEXT DEFAULT '',
                source_id TEXT DEFAULT '',
                created_at INTEGER NOT NULL
            )
        `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_viewing_notes_episode ON viewing_notes(episode_key, position)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_viewing_notes_created ON viewing_notes(created_at DESC)');
}

/**
 * Episode DNA P1：用户确认过的片头/片尾/广告段/关键剧情时间段
 * kind ∈ intro(片头) / outro(片尾) / ad(广告) / highlight(关键剧情)
 * origin ∈ user(手动标记) / dna(分析候选被确认)
 * @param {import('better-sqlite3').Database} db
 */
function createEpisodeSegmentsTable(db) {
  db.exec(`
            CREATE TABLE IF NOT EXISTS episode_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                episode_key TEXT NOT NULL,
                work_key TEXT DEFAULT '',
                bgm_id INTEGER DEFAULT NULL,
                anime_name TEXT DEFAULT '',
                episode_number INTEGER DEFAULT NULL,
                episode_title TEXT DEFAULT '',
                kind TEXT NOT NULL,
                start REAL NOT NULL DEFAULT 0,
                end REAL NOT NULL DEFAULT 0,
                confirmed INTEGER NOT NULL DEFAULT 0,
                origin TEXT DEFAULT 'user',
                note TEXT DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
        `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_episode_segments_episode ON episode_segments(episode_key, kind)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_episode_segments_work ON episode_segments(work_key, kind, confirmed)');
}

module.exports = { createViewingNotesTable, createEpisodeSegmentsTable };