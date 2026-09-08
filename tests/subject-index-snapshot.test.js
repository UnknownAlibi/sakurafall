const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { SubjectIndexService } = require('../src/main/services/SubjectIndexService');

function createIndexDb(file = ':memory:') {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE bangumi_subjects (
      bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, summary TEXT,
      cover_url TEXT, cover_local TEXT, rating REAL, rank INTEGER, votes INTEGER,
      eps INTEGER, air_date TEXT, air_weekday INTEGER, year INTEGER, month INTEGER,
      type INTEGER, nsfw INTEGER, popularity INTEGER, updated_at INTEGER, raw_json TEXT,
      platform TEXT, detail_updated_at INTEGER
    );
    CREATE TABLE bangumi_subject_tags (bgm_id INTEGER, tag TEXT, count INTEGER, UNIQUE(bgm_id, tag));
    CREATE TABLE bangumi_sync_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL);
  `);
  return db;
}

test('failed snapshot batches do not advance the synchronization cursor', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service.upsertSubjects = async () => 0;
  service._setSyncState = () => assert.fail('failed import must retain previous cursor');
  await assert.rejects(service.importSnapshot({ schemaVersion: 1, subjects: [{ id: 1, type: 2, name: 'test' }] }), /Incomplete/);
});

test('WAL import pins old pages until completion and invalidates partial imports on restart', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-paging-'));
  const file = path.join(directory, 'test.db');
  const db = createIndexDb(file);
  const service = new SubjectIndexService();
  service.db = db;
  const makeSubject = (id, date) => ({ id, type: 2, name: `anime-${id}`, date, tags: [{ name: '恋爱' }] });
  try {
    await service.importSnapshot({ schemaVersion: 1, generatedAt: 100, catalogReady: true,
      subjects: Array.from({ length: 205 }, (_, i) => makeSubject(i + 1, '2023-01-01')) });
    const filters = { tag: '恋爱', sort: 'latest', pageSize: 50 };
    const previous = service.querySubjects(filters);
    const oldPage2 = service.querySubjects({ ...filters, page: 2 });
    const upsert = service.upsertSubjects.bind(service);
    let batches = 0;
    service.upsertSubjects = async items => {
      const count = await upsert(items);
      batches++;
      const during = service.querySubjects(filters);
      assert.equal(during.catalogVersion, previous.catalogVersion);
      assert.deepEqual(during.data, previous.data, 'partially imported rows must remain invisible to the list');
      assert.deepEqual(service.querySubjects({ ...filters, page: 2 }).data, oldPage2.data);
      return count;
    };
    await service.importSnapshot({ schemaVersion: 1, generatedAt: 200, catalogReady: true,
      subjects: Array.from({ length: 205 }, (_, i) => makeSubject(i + 1, i < 200 ? '1995-01-01' : '2024-01-01')) });
    assert.equal(batches, 2);
    assert.notEqual(service.getCatalogVersion(), previous.catalogVersion);
    assert.equal(service._catalogReadDb, null);
    const all = [];
    for (let page = 1; page <= 5; page++) all.push(...service.querySubjects({ ...filters, page }).data);
    assert.equal(new Set(all.map(item => item.bgmId)).size, 205);
    assert.ok(all.every((item, index) => !index || all[index - 1].airDate >= item.airDate));
    const completeVersion = service.getCatalogVersion();
    batches = 0;
    service.upsertSubjects = async items => ++batches === 2 ? 0 : upsert(items);
    await assert.rejects(service.importSnapshot({ schemaVersion: 1, generatedAt: 300,
      subjects: Array.from({ length: 205 }, (_, i) => makeSubject(i + 1, '2020-01-01')) }), /Incomplete/);
    assert.equal(service._catalogReadDb, null);
    assert.equal(service.getSyncStatus().lastSync['catalog-snapshot'].generatedAt, 200);
    assert.notEqual(service.getCatalogVersion(), completeVersion);
    const reopened = new SubjectIndexService();
    reopened.db = new Database(file);
    try { assert.equal(reopened.getCatalogVersion(), service.getCatalogVersion()); }
    finally { reopened.db.close(); }
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('switching to local mode prevents an in-flight snapshot from being imported', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service._snapshotBaseUrl = 'https://service.test';
  service.getSyncStatus = () => ({ lastSync: {} });
  let finish;
  service._snapshotHttp.fetch = () => new Promise(resolve => { finish = resolve; });
  service.importSnapshot = () => assert.fail('disabled server must not import');
  const pending = service.syncSnapshot();
  service.setSnapshotBaseUrl('');
  finish(JSON.stringify({ schemaVersion: 1, total: 1, subjects: [{ id: 1 }] }));
  assert.equal((await pending).reason, 'config_changed');
  assert.equal(service._snapshotTimer, null);
});

test('snapshot sync consumes a compressed binary HTTP response into the index', async () => {
  const http = require('node:http');
  const zlib = require('node:zlib');
  const payload = zlib.gzipSync(JSON.stringify({
    schemaVersion: 1, generatedAt: 1234, catalogReady: true, padding: 'x'.repeat(300000),
    subjects: Array.from({ length: 401 }, (_, id) => ({ id: id + 1, type: 2, name: `item-${id}`, date: '2020-01-01' }))
  }));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new SubjectIndexService();
  service.db = createIndexDb();
  service._snapshotBaseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await service.syncSnapshot();
    assert.equal(result.imported, 401);
    assert.equal(service.hasCatalogSnapshot(), true);
    assert.equal(service.querySubjects({ sort: 'latest', releasedOnly: true }).total, 401);
    assert.equal(service._catalogReadDb, null);
  } finally {
    service.setSnapshotBaseUrl('');
    service.db.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('subject index imports a raw server snapshot in yielding batches', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  const batches = [];
  let state = null;
  service.upsertSubjects = async items => {
    batches.push(items);
    return items.length;
  };
  service.getIndexCount = () => batches.reduce((total, batch) => total + batch.length, 0);
  service._setSyncState = (key, value) => { state = { key, value }; };

  const subjects = Array.from({ length: 205 }, (_, index) => ({
    id: index + 1,
    type: 2,
    name: `raw-${index + 1}`,
    name_cn: `条目-${index + 1}`,
    date: '2026-01-01',
    platform: 'TV',
    images: { common: `https://lain.bgm.tv/pic/${index + 1}.jpg` },
    rating: { score: 8.2, rank: 10, total: 200 },
    tags: [{ name: '日本', count: 100 }]
  }));
  const result = await service.importSnapshot({
    schemaVersion: 1,
    generatedAt: 1234,
    full: true,
    total: subjects.length,
    subjects
  });

  assert.equal(result.imported, 205);
  assert.deepEqual(batches.map(batch => batch.length), [200, 5]);
  assert.equal(batches[0][0].name, '条目-1');
  assert.equal(batches[0][0].platform, 'TV');
  assert.equal(batches[0][0].rating, 8.2);
  assert.equal(batches[0][0].cover, 'https://lain.bgm.tv/pic/1.jpg');
  assert.equal(state.key, 'catalog-snapshot');
  assert.equal(state.value.generatedAt, 1234);
});

