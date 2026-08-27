import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const episodeMetadataSource = await readFile(
  new URL('../src/renderer/utils/episodeMetadata.js', import.meta.url),
  'utf8'
);
const episodeMetadataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(episodeMetadataSource)}`;
const coordinatorSource = (await readFile(
  new URL('../src/renderer/services/subjectDetailCoordinator.js', import.meta.url),
  'utf8'
)).replace("'../utils/episodeMetadata.js'", JSON.stringify(episodeMetadataUrl));
const { coordinateSubjectDetail, createDetailPlaceholder, isSettledDetailStage } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(coordinatorSource)}`
);

test('only the completed detail stage is presented as the settled snapshot', () => {
  assert.equal(isSettledDetailStage({ phase: 'source' }), false);
  assert.equal(isSettledDetailStage({ phase: 'metadata-cache' }), false);
  assert.equal(isSettledDetailStage({ phase: 'complete' }), true);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('detail coordinator overlaps source lookup and Bangumi metadata requests', async () => {
  const source = deferred();
  const search = deferred();
  const index = deferred();
  const detail = deferred();
  const calls = [];
  const stages = [];
  const anime = { id: 'source-1', source: 'ffzy', name: '并行测试番剧', cover: 'cover.jpg' };
  const api = {
    sourceProviderDetail() {
      calls.push('source');
      return source.promise;
    },
    subjectSearch() {
      calls.push('search');
      return search.promise;
    },
    subjectIndexGet() {
      calls.push('index');
      return index.promise;
    },
    subjectDetail() {
      calls.push('detail');
      return detail.promise;
    }
  };

  const resultPromise = coordinateSubjectDetail({
    anime,
    api,
    onStage(_value, context) {
      stages.push(context.phase);
    }
  });
  await nextTurn();
  assert.deepEqual(calls, ['source', 'search']);

  search.resolve({ data: [{ bgmId: 42 }] });
  await nextTurn();
  assert.deepEqual(calls, ['source', 'search', 'index', 'detail']);

  source.resolve({ episodes: { line_1: [{ id: 'ep-1', title: '第1集', url: 'https://cdn.test/1.m3u8' }] } });
  await nextTurn();
  assert.deepEqual(stages, ['source']);

  index.resolve({ bgm_id: 42, name: '缓存标题', intro: '缓存简介', planned_episode_count: 12 });
  await nextTurn();
  assert.deepEqual(stages, ['source', 'metadata-cache']);

  detail.resolve({ bgm_id: 42, name: '完整标题', intro: '完整简介', planned_episode_count: 12 });
  const result = await resultPromise;
  assert.deepEqual(stages, ['source', 'metadata-cache', 'complete']);
  assert.equal(result.name, '完整标题');
  assert.equal(result.available_episode_count, 1);
  assert.equal(result._bgmMetaLoading, false);

  const cachedPlaceholder = createDetailPlaceholder(anime);
  assert.equal(cachedPlaceholder.intro, '完整简介');
  assert.equal(cachedPlaceholder._sourceDetailLoading, false);
});
