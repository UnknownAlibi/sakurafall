// LazyPlayerServices 代理下发单元测试
// 运行: node --test tests/lazy-player-services.test.js
const test = require('node:test');
const assert = require('node:assert');

test('applyProxy: 服务未加载时先记住代理，首次加载字幕服务即生效', () => {
  const modulePath = require.resolve('../src/main/services/LazyPlayerServices');
  delete require.cache[modulePath];
  const lazy = require(modulePath);
  // 模拟启动时 applyNetworkConfig 下发代理（播放器尚未打开、服务尚未加载）
  lazy.applyProxy('http://127.0.0.1:7890');
  assert.strictEqual(lazy.subtitle().http.proxy, 'http://127.0.0.1:7890');
});

test('applyProxy: 实例化后变更立即生效，空白值归一化为直连', () => {
  const lazy = require('../src/main/services/LazyPlayerServices');
  const subtitle = lazy.subtitle();
  lazy.applyProxy('   ');
  assert.strictEqual(subtitle.http.proxy, '');
  lazy.applyProxy('http://127.0.0.1:10808');
  assert.strictEqual(subtitle.http.proxy, 'http://127.0.0.1:10808');
  lazy.applyProxy('');
  assert.strictEqual(subtitle.http.proxy, '');
});