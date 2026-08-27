const test = require('node:test');
const assert = require('node:assert/strict');

const { SourceProviderRegistry } = require('../src/main/services/sources/SourceProviderRegistry');

function createRegistry() {
  const cmsApiService = {
    currentSourceId: 'cms-one',
    getSourceList: () => [{ id: 'cms-one', name: 'CMS One', categories: [], health: { score: 90 } }],
    getSourceConfig: () => ({ id: 'cms-one', resolverId: 'author.share', playbackHeaders: {} }),
    searchInSource: async (sourceId, keyword) => ({
      data: [{ id: 'cms-anime', name: keyword, source: sourceId, episodes: { line_1: [{ id: 'ep-1', title: '01', url: 'https://video.test/1.m3u8' }] } }],
      page: 1,
      total: 1,
      totalPages: 1
    }),
    getDetail: async (id, options) => ({ id, name: 'CMS Detail', source: options.sourceId, episodes: {} }),
    setSource(sourceId) { this.currentSourceId = sourceId; },
    getCategories: async () => [],
    getList: async () => ({ data: [] }),
    test: async () => ({ success: true }),
    recordPlaybackResult: () => ({ success: true })
  };

  const sourcePluginManager = {
    getAllForManagement: () => [{ id: 'rule-one', name: 'Rule One', enabled: true, hasDetail: true, type: 'xpath' }],
    search: async (_id, keyword) => ({
      success: true,
      data: [{ id: 'rule-result', name: keyword, url: 'https://rule.test/detail/1' }]
    }),
    parseDetail: async () => ({
      success: true,
      name: 'Rule Detail',
      episodes: [
        { id: 'rule-ep-1', title: '01', url: 'https://video.test/rule-1.m3u8', lineName: '主线' },
        { id: 'rule-ep-2', title: '02', url: 'https://video.test/rule-2.m3u8', lineName: '主线' }
      ]
    }),
    getPlaybackHeaders: () => ({ Referer: 'https://rule.test/' }),
    test: async () => ({ success: true })
  };

  const sharePageResolver = {
    canResolve: () => true,
    resolve: async () => ({ url: 'https://video.test/share.m3u8' }),
    getPlaybackHeaders: () => ({ Referer: 'https://source.test/' }),
    getRequestHeaders: () => ({})
  };

  return new SourceProviderRegistry({ cmsApiService, sourcePluginManager, sharePageResolver });
}

test('registry exposes namespaced providers behind one contract', () => {
  const registry = createRegistry();
  const ids = registry.listProviders().map(item => item.providerId);
  assert.deepEqual(ids, ['cms:cms-one', 'xpath:rule-one']);
});

test('XPath playback results participate in persistent source health', () => {
  const registry = createRegistry();
  let recorded = null;
  registry.cmsApiService.recordPlaybackResult = (sourceId, result) => {
    recorded = { sourceId, result };
    return { success: true };
  };

  registry.reportPlayback('xpath:rule-one', { success: true, height: 1080 });
  assert.deepEqual(recorded, {
    sourceId: 'xpath:rule-one',
    result: { success: true, height: 1080 }
  });
});

test('searchAll normalizes CMS and XPath episodes', async () => {
  const registry = createRegistry();
  const statuses = await registry.searchAll('测试番剧', { includeFallback: false, hydrateLimit: 1 });
  assert.equal(statuses.length, 2);
  assert.equal(statuses[0].status, 'success');
  assert.ok(statuses.every(item => item.results[0].providerId));

  const xpath = statuses.find(item => item.providerId === 'xpath:rule-one');
  assert.equal(xpath.results[0].source, 'xpath:rule-one');
  assert.equal(xpath.results[0].episodes['主线'].length, 2);
});

test('searchAll providerLimit keeps background enrichment on the healthiest providers', async () => {
  const registry = createRegistry();
  const statuses = await registry.searchAll('测试番剧', { providerLimit: 1, hydrateLimit: 1 });
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].providerId, 'cms:cms-one');
});

test('searchAll can return the first successful provider without waiting for a slow source', async () => {
  const registry = createRegistry();
  registry.sourcePluginManager.getAllForManagement = () => [];
  registry.cmsApiService.getSourceList = () => [
    { id: 'fast', name: 'Fast', categories: [], health: { score: 100 } },
    { id: 'slow', name: 'Slow', categories: [], health: { score: 80 } }
  ];
  registry.cmsApiService.searchInSource = async (sourceId, keyword) => {
    if (sourceId === 'slow') return new Promise(() => {});
    return {
      data: [{ id: 'fast-result', name: keyword, episodes: { line_1: [{ title: '01', url: 'https://video.test/1.m3u8' }] } }],
      page: 1,
      total: 1,
      totalPages: 1
    };
  };

  const startedAt = Date.now();
  const statuses = await registry.searchAll('Fast Anime', {
    concurrency: 2,
    providerLimit: 2,
    returnOnFirstSuccess: true
  });

  assert.ok(Date.now() - startedAt < 100);
  assert.equal(statuses[0].providerId, 'cms:fast');
  assert.equal(statuses[0].status, 'success');
  assert.equal(statuses.find(item => item.providerId === 'cms:slow').status, 'pending');
});

