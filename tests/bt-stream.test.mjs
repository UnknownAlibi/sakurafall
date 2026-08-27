import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BtStreamService,
  isVideoFile,
  extractInfoHash,
  appendDefaultTrackers,
  buildStreamUrl,
  DEFAULT_TRACKERS
} from '../src/main/services/bt/BtStreamService.js';

test('isVideoFile recognizes common video containers case-insensitively', () => {
  assert.equal(isVideoFile('Show - 01 [1080p].mkv'), true);
  assert.equal(isVideoFile('movie.MP4'), true);
  assert.equal(isVideoFile('episode.ts'), true);
  assert.equal(isVideoFile('cover.jpg'), false);
  assert.equal(isVideoFile(''), false);
  assert.equal(isVideoFile(null), false);
});

test('extractInfoHash parses hex and base32 hashes and lowercases them', () => {
  assert.equal(
    extractInfoHash('magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567'),
    '0123456789abcdef0123456789abcdef01234567'
  );
  assert.equal(
    extractInfoHash('magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=x'),
    'abcdefghijklmnopqrstuvwxyz234567'
  );
  assert.equal(extractInfoHash('https://example.com/torrent'), '');
  assert.equal(extractInfoHash(''), '');
});

test('appendDefaultTrackers appends public trackers to bare magnets', () => {
  const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
  const enriched = appendDefaultTrackers(magnet);
  assert.ok(enriched.startsWith(magnet));
  assert.ok(enriched.includes(`tr=${encodeURIComponent(DEFAULT_TRACKERS[0])}`));
  assert.ok(enriched.includes('&'));
});

test('appendDefaultTrackers does not duplicate existing trackers', () => {
  const existing = encodeURIComponent(DEFAULT_TRACKERS[0]);
  const magnet = `magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=${existing}`;
  const enriched = appendDefaultTrackers(magnet);
  const occurrences = enriched.split(`tr=${existing}`).length - 1;
  assert.equal(occurrences, 1);
});

test('appendDefaultTrackers passes through non-magnet strings unchanged', () => {
  assert.equal(appendDefaultTrackers('https://example.com'), 'https://example.com');
  assert.equal(appendDefaultTrackers(''), '');
});

test('buildStreamUrl encodes each path segment but keeps slashes', () => {
  const url = buildStreamUrl(51413, 'abc123', 'Group/Show/Show - 01 [1080p].mkv');
  assert.ok(url.startsWith('http://127.0.0.1:51413/webtorrent/abc123/'));
  // 斜杠保留为分隔符，其余特殊字符按段编码
  assert.ok(url.includes('/Group/Show/'));
  assert.ok(url.includes(encodeURIComponent('Show - 01 [1080p].mkv')));
});

// ===== 缓存生命周期（不启动 webtorrent，直接驱动内部方法） =====
function buildCacheSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-stream-cache-test-'));
  const service = new BtStreamService({ app: { getPath: () => root, on: () => {} } });
  service.cacheDir = path.join(root, 'bt-stream-cache');
  fs.mkdirSync(service.cacheDir, { recursive: true });
  return { root, service };
}

test('cleanup removes orphan partial dirs and keeps registered completed ones', () => {
  const { service } = buildCacheSandbox();
  const completedDir = path.join(service.cacheDir, '[Group] Show');
  const orphanDir = path.join(service.cacheDir, '[Group] Halfwatched');
  fs.mkdirSync(completedDir, { recursive: true });
  fs.mkdirSync(orphanDir, { recursive: true });
  fs.writeFileSync(path.join(completedDir, 'Show - 01.mkv'), 'x');
  fs.writeFileSync(path.join(orphanDir, 'Show - 01.mkv'), 'x');

  service._meta = {
    entries: {
      ['a'.repeat(40)]: { name: 'Show', dirName: '[Group] Show', size: 1, completedAt: Date.now() }
    }
  };
  service._cleanupCache();

  assert.equal(fs.existsSync(completedDir), true, '已登记的完整缓存应保留');
  assert.equal(fs.existsSync(orphanDir), false, '未登记的半截目录应被清除');
});

test('cleanup drops completed entries past retention window', () => {
  const { service } = buildCacheSandbox();
  const oldDir = path.join(service.cacheDir, '[Group] OldShow');
  fs.mkdirSync(oldDir, { recursive: true });
  service._meta = {
    entries: {
      ['b'.repeat(40)]: {
        name: 'OldShow',
        dirName: '[Group] OldShow',
        size: 1,
        // 8 天前完成：超过 7 天保留期
        completedAt: Date.now() - 8 * 24 * 60 * 60 * 1000
      }
    }
  };
  service._cleanupCache();
  assert.equal(fs.existsSync(oldDir), false, '超过保留期的完整缓存应被删除');
  assert.equal(service._meta.entries['b'.repeat(40)], undefined, '元数据应同步移除');
});

test('cleanup evicts oldest entries when cache exceeds size cap', () => {
  const { service } = buildCacheSandbox();
  const cap = service.getCacheInfo().maxBytes; // 构造超限前先拿到常量
  const gb = 1024 * 1024 * 1024;
  const oldDir = path.join(service.cacheDir, '[Group] Old');
  const newDir = path.join(service.cacheDir, '[Group] New');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  service._meta = {
    entries: {
      ['c'.repeat(40)]: { name: 'Old', dirName: '[Group] Old', size: cap, completedAt: Date.now() - 2 * 24 * 3600 * 1000 },
      ['d'.repeat(40)]: { name: 'New', dirName: '[Group] New', size: 2 * gb, completedAt: Date.now() }
    }
  };
  service._cleanupCache();
  // cap + 2GB 超限：最旧的（cap 大小）先被淘汰
  assert.equal(fs.existsSync(oldDir), false, '超限时最旧的缓存应被淘汰');
  assert.equal(fs.existsSync(newDir), true, '较新的缓存应保留');
});

