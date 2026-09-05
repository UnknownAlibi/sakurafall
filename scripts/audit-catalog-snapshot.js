const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { CatalogSnapshotService } = require('../server/src/catalogSnapshot');
const { SubjectIndexService } = require('../src/main/services/SubjectIndexService');

async function main() {
  const root = path.resolve(__dirname, '..');
  const catalog = new CatalogSnapshotService({ dataDir: path.join(root, 'artifacts') });
  assert.ok(catalog.records.size > 0, 'Build the catalog snapshot first');
  const payload = catalog._buildPayload();
  assert.ok(payload.body.length < 80 * 1024 * 1024, 'Snapshot exceeds desktop response limit');
  const source = new Database(path.join(root, 'anime.db'), { readonly: true });
  const db = new Database(':memory:');
  for (const row of source.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'bangumi_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all()) db.exec(row.sql);
  source.close();
  const index = new SubjectIndexService();
  index.setDatabase(db);
  const started = performance.now();
  const imported = await index.importSnapshot(JSON.parse(payload.body));
  const importMs = performance.now() - started;
  assert.equal(imported.imported, catalog.records.size);
  assert.equal(index.hasCatalogSnapshot(), true);
  const queries = [];
  for (const filter of [{}, { tag: '日本' }, { tag: '中国' }, { tag: '异世界' }, { year: 2026 }, { platform: 'TV' }, { tag: '日本', year: 2026, platform: 'TV' }, { year: 1901 }]) {
    let expectedTotal;
    for (const sort of ['latest', 'rating', 'rank']) {
      const begin = performance.now();
      const result = index.querySubjects({ ...filter, sort, releasedOnly: true });
      const elapsedMs = performance.now() - begin;
      if (expectedTotal === undefined) expectedTotal = result.total;
      assert.equal(result.total, expectedTotal, 'Sorting changed catalog membership');
      queries.push({ filter, sort, total: result.total, elapsedMs: Math.round(elapsedMs * 100) / 100 });
    }
  }
  const report = { records: catalog.records.size, jsonBytes: payload.body.length,
    gzipBytes: payload.gzip.length, importMs: Math.round(importMs), queries };
  fs.writeFileSync(path.join(root, 'artifacts', 'catalog-snapshot-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  db.close();
  catalog.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
