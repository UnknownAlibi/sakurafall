const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { BangumiApi } = require('../src/main/services/BangumiApi');

function createServer(handler) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      hits: () => hits,
      close: () => new Promise(done => server.close(done))
    }));
  });
}

test('BangumiApi keeps the learned mirror when identical settings are reapplied', () => {
  const api = new BangumiApi();
  api._preferredMirrorBase = 'https://mirror.example.com';

  api.setBaseUrl('');
  api.setProxy('');

  assert.equal(api._preferredMirrorBase, 'https://mirror.example.com');
});

test('cancelling detail requests neither retries mirrors nor penalizes endpoint health', async () => {
  let accepted;
  const arrived = new Promise(resolve => { accepted = resolve; });
  const primary = await createServer(() => accepted());
  const mirror = await createServer((_req, res) => res.end('{}'));
  const api = new BangumiApi();
  api.defaultBaseUrl = primary.baseUrl;
  api.baseUrl = primary.baseUrl;
  api.publicApiMirrors = [mirror.baseUrl];
  api._mirrorScore = base => base === primary.baseUrl ? 100 : 0;
  let failures = 0;
  api._markBaseFailure = () => failures++;
  const controller = new AbortController();
  try {
    const pending = assert.rejects(api.getDetail(1, { signal: controller.signal }), { name: 'AbortError' });
    await arrived;
    controller.abort();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(primary.hits(), 1);
    assert.equal(mirror.hits(), 0);
    assert.equal(failures, 0);
  } finally {
    await primary.close();
    await mirror.close();
  }
});

test('BangumiApi shares one failed endpoint probe across concurrent requests', async () => {
  const unavailable = await createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":"unavailable"}');
    }, 30);
  });
  const mirror = await createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  const api = new BangumiApi();
  api.defaultBaseUrl = unavailable.baseUrl;
  api.baseUrl = unavailable.baseUrl;
  api.publicApiMirrors = [mirror.baseUrl];
  api._mirrorScore = base => base === unavailable.baseUrl ? 100 : 0;

  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => api.request(`${unavailable.baseUrl}/subject/${index}`))
    );

    assert.equal(unavailable.hits(), 1);
    assert.equal(mirror.hits(), 6);
    assert.deepEqual(
      results.map(item => item.path),
      Array.from({ length: 6 }, (_, index) => `/subject/${index}`)
    );
  } finally {
    await unavailable.close();
    await mirror.close();
  }
});

test('BangumiApi hedges a slow cold endpoint instead of waiting for its timeout', async () => {
  const slow = await createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"source":"slow"}');
    }, 900);
  });
  const fast = await createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"source":"fast"}');
  });
  const api = new BangumiApi();
  api.defaultBaseUrl = slow.baseUrl;
  api.baseUrl = slow.baseUrl;
  api.publicApiMirrors = [fast.baseUrl];
  api._mirrorScore = base => base === slow.baseUrl ? 100 : 0;

  try {
    const startedAt = Date.now();
    const result = await api.request(`${slow.baseUrl}/calendar`);
    const elapsed = Date.now() - startedAt;

    assert.equal(result.source, 'fast');
    assert.ok(elapsed < 700, `hedged request took ${elapsed}ms`);
    assert.equal(slow.hits(), 1);
    assert.equal(fast.hits(), 1);
  } finally {
    await slow.close();
    await fast.close();
  }
});

test('SakuraFall service mode keeps upstream fallback and rewrites allowlisted covers', () => {
  const api = new BangumiApi();
  api.setBaseUrl('https://47.109.87.3:8443', { allowFallback: true, fastFail: true });
  api.setCoverProxyBase('https://47.109.87.3:8443/');

  const candidates = api._buildApiCandidates('https://47.109.87.3:8443/v0/subjects/42');
  assert.equal(candidates[0], 'https://47.109.87.3:8443/v0/subjects/42');
  assert.ok(candidates.includes('https://api.bgm.tv/v0/subjects/42'));
  assert.equal(
    api._normalizeImageUrl('http://bgmimg.anibt.net/pic/cover/test.jpg'),
    'https://47.109.87.3:8443/cover?url=https%3A%2F%2Fbgmimg.anibt.net%2Fpic%2Fcover%2Ftest.jpg'
  );
  assert.equal(api.fastFailConfiguredBase, true);
  assert.equal(api.fastFailTimeoutMs, 1800);
});
