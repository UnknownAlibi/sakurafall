const assert = require('node:assert/strict');
const test = require('node:test');
const { SourceRuleEngine } = require('../src/main/services/SourceRuleEngine');

// 「一集一页」的源（Anime1 这类）没有分集列表：详情页本身就是播放页。
// 引擎在规则没有 detail 时，应把该 URL 当成唯一一集返回，而不是直接报错。

const RULE = {
  id: 'xpath-single-page',
  name: 'Single Page',
  type: 'xpath',
  baseUrl: 'https://example.com',
  headers: { 'User-Agent': 'test' },
  search: {
    url: 'https://example.com/search?q=@keyword',
    method: 'GET',
    list: '//article',
    name: './/h2',
    urlPath: './/h2/a/@href',
    cover: ''
  },
  playback: { mode: 'webview-sniff' }
};

const PAGE_HTML = '<html><head><title>示例番剧 第1集 - 站点名</title></head><body><video data-vid="x"></video></body></html>';

function createEngine(html = PAGE_HTML) {
  const calls = [];
  const httpClient = {
    fetch: async (url) => {
      calls.push(url);
      return html;
    }
  };
  return { engine: new SourceRuleEngine({ httpClient }), calls };
}

test('没有 detail 规则时把详情页当作唯一一集', async () => {
  const { engine, calls } = createEngine();
  const result = await engine.parseDetail(RULE, 'https://example.com/post/1');

  assert.equal(result.success, true);
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0].url, 'https://example.com/post/1');
  assert.equal(result.episodes[0].playbackMode, 'webview-sniff');
  assert.match(result.episodes[0].title, /示例番剧/);
  assert.deepEqual(calls, ['https://example.com/post/1']);
});

test('详情页抓取失败时返回失败而不是抛错', async () => {
  const engine = new SourceRuleEngine({
    httpClient: { fetch: async () => { throw new Error('HTTP 403'); } }
  });
  const result = await engine.parseDetail(RULE, 'https://example.com/post/1');

  assert.equal(result.success, false);
  assert.match(result.error, /403/);
});
