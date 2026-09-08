const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { stopProcessTree } = require('./audit-process-tree');

const executable = path.resolve(process.argv[2] || 'dist-app/win-unpacked/SakuraFall.exe');
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-db-upgrade-'));
const userData = path.join(runRoot, 'user-data');
const reportPath = path.join(runRoot, 'report.json');
const marker = `--smoke-user-data=${userData}`;

function launch() {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--smoke-test', marker, `--smoke-report=${reportPath}`], {
      cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_OPTIONS'))
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('upgrade smoke timed out')); }, 45000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', async code => {
      clearTimeout(timer);
      await stopProcessTree({ rootPid: child.pid, executable, marker });
      if (code !== 0) reject(new Error(`packaged application exited with ${code}`));
      else resolve(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
    });
  });
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`packaged executable not found: ${executable}`);
  try {
    await launch();
    const databasePath = path.join(userData, 'anime.db');
    const db = new Database(databasePath);
    db.exec('ALTER TABLE bangumi_subjects DROP COLUMN detail_updated_at');
    db.pragma('user_version = 8');
    db.prepare(`INSERT INTO favorites
      (anime_id, source, name, last_episode, last_episode_index, bgm_id)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run('upgrade-fixture', 'fixture-source', 'Upgrade fixture', '第03集', 2, 424242);
    db.prepare(`INSERT INTO play_history
      (anime_id, source, name, episode_title, episode_index, play_url, anime_data, play_position, bgm_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('upgrade-fixture', 'fixture-source', 'Upgrade fixture', '第03集', 2, 'https://invalid.test/video.m3u8', '{}', 321.5, 424242);
    db.close();

    const report = await launch();
    const upgraded = new Database(databasePath, { readonly: true });
    const favorite = upgraded.prepare('SELECT * FROM favorites WHERE anime_id = ?').get('upgrade-fixture');
    const history = upgraded.prepare('SELECT * FROM play_history WHERE anime_id = ?').get('upgrade-fixture');
    const columns = upgraded.prepare('PRAGMA table_info(bangumi_subjects)').all().map(row => row.name);
    const schemaVersion = upgraded.pragma('user_version', { simple: true });
    upgraded.close();
    assert.equal(schemaVersion, 10);
    assert.equal(report.details.database.integrity, 'ok');
    assert.equal(favorite.last_episode_index, 2);
    assert.equal(history.episode_index, 2);
    assert.equal(history.play_position, 321.5);
    assert.ok(columns.includes('detail_updated_at'));
    assert.ok(fs.existsSync(`${databasePath}.pre-v8-to-v10.backup`));
    console.log(JSON.stringify({ passed: true, schemaVersion, favoritePreserved: true,
      historyPreserved: true, positionPreserved: true, migrationBackupCreated: true }, null, 2));
  } finally {
    await stopProcessTree({ executable, marker });
    try { fs.rmSync(runRoot, { recursive: true, force: true }); }
    catch (error) { console.warn(`[upgrade-smoke] temporary cleanup deferred: ${error.code || error.message}`); }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
