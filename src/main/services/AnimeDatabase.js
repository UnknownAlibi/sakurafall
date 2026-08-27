// 文件路径: src/main/services/AnimeDatabase.js
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const {
    dedupePlayHistoryRows,
    getPlayHistoryIdentity,
    normalizeHistoryTitle,
    toPositiveInteger
} = require('../utils/playHistoryIdentity');

const SCHEMA_VERSION = 5;

class AnimeDatabase {
    constructor() {
        this.db = null;
        // 内存累积 last_used 变更，避免每次 getCache 命中都同步写阻塞主进程
        this._lastUsedPending = new Map(); // cache_key -> timestamp
        this._lastUsedFlushTimer = null;
        this._lastUsedFlushInterval = 30000; // 30 秒批量 flush 一次
        this._cacheEntryCount = null;
        this.MAX_CACHE_ENTRIES = 500;
        // 写队列：非关键写入（历史更新、缓存写入）缓冲后批量执行，避免同步阻塞主进程
        this._writeQueue = [];
        this._writeQueueTimer = null;
        this._writeQueueFlushInterval = 2000; // 2 秒 flush 一次
        this._writeQueueMaxSize = 50; // 队列上限，超过立即 flush
    }

    /**
     * 批量 flush 累积的 last_used 变更到数据库（单事务，避免多次同步写）
     */
    _flushLastUsed() {
        if (!this.db || this._lastUsedPending.size === 0) return;
        const entries = Array.from(this._lastUsedPending.entries());
        try {
            const stmt = this.db.prepare(`UPDATE cms_cache SET last_used = ? WHERE cache_key = ?`);
            const tx = this.db.transaction((items) => {
                for (const [key, ts] of items) stmt.run(ts, key);
            });
            tx(entries);
            this._lastUsedPending.clear();
        } catch (e) {
            // 失败则保留 pending，下次重试，不影响读取流程
        }
    }

    _scheduleLastUsedFlush() {
        if (this._lastUsedFlushTimer) return;
        this._lastUsedFlushTimer = setInterval(() => this._flushLastUsed(), this._lastUsedFlushInterval);
        // 不阻止进程退出
        if (this._lastUsedFlushTimer.unref) this._lastUsedFlushTimer.unref();
    }

    // ── 写队列：非关键写入异步化，避免同步阻塞主进程 ──

    /**
     * 将写入操作加入队列，延迟批量执行
     * @param {Function} fn - 返回 prepared statement run 的函数，接收 db 参数
     */
    _enqueueWrite(fn) {
        this._writeQueue.push(fn);
        // 队列满则立即 flush
        if (this._writeQueue.length >= this._writeQueueMaxSize) {
            this._flushWriteQueue();
            return;
        }
        // 否则调度定时 flush
        if (!this._writeQueueTimer) {
            this._writeQueueTimer = setTimeout(() => {
                this._writeQueueTimer = null;
                this._flushWriteQueue();
            }, this._writeQueueFlushInterval);
            if (this._writeQueueTimer.unref) this._writeQueueTimer.unref();
        }
    }

    /**
     * 批量执行队列中的写入操作（单事务）
     */
    _flushWriteQueue() {
        if (this._writeQueueTimer) {
            clearTimeout(this._writeQueueTimer);
            this._writeQueueTimer = null;
        }
        if (!this.db || this._writeQueue.length === 0) return;
        const ops = this._writeQueue.splice(0);
        try {
            const tx = this.db.transaction(() => {
                for (const fn of ops) {
                    try {
                        fn(this.db);
                    } catch (error) {
                        console.warn('[DB] 延迟写入失败:', error.message);
                    }
                }
            });
            tx();
        } catch (error) {
            console.error('[DB] 延迟写入事务失败:', error);
        }
    }

    connect() {
        try {
            const Database = require('better-sqlite3');
            // 开发环境使用项目根目录，避免 TRAE 等沙箱环境对 AppData 的读写限制
            // 生产环境使用用户数据目录
            // 注意：某些情况下 app.isPackaged 在 dev 模式下也会返回 true，因此通过 execPath 辅助判断
            const isElectronDev = /electron(?:\.exe)?$/i.test(process.execPath);
            const basePath = (app.isPackaged && !isElectronDev)
                ? app.getPath('userData')
                : path.join(__dirname, '../../..');
            this.dbPath = path.join(basePath, 'anime.db');
            const dir = path.dirname(this.dbPath);

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const databaseExisted = fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0;
            this.db = new Database(this.dbPath);

            if (databaseExisted) this._backupBeforeMigration();

            // 启用 WAL 模式提升并发性能（失败则回退到普通模式）
            try {
                this.db.pragma('journal_mode = WAL');
            } catch (walErr) {
                console.warn('[DB] WAL 模式启用失败，回退到普通模式:', walErr.message);
            }

            // 启用外键约束
            this.db.pragma('foreign_keys = ON');
            console.log('[DB] 数据库连接成功:', this.dbPath);

            // 创建收藏表 + 播放历史表
            this._createTables();
            // 启动写队列定时 flush
            this._scheduleLastUsedFlush();
            return true;
        } catch (error) {
            console.error('[DB] 数据库连接失败:', error);
            console.error('[DB] 目标路径:', this.dbPath);
            return false;
        }
    }

