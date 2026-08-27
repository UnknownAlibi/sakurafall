const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const budgets = require('../src/shared/performance-budgets.json');

const workspace = path.resolve(__dirname, '..');
const executableArg = process.argv.find(arg => arg.startsWith('--exe='));
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-smoke-'));
const userData = path.join(runRoot, 'user-data');
const reportPath = path.join(runRoot, 'report.json');
const offline = process.argv.includes('--offline');

if (!fs.existsSync(executable)) {
  console.error(`[smoke] packaged executable not found: ${executable}`);
  process.exit(1);
}

const childArgs = [
  '--smoke-test',
  `--smoke-user-data=${userData}`,
  `--smoke-report=${reportPath}`
];
if (offline) childArgs.push('--smoke-offline');

const child = spawn(executable, childArgs, {
  cwd: path.dirname(executable),
  windowsHide: true,
  stdio: 'ignore'
});

const timeout = setTimeout(() => {
  child.kill();
  console.error('[smoke] packaged application timed out');
  process.exitCode = 1;
}, 45000);

child.once('error', error => {
  clearTimeout(timeout);
  console.error(`[smoke] failed to launch packaged application: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', code => {
  clearTimeout(timeout);
  try {
    if (!fs.existsSync(reportPath)) throw new Error(`smoke report missing (exit ${code})`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (code !== 0 || report.success !== true) {
      throw new Error(`packaged smoke failed: ${JSON.stringify(report.details || {})}`);
    }
    if (report.details.startupMs > budgets.startup.packagedReadyMs) {
      throw new Error(`packaged startup ${report.details.startupMs}ms exceeds ${budgets.startup.packagedReadyMs}ms budget`);
    }
    console.log(`[smoke] packaged app ready: ${report.details.renderer.title}`);
    console.log(`[smoke] mode: ${offline ? 'offline' : 'online'}`);
    console.log(`[smoke] ${report.details.renderer.providerCount} providers, ${report.details.renderer.themeCount} themes`);
    console.log(`[smoke] ${report.details.renderer.themeAssetCount} external theme assets applied`);
    console.log(`[smoke] diagnostics ${report.details.renderer.diagnosticFileCount} file(s)`);
    console.log(`[smoke] database schema v${report.details.database.schemaVersion}, integrity ${report.details.database.integrity}`);
    console.log(`[smoke] startup ${report.details.startupMs}ms / ${budgets.startup.packagedReadyMs}ms budget`);
  } catch (error) {
    console.error(`[smoke] ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
});
