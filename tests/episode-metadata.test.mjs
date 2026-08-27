import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/episodeMetadata.js', import.meta.url),
  'utf8'
);
const { countPlayableEpisodes, totalEpisodeBadge, updatedEpisodeBadge } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`
);

test('alternate playback lines do not multiply the episode count', () => {
  const anime = {
    source: 'cms:test',
    episodes: {
      high: Array.from({ length: 12 }, (_, index) => ({ id: `a${index}` })),
      backup: Array.from({ length: 12 }, (_, index) => ({ id: `b${index}` }))
    }
  };

  assert.equal(countPlayableEpisodes(anime), 12);
  assert.equal(updatedEpisodeBadge(anime), '更新至12集');
  assert.equal(totalEpisodeBadge(anime), '共12集');
});

test('official Bangumi episode lines are not treated as playable source updates', () => {
  const official = [{ id: 'bangumi_eps_1', air_date: '2020-01-01' }];
  official._lineName = '官方分集';
  assert.equal(countPlayableEpisodes({ episodes: { line_1: official } }), 0);
});

test('official aired progress wins over an incomplete playback source', () => {
  const anime = {
    source: 'bangumi',
    planned_episode_count: 12,
    aired_episode_count: 12,
    available_episode_count: 1
  };

  assert.equal(totalEpisodeBadge(anime), '共12集');
  assert.equal(updatedEpisodeBadge(anime), '更新至12集');
});
