const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');

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
const previousArg = process.argv.find(arg => arg.startsWith('--previous='));
const previousInstaller = previousArg ? path.resolve(previousArg.slice('--previous='.length)) : '';

function installedVersion(executable) {
  const archive = path.join(path.dirname(executable), 'resources', 'app.asar');
  return JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version;
}

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

// ── 保护本机已有安装 ──────────────────────────────────────────────
// electron-builder 的 NSIS 安装器在安装阶段会无条件执行 uninstallOldVersion：
// 只要注册表里存在同 appId 的卸载项，就先把旧版本静默卸载（删掉安装目录、快捷
// 方式和注册表项）；安装本身还会覆写 HKCU\Software\<GUID>（InstallLocation 等）
// 并重建/删除桌面与开始菜单快捷方式。冒烟测试把应用装到临时目录也躲不开这些
// 副作用——2026-09-24 发版时因此误删了开发机上已安装的 1.4.0。
// 处理：执行前把「本机已安装实例」的注册表项与快捷方式整体备份后临时移走，
// 测试结束（含临时安装的卸载）后原样恢复；恢复失败时保留备份并输出手工恢复指引。
const SMOKE_APP_NAME_PATTERN = /^SakuraFall\b/i;
const SMOKE_UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const SMOKE_PROTECT_BACKUP_DIR = path.join(os.tmpdir(), 'sakurafall-installer-smoke-protect');

function reg(args) {
  return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 枚举本机已安装的 SakuraFall：卸载注册表项、安装信息键（HKCU\Software\<GUID>） */
function listInstalledRegistrations() {
  const found = { uninstallKeys: [], installKeys: [] };
  let listing = '';
  try {
    listing = reg(['query', SMOKE_UNINSTALL_ROOT]);
  } catch (_) {
    return found;
  }
  // 注意：reg query 输出的是完整 hive 名（HKEY_CURRENT_USER\...），不是简写 HKCU\...。
  // 2026-09-24 曾因按 HKCU\ 前缀过滤导致枚举恒为空、保护未生效、误删本机安装。
  const subkeys = listing.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\/i.test(line))
    .map(line => `HKCU\\${line.replace(/^HKEY_CURRENT_USER\\/i, '')}`);
  for (const key of subkeys) {
    let display = '';
    try {
      const detail = reg(['query', key, '/v', 'DisplayName']);
      display = detail.match(/DisplayName\s+REG_SZ\s+(.+)/)?.[1]?.trim() || '';
    } catch (_) {
      continue;
    }
    if (!SMOKE_APP_NAME_PATTERN.test(display)) continue;
    found.uninstallKeys.push(key);
    const installKey = `HKCU\\Software\\${key.split('\\').pop()}`;
    try {
      reg(['query', installKey]);
      found.installKeys.push(installKey);
    } catch (_) { /* 安装信息键不存在则无需保护 */ }
  }
  return found;
}

function installedShortcutPaths() {
  return [
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'Desktop', 'SakuraFall.lnk'),
    process.env.PUBLIC && path.join(process.env.PUBLIC, 'Desktop', 'SakuraFall.lnk'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SakuraFall.lnk'),
    process.env.ProgramData && path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SakuraFall.lnk')
  ].filter(Boolean).filter(file => fs.existsSync(file));
}

