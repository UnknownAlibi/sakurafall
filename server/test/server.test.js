const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApplication } = require('../src/server');
const { CoverProxy } = require('../src/coverProxy');
const { BangumiProxy, rewriteCoverUrls } = require('../src/bangumiProxy');

test('health, room and unsupported proxy routes behave predictably', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-server-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createApplication({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    cacheDir: path.join(dataDir, 'cache'),
    releaseDir: path.join(dataDir, 'releases'),
    tlsCert: '',
    tlsKey: '',
    upstreams: ['http://127.0.0.1:9'],
    requestTimeoutMs: 50,
    cacheMaxBytes: 32 * 1024 * 1024,
    coverMaxBytes: 1024,
    rateLimitPerMinute: 100,
    roomTtlMs: 1000,
    maxRoomMembers: 4,
    logLevel: 'silent'
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.relay.close(); app.server.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const health = await fetch(`${base}/health`).then(response => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.service, 'sakurafall');

  const roomResponse = await fetch(`${base}/v1/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName: 'test room' })
  });
  assert.equal(roomResponse.status, 201);
  const room = await roomResponse.json();
  assert.match(room.roomCode, /^\d{6}$/);
  assert.ok(room.hostToken.length >= 24);

  const unsupported = await fetch(`${base}/proxy?url=https://example.com`);
  assert.equal(unsupported.status, 404);
});

test('Bangumi responses are shared through the disk cache', async t => {
  let upstreamCalls = 0;
  const upstream = require('node:http').createServer((req, res) => {
    upstreamCalls += 1;
    const body = JSON.stringify({ id: 42, name: 'cached subject' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-proxy-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createApplication({
    host: '127.0.0.1', port: 0, dataDir,
    cacheDir: path.join(dataDir, 'cache'), releaseDir: path.join(dataDir, 'releases'),
    tlsCert: '', tlsKey: '',
    upstreams: [`http://127.0.0.1:${upstream.address().port}`],
    requestTimeoutMs: 1000, cacheMaxBytes: 32 * 1024 * 1024,
    coverMaxBytes: 1024, rateLimitPerMinute: 100,
    roomTtlMs: 1000, maxRoomMembers: 4, logLevel: 'silent'
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.relay.close(); app.server.close(); });
  const url = `http://127.0.0.1:${app.server.address().port}/v0/subjects/42`;

  const first = await fetch(url);
  const second = await fetch(url);
  assert.equal(first.headers.get('x-sakurafall-cache'), 'MISS');
  assert.equal(second.headers.get('x-sakurafall-cache'), 'HIT');
  assert.deepEqual(await second.json(), { id: 42, name: 'cached subject' });
  assert.equal(upstreamCalls, 1);
});

test('cover proxy upgrades allowlisted HTTP image URLs to HTTPS', () => {
  const proxy = new CoverProxy({ cache: {}, timeoutMs: 1000, maxBytes: 1024 });
  const target = proxy.parseTarget('http://bgmimg.anibt.net/pic/cover/test.jpg');
  assert.equal(target.toString(), 'https://bgmimg.anibt.net/pic/cover/test.jpg');
  assert.equal(proxy.parseTarget('http://example.com/test.jpg'), null);
});

test('Bangumi payload cover URLs are rewritten before caching', () => {
  const input = { images: { common: 'http://bgmimg.anibt.net/pic/cover/test.jpg' }, url: 'https://bgm.tv/subject/1' };
  assert.deepEqual(rewriteCoverUrls(input, 'https://47.109.87.3:8443'), {
    images: {
      common: 'https://47.109.87.3:8443/cover?url=https%3A%2F%2Fbgmimg.anibt.net%2Fpic%2Fcover%2Ftest.jpg'
    },
    url: 'https://bgm.tv/subject/1'
  });
});

test('search responses warm r/400 cover variants and prefetch the next page', () => {
  const { coverWarmUrls, nextSearchRequest } = require('../src/bangumiProxy');

  // 请求体带 limit/offset：下一页请求体 offset + limit，其余字段原样保留
  const current = Buffer.from(JSON.stringify({ keyword: '', sort: 'date', limit: 50, offset: 100, filter: { type: [2] } }));
  const fromBody = nextSearchRequest(new URL('http://x/v0/search/subjects'), current);
  const next = JSON.parse(fromBody.body.toString('utf8'));
  assert.equal(next.offset, 150);
  assert.equal(next.limit, 50);
  assert.equal(next.sort, 'date');
  assert.deepEqual(next.filter, { type: [2] });
  assert.equal(fromBody.url.searchParams.get('offset'), null);

  // 客户端真实格式：limit/offset 在 URL query，请求体只有 keyword/sort/filter
  const clientBody = Buffer.from(JSON.stringify({ keyword: '', sort: 'score', filter: { type: [2] } }));
  const fromQuery = nextSearchRequest(new URL('http://x/v0/search/subjects?limit=20&offset=20'), clientBody);
  assert.equal(fromQuery.url.searchParams.get('limit'), '20');
  assert.equal(fromQuery.url.searchParams.get('offset'), '40');
  assert.equal(fromQuery.body, clientBody);

  // 缺失 limit/offset 或 limit<=1 的探测请求跳过预取
  assert.equal(nextSearchRequest(new URL('http://x/v0/search/subjects'), Buffer.from('{}')), null);
  assert.equal(nextSearchRequest(new URL('http://x/v0/search/subjects'), Buffer.alloc(0)), null);
  assert.equal(nextSearchRequest(new URL('http://x/v0/search/subjects?limit=1&offset=0'), clientBody), null);

  // 封面变体：/pic/ → /r/400（与客户端 getRemoteImagePreviewUrl 一致），非图床 URL 忽略；
  // 协议保持原样，由 CoverProxy.parseTarget 统一升级 https。
  const variants = coverWarmUrls({
    data: [
      { images: { common: 'https://bgmimg.anibt.net/pic/cover/l/ab/cd.jpg' } },
      { images: { common: 'http://lain.bgm.tv/pic/cover/l/ef/gh.jpg' } },
      { images: { common: 'https://example.test/other.png' } }
    ],
    total: 100
  });
  assert.deepEqual(variants.sort(), [
    'http://lain.bgm.tv/r/400/pic/cover/l/ef/gh.jpg',
    'https://bgmimg.anibt.net/r/400/pic/cover/l/ab/cd.jpg'
  ].sort());
});

test('search MISS warms covers and prefetched next page serves as HIT', async t => {
  const { ALLOWED_IMAGE_HOSTS } = require('../src/coverProxy');
  const http = require('node:http');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000', 'hex');
  const seenSearchQueries = [];
  const imageHits = [];

  // mock 图床：只监听 IPv4 回环，返回 image/png
  const imageUpstream = http.createServer((req, res) => {
    imageHits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length });
    res.end(PNG);
  });
  await new Promise(r => imageUpstream.listen(0, '127.0.0.1', r));
  t.after(() => imageUpstream.close());

  // mock Bangumi 上游：记录 query，返回封面指向 [::1]（未监听，迫使主机回退到 127.0.0.1）
  const apiUpstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seenSearchQueries.push(req.url);
      const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset')) || 0;
      const imgPort = imageUpstream.address().port;
      const payload = {
        total: 100,
        data: Array.from({ length: 2 }, (_, i) => ({
          id: offset + i,
          images: { common: `http://[::1]:${imgPort}/pic/cover/l/${offset}/${i}.jpg` }
        }))
      };
      const buf = Buffer.from(JSON.stringify(payload));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
      res.end(buf);
    });
  });
  await new Promise(r => apiUpstream.listen(0, '127.0.0.1', r));
  t.after(() => apiUpstream.close());

  // 测试主机白名单：移除真实图床（避免测试触网），注入回环 mock 主机
  const realHosts = [...ALLOWED_IMAGE_HOSTS];
  ALLOWED_IMAGE_HOSTS.clear();
  ALLOWED_IMAGE_HOSTS.add('[::1]');
  ALLOWED_IMAGE_HOSTS.add('127.0.0.1');
  t.after(() => { ALLOWED_IMAGE_HOSTS.clear(); realHosts.forEach(h => ALLOWED_IMAGE_HOSTS.add(h)); });

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-warm-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const app = createApplication({
    host: '127.0.0.1', port: 0, dataDir,
    cacheDir: path.join(dataDir, 'cache'), releaseDir: path.join(dataDir, 'releases'),
    tlsCert: '', tlsKey: '',
    upstreams: [`http://127.0.0.1:${apiUpstream.address().port}`],
    requestTimeoutMs: 2000, cacheMaxBytes: 32 * 1024 * 1024,
    coverMaxBytes: 1024 * 1024, rateLimitPerMinute: 100,
    roomTtlMs: 1000, maxRoomMembers: 4, logLevel: 'silent',
    coverWarmEnabled: true, coverWarmConcurrency: 2,
    publicBaseUrl: 'http://127.0.0.1:1'
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.relay.close(); app.server.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // 客户端真实格式：limit/offset 在 URL query，请求体只有 keyword/sort/filter
  const searchBody = JSON.stringify({ keyword: '', sort: 'score', filter: { type: [2] } });
  const first = await fetch(`${base}/v0/search/subjects?limit=2&offset=0`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: searchBody
  });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-sakurafall-cache'), 'MISS');
  const firstPayload = await first.json();
  // 响应里的封面被改写为代理 URL
  assert.match(firstPayload.data[0].images.common, /\/cover\?url=/);

  // 等预热泵抓完（2 封面 + 预取下一页 2 封面）
  await new Promise(r => setTimeout(r, 800));
  // 预热触发过 mock 图床（r/400 变体），且经主机回退（[::1] 不可达 → 127.0.0.1）
  assert.ok(imageHits.some(url => url.includes('/r/400/')), '应请求 r/400 缩略变体: ' + JSON.stringify(imageHits));
  // 下一页（offset=2）被预取（上游收到过该 query）
  assert.ok(seenSearchQueries.some(q => new URL(q, 'http://x').searchParams.get('offset') === '2'), '应预取下一页搜索');

  // 下一页请求 = HIT（预取生效，客户端滚动加载零等待）
  const second = await fetch(`${base}/v0/search/subjects?limit=2&offset=2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: searchBody
  });
  assert.equal(second.headers.get('x-sakurafall-cache'), 'HIT');

  // 预取页的封面已暖：/cover 直接 HIT（含主机回退后缓存于原始 [::1] 键下）
  const secondPayload = await second.json();
  const proxied = secondPayload.data[0].images.common;
  const inner = new URL(proxied).searchParams.get('url').replace('/pic/cover', '/r/400/pic/cover');
  const cover = await fetch(`${base}/cover?url=${encodeURIComponent(inner)}`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('x-sakurafall-cache'), 'HIT');
});
