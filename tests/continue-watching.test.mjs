import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continueWatchingKey,
  findHistoryEpisode,
  findHistoryProvider,
  historyAnimeReference,
  resolveContinueWatching
} from '../src/renderer/utils/continueWatching.js';

test('continue watching finds an enabled provider across namespaced ids', () => {
  const providers = [
    { providerId: 'cms:ffzy-api', sourceId: 'ffzy-api', enabled: true },
    { providerId: 'cms:disabled', sourceId: 'disabled', enabled: false }
  ];
  assert.equal(findHistoryProvider(providers, { source: 'ffzy-api' })?.providerId, 'cms:ffzy-api');
  assert.equal(findHistoryProvider(providers, { source: 'disabled' }), null);
});

test('continue watching prefers the saved episode title over a stale index', () => {
  const result = findHistoryEpisode({
    hls: [
      { id: 'ep-1', title: '第01集', url: 'https://media.test/1.m3u8' },
      { id: 'ep-2', title: '第02集', url: 'https://media.test/2.m3u8' }
    ]
  }, { episode_title: '第02集', episode_index: 0 });
  assert.equal(result?.episode.id, 'ep-2');
  assert.equal(result?.episodeIndex, 1);
});

test('continue watching falls back to a saved episode index', () => {
  const result = findHistoryEpisode({
    line: [
      { id: 'a', title: '上篇', url: 'https://media.test/a.m3u8' },
      { id: 'b', title: '下篇', url: 'https://media.test/b.m3u8' }
    ]
  }, { episode_title: '', episode_index: 1 });
  assert.equal(result?.episode.id, 'b');
});

test('history reference and card key retain source-specific lookup data', () => {
  const history = {
    anime_id: '42',
    source: 'ffzy-api',
    name: '测试番剧',
    anime_data: { href: 'https://source.test/detail/42' }
  };
  assert.equal(continueWatchingKey(history), 'ffzy-api:42');
  assert.deepEqual(historyAnimeReference(history), {
    id: '42',
    url: 'https://source.test/detail/42',
    href: 'https://source.test/detail/42',
    name: '测试番剧'
  });
});

test('continue watching resolves provider detail and the saved episode', async () => {
  const result = await resolveContinueWatching({
    history: { anime_id: '42', source: 'ffzy-api', name: '测试番剧', episode_title: '第02集' },
    api: {
      sourceProviderList: async () => [{ providerId: 'cms:ffzy-api', sourceId: 'ffzy-api', type: 'cms', enabled: true }],
      sourceProviderDetail: async () => ({
        id: '42',
        name: '测试番剧',
        episodes: { hls: [{ title: '第01集' }, { title: '第02集', url: 'https://media.test/2.m3u8' }] }
      })
    }
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.anime.providerId, 'cms:ffzy-api');
  assert.equal(result.matched.episodeIndex, 1);
});
