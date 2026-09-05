const assert = require('node:assert/strict');
const test = require('node:test');
const { SubjectIndexService } = require('../src/main/services/SubjectIndexService');

test('failed snapshot batches do not advance the synchronization cursor', async () => {
  const service = new SubjectIndexService();
  service.db = {};
  service.upsertSubjects = async () => 0;
  service._setSyncState = () => assert.fail('failed import must retain previous cursor');
  await assert.rejects(service.importSnapshot({ schemaVersion: 1, subjects: [{ id: 1, type: 2, name: 'test' }] }), /Incomplete/);
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
