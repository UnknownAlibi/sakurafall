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
