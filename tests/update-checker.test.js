// UpdateChecker 版本对比单元测试
// 运行: node --test tests/update-checker.test.js
const test = require('node:test');
const assert = require('node:assert');
const updateChecker = require('../src/main/services/UpdateChecker');
const { UpdateChecker, GITHUB_UPDATE_MANIFEST_URL } = require('../src/main/services/UpdateChecker');

test('_compareVersion: 相同版本返回 0', () => {
  assert.strictEqual(updateChecker._compareVersion('1.0.0', '1.0.0'), 0);
  assert.strictEqual(updateChecker._compareVersion('2.5.3', '2.5.3'), 0);
});

test('_compareVersion: 高版本返回 1', () => {
  assert.strictEqual(updateChecker._compareVersion('1.0.1', '1.0.0'), 1);
  assert.strictEqual(updateChecker._compareVersion('1.1.0', '1.0.9'), 1);
  assert.strictEqual(updateChecker._compareVersion('2.0.0', '1.9.9'), 1);
  assert.strictEqual(updateChecker._compareVersion('10.0.0', '9.9.9'), 1);
});

test('_compareVersion: 低版本返回 -1', () => {
  assert.strictEqual(updateChecker._compareVersion('1.0.0', '1.0.1'), -1);
  assert.strictEqual(updateChecker._compareVersion('1.0.9', '1.1.0'), -1);
  assert.strictEqual(updateChecker._compareVersion('1.9.9', '2.0.0'), -1);
});

test('_compareVersion: 位数不同时补 0 比较', () => {
  assert.strictEqual(updateChecker._compareVersion('1.0', '1.0.0'), 0);
  assert.strictEqual(updateChecker._compareVersion('1.0.0.0', '1.0'), 0);
  assert.strictEqual(updateChecker._compareVersion('1.0.1', '1.0'), 1);
  assert.strictEqual(updateChecker._compareVersion('1.0', '1.0.1'), -1);
});

test('_compareVersion: 空值或非法值按 0 处理', () => {
  assert.strictEqual(updateChecker._compareVersion('', '1.0.0'), -1);
  assert.strictEqual(updateChecker._compareVersion('1.0.0', ''), 1);
  assert.strictEqual(updateChecker._compareVersion('', ''), 0);
  assert.strictEqual(updateChecker._compareVersion('abc', '1.0.0'), -1);
});

test('_compareVersion: 正确处理预发布版本', () => {
  assert.strictEqual(updateChecker._compareVersion('1.0.0-beta', '1.0.0'), -1);
  assert.strictEqual(updateChecker._compareVersion('1.0.0', '1.0.0-rc.1'), 1);
  assert.strictEqual(updateChecker._compareVersion('1.0.0-rc.2', '1.0.0-rc.1'), 1);
  assert.strictEqual(updateChecker._compareVersion('1.0.1', '1.0.0-beta'), 1);
});

test('normalizeUpdateUrl: 仅允许安全的 http/https 更新源', () => {
  assert.strictEqual(
    updateChecker.normalizeUpdateUrl('https://example.com/latest.json#hash'),
    'https://example.com/latest.json'
  );
  assert.strictEqual(
    updateChecker.normalizeUpdateUrl('http://127.0.0.1:3000/latest.json'),
    'http://127.0.0.1:3000/latest.json'
  );
  assert.throws(() => updateChecker.normalizeUpdateUrl('http://example.com/latest.json'), /https/);
  assert.throws(() => updateChecker.normalizeUpdateUrl('file:///C:/latest.json'), /http\/https/);
  assert.throws(() => updateChecker.normalizeUpdateUrl('javascript:alert(1)'), /http\/https/);
});

test('normalizeDownloadUrl: 阻止非 http/https 下载链接', () => {
  assert.strictEqual(
    updateChecker.normalizeDownloadUrl('https://example.com/SakuraFall.exe'),
    'https://example.com/SakuraFall.exe'
  );
  assert.throws(() => updateChecker.normalizeDownloadUrl('http://example.com/SakuraFall.exe'), /https/);
  assert.throws(() => updateChecker.normalizeDownloadUrl('file:///C:/Windows/notepad.exe'), /http\/https/);
});