test('subject index requests a delta after the previous snapshot generation', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service._snapshotBaseUrl = 'https://service.test';
  service.getSyncStatus = () => ({
    indexed: 10,
    lastSync: { 'catalog-snapshot': { generatedAt: 5678, syncedAt: 1 } }
  });
  let requestedUrl = '';
  service._snapshotHttp.fetch = async url => {
    requestedUrl = url;
    return JSON.stringify({ schemaVersion: 1, generatedAt: 6789, total: 11, subjects: [{ id: 11 }] });
  };
  service.importSnapshot = async snapshot => ({ imported: snapshot.subjects.length });

  const result = await service.syncSnapshot({ force: false });
  assert.equal(result.imported, 1);
  assert.equal(requestedUrl, 'https://service.test/v1/catalog/snapshot?since=5678');
});

test('server generatedAt rollback forces a full resync instead of a stale empty delta', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service._snapshotBaseUrl = 'https://service.test';
  service.getSyncStatus = () => ({
    indexed: 10,
    lastSync: { 'catalog-snapshot': { generatedAt: 9000, syncedAt: 1, baseUrl: 'https://service.test' } }
  });
  const urls = [];
  service._snapshotHttp.fetch = async url => {
    urls.push(url);
    if (url.includes('since=9000')) {
      // 服务器重建/备份恢复后的回退响应：旧游标之后没有任何增量
      return JSON.stringify({ schemaVersion: 1, generatedAt: 4000, total: 2, subjects: [] });
    }
    return JSON.stringify({
      schemaVersion: 1, generatedAt: 9500, full: true, total: 2,
      subjects: [{ id: 1, type: 2 }, { id: 2, type: 2 }]
    });
  };
  service.importSnapshot = async snapshot => ({ imported: snapshot.subjects.length });

  const result = await service.syncSnapshot();
  assert.equal(result.imported, 2);
  assert.deepEqual(urls, [
    'https://service.test/v1/catalog/snapshot?since=9000',
    'https://service.test/v1/catalog/snapshot'
  ]);
});