    /**
     * 创建收藏表 + 播放历史表（如果不存在）
     */
    _createTables() {
        const favSql = `
            CREATE TABLE IF NOT EXISTS favorites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'legacy',
                name TEXT NOT NULL,
                cover TEXT DEFAULT '',
                intro TEXT DEFAULT '',
                year TEXT DEFAULT '',
                area TEXT DEFAULT '',
                type TEXT DEFAULT '',
                episode_count INTEGER DEFAULT 0,
                bgm_id INTEGER DEFAULT NULL,
                last_episode TEXT DEFAULT '',
                last_episode_index INTEGER DEFAULT -1,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(anime_id, source)
            )
        `;
        const historySql = `
            CREATE TABLE IF NOT EXISTS play_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                anime_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'legacy',
                name TEXT NOT NULL,
                cover TEXT DEFAULT '',
                episode_title TEXT DEFAULT '',
                episode_index INTEGER DEFAULT -1,
                play_url TEXT DEFAULT '',
                anime_data TEXT DEFAULT '',
                play_position REAL DEFAULT 0,
                bgm_id INTEGER DEFAULT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(anime_id, source)
            )
        `;

        this.db.exec(favSql);
        console.log('收藏表就绪');

        this.db.exec(historySql);
        console.log('播放历史表就绪');

        // CMS 接口缓存表（列表/详情）
        const cacheSql = `
            CREATE TABLE IF NOT EXISTS cms_cache (
                cache_key TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_used INTEGER NOT NULL
            )
        `;
        this.db.exec(cacheSql);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cms_cache_expires ON cms_cache(expires_at)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cms_cache_source ON cms_cache(source_id, kind)`);
        console.log('CMS 缓存表就绪');

        // ── Bangumi 本地索引（P0：本地索引为主，网络同步为辅）──
        // 详见 docs/next-stage-rebuild-plan.md
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bangumi_subjects (
                bgm_id INTEGER PRIMARY KEY,
                name TEXT,
                name_cn TEXT,
                aliases TEXT,
                summary TEXT,
                cover_url TEXT,
                cover_local TEXT,
                rating REAL,
                rank INTEGER,
                votes INTEGER,
                eps INTEGER,
                air_date TEXT,
                air_weekday INTEGER,
                year INTEGER,
                month INTEGER,
                type INTEGER,
                nsfw INTEGER DEFAULT 0,
                popularity INTEGER DEFAULT 0,
                updated_at INTEGER NOT NULL,
                raw_json TEXT
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bangumi_subject_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bgm_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                count INTEGER DEFAULT 0,
                UNIQUE(bgm_id, tag)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bangumi_sync_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at INTEGER NOT NULL
            )
        `);
        // 索引：支持按播出日期/评分/排名/年份/类型/标签查询
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bgm_subject_air_date ON bangumi_subjects(air_date)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bgm_subject_rating ON bangumi_subjects(rating)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bgm_subject_rank ON bangumi_subjects(rank)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bgm_subject_year ON bangumi_subjects(year)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bgm_subject_type ON bangumi_subjects(type)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_bgm_tag_tag ON bangumi_subject_tags(tag)`);
        this._runMigrations();
        console.log('Bangumi 索引表就绪');
    }

    _getUserVersion() {
        if (!this.db) return 0;
        const value = this.db.pragma('user_version', { simple: true });
        return Number.isFinite(Number(value)) ? Number(value) : 0;
    }

    _backupBeforeMigration() {
        const currentVersion = this._getUserVersion();
        if (currentVersion >= SCHEMA_VERSION || !this.dbPath || !fs.existsSync(this.dbPath)) return;
        try {
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            const backupPath = `${this.dbPath}.pre-v${currentVersion}-to-v${SCHEMA_VERSION}.backup`;
            if (!fs.existsSync(backupPath)) fs.copyFileSync(this.dbPath, backupPath);
        } catch (error) {
            console.warn('[DB] 迁移前备份失败，将继续执行幂等迁移:', error.message);
        }
    }

    _runMigrations() {
        const migrations = [
            {
                version: 1,
                run: () => {
                    this._addColumnIfNotExists('favorites', 'last_episode', 'TEXT DEFAULT ""');
                    this._addColumnIfNotExists('favorites', 'last_episode_index', 'INTEGER DEFAULT -1');
                    this._addColumnIfNotExists('favorites', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
                    this._addColumnIfNotExists('favorites', 'bgm_id', 'INTEGER DEFAULT NULL');
                    this._addColumnIfNotExists('play_history', 'play_position', 'REAL DEFAULT 0');
                    this._addColumnIfNotExists('play_history', 'bgm_id', 'INTEGER DEFAULT NULL');
                    const requiredColumns = [
                        ['favorites', 'last_episode'],
                        ['favorites', 'last_episode_index'],
                        ['favorites', 'updated_at'],
                        ['favorites', 'bgm_id'],
                        ['play_history', 'play_position'],
                        ['play_history', 'bgm_id']
                    ];
                    for (const [table, column] of requiredColumns) {
                        if (!this._hasColumn(table, column)) throw new Error(`迁移后缺少字段 ${table}.${column}`);
                    }
                }
            },
            {
                version: 2,
                run: () => {
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_bgm_id ON favorites(bgm_id)');
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_play_history_bgm_id ON play_history(bgm_id)');
                    this.db.exec('CREATE INDEX IF NOT EXISTS idx_play_history_updated ON play_history(updated_at)');
                    this.db.exec('UPDATE play_history SET play_position = 0 WHERE play_position IS NULL OR play_position < 0');
                }
            },
            {
                version: 3,
                run: () => {
                    // bangumi_subjects 添加 platform 列，存储 TV/OVA/剧场版/WEB 等平台信息
                    this._addColumnIfNotExists('bangumi_subjects', 'platform', "TEXT DEFAULT ''");
                }
            },
            {
                version: 4,
                run: () => {
                    // 清除旧索引数据（platform 为空的记录），这些记录在添加 platform 列之前写入，
                    // 缺少 platform 信息，会导致索引回退时卡片不显示 TV/OVA/剧场版 等类型标签。
                    // 清除后应用会在浏览时重新从 API 获取并写入正确的 platform。
                    try {
                        const deleted = this.db.prepare("DELETE FROM bangumi_subjects WHERE platform IS NULL OR platform = ''").run();
                        if (deleted.changes > 0) {
                            console.log(`[DB] v4 迁移: 清除 ${deleted.changes} 条 platform 为空的旧索引记录`);
                        }
                    } catch (e) {
                        console.warn('[DB] v4 迁移: 清除旧索引记录失败:', e.message);
                    }
                    // 清除旧 catalog/browse 缓存，这些缓存中的数据缺少 platform 字段（_toSubjectSummary 旧版本不输出 platform），
                    // 且可能包含旧的 area 为空的数据。清除后应用会重新从 API 获取完整数据。
                    try {
                        const cacheDeleted = this.db.prepare("DELETE FROM cms_cache WHERE cache_key LIKE 'bangumi:catalog:%' OR cache_key LIKE 'bangumi:browse:%'").run();
                        if (cacheDeleted.changes > 0) {
                            console.log(`[DB] v4 迁移: 清除 ${cacheDeleted.changes} 条旧 catalog/browse 缓存`);
                        }
                    } catch (e) {
                        console.warn('[DB] v4 迁移: 清除旧缓存失败:', e.message);
                    }
                }
            },
            {
                version: 5,
                run: () => {
                    const rows = this.db.prepare(`
                        SELECT id, anime_id, source, name, bgm_id, anime_data, updated_at
                        FROM play_history
                        ORDER BY updated_at DESC, id DESC
                    `).all();
                    const seen = new Set();
                    const duplicateIds = [];
                    for (const row of rows) {
                        const identity = getPlayHistoryIdentity(row);
                        if (seen.has(identity)) duplicateIds.push(row.id);
                        else seen.add(identity);
                    }
                    if (duplicateIds.length > 0) {
                        const remove = this.db.prepare('DELETE FROM play_history WHERE id = ?');
                        for (const id of duplicateIds) remove.run(id);
                        console.log(`[DB] v5 migration: removed ${duplicateIds.length} duplicate history rows`);
                    }
                }
            }
        ];

        let currentVersion = this._getUserVersion();
        for (const migration of migrations) {
            if (migration.version <= currentVersion) continue;
            const transaction = this.db.transaction(() => {
                migration.run();
                this.db.pragma(`user_version = ${migration.version}`);
            });
            transaction();
            currentVersion = migration.version;
            console.log(`[DB] schema 已升级到 v${currentVersion}`);
        }
    }

    getHealthStatus() {
        if (!this.db) return { connected: false, schemaVersion: 0, integrity: 'not-connected' };
        let integrity = 'unknown';
        try {
            integrity = String(this.db.pragma('integrity_check', { simple: true }) || 'unknown');
        } catch (error) {
            integrity = `error: ${error.message}`;
        }
        return {
            connected: true,
            schemaVersion: this._getUserVersion(),
            expectedSchemaVersion: SCHEMA_VERSION,
            integrity,
            wal: String(this.db.pragma('journal_mode', { simple: true }) || ''),
            path: this.dbPath
        };
    }

    // ── CMS 接口缓存 ────────────────────────────────────────

    /**
     * 读取缓存（命中时自动更新 last_used）
     * @param {string} key - 缓存键
     * @returns {any|null} 缓存内容，未命中或过期返回 null
     */
    getCache(key) {
        if (!this.db) return null;
        const now = Date.now();
        const row = this.db.prepare(
            `SELECT content FROM cms_cache WHERE cache_key = ? AND expires_at > ?`
        ).get(key, now);
        if (!row) return null;
        // 命中时把 last_used 累积到内存，30s 批量 flush，避免主流程同步写阻塞
        this._lastUsedPending.set(key, now);
        this._scheduleLastUsedFlush();
        try {
            return JSON.parse(row.content);
        } catch (e) {
            console.warn('[DB] 缓存内容解析失败，删除脏数据:', key);
            this.db.prepare(`DELETE FROM cms_cache WHERE cache_key = ?`).run(key);
            return null;
        }
    }

    /**
     * 读取缓存（忽略过期检查），用于网络失败时的兜底
     * 返回 { content, expired } 或 null
     */
    getCacheAny(key) {
        if (!this.db) return null;
        const now = Date.now();
        const row = this.db.prepare(
            `SELECT content, expires_at FROM cms_cache WHERE cache_key = ?`
        ).get(key);
        if (!row) return null;
        try {
            return { content: JSON.parse(row.content), expired: row.expires_at <= now };
        } catch (e) {
            return null;
        }
    }

    /**
     * 写入缓存（upsert），并按容量上限淘汰最旧条目
     * @param {string} key - 缓存键
     * @param {string} sourceId - 数据源 ID
     * @param {string} kind - 缓存类型 'list' | 'detail'
     * @param {any} content - 缓存内容（会被 JSON.stringify）
     * @param {number} ttl - 有效期（毫秒）
     */
    setCache(key, sourceId, kind, content, ttl) {
        if (!this.db) return;
        const now = Date.now();
        const expiresAt = now + ttl;
        const contentStr = JSON.stringify(content);
        // 检查是否已存在（读取保持同步，确保计数准确）
        const existed = !!this.db.prepare(
            `SELECT 1 as ok FROM cms_cache WHERE cache_key = ?`
        ).get(key);

        if (this._cacheEntryCount === null) {
            this._cacheEntryCount = this.db.prepare(`SELECT COUNT(*) as n FROM cms_cache`).get().n;
        }

        // 缓存必须具备写后可读语义。better-sqlite3 + WAL 下单条 upsert 很轻量，
        // 延迟队列反而会让 clear/get/LRU 与待写数据产生竞态。
        this.db.prepare(`
            INSERT INTO cms_cache (cache_key, source_id, kind, content, created_at, expires_at, last_used)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                source_id = excluded.source_id,
                kind = excluded.kind,
                content = excluded.content,
                created_at = excluded.created_at,
                expires_at = excluded.expires_at,
                last_used = excluded.last_used
        `).run(key, sourceId, kind, contentStr, now, expiresAt, now);

        if (!existed) {
            this._cacheEntryCount += 1;
        }

        this._enforceCacheLimit();
    }

    _enforceCacheLimit() {
        if (!this.db || this._cacheEntryCount === null || this._cacheEntryCount <= this.MAX_CACHE_ENTRIES) {
            return;
        }

        this._flushLastUsed();
        const removeCount = this._cacheEntryCount - this.MAX_CACHE_ENTRIES;
        const info = this.db.prepare(`
                DELETE FROM cms_cache WHERE cache_key IN (
                    SELECT cache_key FROM cms_cache ORDER BY last_used ASC LIMIT ?
                )
            `).run(removeCount);
        this._cacheEntryCount = Math.max(0, this._cacheEntryCount - (info.changes || removeCount));
    }

    _resetCacheEntryCount() {
        this._cacheEntryCount = null;
        if (this.db) {
            this._cacheEntryCount = this.db.prepare(`SELECT COUNT(*) as n FROM cms_cache`).get().n;
        }
    }

    /**
     * 清除缓存
     * @param {object} options - { sourceId?, kind?, expiredOnly? }
     * @returns {number} 删除条数
     */
    clearCache(options = {}) {
        if (!this.db) return 0;
        const { sourceId, kind, expiredOnly } = options;
        const conditions = [];
        const params = [];
        if (sourceId) { conditions.push('source_id = ?'); params.push(sourceId); }
        if (kind) { conditions.push('kind = ?'); params.push(kind); }
        if (expiredOnly) { conditions.push('expires_at <= ?'); params.push(Date.now()); }
        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const info = this.db.prepare(`DELETE FROM cms_cache ${where}`).run(...params);
        this._resetCacheEntryCount();
        return info.changes;
    }

    /**
     * 安全地为表添加列（如果不存在）
     * 使用白名单校验防止 SQL 注入
     */
    _addColumnIfNotExists(table, column, definition) {
        const allowedTables = ['favorites', 'play_history', 'bangumi_subjects'];
        const allowedColumns = {
            favorites: ['last_episode', 'last_episode_index', 'updated_at', 'bgm_id'],
            play_history: ['play_position', 'bgm_id'],
            bangumi_subjects: ['platform']
        };

        if (!allowedTables.includes(table)) {
            console.warn(`拒绝修改未授权的表: ${table}`);
            return;
        }
        if (allowedColumns[table] && !allowedColumns[table].includes(column)) {
            console.warn(`拒绝添加未授权的列: ${table}.${column}`);
            return;
        }

        try {
            if (this._hasColumn(table, column)) return;
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        } catch (err) {
            // SQLite ALTER TABLE ADD COLUMN 如果列已存在会报错，忽略即可
            if (!err.message.includes('duplicate column')) {
                console.warn(`添加列 ${table}.${column} 失败:`, err.message);
            }
        }
    }

    _hasColumn(table, column) {
        return this.db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
    }

    // ── 收藏 CRUD ──────────────────────────────────────────

    /**
     * 添加收藏
     * 如果 anime 带 bgm_id，则按 bgm_id 去重：已有同 bgm_id 的收藏会被更新源信息（多源合并）
     * @param {Object} anime - 动漫信息 { id, source, name, cover, intro, year, area, type, episode_count, bgm_id? }
     */
    addFavorite(anime) {
        if (!this.db) throw new Error('数据库未连接');

        const bgmId = anime.bgm_id ? Number(anime.bgm_id) : null;

        // 有 bgm_id 时，按 bgm_id 去重：已存在则更新源信息，保留原 created_at
        if (bgmId) {
            const existing = this.db.prepare(`SELECT id FROM favorites WHERE bgm_id = ?`).get(bgmId);
            if (existing) {
                this.db.prepare(`
                    UPDATE favorites SET
                        anime_id = ?, source = ?, name = ?, cover = ?, intro = ?,
                        year = ?, area = ?, type = ?, episode_count = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(
                    String(anime.id),
                    anime.source || 'legacy',
                    anime.name || '',
                    anime.cover || '',
                    anime.intro || '',
                    anime.year || '',
                    anime.area || '',
                    Array.isArray(anime.type) ? anime.type.join(',') : (anime.type || ''),
                    anime.episode_count || 0,
                    existing.id
                );
                return { id: existing.id, changes: 1 };
            }
        }

        const sql = `
            INSERT OR IGNORE INTO favorites (anime_id, source, name, cover, intro, year, area, type, episode_count, bgm_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
            String(anime.id),
            anime.source || 'legacy',
            anime.name || '',
            anime.cover || '',
            anime.intro || '',
            anime.year || '',
            anime.area || '',
            Array.isArray(anime.type) ? anime.type.join(',') : (anime.type || ''),
            anime.episode_count || 0,
            bgmId
        ];
        const info = this.db.prepare(sql).run(...params);
        return { id: info.lastInsertRowid, changes: info.changes };
    }

    /**
     * 按 Bangumi ID 查询收藏（用于跨源关联）
     */
    findFavoriteByBgmId(bgmId) {
        if (!this.db) throw new Error('数据库未连接');
        if (!bgmId) return null;
        const row = this.db.prepare(`SELECT * FROM favorites WHERE bgm_id = ? LIMIT 1`).get(Number(bgmId));
        if (!row) return null;
        return {
            ...row,
            type: row.type ? row.type.split(',').filter(Boolean) : [],
            isFavorited: true,
            last_episode: row.last_episode || '',
            last_episode_index: row.last_episode_index ?? -1
        };
    }

    /**
     * 取消收藏
     * @param {string} animeId - 动漫ID
     * @param {string} source - 数据源
     */
    removeFavorite(animeId, source) {
        if (!this.db) throw new Error('数据库未连接');

        const sql = `DELETE FROM favorites WHERE anime_id = ? AND source = ?`;
        const info = this.db.prepare(sql).run(String(animeId), source || 'legacy');
        return { changes: info.changes };
    }

    /**
     * 获取收藏列表
     * @param {number} page - 页码
     * @param {number} limit - 每页数量
     */
    getFavoriteList(page = 1, limit = 50) {
        if (!this.db) throw new Error('数据库未连接');

        const offset = (page - 1) * limit;
        const sql = `SELECT * FROM favorites ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        const countSql = `SELECT COUNT(*) as total FROM favorites`;

        const favorites = this.db.prepare(sql).all(limit, offset);
        const countResult = this.db.prepare(countSql).get();

        return {
            data: favorites.map(f => ({
                ...f,
                type: f.type ? f.type.split(',').filter(Boolean) : [],
                isFavorited: true,
                last_episode: f.last_episode || '',
                last_episode_index: f.last_episode_index ?? -1
            })),
            total: countResult.total,
            page,
            limit,
            totalPages: Math.ceil(countResult.total / limit)
        };
    }

    /**
     * 检查是否已收藏
     * @param {string} animeId - 动漫ID
     * @param {string} source - 数据源
     */
    isFavorite(animeId, source) {
        if (!this.db) throw new Error('数据库未连接');

        const sql = `SELECT id FROM favorites WHERE anime_id = ? AND source = ?`;
        const row = this.db.prepare(sql).get(String(animeId), source || 'legacy');
        return !!row;
    }

    /**
     * 批量检查收藏状态
     * @param {Array} items - [{ id, source }]
     */
    checkFavorites(items) {
        if (!this.db || !items || items.length === 0) {
            return {};
        }
        const placeholders = items.map(() => '(anime_id = ? AND source = ?)').join(' OR ');
        const params = items.flatMap(item => [String(item.id), item.source || 'legacy']);
        const sql = `SELECT anime_id, source FROM favorites WHERE ${placeholders}`;

        const rows = this.db.prepare(sql).all(...params);
        const result = {};
        rows.forEach(row => {
            result[`${row.source}:${row.anime_id}`] = true;
        });
        return result;
    }

    // ── 播放历史 / 观看进度 ────────────────────────────────

    /**
     * 更新播放进度（upsert）
     * @param {Object} data - { anime_id, source, name, cover, episode_title, episode_index, play_url, anime_data, play_position, bgm_id? }
     */
    updatePlayHistory(data) {
        if (!this.db) throw new Error('数据库未连接');

        const bgmId = toPositiveInteger(data.bgm_id);

        const sql = `
            INSERT INTO play_history (anime_id, source, name, cover, episode_title, episode_index, play_url, anime_data, play_position, bgm_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(anime_id, source) DO UPDATE SET
                name = excluded.name,
                cover = excluded.cover,
                episode_title = excluded.episode_title,
                episode_index = excluded.episode_index,
                play_url = excluded.play_url,
                anime_data = excluded.anime_data,
                play_position = excluded.play_position,
                bgm_id = excluded.bgm_id,
                updated_at = CURRENT_TIMESTAMP
        `;
        const params = [
            String(data.anime_id),
            data.source || 'legacy',
            data.name || '',
            data.cover || '',
            data.episode_title || '',
            data.episode_index ?? -1,
            data.play_url || '',
            data.anime_data || '',
            data.play_position ?? 0,
            bgmId
        ];
        const info = this.db.prepare(sql).run(...params);
        this._removePlayHistoryAliases(this.db, {
            animeId: String(data.anime_id),
            source: data.source || 'legacy',
            bgmId,
            name: data.name || ''
        });
        return { id: info.lastInsertRowid, changes: info.changes };
    }

    /**
     * 获取最近播放列表（续播用）
     * @param {number} limit - 返回数量
     */
    getRecentPlayHistory(limit = 10) {
        if (!this.db) throw new Error('数据库未连接');

        const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
        const batchSize = Math.max(50, safeLimit * 5);
        const statement = this.db.prepare(`
            SELECT * FROM play_history
            ORDER BY updated_at DESC, id DESC
            LIMIT ? OFFSET ?
        `);
        const rows = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const batch = statement.all(batchSize, offset);
            rows.push(...batch);
            const uniqueRows = dedupePlayHistoryRows(rows, safeLimit);
            hasMore = batch.length === batchSize;
            if (uniqueRows.length >= safeLimit || !hasMore) return uniqueRows;
            offset += batch.length;
        }
        return dedupePlayHistoryRows(rows, safeLimit);
    }

    /**
     * 获取指定动漫的播放进度
     */
    getPlayProgress(animeId, source) {
        if (!this.db) throw new Error('数据库未连接');

        const sql = `SELECT * FROM play_history WHERE anime_id = ? AND source = ?`;
        const row = this.db.prepare(sql).get(String(animeId), source || 'legacy');
        if (row && row.anime_data) {
            row.anime_data = this._safeParseJSON(row.anime_data);
        }
        return row || null;
    }

    /**
     * 删除播放历史
     */
    removePlayHistory(animeId, source) {
        if (!this.db) throw new Error('数据库未连接');

        const normalizedAnimeId = String(animeId);
        const normalizedSource = source || 'legacy';
        const row = this.db.prepare(`
            SELECT anime_id, source, name, bgm_id, anime_data
            FROM play_history
            WHERE anime_id = ? AND source = ?
        `).get(normalizedAnimeId, normalizedSource);
        if (!row) return { changes: 0 };

        const info = this._deletePlayHistoryWork(this.db, row);
        return { changes: info.changes };
    }

    _removePlayHistoryAliases(db, { animeId, source, bgmId, name }) {
        if (bgmId) {
            return db.prepare(`
                DELETE FROM play_history
                WHERE bgm_id = ? AND NOT (anime_id = ? AND source = ?)
            `).run(bgmId, animeId, source);
        }

        const title = normalizeHistoryTitle(name);
        if (!title) return { changes: 0 };
        const candidates = db.prepare(`
            SELECT id, name FROM play_history
            WHERE (bgm_id IS NULL OR bgm_id <= 0)
              AND NOT (anime_id = ? AND source = ?)
        `).all(animeId, source);
        const remove = db.prepare('DELETE FROM play_history WHERE id = ?');
        let changes = 0;
        for (const candidate of candidates) {
            if (normalizeHistoryTitle(candidate.name) === title) {
                changes += remove.run(candidate.id).changes;
            }
        }
        return { changes };
    }

    _deletePlayHistoryWork(db, row) {
        const bgmId = toPositiveInteger(row.bgm_id)
            || toPositiveInteger(this._safeParseJSON(row.anime_data || '')?.bgm_id);
        if (bgmId) {
            return db.prepare('DELETE FROM play_history WHERE bgm_id = ?').run(bgmId);
        }

        const title = normalizeHistoryTitle(row.name);
        if (!title) {
            return db.prepare('DELETE FROM play_history WHERE anime_id = ? AND source = ?')
                .run(String(row.anime_id), row.source || 'legacy');
        }

        const candidates = db.prepare('SELECT id, name FROM play_history').all();
        const remove = db.prepare('DELETE FROM play_history WHERE id = ?');
        let changes = 0;
        for (const candidate of candidates) {
            if (normalizeHistoryTitle(candidate.name) === title) {
                changes += remove.run(candidate.id).changes;
            }
        }
        return { changes };
    }

    /**
     * 清空所有播放历史
     */
    clearPlayHistory() {
        if (!this.db) throw new Error('数据库未连接');

        const info = this.db.prepare(`DELETE FROM play_history`).run();
        return { changes: info.changes };
    }

    /**
     * 安全解析 JSON
     */
    _safeParseJSON(str) {
        try {
            return JSON.parse(str);
        } catch {
            return null;
        }
    }

    // ── 收藏进度更新 ──────────────────────────────────────

    /**
     * 更新收藏的观看进度
     */
    updateFavoriteProgress(animeId, source, episodeTitle, episodeIndex) {
        if (!this.db) throw new Error('数据库未连接');

        const sql = `
            UPDATE favorites SET last_episode = ?, last_episode_index = ?, updated_at = CURRENT_TIMESTAMP
            WHERE anime_id = ? AND source = ?
        `;
        const info = this.db.prepare(sql).run(episodeTitle || '', episodeIndex ?? -1, String(animeId), source || 'legacy');
        return { changes: info.changes };
    }

    /**
     * 合并写入：同时更新收藏进度 + 播放历史
     * 异步队列写入：历史更新是非关键写入，可容忍 2 秒延迟，避免每 10s 同步阻塞主进程
     */
    updateFavoriteAndHistory(data) {
        if (!this.db) throw new Error('数据库未连接');

        const bgmId = toPositiveInteger(data.bgm_id);
        const animeId = String(data.anime_id);
        const source = data.source || 'legacy';
        const epTitle = data.episode_title || '';
        const epIndex = data.episode_index ?? -1;
        const name = data.name || '';
        const cover = data.cover || '';
        const playUrl = data.play_url || '';
        const animeData = data.anime_data || '';
        const playPos = data.play_position ?? 0;

        // 加入写队列，延迟批量执行
        this._enqueueWrite((db) => {
            const updateFav = db.prepare(`
                UPDATE favorites SET last_episode = ?, last_episode_index = ?, updated_at = CURRENT_TIMESTAMP
                WHERE anime_id = ? AND source = ?
            `);
            const upsertHistory = db.prepare(`
                INSERT INTO play_history (anime_id, source, name, cover, episode_title, episode_index, play_url, anime_data, play_position, bgm_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(anime_id, source) DO UPDATE SET
                    name = excluded.name,
                    cover = excluded.cover,
                    episode_title = excluded.episode_title,
                    episode_index = excluded.episode_index,
                    play_url = excluded.play_url,
                    anime_data = excluded.anime_data,
                    play_position = excluded.play_position,
                    bgm_id = excluded.bgm_id,
                    updated_at = CURRENT_TIMESTAMP
            `);
            if (animeId && source) {
                updateFav.run(epTitle, epIndex, animeId, source);
            }
            upsertHistory.run(animeId, source, name, cover, epTitle, epIndex, playUrl, animeData, playPos, bgmId);
            this._removePlayHistoryAliases(db, { animeId, source, bgmId, name });
        });
        return { ok: true };
    }

    // ── 本地动漫库（兜底数据源）────────────────────────────
    // 注意：anime / episode 表由已移除的 video-parser.js 创建入库，
    // 当前不再存在。local 作为 fallbackChain 的最后兜底，表不存在时
    // 以下方法优雅返回空结构，而非抛出 "no such table"。

    /**
     * 本地动漫表是否存在（首次检测后缓存）
     */
    _hasLocalTable() {
        if (this._animeTableChecked) return this._hasAnimeTable;
        this._animeTableChecked = true;
        try {
            this._hasAnimeTable = !!this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='anime'"
            ).get();
        } catch (e) {
            this._hasAnimeTable = false;
        }
        return this._hasAnimeTable;
    }

    // 获取动漫列表（分页）
    getAnimeList(page = 1, limit = 20, search = '') {
        if (!this.db) throw new Error('数据库未连接');
        if (!this._hasLocalTable()) {
            return { data: [], total: 0, page, limit, totalPages: 0 };
        }

        const offset = (page - 1) * limit;
        let sql = `
            SELECT
                id, name, href, cover, intro, year, area, type, total_eps,
                (SELECT COUNT(*) FROM episode WHERE anime_id = anime.id) as episode_count
            FROM anime
        `;
        let params = [];

        if (search) {
            sql += ` WHERE name LIKE ? OR type LIKE ? `;
            params = [`%${search}%`, `%${search}%`];
        }

        sql += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const animes = this.db.prepare(sql).all(...params);

        // 获取总数
        let countSql = `SELECT COUNT(*) as total FROM anime`;
        let countParams = [];
        if (search) {
            countSql += ` WHERE name LIKE ? OR type LIKE ?`;
            countParams = [`%${search}%`, `%${search}%`];
        }

        const countResult = this.db.prepare(countSql).get(...countParams);

        return {
            data: animes.map(anime => ({
                ...anime,
                cover: anime.cover || '',
                type: anime.type ? anime.type.split(',') : [],
                episode_count: anime.episode_count || 0
            })),
            total: countResult.total,
            page,
            limit,
            totalPages: Math.ceil(countResult.total / limit)
        };
    }

    // 获取动漫详情
    getAnimeDetail(animeId) {
        if (!this.db) throw new Error('数据库未连接');
        if (!this._hasLocalTable()) return null;

        const anime = this.db.prepare(`SELECT * FROM anime WHERE id = ?`).get(animeId);
        if (!anime) return null;

        // 获取分集信息
        const episodes = this.db.prepare(`
            SELECT * FROM episode
            WHERE anime_id = ?
            ORDER BY line_id, title
        `).all(animeId);

        // 按线路分组
        const episodesByLine = {};
        episodes.forEach(ep => {
            const lineId = ep.line_id || 'default';
            if (!episodesByLine[lineId]) {
                episodesByLine[lineId] = [];
            }
            episodesByLine[lineId].push({
                id: ep.id,
                title: ep.title,
                play_url: ep.play_url,
                video_src: ep.video_src,
                real_video_url: ep.real_video_url
            });
        });

        return {
            ...anime,
            cover: anime.cover || '',
            type: anime.type ? anime.type.split(',') : [],
            episodes: episodesByLine
        };
    }

    // 搜索动漫
    searchAnime(keyword, limit = 10) {
        if (!this.db) throw new Error('数据库未连接');
        if (!this._hasLocalTable()) return [];

        const sql = `
            SELECT id, name, cover, year, type
            FROM anime
            WHERE name LIKE ? OR type LIKE ?
            ORDER BY name
            LIMIT ?
        `;

        const results = this.db.prepare(sql).all(`%${keyword}%`, `%${keyword}%`, limit);
        return results.map(anime => ({
            ...anime,
            cover: anime.cover || '',
            type: anime.type ? anime.type.split(',') : []
        }));
    }

    // 获取热门分类
    getPopularTypes() {
        if (!this.db) throw new Error('数据库未连接');
        if (!this._hasLocalTable()) return [];

        const sql = `
            SELECT type, COUNT(*) as count
            FROM anime
            WHERE type IS NOT NULL AND type != ''
            GROUP BY type
            ORDER BY count DESC
            LIMIT 20
        `;

        const results = this.db.prepare(sql).all();
        const typeCount = {};

        results.forEach(row => {
            if (row.type) {
                const types = row.type.split(',');
                types.forEach(type => {
                    const cleanType = type.trim();
                    if (cleanType) {
                        typeCount[cleanType] = (typeCount[cleanType] || 0) + row.count;
                    }
                });
            }
        });

        return Object.entries(typeCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([type, count]) => ({ type, count }));
    }

    close() {
        // 关闭前清理 flush 定时器，并把残留变更落盘
        if (this._lastUsedFlushTimer) {
            clearInterval(this._lastUsedFlushTimer);
            this._lastUsedFlushTimer = null;
        }
        this._flushLastUsed();
        this._flushWriteQueue();
        if (this.db) {
            this.db.close();
            console.log('数据库已关闭');
        }
    }
}

module.exports = AnimeDatabase;