function protectInstalledApp() {
  const { uninstallKeys, installKeys } = listInstalledRegistrations();
  const shortcuts = installedShortcutPaths();
  if (!uninstallKeys.length && !installKeys.length && !shortcuts.length) return null;

  fs.rmSync(SMOKE_PROTECT_BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(SMOKE_PROTECT_BACKUP_DIR, { recursive: true });
  const manifest = { uninstallKeys: [], installKeys: [], shortcuts: [] };
  uninstallKeys.forEach((key, index) => {
    const file = path.join(SMOKE_PROTECT_BACKUP_DIR, `uninstall-${index}.reg`);
    reg(['export', key, file, '/y']);
    manifest.uninstallKeys.push({ key, file });
  });
  installKeys.forEach((key, index) => {
    const file = path.join(SMOKE_PROTECT_BACKUP_DIR, `install-${index}.reg`);
    reg(['export', key, file, '/y']);
    manifest.installKeys.push({ key, file });
  });
  shortcuts.forEach((file, index) => {
    const backup = path.join(SMOKE_PROTECT_BACKUP_DIR, `shortcut-${index}.lnk`);
    fs.copyFileSync(file, backup);
    manifest.shortcuts.push({ path: file, file: backup });
  });
  fs.writeFileSync(path.join(SMOKE_PROTECT_BACKUP_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const { key } of manifest.uninstallKeys) reg(['delete', key, '/f']);
  for (const { key } of manifest.installKeys) reg(['delete', key, '/f']);
  for (const { path: file } of manifest.shortcuts) fs.rmSync(file, { force: true });
  return manifest;
}

function restoreInstalledApp(manifest) {
  if (!manifest) return;
  const failures = [];
  for (const { path: file, file: backup } of manifest.shortcuts) {
    try {
      fs.copyFileSync(backup, file);
    } catch (error) {
      failures.push(`快捷方式 ${file}: ${error.message}`);
    }
  }
  for (const { key, file } of [...manifest.uninstallKeys, ...manifest.installKeys]) {
    try {
      reg(['import', file]);
    } catch (error) {
      failures.push(`注册表 ${key}: ${error.message}`);
    }
  }
  if (failures.length) {
    console.error('[installer-smoke] ⚠ 本机已安装实例的恢复未完成，请按下列信息手工恢复:');
    failures.forEach(item => console.error(`    - ${item}`));
    console.error(`    备份保留在: ${SMOKE_PROTECT_BACKUP_DIR}`);
  } else {
    fs.rmSync(SMOKE_PROTECT_BACKUP_DIR, { recursive: true, force: true });
    console.log('[installer-smoke] 本机已安装实例的注册表与快捷方式已恢复');
  }
}

/**
 * 运行临时安装的卸载器并等待其真正结束。
 * NSIS 卸载器会先把自身复制到临时目录再异步执行，直接 spawn 得到的退出只代表
 * “已启动”；不等它收尾就恢复本机安装，恢复的注册表项/快捷方式会被它随后的
 * 清理动作（按名删除快捷方式、删除注册表项）覆盖——2026-09-24 的二次误删原因之一。
 */
async function runUninstallerAndWait(uninstaller, installDir) {
  await run(uninstaller, ['/S'], 60000);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(installDir) || !fs.existsSync(path.join(installDir, 'SakuraFall.exe'))) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  // 主程序消失后，注册表与快捷方式的收尾可能还有短暂延迟，静置后再恢复
  await new Promise(resolve => setTimeout(resolve, 1000));
}

/** 保护生效的自检：本机不应再有任何可见的 SakuraFall 卸载注册表项 */
function assertOldInstallHidden() {
  const { uninstallKeys, installKeys } = listInstalledRegistrations();
  if (uninstallKeys.length || installKeys.length) {
    throw new Error('检测到本机仍存在 SakuraFall 卸载注册表项，保护未生效，已中止冒烟测试以免误删正常安装');
  }
}

(async () => {
  let protection = null;
  try {
    protection = protectInstalledApp();
    if (protection) {
      console.log('[installer-smoke] 检测到本机已安装 SakuraFall：已临时移走其注册表项与快捷方式，测试后自动恢复');
      assertOldInstallHidden();
    }
    let previousVersion = '';
    if (previousInstaller) {
      if (!fs.existsSync(previousInstaller)) throw new Error('previous installer not found');
      await run(previousInstaller, ['/S', `/D=${installDir}`], 90000);
      const previousExecutable = path.join(installDir, 'SakuraFall.exe');
      if (!fs.existsSync(previousExecutable)) throw new Error('previous executable is missing');
      previousVersion = path.basename(previousInstaller).match(/Setup-([0-9]+(?:\.[0-9]+)+)\.exe$/i)?.[1] || 'previous';
    }
    await run(installer, ['/S', `/D=${installDir}`], 90000);
    const executable = path.join(installDir, 'SakuraFall.exe');
    if (!fs.existsSync(executable)) throw new Error('installed executable is missing');
    const currentVersion = installedVersion(executable);
    const expectedVersion = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')).version;
    if (currentVersion !== expectedVersion) throw new Error(`installed version ${currentVersion} does not match ${expectedVersion}`);
    await run(process.execPath, [path.join(__dirname, 'smoke-packaged.js'), `--exe=${executable}`], 60000);
    await run(process.execPath, [path.join(__dirname, 'smoke-packaged.js'), '--offline', `--exe=${executable}`], 60000);
    console.log('[installer-smoke] install, online/offline launch, and data bootstrap passed');
    if (previousVersion) console.log(`[installer-smoke] in-place upgrade ${previousVersion} -> ${currentVersion} passed`);

    const uninstaller = path.join(installDir, 'Uninstall SakuraFall.exe');
    if (fs.existsSync(uninstaller)) await runUninstallerAndWait(uninstaller, installDir);
  } catch (error) {
    console.error(`[installer-smoke] ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { restoreInstalledApp(protection); } catch (error) { console.error(`[installer-smoke] 恢复本机已安装实例异常: ${error.message}`); }
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})();
