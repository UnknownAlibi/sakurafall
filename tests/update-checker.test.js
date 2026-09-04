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

test('startManagedUpdate: 下载中防重复启动，完成后自动安装', async () => {
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
    const first = checker.startManagedUpdate('https://github.example.com/setup.exe');
    assert.strictEqual(first.status, 'downloading');
    // 下载进行中再次启动：直接返回当前状态，不触发重复下载
    const again = checker.startManagedUpdate('https://github.example.com/setup.exe');
    assert.strictEqual(again.alreadyRunning, true);
    assert.strictEqual(downloads, 1);

    // 等待下载链与 2 秒自动安装延时
    await new Promise(resolve => setTimeout(resolve, 2300));
    const state = checker.getUpdateState();
    assert.strictEqual(state.status, 'completed');
    assert.strictEqual(state.percent, 100);
    assert.strictEqual(installs, 1);
  } finally {
    checker.downloadInstaller = originalDownload;
    checker.runInstaller = originalRun;
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
