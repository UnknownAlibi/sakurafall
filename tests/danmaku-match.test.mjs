import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/danmakuMatch.js', import.meta.url),
  'utf8'
);
const { extractDanmakuEpisodeNumber, selectDanmakuEpisode } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`
);

test('extractDanmakuEpisodeNumber understands common episode labels', () => {
  assert.equal(extractDanmakuEpisodeNumber('第03话'), 3);
  assert.equal(extractDanmakuEpisodeNumber('EP12 简体'), 12);
  assert.equal(extractDanmakuEpisodeNumber({ episodeNumber: 7 }), 7);
});

test('selectDanmakuEpisode matches the current anime and exact episode', () => {
  const result = selectDanmakuEpisode([
    {
      animeId: 10,
      title: '葬送的芙莉莲 第二季',
      episodes: [{ episodeId: 1001, episodeTitle: '第1话' }]
    },
    {
      animeId: 20,
      title: '葬送的芙莉莲',
      episodes: [
        { episodeId: 2001, episodeTitle: '01' },
        { episodeId: 2002, episodeTitle: '02' }
      ]
    }
  ], '葬送的芙莉莲', 2);

  assert.equal(result.animeId, 20);
  assert.equal(result.episodeId, 2002);
  assert.equal(result.episodeNumber, 2);
});
