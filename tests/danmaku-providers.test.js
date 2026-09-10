const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {
  DanmakuProviderRegistry,
  BilibiliDanmakuProvider,
  AcfunDanmakuProvider,
  TencentDanmakuProvider,
  IqiyiDanmakuProvider,
  YoukuDanmakuProvider,
  CustomDanmakuProvider,
  parseBilibiliXml,
  extractEpisodeNumber
} = require('../src/main/services/danmaku/DanmakuProviderRegistry');

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

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

test('registry enables the three new providers by default and lists them', () => {
  const registry = new DanmakuProviderRegistry();
  const rows = registry.listProviders();
  for (const id of ['tencent', 'iqiyi', 'youku']) {
    const row = rows.find(item => item.id === id);
    assert.ok(row, `${id} 应出现在 provider 列表`);
    assert.equal(row.enabled, true);
    assert.equal(row.zeroConfig, true);
  }
  const names = { tencent: '腾讯视频', iqiyi: '爱奇艺', youku: '优酷' };
  for (const [id, name] of Object.entries(names)) {
    assert.equal(rows.find(item => item.id === id).name, name);
  }
});

test('Tencent provider searches, picks the episode and maps segment comments', async () => {
  const searchResponse = {
    ret: 0,
    data: {
      areaBoxList: [{
        boxId: 'MainNeed',
        itemList: [{
          doc: { id: 'mzc00200test' },
          videoInfo: { title: '<em>测试</em>番剧', year: 2026, typeName: '动漫', subTitle: '独家' }
        }]
      }]
    }
  };
  const episodesResponse = {
    ret: 0,
    data: {
      module_list_datas: [{
        module_datas: [{
          module_params: { tabs: JSON.stringify([]) },
          item_data_lists: {
            item_datas: [
              { item_params: { vid: 'v001', title: '第1集' } },
              { item_params: { vid: 'v002', title: '第2集' } },
              { item_params: { vid: 'v003', title: '预告', is_trailer: '1' } }
            ]
          }
        }]
      }]
    }
  };
  const segmentComment = { time_offset: 1500, content: '腾讯弹幕', content_style: '{"color":"#ff0000","position":2}' };
  const http = { async fetch(url, options = {}) {
    if (url.includes('MbSearch')) {
      assert.equal(options.method, 'POST');
      return JSON.stringify(searchResponse);
    }
    if (url.includes('GetPageData')) return JSON.stringify(episodesResponse);
    if (url.includes('/barrage/base/')) {
      return JSON.stringify({ segment_index: { 0: { segment_start: 0, segment_name: 't/v1/0/30000' } } });
    }
    if (url.includes('/barrage/segment/')) return JSON.stringify({ barrage_list: [segmentComment] });
    throw new Error(`unexpected url ${url}`);
  } };
  const provider = new TencentDanmakuProvider(http);
  const candidates = await provider.search({ animeName: '测试番剧', aliases: [] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'mzc00200test');
  assert.equal(candidates[0].reliable, true);

  const result = await provider.resolve({ animeName: '测试番剧', aliases: [], episodeNumber: 2 });
  assert.equal(result.match.vid, 'v002');
  assert.equal(result.match.episodeNumber, 2);
  assert.deepEqual(result.comments, [{ time: 1.5, color: 0xff0000, text: '腾讯弹幕', type: 'top', source: 'tencent' }]);
});

test('Tencent provider honours the cid override', async () => {
  const http = { async fetch(url) {
    if (url.includes('GetPageData')) {
      return JSON.stringify({ ret: 0, data: { module_list_datas: [{ module_datas: [{ module_params: {}, item_data_lists: { item_datas: [{ item_params: { vid: 'v001', title: '正片' } }] } }] }] } });
    }
    if (url.includes('/barrage/base/')) return JSON.stringify({ segment_index: { 0: { segment_name: 't/v1/0/30000' } } });
    if (url.includes('/barrage/segment/')) return JSON.stringify({ barrage_list: [{ time_offset: 500, content: '手动匹配' }] });
    throw new Error(`unexpected url ${url}`);
  } };
  const result = await new TencentDanmakuProvider(http).resolve({
    animeName: '测试番剧',
    episodeNumber: 1,
    overrides: { tencent: { cid: 'mzc00200test', title: '手动标题' } }
  });
  assert.equal(result.match.manual, true);
  assert.equal(result.match.title, '手动标题');
  assert.equal(result.comments[0].text, '手动匹配');
});

test('Iqiyi provider converts link_id to entity_id and parses brotli XML bullets', async () => {
  const tvid = '123456789';
  const http = { async fetch(url, options = {}) {
    if (url.includes('homePageV3')) {
      return JSON.stringify({
        code: 'A00000',
        data: { templates: [{ template: 112, intentAlbumInfos: [{ title: '测试番剧', channel: '动漫;热血', pageUrl: 'https://www.iqiyi.com/v_link123.html', btnText: '立即播放' }] }] }
      });
    }
    if (url.includes('/prelw/tvg/v2/lw/base_info')) {
      // 断言 entity_id 已按 XOR 算法生成且带签名
      assert.match(url, /entity_id=\d+/);
      assert.match(url, /sign=[0-9A-F]{32}/);
      return JSON.stringify({
        status_code: 0,
        data: { template: { tabs: [{ blocks: [{ bk_type: 'video_list', tag: 'episodes', data: { data: [{ videos: [{ data: [
          { content_type: 1, play_url: `https://www.iqiyi.com/v_test.html?tvid=${tvid}`, short_display_name: '第1集', album_order: 1 }
        ] }] }] } }] }] } }
      });
    }
    if (url.includes('pcw-api.iqiyi.com/video/video/baseinfo/')) {
      return JSON.stringify({ data: { durationSec: 90, displayBarrage: true } });
    }
    if (url.includes('cmts.iqiyi.com/bullet/')) {
      // 分片 URL 使用 md5 签名后缀（duration 90s → 2 页）
      const pageNo = Number(url.match(/_60_(\d+)_/)?.[1]);
      const sign = md5(`${tvid}_60_${pageNo}cbzuw1259a`).slice(-8);
      assert.ok(url.includes(`/${tvid}_60_${pageNo}_${sign}.br`));
      assert.equal(options.responseType, 'buffer');
      if (pageNo > 1) {
        const error = new Error('HTTP 404');
        error.statusCode = 404;
        throw error;
      }
      return Buffer.from('<bullet><content>爱奇艺弹幕</content><showTime>3.5</showTime><color>ff0000</color><likeCount>2</likeCount></bullet>');
    }
    throw new Error(`unexpected url ${url}`);
  } };
  const provider = new IqiyiDanmakuProvider(http);
  const candidates = await provider.search({ animeName: '测试番剧', aliases: [] });
  assert.equal(candidates[0].id, 'link123');

  const result = await provider.resolve({ animeName: '测试番剧', aliases: [], episodeNumber: 1 });
  assert.equal(result.match.tvid, tvid);
  assert.deepEqual(result.comments, [{ time: 3.5, color: 0xff0000, text: '爱奇艺弹幕', type: 'scroll', source: 'iqiyi' }]);
});

test('Iqiyi provider skips 404 bullet segments', async () => {
  const http = { async fetch(url) {
    if (url.includes('pcw-api.iqiyi.com')) return JSON.stringify({ data: { durationSec: 60 } });
    if (url.includes('cmts.iqiyi.com/bullet/')) {
      const error = new Error('HTTP 404');
      error.statusCode = 404;
      throw error;
    }
    throw new Error(`unexpected url ${url}`);
  } };
  const result = await new IqiyiDanmakuProvider(http)._commentsForTvid('123456789', { tvid: '123456789' });
  assert.deepEqual(result.comments, []);
});

test('Iqiyi provider decompresses raw brotli protobuf bullet segments', async () => {
  // 构造 protobuf 弹幕分片：outer(field6=block{ field1=blockShowTime, field2=item{ field2=text, field6=showTime, field8=color } })
  const lenDelim = (fieldNumber, payload) => Buffer.concat([
    Buffer.from([(fieldNumber << 3) | 2, payload.length]),
    payload
  ]);
  const item = Buffer.concat([
    lenDelim(2, Buffer.from('brotli弹幕', 'utf8')),
    lenDelim(6, Buffer.from('3.5')),
    lenDelim(8, Buffer.from('ff0000'))
  ]);
  const block = Buffer.concat([lenDelim(1, Buffer.from('0')), lenDelim(2, item)]);
  const outer = lenDelim(6, block);
  const compressed = zlib.brotliCompressSync(outer);

  const http = { async fetch(url) {
    if (url.includes('pcw-api.iqiyi.com')) return JSON.stringify({ data: { durationSec: 60 } });
    if (url.includes('cmts.iqiyi.com/bullet/')) return compressed;
    throw new Error(`unexpected url ${url}`);
  } };
  const result = await new IqiyiDanmakuProvider(http)._commentsForTvid('123456789', { tvid: '123456789' });
  assert.deepEqual(result.comments, [{ time: 3.5, color: 0xff0000, text: 'brotli弹幕', type: 'scroll', source: 'iqiyi' }]);
});

test('Youku provider resolves show episodes via mtop signed requests', async () => {
  const http = { async fetch(url, options = {}) {
    if (url.includes('search.youku.com/api/search')) {
      return JSON.stringify({ pageComponentList: [{ commonData: { isYouku: 1, showId: 'show1', titleDTO: { displayName: '测试番剧' }, feature: '2026 动漫', episodeTotal: 12, cats: '动漫' } }] });
    }
    if (url.includes('/v2/shows/videos.json')) {
      return JSON.stringify({ total: 2, videos: [
        { id: 'vid001', displayName: '第1集' },
        { id: 'vid002', displayName: '第2集' }
      ] });
    }
    if (url.includes('/v2/videos/show.json')) {
      assert.ok(url.includes('video_id=vid002'));
      return JSON.stringify({ duration: 65 });
    }
    if (url.includes('log.mmstat.com/eg.js')) {
      assert.equal(options.returnHeaders, true);
      return { body: '', statusCode: 200, headers: { etag: '"cna-token-1"' } };
    }
    if (url.includes('mtop.com.youku.aplatform.weakget')) {
      return { body: '{}', statusCode: 200, headers: { 'set-cookie': ['_m_h5_tk=abcd1234abcd1234abcd1234abcd1234_1737024000000;Path=/;Domain=youku.com', '_m_h5_tk_enc=encvalue;Path=/;Domain=youku.com'] } };
    }
    if (url.includes('mopen.youku.danmu.list')) {
      assert.equal(options.method, 'POST');
      assert.match(options.body, /^data=/);
      assert.match(options.headers.Cookie, /_m_h5_tk=abcd1234abcd1234abcd1234abcd1234/);
      // mtop sign = md5(token前32位 & t & appKey & data)
      const t = new URL(url).searchParams.get('t');
      const data = decodeURIComponent(options.body.replace(/^data=/, ''));
      assert.equal(new URL(url).searchParams.get('sign'), md5(['abcd1234abcd1234abcd1234abcd1234', t, '24679788', data].join('&')).toLowerCase());
      // duration 65s → 2 个 mat 分片，仅第 1 个分片返回弹幕
      const mat = JSON.parse(data).mat;
      const items = mat === 0 ? [{ playat: 62000, content: '优酷弹幕', propertis: '{"color":16711680,"pos":2}' }] : [];
      return JSON.stringify({ data: { result: JSON.stringify({ code: '0', data: { result: items } }) } });
    }
    throw new Error(`unexpected url ${url}`);
  } };
  const provider = new YoukuDanmakuProvider(http);
  const candidates = await provider.search({ animeName: '测试番剧', aliases: [] });
  assert.equal(candidates[0].id, 'show1');

  const result = await provider.resolve({ animeName: '测试番剧', aliases: [], episodeNumber: 2 });
  assert.equal(result.match.vid, 'vid002');
  assert.deepEqual(result.comments, [{ time: 62, color: 16711680, text: '优酷弹幕', type: 'bottom', source: 'youku' }]);
});
