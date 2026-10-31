import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const episodeListSource = await readFile(
  new URL('../src/renderer/utils/episodeList.js', import.meta.url),
  'utf8'
);
const mappingSource = await readFile(
  new URL('../src/renderer/utils/sourceEpisodeMapping.js', import.meta.url),
  'utf8'
);
const dataUrl = value => `data:text/javascript;charset=utf-8,${encodeURIComponent(value)}`;
const combined = `${episodeListSource}\n${mappingSource.replace(
  "import { extractEpisodeNumber, rankEpisodeLines } from './episodeList.js';",
  ''
)}`;
const { applySourceEpisodeMapping, sourceMappingKey } = await import(dataUrl(combined));

test('manual mapping slices a continuous collection into season episodes', () => {
  const episodes = Array.from({ length: 197 }, (_, index) => ({
    id: `ep-${index + 1}`,
    title: `第${index + 1}集`,
    url: `https://example.test/${index + 1}.m3u8`
  }));
  const line = { lineId: 'line', episodes };
  const source = {
    providerId: 'cms:zy360',
    selectedResultId: '99260',
    playableEpisodeCount: 197,
    animeList: [{ id: '99260', name: '凡人修仙传', episodes: { line } }],
    results: [{ id: '99260', name: '凡人修仙传', episodes: { line } }],
    rankedLines: [line]
  };

  applySourceEpisodeMapping(source, 177, { planned_episode_count: 52 });

  assert.equal(source.playableEpisodeCount, 21);
  assert.equal(source.rankedLines[0].episodes.length, 21);
  assert.equal(source.rankedLines[0].episodes[0].title, '第1集');
  assert.equal(source.rankedLines[0].episodes[0].sourceTitle, '第177集');
  assert.equal(source.rankedLines[0].episodes[0].sourceEpisodeNumber, 177);
  assert.equal(source.rankedLines[0].episodes[20].title, '第21集');
  assert.equal(source.animeList[0].episodes.line.length, 21);
  assert.equal(source.matchReliable, true);
  assert.equal(source.manualMapped, true);
});

test('source mapping key is stable per work, provider and result', () => {
  const key = sourceMappingKey(
    { bgm_id: 607915 },
    { providerId: 'cms:zy360', selectedResultId: '99260' }
  );
  assert.equal(key, '607915|cms:zy360|99260');
});
