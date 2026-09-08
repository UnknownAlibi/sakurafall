const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function verify(archive, seed) {
  const http = require('node:http');
  const { gzipSync } = require('node:zlib');
  const Database = require(path.join(archive, 'node_modules/better-sqlite3'));
  const { SubjectIndexService } = require(path.join(archive, 'src/main/services/SubjectIndexService'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-packaged-snapshot-'));
  const source = new Database(seed, { readonly: true });
  const db = new Database(path.join(directory, 'catalog.db'));
  try {
    db.pragma('journal_mode = WAL');
    for (const row of source.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'bangumi_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all()) db.exec(row.sql);
  } finally { source.close(); }
  const index = new SubjectIndexService();
  index.setDatabase(db);
  const snapshot = {
    schemaVersion: 1, generatedAt: Date.now(), total: 401,
    subjects: Array.from({ length: 401 }, (_, i) => ({
      id: i + 1, type: 2, name: `Packaged subject ${i + 1}`, name_cn: '',
      summary: 'Snapshot stream verification. '.repeat(100), date: '2025-01-01',
      rating: { score: 7, total: 100, rank: i + 1 }, tags: [{ name: '恋爱', count: 10 }]
    }))
  };
  const body = gzipSync(Buffer.from(JSON.stringify(snapshot)));
  let requests = 0;
  let fail = false;
  const server = http.createServer((request, response) => {
    requests++;
    if (fail) { response.writeHead(503); response.end('Unavailable'); return; }
    if (request.url !== '/v1/catalog/snapshot') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    response.end(body);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    index.setSnapshotBaseUrl(`http://127.0.0.1:${server.address().port}`);
    const result = await index.syncSnapshot({ force: true });
    assert.equal(result.imported, 401);
    assert.equal(index.getIndexCount(), 401);
    const version = index.getCatalogVersion();
    fail = true;
    await assert.rejects(index.syncSnapshot({ force: true }));
    assert.equal(index.getIndexCount(), 401);
    assert.equal(index.getCatalogVersion(), version);
    assert.equal(index._catalogReadDb, null);
    return { passed: true, imported: result.imported, requests, failurePreservedCatalog: true,
      scope: 'Packaged Electron Node runtime, ASAR worker and native SQLite; gzip HTTP import into isolated WAL database' };
  } finally {
    index.setSnapshotBaseUrl('');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
}

async function main() {
  if (process.argv[2] === '--child') {
    console.log(JSON.stringify(await verify(process.argv[3], process.argv[4])));
    return;
  }
  const executable = path.resolve(process.argv[2]);
  const seed = JSON.parse(fs.readFileSync('artifacts/catalog-snapshot-audit.json', 'utf8')).diskFirstImport.database;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SAKURAFALL_SERVICE_URL: 'off' };
  delete env.NODE_OPTIONS;
  delete env.SAKURAFALL_OFFLINE_MODE;
  const child = spawnSync(executable, [__filename, '--child', path.join(path.dirname(executable), 'resources/app.asar'), seed], {
    env, encoding: 'utf8', timeout: 45000, windowsHide: true
  });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || child.error?.message || 'Packaged snapshot failed');
  const report = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  fs.writeFileSync('artifacts/packaged-snapshot-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
