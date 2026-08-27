import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/sourceMatch.js', import.meta.url),
  'utf8'
);
const { rankSourcesByMatch, scoreSourceMatch } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`
);

test('source matching selects the best candidate instead of trusting result order', () => {
  const anime = { name: '超市后门吸烟的二人', air_date: '2026-01-01', planned_episode_count: 12 };
  const source = {
    sourceId: 'cms:test',
    status: 'success',
    results: [
      { id: 'wrong', name: '超市大赢家', year: '2026', episode_count: 12 },
      { id: 'right', name: '超市后门吸烟的二人', year: '2026', episode_count: 12 }
    ]
  };

  const ranked = rankSourcesByMatch(anime, [source]);
  assert.equal(ranked[0].results[0].id, 'right');
  assert.equal(ranked[0].selectedResultId, 'right');
  assert.equal(ranked[0].matchReliable, true);
});

test('low title similarity is not considered reliable for automatic selection', () => {
  const match = scoreSourceMatch(
    { name: '葬送的芙莉莲', air_date: '2023-09-29' },
    { status: 'success', results: [{ id: 'wrong', name: '间谍过家家', year: '2023' }] }
  );

  assert.equal(match.reliable, false);
});

test('episode count uses the longest alternate line', () => {
  const ranked = rankSourcesByMatch(
    { name: '测试番剧' },
    [{
      status: 'success',
      results: [{
        id: 'multi',
        name: '测试番剧',
        episodes: { a: Array(12).fill({}), b: Array(12).fill({}) }
      }]
    }]
  );

  assert.equal(ranked[0].episodeCount, 12);
});

test('release metadata and update suffixes do not hide an exact title match', () => {
  const match = scoreSourceMatch(
    { name: '超市后门吸烟的二人' },
    {
      status: 'success',
      results: [{ name: '超市后门吸烟的二人【1080P・简繁字幕】更新至12集', episode_count: 12 }]
    }
  );

  assert.equal(match.reliable, true);
  assert.equal(match.titleScore, 1);
});

test('raw names and aliases can establish a reliable source match', () => {
  const match = scoreSourceMatch(
    { name: '孤独摇滚！', nameRaw: 'ぼっち・ざ・ろっく！', aliases: ['Bocchi the Rock!'] },
    { status: 'success', results: [{ name: 'ぼっち・ざ・ろっく！', episode_count: 12 }] }
  );

  assert.equal(match.reliable, true);
});

test('equally matched playable sources prefer proven playback health', () => {
  const anime = { name: 'Health Ranked Anime', planned_episode_count: 1 };
  const ranked = rankSourcesByMatch(anime, [
    {
      sourceId: 'unverified',
      status: 'success',
      healthScore: 50,
      results: [{
        name: 'Health Ranked Anime',
        episode_count: 1,
        episodes: { line: [{ title: '01', url: 'https://bad.test/1.m3u8' }] }
      }]
    },
    {
      sourceId: 'verified',
      status: 'success',
      healthScore: 95,
      results: [{
        name: 'Health Ranked Anime',
        episode_count: 1,
        episodes: { line: [{ title: '01', url: 'https://good.test/1.m3u8' }] }
      }]
    }
  ]);

  assert.equal(ranked[0].sourceId, 'verified');
});