test('setServiceBaseUrl: 本机模式恢复 GitHub 更新源', () => {
  const checker = new UpdateChecker();
  checker.setServiceBaseUrl('https://service.example.com/');
  assert.strictEqual(checker.defaultUpdateUrl, 'https://service.example.com/updates/latest.json');
  assert.deepStrictEqual(checker.fallbackUpdateUrls, [GITHUB_UPDATE_MANIFEST_URL]);

  checker.setServiceBaseUrl('');
  assert.strictEqual(checker.defaultUpdateUrl, GITHUB_UPDATE_MANIFEST_URL);
  assert.deepStrictEqual(checker.fallbackUpdateUrls, []);
});

test('checkForUpdates: 服务端离线时自动回退 GitHub 清单', async () => {
  const checker = new UpdateChecker();
  checker.defaultUpdateUrl = 'https://service.example.com/updates/latest.json';
  checker.fallbackUpdateUrls = ['https://github.example.com/latest.json'];
  checker._config = {};
  checker.getCurrentVersion = () => '1.0.0';
  const calls = [];
  checker.http.fetch = async url => {
    calls.push(url);
    if (url.includes('service.example.com')) throw new Error('service offline');
    return JSON.stringify({ version: '1.1.0', downloadUrl: 'https://github.example.com/setup.exe' });
  };

  const result = await checker.checkForUpdates({ silent: true });
  assert.deepStrictEqual(calls, [
    'https://service.example.com/updates/latest.json',
    'https://github.example.com/latest.json'
  ]);
  assert.strictEqual(result.hasUpdate, true);
  assert.strictEqual(result.fallbackUsed, true);
  assert.strictEqual(result.sourceUrl, 'https://github.example.com/latest.json');
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 注入 electron mock 后重新加载 UpdateChecker。
 * 真实 electron 包在纯 Node 下只导出二进制路径，`app` 是 undefined，
 * 无法覆盖 app.isPackaged（安装守卫依赖它）相关分支。
 */
function loadCheckerWithElectron({ isPackaged = false, userDataDir = null } = {}) {
  const os = require('os');
  const nodePath = require('path');
  const dataDir = userDataDir || nodePath.join(os.tmpdir(), `sakurafall-test-ud-${process.pid}`);
  const electronPath = require.resolve('electron');
  const modulePath = require.resolve('../src/main/services/UpdateChecker');
  const previousElectron = require.cache[electronPath];
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      app: {
        isPackaged,
        getVersion: () => '1.0.0',
        getPath: name => (name === 'userData' ? dataDir : os.tmpdir()),
        quit: () => {}
      }
    }
  };
  delete require.cache[modulePath];
  const { UpdateChecker: FreshChecker } = require(modulePath);
  return {
    checker: new FreshChecker(),
    userDataDir: dataDir,
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      delete require.cache[modulePath];
      require(modulePath);
    }
  };
}

test('startManagedUpdate: 下载中防重复启动，完成后停在 ready 等用户确认', async () => {
  const checker = new UpdateChecker();
  const originalDownload = checker.downloadInstaller;
  const originalRun = checker.runInstaller;
  let downloads = 0;
  let installs = 0;
  checker.downloadInstaller = async (url, onProgress) => {
    downloads += 1;
    onProgress && onProgress({ received: 50, total: 100, percent: 50 });
    return { success: true, path: 'C:\\updates\\setup.exe', received: 100, total: 100 };
  };
  checker.runInstaller = async () => {
    installs += 1;
    return { success: true };
  };

  try {
    const first = checker.startManagedUpdate(
      'https://github.example.com/setup.exe',
      null,
      { latestVersion: '1.1.0', releaseNotes: '修复若干问题' }
    );
    assert.strictEqual(first.status, 'downloading');
    // 下载进行中再次启动：直接返回当前状态，不触发重复下载
    const again = checker.startManagedUpdate('https://github.example.com/setup.exe');
    assert.strictEqual(again.alreadyRunning, true);
    assert.strictEqual(downloads, 1);

    await wait(50);
    const state = checker.getUpdateState();
    assert.strictEqual(state.status, 'ready');
    assert.strictEqual(state.percent, 100);
    assert.strictEqual(state.filePath, 'C:\\updates\\setup.exe');
    // 版本信息随状态带出，供全局更新卡片直接展示
    assert.strictEqual(state.latestVersion, '1.1.0');
    assert.strictEqual(state.releaseNotes, '修复若干问题');

    // 回归守卫：下载完成后不得自动安装/重启，必须等用户在卡片上确认
    await wait(2200);
    assert.strictEqual(installs, 0, '下载完成后不应自动安装');
    assert.strictEqual(checker.getUpdateState().status, 'ready');
  } finally {
    checker.downloadInstaller = originalDownload;
    checker.runInstaller = originalRun;
  }
});

