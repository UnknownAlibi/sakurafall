// CmsApiService 解析方法单元测试
// 运行: node --test tests/cms-api.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cmsApiService = require('../src/main/services/CmsApiService');

test('parseEpisodes: 标准单线路格式', () => {
  const result = cmsApiService.parseEpisodes(
    '线路1',
    '第01集$https://example.com/ep01.m3u8#第02集$https://example.com/ep02.m3u8'
  );
  assert.strictEqual(Object.keys(result).length, 1);
  assert.strictEqual(result['线路1'].length, 2);
  assert.strictEqual(result['线路1'][0].title, '第01集');
  assert.strictEqual(result['线路1'][0].url, 'https://example.com/ep01.m3u8');
  assert.strictEqual(result['线路1'][1].title, '第02集');
});

test('parseEpisodes: 多线路格式（用 $$$ 分隔）', () => {
  const result = cmsApiService.parseEpisodes(
    '高清$$$备用',
    '第01集$https://e.com/u1#第02集$https://e.com/u2$$$第01集$https://e.com/u3'
  );
  assert.strictEqual(Object.keys(result).length, 2);
  assert.strictEqual(result['高清'].length, 2);
  assert.strictEqual(result['备用'].length, 1);
  assert.strictEqual(result['备用'][0].url, 'https://e.com/u3');
});

test('parseEpisodes: 空字符串返回空对象', () => {
  assert.deepStrictEqual(cmsApiService.parseEpisodes('', ''), {});
  assert.deepStrictEqual(cmsApiService.parseEpisodes('线路1', ''), {});
});

test('parseEpisodes: 跳过非 http 的 url', () => {
  const result = cmsApiService.parseEpisodes('线路1', '第01集$noturl#第02集$https://ok.com/x.m3u8');
  assert.strictEqual(result['线路1'].length, 1);
  assert.strictEqual(result['线路1'][0].url, 'https://ok.com/x.m3u8');
});

test('parseEpisodes: 缺少 vodPlayFrom 时用默认线路名', () => {
  const result = cmsApiService.parseEpisodes('', '第01集$https://ok.com/x.m3u8');
  assert.strictEqual(result['线路1'].length, 1);
});

test('_mapVodListItem: 正确映射字段并清理 HTML 标签', () => {
  const vod = {
    vod_id: 123,
    vod_name: '测试番剧',
    vod_pic: 'https://img.com/cover.jpg',
    vod_year: '2024',
    vod_area: '日本',
    vod_class: '热血,恋爱,校园',
    vod_content: '<p>这是<b>简介</b></p>',
    vod_remarks: '更新至第12集'
  };
  const item = cmsApiService._mapVodListItem(vod, 'ffzy-api');
  assert.strictEqual(item.id, '123');
  assert.strictEqual(item.name, '测试番剧');
  assert.strictEqual(item.cover, 'https://img.com/cover.jpg');
  assert.strictEqual(item.source, 'ffzy-api');
  assert.strictEqual(item.year, '2024');
  assert.strictEqual(item.area, '日本');
  assert.deepStrictEqual(item.type, ['热血', '恋爱', '校园']);
  assert.strictEqual(item.intro, '这是简介');
  assert.strictEqual(item.episode_count, 12);
  assert.strictEqual(item._detailLoaded, false);
});

test('_mapVodListItem: remarks 为"已完结"时 episode_count 为 0', () => {
  const item = cmsApiService._mapVodListItem({ vod_id: 1, vod_name: 'x', vod_remarks: '已完结' }, 's');
  assert.strictEqual(item.episode_count, 0);
});

test('_mapVodListItem: remarks 为"24集全"时 episode_count 为 24', () => {
  const item = cmsApiService._mapVodListItem({ vod_id: 1, vod_name: 'x', vod_remarks: '24集全' }, 's');
  assert.strictEqual(item.episode_count, 24);
});

