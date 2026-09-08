const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CatalogSnapshotService, unwrapCoverProxy } = require('../src/catalogSnapshot');

test('catalog snapshot merges subjects, persists atomically and serves deltas', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-catalog-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const catalog = new CatalogSnapshotService({ dataDir, warmEnabled: false });
  t.after(() => catalog.close());

  const firstAt = Date.now() - 1000;
  assert.equal(catalog.ingest({
    data: [{
      id: 42,
      type: 2,
      name: 'subject',
      images: { common: 'https://service.test/cover?url=https%3A%2F%2Flain.bgm.tv%2Fpic%2F42.jpg' }
    }]
  }, firstAt), 1);
  assert.equal(catalog.ingest({ data: [{ id: 42, type: 2, name: 'subject', name_cn: '条目' }] }), 1);
  catalog.flush();

  const reloaded = new CatalogSnapshotService({ dataDir, warmEnabled: false });
  t.after(() => reloaded.close());
  assert.equal(reloaded.records.size, 1);
  assert.equal(reloaded.records.get(42).subject.name_cn, '条目');
  assert.equal(reloaded.records.get(42).subject.images.common, 'https://lain.bgm.tv/pic/42.jpg');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!reloaded.handle(req, res, url)) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const fullResponse = await fetch(`${base}/v1/catalog/snapshot`, {
    headers: { 'Accept-Encoding': 'gzip' }
  });
  assert.equal(fullResponse.status, 200);
  assert.equal(fullResponse.headers.get('content-encoding'), 'gzip');
  assert.equal(fullResponse.headers.get('x-sakurafall-catalog-count'), '1');
  const full = await fullResponse.json();
  assert.equal(full.schemaVersion, 1);
  assert.equal(full.full, true);
  assert.equal(full.subjects.length, 1);

  const delta = await fetch(`${base}/v1/catalog/snapshot?since=${Date.now() + 1000}`).then(response => response.json());
  assert.equal(delta.full, false);
  assert.deepEqual(delta.subjects, []);
});

test('cover proxy URLs are removed before catalog persistence', () => {
  assert.deepEqual(unwrapCoverProxy({
    cover: 'https://service.test/cover?url=https%3A%2F%2Fbgmimg.anibt.net%2Fpic%2Fa.jpg',
    ordinary: 'https://example.test/page'
  }), {
    cover: 'https://bgmimg.anibt.net/pic/a.jpg',
    ordinary: 'https://example.test/page'
  });
});

test('warm scans use actual page lengths and publish only after every category completes', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-catalog-warm-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const catalog = new CatalogSnapshotService({ dataDir, warmEnabled: false, warmDelayMs: 25 });
  t.after(() => catalog.close());
  catalog.ingest([{ id: 99, type: 2, name: 'previous' }]);
  const version = catalog.generatedAt;
  const offsets = [];
  const result = await catalog.warm(async ({ category, offset }) => {
    assert.equal(catalog.generatedAt, version);
    assert.equal(catalog.records.size, 1);
    if (category !== 0) return { total: 0, data: [] };
    offsets.push(offset);
    return { total: 5, data: Array.from({ length: Math.min(2, 5 - offset) }, (_, i) => ({ id: offset + i + 1, type: 2, name: 'new' })) };
  });
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.equal(result.total, 6);
  assert.ok(catalog.lastFullWarmAt > 0);
});

test('incomplete or unstable scans leave the published version and disk unchanged', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-catalog-failure-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const catalog = new CatalogSnapshotService({ dataDir, warmEnabled: false, warmDelayMs: 25 });
  t.after(() => catalog.close());
  catalog.ingest([{ id: 99, type: 2, name: 'previous' }]);
  catalog.flush();
  const version = catalog.generatedAt;
  const original = await fs.readFile(catalog.filePath, 'utf8');
  for (const second of [
    { total: 2, data: [] },
    { total: 3, data: [{ id: 2, type: 2, name: 'new' }] },
    { total: 2, data: [{ id: 1, type: 2, name: 'duplicate' }] }
  ]) {
    await assert.rejects(catalog.warm(async ({ offset }) => offset ? second : { total: 2, data: [{ id: 1, type: 2, name: 'first' }] }));
    assert.equal(catalog.records.size, 1);
    assert.equal(catalog.generatedAt, version);
    assert.equal(catalog.lastFullWarmAt, 0);
    assert.equal(await fs.readFile(catalog.filePath, 'utf8'), original);
  }
});

test('payload cache is bounded by bytes as well as entries', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-catalog-budget-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const catalog = new CatalogSnapshotService({ dataDir, warmEnabled: false, payloadCacheMaxBytes: 4096 });
  t.after(() => catalog.close());
  catalog.ingest([{ id: 1, type: 2, name: 'sample', summary: 'x'.repeat(700) }]);
  for (let since = 0; since < 15; since++) catalog._buildPayload(since);
  assert.ok(catalog._payloadCache.size < 8);
  assert.ok(catalog._payloadCacheBytes <= 4096);
  assert.equal(catalog._payloadCacheBytes, [...catalog._payloadCache.values()].reduce((sum, item) => sum + item.body.byteLength + item.gzip.byteLength, 0));
  catalog.ingest([{ id: 1, type: 2, name: 'large', summary: 'x'.repeat(10000) }]);
  assert.equal(catalog._payloadCacheBytes, 0);
  assert.ok(catalog._buildPayload().body.byteLength > 4096);
  assert.equal(catalog._payloadCache.size, 0);
});

test('warm publication does not overwrite fresher detail responses received during a page request', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-catalog-concurrent-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const catalog = new CatalogSnapshotService({ dataDir, warmEnabled: false });
  t.after(() => catalog.close());
  catalog.ingest([{ id: 1, type: 2, name: 'original' }]);
  await catalog.warm(async ({ category }) => {
    if (category !== 0) return { total: 0, data: [] };
    catalog.ingest([{ id: 1, type: 2, name: 'fresh detail' }]);
    return { total: 1, data: [{ id: 1, type: 2, name: 'old page' }] };
  });
  assert.equal(catalog.records.get(1).subject.name, 'fresh detail');
});
