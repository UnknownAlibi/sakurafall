const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const outputDir = path.join(workspace, 'dist-app');
const installerName = fs.readdirSync(outputDir).find(name => /^SakuraFall(?: |-)Setup(?: |-)?.*\.exe$/i.test(name));
if (!installerName) {
  console.error('[installer-smoke] installer not found');
  process.exit(1);
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-installer-'));
const installDir = path.join(runRoot, 'app');
const installer = path.join(outputDir, installerName);

function run(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'inherit' });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} timed out`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with ${code}`));
    });
  });
}

(async () => {
  try {
    await run(installer, ['/S', `/D=${installDir}`], 90000);
    const executable = path.join(installDir, 'SakuraFall.exe');
    if (!fs.existsSync(executable)) throw new Error('installed executable is missing');
    await run(process.execPath, [path.join(__dirname, 'smoke-packaged.js'), `--exe=${executable}`], 60000);
    await run(process.execPath, [path.join(__dirname, 'smoke-packaged.js'), '--offline', `--exe=${executable}`], 60000);
    console.log('[installer-smoke] install, online/offline launch, and data bootstrap passed');

    const uninstaller = path.join(installDir, 'Uninstall SakuraFall.exe');
    if (fs.existsSync(uninstaller)) await run(uninstaller, ['/S'], 60000);
  } catch (error) {
    console.error(`[installer-smoke] ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})();
