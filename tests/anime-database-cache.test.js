// AnimeDatabase 缓存读写单元测试
// 运行: node --test tests/anime-database-cache.test.js
//
// 说明：better-sqlite3 是为 Electron 的 Node 版本编译的原生模块，
// 无法在测试环境的 Node 22 下直接加载，因此用内存 mock 模拟 cms_cache 表。
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── 拦截 require ──────────────────────────────────────
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return { app: { getPath: () => '/fake', isPackaged: false } };
  }
  if (request === 'better-sqlite3') {
    return MockDatabase;
  }
  return originalLoad.call(this, request, ...args);
};

// ── Mock better-sqlite3 ───────────────────────────────
// 仅实现 AnimeDatabase 缓存方法用到的 SQL 子集
class MockStatement {
  constructor(store, sql) {
    this.store = store; // 数组，每项 {cache_key, source_id, kind, content, created_at, expires_at, last_used}
    this.sql = sql;
  }

  get(...params) {
    const sql = this.sql;
    if (/SELECT content FROM cms_cache WHERE cache_key = \? AND expires_at > \?/.test(sql)) {
      const [key, now] = params;
      const row = this.store.find(r => r.cache_key === key && r.expires_at > now);
      return row ? { content: row.content } : undefined;
    }
    if (/SELECT 1 as ok FROM cms_cache WHERE cache_key = \?/.test(sql)) {
      const [key] = params;
      const row = this.store.find(r => r.cache_key === key);
      return row ? { ok: 1 } : undefined;
    }
    if (/SELECT COUNT\(\*\) as n FROM cms_cache/.test(sql)) {
      return { n: this.store.length };
    }
    return undefined;
  }

  all(...params) {
    return [];
  }

  run(...params) {
    const sql = this.sql;
    // UPDATE last_used
    if (/UPDATE cms_cache SET last_used = \? WHERE cache_key = \?/.test(sql)) {
      const [now, key] = params;
      const row = this.store.find(r => r.cache_key === key);
      if (row) row.last_used = now;
      return { changes: row ? 1 : 0 };
    }
    // DELETE by cache_key
    if (/DELETE FROM cms_cache WHERE cache_key = \?/.test(sql) && !/IN /.test(sql)) {
      const [key] = params;
      const idx = this.store.findIndex(r => r.cache_key === key);
      if (idx >= 0) { this.store.splice(idx, 1); return { changes: 1 }; }
      return { changes: 0 };
    }
    // INSERT ... ON CONFLICT (upsert)
    if (/INSERT INTO cms_cache/.test(sql) && /ON CONFLICT/.test(sql)) {
      const [key, sourceId, kind, contentStr, now, expiresAt, lastUsed] = params;
      const idx = this.store.findIndex(r => r.cache_key === key);
      const row = { cache_key: key, source_id: sourceId, kind, content: contentStr, created_at: now, expires_at: expiresAt, last_used: lastUsed };
      if (idx >= 0) this.store[idx] = row;
      else this.store.push(row);
      return { changes: 1 };
    }
    // LRU 淘汰：DELETE ... WHERE cache_key IN (SELECT ... ORDER BY last_used ASC LIMIT ?)
    if (/DELETE FROM cms_cache WHERE cache_key IN/.test(sql)) {
      const [limit] = params;
      const sorted = [...this.store].sort((a, b) => a.last_used - b.last_used);
      const toDelete = sorted.slice(0, limit).map(r => r.cache_key);
      for (const k of toDelete) {
        const idx = this.store.findIndex(r => r.cache_key === k);
        if (idx >= 0) this.store.splice(idx, 1);
      }
      return { changes: toDelete.length };
    }
    // clearCache：DELETE FROM cms_cache WHERE ...
    if (/DELETE FROM cms_cache/.test(sql)) {
      const conditions = [];
      const p = [...params];
      if (/source_id = \?/.test(sql)) { const v = p.shift(); conditions.push(r => r.source_id === v); }
      if (/kind = \?/.test(sql)) { const v = p.shift(); conditions.push(r => r.kind === v); }
      if (/expires_at <= \?/.test(sql)) { const v = p.shift(); conditions.push(r => r.expires_at <= v); }
      const before = this.store.length;
      for (let i = this.store.length - 1; i >= 0; i--) {
        if (conditions.every(fn => fn(this.store[i]))) {
          this.store.splice(i, 1);
        }
      }
      return { changes: before - this.store.length };
    }
    return { changes: 0 };
  }
}

class MockDatabase {
  constructor() {
    this._cacheStore = [];
  }
  exec() { /* 忽略 CREATE TABLE/INDEX */ }
  pragma() { /* 忽略 */ }
  prepare(sql) {
    return new MockStatement(this._cacheStore, sql);
  }
  transaction(fn) {
    return (...args) => fn(...args);
  }
  close() {}
}

// ── 加载 AnimeDatabase ────────────────────────────────
const AnimeDatabase = require('../src/main/services/AnimeDatabase');

// 辅助：创建一个已注入 mock db 的实例
function createDb() {
  const db = new AnimeDatabase();
  db.db = new MockDatabase();
  return db;
}

// ── 测试用例 ──────────────────────────────────────────

test('setCache/getCache: 基本写入和读取', () => {
  const db = createDb();
  db.setCache('key1', 'src1', 'list', { items: [1, 2, 3] }, 60000);
  const result = db.getCache('key1');
  assert.deepStrictEqual(result, { items: [1, 2, 3] });
});

