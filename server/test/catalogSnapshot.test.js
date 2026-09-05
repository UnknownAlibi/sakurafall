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