test('_mapVodDetail: 正确解析播放地址和集数', () => {
  const vod = {
    vod_id: 456,
    vod_name: '详情番',
    vod_pic: 'cover.jpg',
    vod_year: '2023',
    vod_area: '中国',
    vod_class: '国产',
    vod_content: '<span>详情简介</span>',
    vod_remarks: '完结',
    vod_actor: '演员A',
    vod_director: '导演B',
    vod_play_from: '线路A',
    vod_play_url: '第01集$https://e.com/u1#第02集$https://e.com/u2'
  };
  const detail = cmsApiService._mapVodDetail(vod, 'bfzy');
  assert.strictEqual(detail.id, '456');
  assert.strictEqual(detail.name, '详情番');
  assert.strictEqual(detail.actor, '演员A');
  assert.strictEqual(detail.director, '导演B');
  assert.strictEqual(detail.intro, '详情简介');
  assert.strictEqual(detail.episode_count, 2);
  assert.strictEqual(detail._detailLoaded, true);
  assert.ok(detail.episodes['线路A']);
  assert.strictEqual(detail.episodes['线路A'].length, 2);
});

test('_mapVodDetail: 多线路按最长线路计算集数而不是相加', () => {
  const detail = cmsApiService._mapVodDetail({
    vod_id: 789,
    vod_name: '多线路番剧',
    vod_play_from: '高清$$$备用',
    vod_play_url: '第01集$https://e.com/a1#第02集$https://e.com/a2$$$第01集$https://e.com/b1#第02集$https://e.com/b2'
  }, 'multi');

  assert.strictEqual(detail.episode_count, 2);
});

test('_parseJson: 合法 JSON 正常解析', () => {
  const data = cmsApiService._parseJson('{"code":1,"list":[]}', 'test');
  assert.strictEqual(data.code, 1);
  assert.deepStrictEqual(data.list, []);
});

test('_parseJson: 非法 JSON 抛出带上下文的错误', () => {
  assert.throws(
    () => cmsApiService._parseJson('<html>error</html>', '[TestCtx]'),
    (err) => {
      assert.ok(err.message.includes('[TestCtx]'));
      assert.ok(err.message.includes('JSON 解析失败'));
      return true;
    }
  );
});

test('searchInSource: 搜索结果写入短期缓存并可强制刷新', async () => {
  const CmsApiService = cmsApiService.CmsApiService;
  const service = new CmsApiService();
  service.sources = [{ id: 'cached', name: '缓存源', api: 'https://source.test/api' }];
  const cache = new Map();
  service.setDatabase({
    getCache: key => cache.get(key) || null,
    setCache: (key, _sourceId, _kind, content) => cache.set(key, content)
  });
  let requestCount = 0;
  service.fetch = async () => {
    requestCount += 1;
    return JSON.stringify({
      page: 1,
      total: 1,
      list: [{ vod_id: 1, vod_name: '缓存番剧', vod_play_from: '主线', vod_play_url: '第01集$https://v.test/1.m3u8' }]
    });
  };

  const first = await service.searchInSource('cached', '缓存番剧');
  const second = await service.searchInSource('cached', '缓存番剧');
  await service.searchInSource('cached', '缓存番剧', 1, { refresh: true });

  assert.equal(first.data[0].episode_count, 1);
  assert.equal(second._fromCache, true);
  assert.equal(requestCount, 2);
});

test('parseM3u8Quality: master playlist 选择最高分辨率', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
    '480/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    '1080/index.m3u8'
  ].join('\n');

  const result = cmsApiService.parseM3u8Quality(playlist, 'https://cdn.example.com/master.m3u8');
  assert.strictEqual(result.height, 1080);
  assert.strictEqual(result.width, 1920);
  assert.strictEqual(result.bitrate, 5000000);
  assert.strictEqual(result.variants, 3);
  assert.strictEqual(result.url, 'https://cdn.example.com/1080/index.m3u8');
});

test('findMatchingEpisode: 支持按标题数字归一化匹配', () => {
  const episodes = {
    line1: [
      { id: '1', title: '第01集', url: 'https://e.com/1.m3u8' },
      { id: '2', title: '第02集', url: 'https://e.com/2.m3u8' }
    ]
  };

  const result = cmsApiService.findMatchingEpisode(episodes, '02话', -1);
  assert.ok(result);
  assert.strictEqual(result.episode.id, '2');
  assert.strictEqual(result.lineId, 'line1');
  assert.strictEqual(result.matchType, 'title');
});