test('getCache: 未命中的 key 返回 null', () => {
  const db = createDb();
  db.setCache('key1', 'src1', 'list', { a: 1 }, 60000);
  assert.strictEqual(db.getCache('not-exist'), null);
});

test('getCache: 过期缓存返回 null', () => {
  const db = createDb();
  // ttl = 0 表示立即过期
  db.setCache('key1', 'src1', 'list', { a: 1 }, 0);
  // 等待 1ms 确保 Date.now() 已超过 expires_at
  const result = db.getCache('key1');
  assert.strictEqual(result, null);
});

test('setCache: 相同 key 覆盖旧内容（upsert）', () => {
  const db = createDb();
  db.setCache('key1', 'src1', 'list', { version: 1 }, 60000);
  db.setCache('key1', 'src1', 'list', { version: 2 }, 60000);
  const result = db.getCache('key1');
  assert.deepStrictEqual(result, { version: 2 });
});

test('setCache: LRU 淘汰 - 超过 500 条时删除最旧的', () => {
  const db = createDb();
  // 写入 502 条，前 2 条 last_used 最旧
  for (let i = 0; i < 502; i++) {
    db.setCache(`key${i}`, 'src1', 'list', { i }, 60000);
  }
  // 502 - 500 = 2 条被淘汰，应为最旧的 key0、key1
  assert.strictEqual(db.getCache('key0'), null);
  assert.strictEqual(db.getCache('key1'), null);
  assert.ok(db.getCache('key2'));
  assert.ok(db.getCache('key501'));
});

test('getCache: 命中时更新 last_used（影响 LRU 顺序）', () => {
  const db = createDb();
  // 用 mock 时间确保 last_used 有明确先后顺序
  const realNow = Date.now;
  let t = 1000000;
  Date.now = () => t++;
  try {
    db.setCache('old', 'src1', 'list', { a: 1 }, 60000);  // old.last_used = T0
    db.setCache('new', 'src1', 'list', { b: 2 }, 60000);  // new.last_used = T1
    db.getCache('old');  // old.last_used 更新为 T2（比 new 新）
    // 再写入 499 条触发淘汰边界（总共 501 条，淘汰 1 条）
    for (let i = 0; i < 499; i++) {
      db.setCache(`k${i}`, 'src1', 'list', { i }, 60000);
    }
    // 'new' 的 last_used 最旧，应被淘汰；'old' 刚被读取过，应保留
    assert.strictEqual(db.getCache('new'), null);
    assert.ok(db.getCache('old'));
  } finally {
    Date.now = realNow;
  }
});

test('clearCache: 按 sourceId 清理', () => {
  const db = createDb();
  db.setCache('k1', 'srcA', 'list', { a: 1 }, 60000);
  db.setCache('k2', 'srcB', 'list', { b: 2 }, 60000);
  const deleted = db.clearCache({ sourceId: 'srcA' });
  assert.strictEqual(deleted, 1);
  assert.strictEqual(db.getCache('k1'), null);
  assert.ok(db.getCache('k2'));
});

test('clearCache: 按 kind 清理', () => {
  const db = createDb();
  db.setCache('k1', 'srcA', 'list', { a: 1 }, 60000);
  db.setCache('k2', 'srcA', 'detail', { b: 2 }, 60000);
  const deleted = db.clearCache({ kind: 'list' });
  assert.strictEqual(deleted, 1);
  assert.strictEqual(db.getCache('k1'), null);
  assert.ok(db.getCache('k2'));
});

test('clearCache: 按 sourceId + kind 组合清理', () => {
  const db = createDb();
  db.setCache('k1', 'srcA', 'list', { a: 1 }, 60000);
  db.setCache('k2', 'srcA', 'detail', { b: 2 }, 60000);
  db.setCache('k3', 'srcB', 'list', { c: 3 }, 60000);
  const deleted = db.clearCache({ sourceId: 'srcA', kind: 'list' });
  assert.strictEqual(deleted, 1);
  assert.strictEqual(db.getCache('k1'), null);
  assert.ok(db.getCache('k2'));
  assert.ok(db.getCache('k3'));
});

test('clearCache: expiredOnly 只清理过期缓存', () => {
  const db = createDb();
  db.setCache('fresh', 'srcA', 'list', { a: 1 }, 60000);
  db.setCache('stale', 'srcA', 'list', { b: 2 }, 0); // 立即过期
  const deleted = db.clearCache({ expiredOnly: true });
  assert.strictEqual(deleted, 1);
  assert.ok(db.getCache('fresh'));
  // stale 已被清理
  assert.strictEqual(db.getCache('stale'), null);
});

test('clearCache: 无参数清空全部', () => {
  const db = createDb();
  db.setCache('k1', 'srcA', 'list', { a: 1 }, 60000);
  db.setCache('k2', 'srcB', 'detail', { b: 2 }, 60000);
  const deleted = db.clearCache();
  assert.strictEqual(deleted, 2);
  assert.strictEqual(db.getCache('k1'), null);
  assert.strictEqual(db.getCache('k2'), null);
});

test('getCache: 内容损坏（非法 JSON）时返回 null 并删除脏数据', () => {
  const db = createDb();
  // 直接写入非法 JSON 到 mock store
  db.db._cacheStore.push({
    cache_key: 'bad',
    source_id: 'src',
    kind: 'list',
    content: 'not-json{',
    created_at: Date.now(),
    expires_at: Date.now() + 60000,
    last_used: Date.now()
  });
  const result = db.getCache('bad');
  assert.strictEqual(result, null);
  // 脏数据应已被删除
  assert.strictEqual(db.db._cacheStore.find(r => r.cache_key === 'bad'), undefined);
});
