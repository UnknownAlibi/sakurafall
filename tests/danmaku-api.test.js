const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DanmakuApi } = require('../src/main/services/DanmakuApi');

test('DanmakuApi uses the current v2 endpoint and SHA-256 signature headers', async () => {
  const api = new DanmakuApi();
  api.setCredentials('test-app', 'test-secret');
  let observed = null;
  api.http.fetch = async (url, options) => {
    observed = { url, options };
    return JSON.stringify({
      animes: [{
        animeId: 42,
        animeTitle: '测试番剧',
        episodes: [{ episodeId: 420001, episodeTitle: '01' }]
      }]
    });
  };

  const result = await api.searchAnime('测试番剧');
  assert.match(observed.url, /\/api\/v2\/search\/anime\?keyword=/);
  assert.match(observed.url, /v2=true/);
  assert.equal(observed.options.headers['X-AppId'], 'test-app');
  const timestamp = observed.options.headers['X-Timestamp'];
  const expected = crypto
    .createHash('sha256')
    .update(`test-app${timestamp}/api/v2/search/animetest-secret`, 'utf8')
    .digest('base64');
  assert.equal(observed.options.headers['X-Signature'], expected);
  assert.deepEqual(result[0].episodes[0], {
    episodeId: 420001,
    episodeTitle: '01',
    episodeNumber: 0
  });
});

test('DanmakuApi requests comments by episode id and parses lowercase v2 fields', async () => {
  const api = new DanmakuApi();
  api.setCredentials('test-app', 'test-secret');
  let requestedUrl = '';
  api.http.fetch = async url => {
    requestedUrl = url;
    return JSON.stringify({ comments: [{ p: '12.5,5,16711680,uid', m: '测试弹幕' }] });
  };

  const comments = await api.getComments(420001);
  assert.match(requestedUrl, /\/api\/v2\/comment\/420001\?withRelated=true$/);
  assert.deepEqual(comments, [{ time: 12.5, color: 16711680, text: '测试弹幕', type: 'top' }]);
});

test('DanmakuApi reports missing credentials instead of silently returning no data', async () => {
  const api = new DanmakuApi();
  await assert.rejects(
    () => api.searchAnime('测试番剧'),
    error => error.code === 'DANMAKU_NOT_CONFIGURED'
  );
});