test('collectEpisodeCandidates: later episodes never fall back to episode one', () => {
  const results = [{
    sourceId: 's1',
    sourceName: '源1',
    data: [{
      name: '测试番',
      episodes: {
        line1: [{ id: '1', title: '第01集', url: 'https://e.com/1.m3u8' }]
      }
    }]
  }];

  const candidates = cmsApiService.collectEpisodeCandidates(results, {
    episodeTitle: '第99集',
    episodeIndex: 98,
    allowFirstFallback: true
  });

  assert.strictEqual(candidates.length, 0);
});

test('collectEpisodeCandidates: keeps only the reliable best title from each source', () => {
  const results = [{
    sourceId: 's1',
    sourceName: 'source one',
    data: [{
      name: 'One Piece Film Red',
      episodes: {
        line1: [{ id: 'movie', title: 'HD', url: 'https://e.com/movie.m3u8' }]
      }
    }, {
      name: 'One Piece',
      episodes: {
        line1: [{ id: 'series', title: 'Episode 1', url: 'https://e.com/series.m3u8' }]
      }
    }]
  }, {
    sourceId: 's2',
    sourceName: 'source two',
    data: [{
      name: 'Entirely Different Work',
      episodes: {
        line1: [{ id: 'wrong', title: 'Episode 1', url: 'https://e.com/wrong.m3u8' }]
      }
    }]
  }];

  const candidates = cmsApiService.collectEpisodeCandidates(results, {
    keyword: 'One Piece',
    episodeTitle: 'Episode 1',
    episodeIndex: 0,
    allowFirstFallback: true
  });

  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].sourceId, 's1');
  assert.strictEqual(candidates[0].anime.name, 'One Piece');
  assert.strictEqual(candidates[0].episode.id, 'series');
  assert.strictEqual(candidates[0].titleMatchExact, true);
});

test('selectBestEpisodeSource: keeps share pages for the playback resolver', async () => {
  const CmsApiService = cmsApiService.CmsApiService;
  const service = new CmsApiService();
  service.sources = [{ id: 'share-source', name: 'share source', api: 'https://source.test/api' }];
  service.searchAllSources = async () => ({
    results: [{
      sourceId: 'share-source',
      sourceName: 'share source',
      data: [{
        id: 'work-1',
        name: 'Exact Work',
        episodes: {
          line1: [{
            id: 'ep-1',
            title: 'Episode 1',
            url: 'https://source.test/share/episode-one'
          }]
        }
      }]
    }],
    skipped: []
  });
  service.probeStreamQuality = async () => {
    throw new Error('share page must not be probed as m3u8');
  };

  const result = await service.selectBestEpisodeSource('Exact Work', {
    episodeIndex: 0,
    episodeTitle: 'Episode 1'
  });

  assert.equal(result.best?.sourceId, 'share-source');
  assert.equal(result.best?.quality?.source, 'resolver-required');
  assert.equal(result.candidates.length, 1);
});

test('_mapWithConcurrency: 限制并发任务数量', async () => {
  let active = 0;
  let maxActive = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  await cmsApiService._mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(5);
    active -= 1;
  });

  assert.ok(maxActive <= 2);
});

test('_mapWithConcurrency: signal abort 后停止后续任务', async () => {
  const controller = new AbortController();
  let started = 0;

  await assert.rejects(
    cmsApiService._mapWithConcurrency([1, 2, 3], 1, async () => {
      started += 1;
      controller.abort();
    }, controller.signal),
    err => err.name === 'AbortError'
  );

  assert.strictEqual(started, 1);
});

test('probeStreamQuality: 已取消的 signal 不发起探测', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    cmsApiService.probeStreamQuality('https://cdn.example.com/master.m3u8', '', { signal: controller.signal }),
    err => err.name === 'AbortError'
  );
});

