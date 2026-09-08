const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { CatalogSnapshotService } = require('../server/src/catalogSnapshot');
const { SubjectIndexService } = require('../src/main/services/SubjectIndexService');
const parseSnapshot = require('../src/main/utils/parseSnapshot');

/**
 * 空白磁盘库首导入分阶段测量（S1-1）：
 * - JSON 整包解析、归一化+事务写入分别计时；
 * - 事件循环延迟探测（setTimeout 漂移）记录 >50ms 长任务；
 * - 采样内存峰值（RSS / JS 堆）。
 */
async function measureDiskFirstImport(payloadBody, tableSchemas) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-catalog-audit-'));
  const db = new Database(path.join(runRoot, 'anime.db'));
  // 与应用库一致：WAL + normal 同步级别（AnimeDatabase 初始化口径）
  db.pragma('journal_mode = WAL');
  for (const sql of tableSchemas) db.exec(sql);
  const index = new SubjectIndexService();
  index.setDatabase(db);

  const lags = [];
  let stopProbing = false;
  let peakRssMB = 0;
  let peakHeapMB = 0;
  const probe = (async () => {
    while (!stopProbing) {
      const t0 = performance.now();
      await new Promise(resolve => setTimeout(resolve, 10));
      const lag = performance.now() - t0 - 10;
      if (lag > 1) lags.push(lag);
    }
  })();
  const memorySampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRssMB = Math.max(peakRssMB, usage.rss / 1024 / 1024);
    peakHeapMB = Math.max(peakHeapMB, usage.heapUsed / 1024 / 1024);
  }, 25);
  memorySampler.unref?.();

  const parseStart = performance.now();
  const snapshot = await parseSnapshot(payloadBody);
  const parseMs = performance.now() - parseStart;

  const importStart = performance.now();
  const result = await index.importSnapshot(snapshot);
  const importMs = performance.now() - importStart;

  stopProbing = true;
  clearInterval(memorySampler);
  await probe;

  const longTasks = lags.filter(lag => lag > 50);
  const report = {
    database: path.join(runRoot, 'anime.db'),
    subjects: result.imported,
    parseMs: Math.round(parseMs),
    importMs: Math.round(importMs),
    longTasksOver50ms: longTasks.length,
    maxEventLoopLagMs: lags.length > 0 ? Math.round(Math.max(...lags) * 100) / 100 : 0,
    p95EventLoopLagMs: lags.length > 0
      ? Math.round(lags.slice().sort((a, b) => a - b)[Math.floor(lags.length * 0.95)] * 100) / 100
      : 0,
    peakRssMB: Math.round(peakRssMB * 10) / 10,
    peakHeapMB: Math.round(peakHeapMB * 10) / 10
  };
  db.close();
  return report;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const catalog = new CatalogSnapshotService({ dataDir: path.join(root, 'artifacts') });
  assert.ok(catalog.records.size > 0, 'Build the catalog snapshot first');
  const payload = catalog._buildPayload();
  assert.ok(payload.body.length < 80 * 1024 * 1024, 'Snapshot exceeds desktop response limit');
  const source = new Database(path.join(root, 'anime.db'), { readonly: true });
  const db = new Database(':memory:');
  const tableSchemas = source.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'bangumi_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all().map(row => row.sql);
  for (const sql of tableSchemas) db.exec(sql);
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
  // S1-1：空白磁盘库首导入分阶段测量（JSON 解析 / 事务写入 / 事件循环延迟 / 内存峰值）
  const diskFirstImport = await measureDiskFirstImport(payload.body, tableSchemas);
  const report = { records: catalog.records.size, jsonBytes: payload.body.length,
    gzipBytes: payload.gzip.length, importMs: Math.round(importMs), queries, diskFirstImport };
  fs.writeFileSync(path.join(root, 'artifacts', 'catalog-snapshot-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  db.close();
  catalog.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