test('corrupt snapshot payloads reject without touching the import path', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service._snapshotBaseUrl = 'https://service.test';
  service.getSyncStatus = () => ({ lastSync: { 'catalog-snapshot': { generatedAt: 1, syncedAt: 1 } } });
  service._snapshotHttp.fetch = async () => '{"schemaVersion":1,"subjects":[';
  service.importSnapshot = () => assert.fail('corrupt payload must not be imported');
  await assert.rejects(service.syncSnapshot(), SyntaxError);
});

test('unsupported snapshot schema versions reject before any write', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service._setSyncState = () => assert.fail('unsupported schema must not write sync state');
  await assert.rejects(
    service.importSnapshot({ schemaVersion: 99, subjects: [{ id: 1 }] }),
    /目录快照版本不受支持/
  );
  await assert.rejects(
    service.importSnapshot({ schemaVersion: 1, subjects: [{ id: 'abc' }] }),
    /Invalid catalog snapshot/
  );
});

test('query results expose the catalog version and advance with snapshot imports', async () => {
  const service = new SubjectIndexService();
  const db = createIndexDb();
  service.db = db;
  try {
    assert.equal(service.getCatalogVersion(), null);
    assert.equal(service.querySubjects({}).catalogVersion, null);

    await service.importSnapshot({
      schemaVersion: 1, generatedAt: 1000, full: true, total: 1,
      subjects: [{ id: 1, type: 2, name: 'A', name_cn: '甲' }]
    });
    assert.equal(service.getCatalogVersion(), '1000:1');
    assert.equal(service.querySubjects({}).catalogVersion, '1000:1');

    // generatedAt 未推进的无变化同步：版本保持不变，不触发无谓的整组刷新
    await service.importSnapshot({
      schemaVersion: 1, generatedAt: 1000, full: false, total: 1, subjects: []
    });
    assert.equal(service.getCatalogVersion(), '1000:1');

    await service.importSnapshot({
      schemaVersion: 1, generatedAt: 2000, full: false, total: 2,
      subjects: [{ id: 2, type: 2, name: 'B', name_cn: '乙' }]
    });
    assert.equal(service.getCatalogVersion(), '2000:2');
    assert.equal(service.querySubjects({}).total, 2);
  } finally {
    service.db = null;
    db.close();
  }
});

test('sparse list upserts preserve cached detail fields', async () => {
  const service = new SubjectIndexService();
  const db = createIndexDb();
  service.db = db;
  try {
    await service.upsertDetail({
      bgmId: 1, name: '甲', aliases: ['别名甲'], summary: '详细简介', rating: 8
    });
    const before = db.prepare('SELECT updated_at, detail_updated_at FROM bangumi_subjects WHERE bgm_id = 1').get();

    // 稀疏列表元数据：无 aliases/summary，仅评分与名称
    await service.upsertSubjects([{ bgmId: 1, name: '甲', rating: 7 }]);

    const row = db.prepare('SELECT * FROM bangumi_subjects WHERE bgm_id = 1').get();
    assert.equal(row.summary, '详细简介', 'sparse upsert must not wipe cached summary');
    assert.deepEqual(JSON.parse(row.aliases), ['别名甲'], 'sparse upsert must not wipe cached aliases');
    assert.equal(row.rating, 7, 'volatile fields still update');
    assert.equal(row.detail_updated_at, before.detail_updated_at, 'list upserts must not reset detail freshness');
    assert.ok(row.updated_at >= before.updated_at, 'list upserts still advance list freshness');
  } finally {
    service.db = null;
    db.close();
  }
});

test('detail freshness is independent of list refresh time', async () => {
  const service = new SubjectIndexService();
  const db = createIndexDb();
  service.db = db;
  const bangumiApi = require('../src/main/services/BangumiApi');
  const originalGetDetail = bangumiApi.getDetail;
  try {
    const now = Date.now();
    // 列表数据很新（updated_at=now），但详情很久未补全（detail_updated_at 很旧）
    db.prepare(`
      INSERT INTO bangumi_subjects (bgm_id, name, updated_at, detail_updated_at)
      VALUES (1, '甲', ?, 1)
    `).run(now);
    service.DETAIL_STALE_MS = 7 * 24 * 60 * 60 * 1000;
    let fetched = 0;
    bangumiApi.getDetail = async () => { fetched += 1; return { id: 1, name: '甲' }; };

    await service.syncDetailIfStale(1);
    assert.equal(fetched, 1, 'stale detail must be refetched even though list data is fresh');

    // 详情补全后，仅刷新列表数据不应重置详情新鲜度
    fetched = 0;
    await service.upsertSubjects([{ bgmId: 1, name: '甲', rating: 9 }]);
    await service.syncDetailIfStale(1);
    assert.equal(fetched, 0, 'fresh detail must not refetch after list upserts');
  } finally {
    bangumiApi.getDetail = originalGetDetail;
    service.db = null;
    db.close();
  }
});
