// UpdateChecker 版本对比单元测试
// 运行: node --test tests/update-checker.test.js
const test = require('node:test');
const assert = require('node:assert');
const updateChecker = require('../src/main/services/UpdateChecker');

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