test('probeStreamQuality: HTML 错误页不会被误判为可播放清单', async () => {
  const originalFetch = cmsApiService.fetch;
  cmsApiService.fetch = async () => '<html><h1>Access denied</h1></html>';

  try {
    const result = await cmsApiService.probeStreamQuality('https://cdn.example.com/broken.m3u8');
    assert.equal(result.source, 'probe-failed');
    assert.match(result.error, /INVALID_M3U8_MANIFEST/);
  } finally {
    cmsApiService.fetch = originalFetch;
  }
});

test('source health: playback success improves score and stores quality', () => {
  const sourceId = 'unit-health-success';
  cmsApiService.sourceHealth.delete(sourceId);

  const before = cmsApiService._getSourceHealth(sourceId);
  const result = cmsApiService.recordPlaybackResult(sourceId, {
    success: true,
    quality: { height: 1080, bitrate: 5000000 }
  });
  const after = cmsApiService._getSourceHealth(sourceId);

  assert.strictEqual(result.success, true);
  assert.strictEqual(after.playbackSuccessCount, 1);
  assert.strictEqual(after.averageQualityHeight, 1080);
  assert.ok(after.score > before.score);

  cmsApiService.sourceHealth.delete(sourceId);
});

test('source health: repeated playback failures lower score and cool down source', () => {
  const sourceId = 'unit-health-failure';
  cmsApiService.sourceHealth.delete(sourceId);

  cmsApiService.recordPlaybackResult(sourceId, {
    success: true,
    quality: { height: 720 }
  });
  const healthy = cmsApiService._getSourceHealth(sourceId);

  cmsApiService.recordPlaybackResult(sourceId, { success: false, reason: 'native-video-error' });
  cmsApiService.recordPlaybackResult(sourceId, { success: false, reason: 'hls-network-error' });
  const unhealthy = cmsApiService._getSourceHealth(sourceId);

  assert.strictEqual(unhealthy.playbackFailureCount, 2);
  assert.strictEqual(unhealthy.coolingDown, true);
  assert.ok(unhealthy.score < healthy.score);

  cmsApiService.sourceHealth.delete(sourceId);
});

test('source health: reloadSources keeps existing health state', () => {
  const sourceId = 'ffzy-api';
  const original = cmsApiService.sourceHealth.get(sourceId);
  cmsApiService.sourceHealth.delete(sourceId);

  try {
    cmsApiService.recordPlaybackResult(sourceId, { success: false, reason: 'native-video-error' });
    cmsApiService.recordPlaybackResult(sourceId, { success: false, reason: 'hls-network-error' });
    const before = cmsApiService._getSourceHealth(sourceId);

    cmsApiService.reloadSources();
    const after = cmsApiService._getSourceHealth(sourceId);

    assert.strictEqual(after.playbackFailureCount, before.playbackFailureCount);
    assert.strictEqual(after.coolingDown, true);
  } finally {
    if (original) {
      cmsApiService.sourceHealth.set(sourceId, original);
    } else {
      cmsApiService.sourceHealth.delete(sourceId);
    }
  }
});

test('source health: advertising feedback lowers priority without cooling down the source', () => {
  const sourceId = 'unit-health-advertising';
  cmsApiService.sourceHealth.delete(sourceId);

  try {
    const baseline = cmsApiService._getSourceHealth(sourceId);
    const result = cmsApiService.recordPlaybackResult(sourceId, { issue: 'advertising' });
    const reported = cmsApiService._getSourceHealth(sourceId);

    assert.equal(result.success, true);
    assert.equal(reported.advertisingReportCount, 1);
    assert.equal(reported.contentIssueReason, 'advertising');
    assert.equal(reported.coolingDown, false);
    assert.equal(reported.playbackFailureCount, 0);
    // 广告反馈：次数降分 8 + 软惩罚窗口（10 分钟）内额外降 10
    assert.ok(reported.adPenaltyUntil > Date.now(), 'ad penalty window should be active');
    assert.equal(reported.score, baseline.score - 8 - 10);
  } finally {
    cmsApiService.sourceHealth.delete(sourceId);
  }
});