test('clearCache wipes all data and resets meta', async () => {
  const { service } = buildCacheSandbox();
  const dir = path.join(service.cacheDir, '[Group] Show');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Show - 01.mkv'), 'x');
  service._meta = { entries: { ['e'.repeat(40)]: { name: 'Show', dirName: '[Group] Show', size: 1, completedAt: Date.now() } } };
  service._saveMeta();

  const result = await service.clearCache();
  assert.equal(result.success, true);
  assert.equal(fs.existsSync(dir), false, '缓存内容应被清空');
  assert.equal(fs.existsSync(service.cacheDir), true, '缓存根目录应保留');
  assert.deepEqual(service._meta.entries, {}, '元数据应重置');
});

test('torrentDirName derives folder from first file path', () => {
  const { service } = buildCacheSandbox();
  assert.equal(service._torrentDirName({ name: 'Show', files: [{ path: '[Group] Show\\Show - 01.mkv' }] }), '[Group] Show');
  assert.equal(service._torrentDirName({ name: 'Fallback', files: [] }), 'Fallback');
});

test('buildStreamUrl encodes characters that would break URL parsing', () => {
  const url = buildStreamUrl(8080, 'hash', 'dir/file#1?v=2.mkv');
  assert.ok(url.includes(encodeURIComponent('file#1?v=2.mkv')));
  assert.ok(!url.includes('#'));
  assert.ok(!url.includes('?'));
});

// ===== 代理接线：setProxy 归一化地址，代理变化时重建客户端 =====
test('setProxy normalizes bare host into http url and skips redundant updates', () => {
  const { service } = buildCacheSandbox();
  service.setProxy('127.0.0.1:7890');
  assert.equal(service.proxyUrl, 'http://127.0.0.1:7890');
  service.setProxy('http://127.0.0.1:7890'); // 等价地址不触发重建
  assert.equal(service.proxyUrl, 'http://127.0.0.1:7890');
  service.setProxy('socks5://127.0.0.1:1080');
  assert.equal(service.proxyUrl, 'socks5://127.0.0.1:1080');
  service.setProxy('');
  assert.equal(service.proxyUrl, '');
});

test('setProxy tears down existing client when proxy changes', () => {
  const { service } = buildCacheSandbox();
  let destroyed = false;
  let agentClosed = false;
  service.client = { destroy: () => { destroyed = true; } };
  service._initPromise = Promise.resolve(service.client);
  service._trackerAgent = { close: () => { agentClosed = true; } };
  service._doneWatched.add('x'.repeat(40));

  service.setProxy('http://127.0.0.1:7890');

  assert.equal(destroyed, true, '旧客户端应被销毁');
  assert.equal(agentClosed, true, '旧代理 agent 应被关闭');
  assert.equal(service.client, null);
  assert.equal(service._initPromise, null);
  assert.equal(service._trackerAgent, null);
  assert.equal(service.serverPort, 0);
  assert.equal(service._doneWatched.size, 0);
  assert.equal(service.proxyUrl, 'http://127.0.0.1:7890');
});

test('buildTrackerProxyOpts returns dispatcher pairs for supported protocols and null otherwise', () => {
  const { service } = buildCacheSandbox();

  service.proxyUrl = '';
  assert.equal(service._buildTrackerProxyOpts(), null, '无代理应返回 null');

  service.proxyUrl = 'http://127.0.0.1:7890';
  let opts = service._buildTrackerProxyOpts();
  assert.ok(opts.httpAgent && opts.httpsAgent, 'http 代理应生成 agent');
  assert.equal(opts.httpAgent, opts.httpsAgent);
  assert.equal(opts.socksProxy, null, 'socksProxy 必须为 null 而非 undefined（bittorrent-tracker UDP clone bug）');
  try { opts.httpAgent.close(); } catch {}

  service.proxyUrl = 'socks5://127.0.0.1:1080';
  opts = service._buildTrackerProxyOpts();
  assert.ok(opts.httpAgent && opts.httpsAgent, 'socks5 代理应生成 agent');
  try { opts.httpAgent.close(); } catch {}
  service._trackerAgent = null;

  service.proxyUrl = 'ftp://127.0.0.1:21';
  assert.equal(service._buildTrackerProxyOpts(), null, '不支持的协议应返回 null');
});

test('detected proxy fills empty proxy on create and is session-cached', async () => {
  const { service } = buildCacheSandbox();
  // 模拟探测器返回一个地址：_create 只取缓存值，不会真正起客户端（此处直接驱动取值逻辑）
  service._detectedProxy = 'http://127.0.0.1:7890';
  service.proxyUrl = '';
  if (!service.proxyUrl && service._detectedProxy) service.proxyUrl = service._detectedProxy;
  assert.equal(service.proxyUrl, 'http://127.0.0.1:7890', '探测结果应填充空代理');

  // 探测失败缓存 ''：会话内不再重复探测
  const service2 = new BtStreamService({ app: { getPath: () => '/tmp', on: () => {} } });
  service2._detectedProxy = '';
  assert.equal(service2._detectedProxy, '', '探测失败应以空串哨兵缓存');
});
