import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/sourceMatch.js', import.meta.url),
  'utf8'
);
const { rankSourcesByMatch, scoreSourceMatch, buildSeasonSearchContext } = await import(
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

test('season-specific anime rejects same-name live action and other seasons', () => {
  const anime = {
    name: '凡人修仙传 第五季',
    name_cn: '凡人修仙传 第五季',
    aliases: ['凡人慕兰之战', '凡人修仙传 慕兰之战篇'],
    air_date: '2026-06-13',
    type: ['动漫'],
    planned_episode_count: 52
  };
  const source = {
    sourceId: 'cms:test',
    status: 'success',
    results: [
      { id: 'live', name: '凡人修仙传真人版', year: '2025', type: ['奇幻', '古装'], episode_count: 30 },
      { id: 's4', name: '凡人修仙传：外海风云', year: '2025', type: ['动画'], episode_count: 52 },
      { id: 'base', name: '凡人修仙传', year: '2020', type: ['动画'], episode_count: 197 },
      { id: 'remaster', name: '凡人修仙传重制版', year: '2023', type: ['动画'], episode_count: 21 },
      { id: 's5', name: '凡人修仙传 慕兰之战', year: '2026', type: [], episode_count: 21 },
      { id: 's5-explicit', name: '凡人修仙传 第五季', year: '2026', type: ['动画'], episode_count: 21 }
    ]
  };

  const ranked = rankSourcesByMatch(anime, [source])[0];
  assert.ok(['s5', 's5-explicit'].includes(ranked.results[0].id));
  assert.ok(['s5', 's5-explicit'].includes(ranked.selectedResultId));
  assert.equal(ranked.matchReliable, true);
  assert.equal(ranked.requiresEpisodeMapping, false);

  const liveMatch = scoreSourceMatch(anime, { status: 'success', results: [source.results[0]] });
  assert.equal(liveMatch.reliable, false);
  assert.equal(liveMatch.contentType, 'live-action');

  const seasonFourMatch = scoreSourceMatch(anime, { status: 'success', results: [source.results[1]] });
  assert.equal(seasonFourMatch.reliable, false);
  assert.match(seasonFourMatch.reasons.join(' '), /篇名不一致/);

  const baseMatch = scoreSourceMatch(anime, { status: 'success', results: [source.results[2]] });
  assert.equal(baseMatch.reliable, false);
  assert.equal(baseMatch.requiresMapping, true);
  assert.match(baseMatch.reasons.join(' '), /缺少季信息/);

  const seasonContext = buildSeasonSearchContext(anime);
  assert.equal(seasonContext.seasonNumber, 5);
  assert.ok(seasonContext.keywords.includes('慕兰之战'));
});

test('live action is rejected when the anime type arrives as a tag array', () => {
  const match = scoreSourceMatch(
    { name: '测试番剧', type: ['动漫'], year: '2026' },
    {
      status: 'success',
      results: [{ id: 'live', name: '测试番剧真人版', year: '2026', type: ['古装', '奇幻'], episode_count: 30 }]
    }
  );

  assert.equal(match.reliable, false);
  assert.equal(match.contentType, 'live-action');
  assert.match(match.reasons.join(' '), /真人版/);
});

test('explicit season candidate is reliable when its alias subtitle matches', () => {
  const anime = {
    name: '凡人修仙传 第四季',
    aliases: ['凡人修仙传 外海风云篇', '凡人修仙传 重返天南篇'],
    air_date: '2025-01-18',
    planned_episode_count: 52
  };
  const match = scoreSourceMatch(anime, {
    status: 'success',
    results: [{ id: 's4', name: '凡人修仙传：外海风云', year: '2025', type: ['动画'], episode_count: 52 }]
  });

  assert.equal(match.reliable, true);
  assert.equal(match.seasonMatch, 1);
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