test('installManagedUpdate: 未下载完成时拒绝安装', async () => {
  const checker = new UpdateChecker();
  const originalRun = checker.runInstaller;
  let installs = 0;
  checker.runInstaller = async () => {
    installs += 1;
    return { success: true };
  };

  try {
    const result = await checker.installManagedUpdate();
    assert.strictEqual(result.success, false);
    assert.match(result.error, /没有已下载完成/);
    assert.strictEqual(installs, 0);
    assert.strictEqual(checker.getUpdateState().status, 'idle');
  } finally {
    checker.runInstaller = originalRun;
  }
});

test('installManagedUpdate: 开发模式下拦截覆盖安装', async () => {
  const { checker, restore } = loadCheckerWithElectron({ isPackaged: false });
  try {
    let installs = 0;
    checker.downloadInstaller = async () => ({ success: true, path: 'C:\\updates\\setup.exe' });
    checker.runInstaller = async () => {
      installs += 1;
      return { success: true };
    };
    checker.startManagedUpdate('https://github.example.com/setup.exe');
    await wait(50);
    assert.strictEqual(checker.getUpdateState().status, 'ready');

    const result = await checker.installManagedUpdate();
    assert.strictEqual(result.success, false);
    assert.strictEqual(installs, 0, '开发模式不能真的去覆盖 electron 自身目录');
    assert.strictEqual(checker.getUpdateState().status, 'error');
    assert.match(checker.getUpdateState().error, /开发模式/);
  } finally {
    restore();
  }
});

test('installManagedUpdate: 打包环境确认后安装，失败回落 error 并广播中间态', async () => {
  const { checker, restore } = loadCheckerWithElectron({ isPackaged: true });
  try {
    checker.downloadInstaller = async () => ({ success: true, path: 'C:\\updates\\setup.exe' });
    checker.runInstaller = async () => ({ success: false, error: '安装程序启动失败' });
    checker.startManagedUpdate('https://github.example.com/setup.exe');
    await wait(50);
    assert.strictEqual(checker.getUpdateState().status, 'ready');

    const emitted = [];
    const result = await checker.installManagedUpdate(state => emitted.push(state.status));
    assert.ok(emitted.includes('installing'), '应广播 installing 中间态供 UI 展示');
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.error, '安装程序启动失败');
  } finally {
    restore();
  }
});

test('startManagedUpdate: 下载失败进入 error 状态', async () => {
  const checker = new UpdateChecker();
  const originalDownload = checker.downloadInstaller;
  checker.downloadInstaller = async () => ({ success: false, error: '网络中断' });

  try {
    checker.startManagedUpdate('https://github.example.com/setup.exe');
    await new Promise(resolve => setTimeout(resolve, 50));
    const state = checker.getUpdateState();
    assert.strictEqual(state.status, 'error');
    assert.strictEqual(state.error, '网络中断');
  } finally {
    checker.downloadInstaller = originalDownload;
  }
});