test('searchAll does not start queued providers after an early success', async () => {
  const registry = createRegistry();
  const requested = [];
  registry.sourcePluginManager.getAllForManagement = () => [];
  registry.cmsApiService.getSourceList = () => [
    { id: 'first', name: 'First', categories: [], health: { score: 100 } },
    { id: 'second', name: 'Second', categories: [], health: { score: 90 } },
    { id: 'third', name: 'Third', categories: [], health: { score: 80 } }
  ];
  registry.cmsApiService.searchInSource = async (sourceId, keyword) => {
    requested.push(sourceId);
    return {
      data: [{ id: `${sourceId}-result`, name: keyword, episodes: { line_1: [{ title: '01', url: 'https://video.test/1.m3u8' }] } }],
      page: 1,
      total: 1,
      totalPages: 1
    };
  };

  await registry.searchAll('First Anime', {
    concurrency: 1,
    providerLimit: 3,
    returnOnFirstSuccess: true
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.deepEqual(requested, ['first']);
});

test('share-page resolution is delegated through the registry', async () => {
  const registry = createRegistry();
  const result = await registry.resolveEpisode('cms:cms-one', { url: 'https://share.test/share/123' });
  assert.equal(result.url, 'https://video.test/share.m3u8');
});

test('CMS search hydrates the best summary when the search response has no episodes', async () => {
  const registry = createRegistry();
  registry.cmsApiService.searchInSource = async (sourceId, keyword) => ({
    data: [{ id: 'summary-only', name: keyword, source: sourceId, episodes: {} }],
    page: 1,
    total: 1,
    totalPages: 1
  });
  registry.cmsApiService.getDetail = async (id, options) => ({
    id,
    name: 'Hydrated Detail',
    source: options.sourceId,
    episodes: {
      line_1: [{ id: 'ep-1', title: '01', url: 'https://video.test/1.m3u8' }]
    },
    episode_count: 1
  });

  const result = await registry.search('cms:cms-one', 'Hydrated Detail', { hydrateLimit: 1 });

  assert.equal(result.data[0].episode_count, 1);
  assert.equal(result.data[0].episodes.line_1.length, 1);
});

test('CMS playback headers fall back to the source origin', () => {
  const registry = createRegistry();
  registry.cmsApiService.getSourceConfig = () => ({
    id: 'cms-one',
    api: 'https://source.example/api.php/provide/vod/',
    playbackHeaders: {}
  });
  registry.sharePageResolver.getPlaybackHeaders = () => ({});

  const headers = registry.getPlaybackHeaders('cms:cms-one', 'https://cdn.example/video.m3u8');

  assert.equal(headers.Referer, 'https://source.example/');
});

test('XPath playback headers come from the imported rule', () => {
  const registry = createRegistry();
  const headers = registry.getPlaybackHeaders('xpath:rule-one', 'https://cdn.example/video.m3u8');
  assert.equal(headers.Referer, 'https://rule.test/');
});

test('personal media providers participate in same-episode automatic selection', async () => {
  const registry = createRegistry();
  registry.mediaLibraryService = {
    listLibraries: () => [{ id: 'local', name: 'Local Library', type: 'local', enabled: true, preference: 15 }],
    search: async () => ({
      success: true,
      data: [{
        id: 'local-series',
        name: 'Example Anime',
        episodes: {
          local: [
            { id: 'ep-1', title: '第01集', url: 'sakurafall-media://asset/one' },
            { id: 'ep-2', title: '第02集', url: 'sakurafall-media://asset/two', quality: { height: 1080 } }
          ]
        }
      }]
    }),
    getDetail: async (_id, reference) => reference,
    getPlaybackHeaders: () => ({}),
    resolveEpisode: async (_id, episode) => ({ url: episode.url })
  };
  registry.cmsApiService.selectBestEpisodeSource = async () => ({ best: null, candidates: [], skipped: [] });
  registry.cmsApiService.findMatchingEpisode = (episodes, _title, index) => ({
    episode: episodes.local[index],
    lineId: 'local',
    matchType: 'index',
    matchScore: 100
  });

  const result = await registry.selectBestEpisodeSource('Example Anime', { episodeIndex: 1 });

  assert.equal(result.best.providerId, 'media:local');
  assert.equal(result.best.episode.title, '第02集');
  assert.equal(result.best.quality.height, 1080);
});

test('XPath-style community providers participate in same-episode automatic selection', async () => {
  const registry = createRegistry();
  registry.cmsApiService.selectBestEpisodeSource = async () => ({ best: null, candidates: [], skipped: [] });
  registry.cmsApiService.findMatchingEpisode = episodes => {
    const [lineId, line] = Object.entries(episodes)[0] || [];
    return {
      episode: line?.[0],
      lineId,
      matchType: 'title',
      matchScore: 100
    };
  };

  const result = await registry.selectBestEpisodeSource('Rule Detail', { episodeIndex: 0 });

  assert.equal(result.best.providerId, 'xpath:rule-one');
  assert.equal(result.best.sourceType, 'xpath');
  assert.equal(result.best.episode.url, 'https://video.test/rule-1.m3u8');
});
