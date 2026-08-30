const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DanmakuProviderRegistry,
  BilibiliDanmakuProvider,
  AcfunDanmakuProvider,
  CustomDanmakuProvider,
  parseBilibiliXml,
  extractEpisodeNumber
} = require('../src/main/services/danmaku/DanmakuProviderRegistry');

test('Bilibili XML parser uses the standard color field and decodes entities', () => {
  const comments = parseBilibiliXml('<i><d p="12.5,5,25,16711680,0,0,0,0">A&amp;B</d></i>');
  assert.deepEqual(comments, [{ time: 12.5, color: 16711680, text: 'A&B', type: 'top', source: 'bilibili' }]);
});

test('episode parser handles Chinese, EP and season episode labels', () => {
  assert.equal(extractEpisodeNumber('第 12 集'), 12);
  assert.equal(extractEpisodeNumber('EP03'), 3);
  assert.equal(extractEpisodeNumber('S02E09_x264'), 9);
});

test('Bilibili provider resolves season, episode cid and comments', async () => {
  const http = { async fetch(url) {
    if (url.includes('/search/all/v2')) return JSON.stringify({ code: 0, data: { result: [{ result_type: 'media_bangumi', data: [{ title: '<em>测试番剧</em>', season_id: 88 }] }] } });
    if (url.includes('/pgc/view/web/season')) return JSON.stringify({ code: 0, result: { season_id: 88, episodes: [{ id: 881, cid: 9901, title: '1' }] } });
    if (url.includes('comment.bilibili.com')) return '<i><d p="1,1,25,16777215,0,0,0,0">开场</d></i>';
    throw new Error(`unexpected url ${url}`);
  } };
  const result = await new BilibiliDanmakuProvider(http).resolve({ animeName: '测试番剧', aliases: [], episodeNumber: 1 });
  assert.equal(result.match.cid, 9901);
  assert.equal(result.comments[0].text, '开场');
});

test('AcFun provider resolves album video id and paged comments', async () => {
  const http = { async fetch(url) {
    if (url.includes('/search?')) return 'href=\\"/a/aa123\\"><img alt=\\"【2026】测试番剧\\" />';
    if (url.includes('/arubamu/content/list')) return JSON.stringify({ result: 0, contents: [{ title: '测试番剧S01E02', videoList: [{ id: '456', priority: 0 }] }] });
    if (url.includes('/new-danmaku/list')) return JSON.stringify({ result: 0, pcursor: 'no_more', danmakus: [{ position: 2500, mode: 1, color: 16777215, body: '第二集' }] });
    throw new Error(`unexpected url ${url}`);
  } };
  const result = await new AcfunDanmakuProvider(http).resolve({ animeName: '测试番剧', aliases: [], episodeNumber: 2 });
  assert.equal(result.match.videoId, '456');
  assert.equal(result.comments[0].time, 2.5);
});

test('custom provider supports placeholder GET endpoints and JSON comments', async () => {
  let requested = '';
  const http = { async fetch(url) {
    requested = url;
    return JSON.stringify({ comments: [{ time: 3, color: 1, text: '自建池', type: 'bottom' }] });
  } };
  const provider = new CustomDanmakuProvider(http, () => ({ customEndpoint: 'https://example.test/danmaku?name={name}&episode={episode}' }));
  const result = await provider.resolve({ animeName: '测试 番剧', episodeNumber: 4 });
  assert.match(requested, /name=%E6%B5%8B%E8%AF%95%20%E7%95%AA%E5%89%A7/);
  assert.match(requested, /episode=4/);
  assert.equal(result.comments[0].source, 'custom');
});

test('registry isolates failures and deduplicates near-identical comments', async () => {
  const registry = new DanmakuProviderRegistry();
  registry.providers.clear();
  registry.register({ id: 'bilibili', name: 'A', async resolve() { return { comments: [{ time: 10, text: '同一句！', color: 1, type: 'scroll' }] }; } });
  registry.register({ id: 'acfun', name: 'B', async resolve() { return { comments: [{ time: 10.8, text: '同一句', color: 2, type: 'scroll' }] }; } });
  registry.register({ id: 'custom', name: 'C', async resolve() { throw new Error('offline'); } });
  registry.configure({ providers: { bilibili: true, acfun: true, custom: true, dandanplay: false } });
  const result = await registry.resolve({ animeName: '测试番剧', episodeNumber: 1, providerIds: ['bilibili', 'acfun', 'custom'], forceRefresh: true });
  assert.equal(result.comments.length, 1);
  assert.equal(result.sources.find(item => item.id === 'custom').status, 'error');
  assert.equal(result.success, true);
});