test('downloadInstaller: URL 尾段的路径穿越被消解在更新目录内', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-ud-tv-'));
  const { checker, restore } = loadCheckerWithElectron({ isPackaged: true, userDataDir });

  try {
    const targets = [];
    checker.http.downloadToFile = async (url, filePath) => {
      targets.push(filePath);
      return { received: 12, total: 12 };
    };
    // 解码后尾段是 ../../evil/payload.exe，未加 basename 时会写出 updates 目录
    const result = await checker.downloadInstaller('https://example.com/..%2F..%2Fevil%2Fpayload.exe');
    assert.strictEqual(result.success, true);
    const updatesDir = path.resolve(path.join(userDataDir, 'updates'));
    assert.strictEqual(path.dirname(path.resolve(targets[0])), updatesDir);
    assert.strictEqual(path.basename(path.resolve(targets[0])), 'payload.exe');
  } finally {
    restore();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

test('downloadInstaller: sha256 匹配放行，不匹配则删除文件并报错', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-ud-hs-'));
  const { checker, restore } = loadCheckerWithElectron({ isPackaged: true, userDataDir });
  const payload = Buffer.from('sakurafall-installer-bytes');
  const goodHash = crypto.createHash('sha256').update(payload).digest('hex');

  try {
    checker.http.downloadToFile = async (url, filePath) => {
      fs.writeFileSync(filePath, payload);
      return { received: payload.length, total: payload.length };
    };

    // 摘要一致：通过并返回 checksum
    const ok = await checker.downloadInstaller(
      'https://example.com/SakuraFall-Setup-1.1.0.exe',
      null,
      { sha256: goodHash.toUpperCase() }
    );
    assert.strictEqual(ok.success, true, ok.error);
    assert.strictEqual(ok.checksum, goodHash);
    assert.ok(fs.existsSync(ok.path));

    // 摘要不一致：文件必须被删掉，且返回失败
    const bad = await checker.downloadInstaller(
      'https://example.com/SakuraFall-Setup-1.1.0.exe',
      null,
      { sha256: '0'.repeat(64) }
    );
    assert.strictEqual(bad.success, false);
    assert.match(bad.error, /校验失败/);
    assert.ok(!fs.existsSync(ok.path), '摘要不匹配时必须删除已下载的安装包');
  } finally {
    restore();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

test('runInstaller: 正确使用 process.execPath 字符串构造安装命令', async () => {
  // 回归：旧代码误把 process.execPath 当函数调用（它是字符串属性），
  // TypeError 被 catch 吞掉后 app.quit 永不执行，UI 永远停留在“正在安装”
  const childProcess = require('child_process');
  const realSpawn = childProcess.spawn;
  const spawned = [];
  childProcess.spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return {
      once(event, callback) {
        if (event === 'spawn') queueMicrotask(callback);
        return this;
      },
      unref() {}
    };
  };

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-ud-ri-'));
  const updatesDir = path.join(userDataDir, 'updates');
  fs.mkdirSync(updatesDir, { recursive: true });
  const fakeInstaller = path.join(updatesDir, `sakurafall-setup-${process.pid}.exe`);
  // spawn 桩必须在重新加载模块之前装好（模块顶层 require 了 child_process）
  const { checker, restore } = loadCheckerWithElectron({ isPackaged: true, userDataDir });

  try {
    fs.writeFileSync(fakeInstaller, 'dummy');
    const result = await checker.runInstaller(fakeInstaller);
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(spawned.length, 1);
    assert.strictEqual(spawned[0].cmd, 'powershell.exe');
    assert.ok(spawned[0].args.includes('-NonInteractive'), '安装接力进程应以非交互模式运行');
    assert.strictEqual(spawned[0].opts.env.SAKURAFALL_UPDATE_EXECUTABLE, path.resolve(process.execPath));
    assert.strictEqual(spawned[0].opts.env.SAKURAFALL_UPDATE_INSTALL_DIR, path.dirname(path.resolve(process.execPath)));
    assert.strictEqual(spawned[0].opts.env.SAKURAFALL_UPDATE_INSTALLER, path.resolve(fakeInstaller));
    assert.ok(spawned[0].args.join(' ').includes('Wait-Process'), '应等待旧版本完全退出后再覆盖安装');
  } finally {
    childProcess.spawn = realSpawn;
    restore();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

test('runInstaller: 拒绝执行更新目录之外的 exe', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-ud-out-'));
  const outside = path.join(userDataDir, 'not-updates', 'evil.exe');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, 'dummy');
  const childProcess = require('child_process');
  const realSpawn = childProcess.spawn;
  let spawned = 0;
  childProcess.spawn = () => {
    spawned += 1;
    return { once: () => {}, unref() {} };
  };
  const { checker, restore } = loadCheckerWithElectron({ isPackaged: true, userDataDir });

  try {
    const result = await checker.runInstaller(outside);
    assert.strictEqual(result.success, false);
    assert.match(result.error, /更新目录/);
    assert.strictEqual(spawned, 0, '目录外的安装包绝不能被执行');
  } finally {
    childProcess.spawn = realSpawn;
    restore();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});