test('source health: real playback sessions track startup, stalls and dropped frames', () => {
  const sourceId = 'unit-health-session';
  cmsApiService.sourceHealth.delete(sourceId);
  try {
    cmsApiService.recordPlaybackResult(sourceId, {
      sample: 'session',
      success: true,
      metrics: {
        startupMs: 900,
        playedMs: 30000,
        stallCount: 1,
        stallMs: 600,
        totalFrames: 720,
        droppedFrames: 2,
        height: 1080,
        bitrate: 4500000,
        sustained: true
      }
    });
    const health = cmsApiService._getSourceHealth(sourceId);
    assert.equal(health.playbackSessionCount, 1);
    assert.equal(health.sustainedPlaybackCount, 1);
    assert.equal(health.averageStartupMs, 900);
    assert.ok(health.averageStallRatio > 0 && health.averageStallRatio < 0.03);
    assert.ok(health.averageDroppedFrameRatio > 0 && health.averageDroppedFrameRatio < 0.01);
  } finally {
    cmsApiService.sourceHealth.delete(sourceId);
  }
});

test('source health: persists to disk and loads into a new service', () => {
  const CmsApiService = cmsApiService.CmsApiService;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-source-health-'));
  const storePath = path.join(tempDir, 'source-health.json');

  try {
    const service = new CmsApiService();
    service.setHealthStorePath(storePath);
    service.recordPlaybackResult('persist-source', { success: false, reason: 'hls-network-error' });
    service.recordPlaybackResult('persist-source', { success: false, reason: 'hls-network-error' });
    assert.strictEqual(service.flushSourceHealth(), true);

    const reloaded = new CmsApiService();
    reloaded.setHealthStorePath(storePath);
    const health = reloaded._getSourceHealth('persist-source');

    assert.strictEqual(health.playbackFailureCount, 2);
    assert.strictEqual(health.coolingDown, true);
    // 故障类型拆分后 reason 存储本地化的规则标签（未知类型 → '播放失败'）
    assert.strictEqual(health.reason, '播放失败');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('serializeEpisodeCandidate: returns playable candidate payload for UI', () => {
  const payload = cmsApiService.serializeEpisodeCandidate({
    sourceId: 's1',
    sourceName: 'Source 1',
    anime: { id: 'a1', name: 'Anime', source: 's1' },
    episode: { id: 'e1', title: 'Episode 1' },
    lineId: 'line1',
    matchType: 'title',
    url: 'https://cdn.example.com/e1.m3u8',
    healthScore: 88,
    quality: { height: 1080 },
    score: 123
  });

  assert.strictEqual(payload.sourceId, 's1');
  assert.strictEqual(payload.url, 'https://cdn.example.com/e1.m3u8');
  assert.strictEqual(payload.anime.name, 'Anime');
  assert.strictEqual(payload.episode.title, 'Episode 1');
  assert.strictEqual(payload.healthScore, 88);
  assert.strictEqual(payload.quality.height, 1080);
});

test('source health: search success does not erase an active playback cooldown', () => {
  const sourceId = 'unit-health-preserve-playback';
  cmsApiService.sourceHealth.delete(sourceId);

  try {
    cmsApiService.recordPlaybackResult(sourceId, { success: false, reason: 'hls-network-error' });
    cmsApiService.recordPlaybackResult(sourceId, { success: false, reason: 'hls-network-error' });
    const failed = cmsApiService._getSourceHealth(sourceId);

    cmsApiService._markSourceSuccess(sourceId, { latencyMs: 120 });
    cmsApiService._markSourceSuccess(sourceId, { latencyMs: 80 });
    const searched = cmsApiService._getSourceHealth(sourceId);

    assert.equal(searched.playbackFailureCount, 2);
    assert.equal(searched.cooldownUntil, failed.cooldownUntil);

    cmsApiService.recordPlaybackResult(sourceId, {
      success: true,
      quality: { height: 1080 }
    });
    const recovered = cmsApiService._getSourceHealth(sourceId);
    assert.equal(recovered.playbackFailureCount, 0);
    assert.equal(recovered.cooldownUntil, 0);
  } finally {
    cmsApiService.sourceHealth.delete(sourceId);
  }
});
