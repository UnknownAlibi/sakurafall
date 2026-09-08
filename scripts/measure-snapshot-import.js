const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');
const { SubjectIndexService } = require('../src/main/services/SubjectIndexService');
const parseSnapshot = require('../src/main/utils/parseSnapshot');
const openSnapshot = require('../src/main/utils/openSnapshot');

async function measure(directory, mode) {
  const db = new Database(path.join(directory, `${mode}.db`));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const sql of JSON.parse(fs.readFileSync(path.join(directory, 'schema.json'), 'utf8'))) db.exec(sql);
  const index = new SubjectIndexService();
  index.setDatabase(db);
  const samples = [];
  const baseline = process.memoryUsage();
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push({ lag: Math.max(0, now - previous - 5), ...process.memoryUsage() });
    previous = now;
  }, 5);
  let snapshot;
  try {
    const started = performance.now();
    const text = await fs.promises.readFile(path.join(directory, 'payload.json'), mode === 'stream' ? undefined : 'utf8');
    const downloaded = performance.now();
    snapshot = mode === 'stream' ? await openSnapshot(text, { transferBuffer: true }) : await parseSnapshot(text);
    const parsed = performance.now();
    const result = await index.importSnapshot(snapshot);
    const done = performance.now();
    await new Promise(resolve => setImmediate(resolve));
    const lags = samples.map(item => item.lag).sort((a, b) => a - b);
    const mb = bytes => Math.round(bytes / 1024 / 1024 * 10) / 10;
    const peak = field => Math.max(baseline[field], ...samples.map(item => item[field]));
    return {
      mode, imported: result.imported, payloadReadMs: downloaded - started,
      parseToHeaderMs: parsed - downloaded, consumeAndImportMs: done - parsed, totalMs: done - started,
      samples: lags.length, p95LagMs: lags[Math.floor(lags.length * .95)] || 0,
      maxLagMs: lags.at(-1) || 0, longTasksOver50ms: lags.filter(lag => lag > 50).length,
      baselineRssMB: mb(baseline.rss), peakRssMB: mb(peak('rss')), rssGrowthMB: mb(peak('rss') - baseline.rss),
      baselineMainHeapMB: mb(baseline.heapUsed), peakMainHeapMB: mb(peak('heapUsed')),
      scope: 'Dedicated Node process including parser worker, file read instead of HTTP; not the whole Electron application'
    };
  } finally {
    snapshot?.close?.();
    clearInterval(timer);
    db.close();
  }
}

async function main() {
  if (process.argv[2] === '--child') {
    console.log(JSON.stringify(await measure(process.argv[3], process.argv[4])));
    return;
  }
  const { CatalogSnapshotService } = require('../server/src/catalogSnapshot');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-import-memory-'));
  const catalog = new CatalogSnapshotService({ dataDir: path.resolve('artifacts') });
  const source = new Database('anime.db', { readonly: true });
  try {
    fs.writeFileSync(path.join(directory, 'payload.json'), catalog._buildPayload().body);
    fs.writeFileSync(path.join(directory, 'schema.json'), JSON.stringify(source.prepare(
      "SELECT sql FROM sqlite_master WHERE name LIKE 'bangumi_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
    ).all().map(row => row.sql)));
  } finally {
    source.close();
    catalog.close();
  }
  const report = [];
  for (const mode of ['collect', 'stream']) {
    const child = spawnSync(process.execPath, [__filename, '--child', directory, mode], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    if (child.status !== 0) throw new Error(child.stderr || child.error?.message || `Import benchmark failed: ${mode}`);
    report.push(JSON.parse(child.stdout));
  }
  fs.writeFileSync('artifacts/snapshot-import-memory.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
