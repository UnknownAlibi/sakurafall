import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/episodeList.js', import.meta.url),
  'utf8'
);
const {
  findEpisodeIndex,
  findLineForEpisode,
  formatLineNames,
  getAdjacentEpisode,
  getLineEpisodes,
  getPreferredEpisodeLine,
  hasEpisodeLines,
  isSameEpisode
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`);

test('formatLineNames: formats cms line ids', () => {
  assert.deepEqual(formatLineNames({
    '1': [],
    ul_playlist_backup: []
  }), {
    '1': '\u7ebf\u8def1',
    ul_playlist_backup: 'backup'
  });
});

test('getLineEpisodes: sorts by episode number in title', () => {
  const episodes = {
    line1: [
      { id: '10', title: 'Episode 10' },
      { id: '2', title: 'Episode 2' },
      { id: '1', title: 'Episode 1' }
    ]
  };

  assert.deepEqual(getLineEpisodes(episodes, 'line1').map(ep => ep.id), ['1', '2', '10']);
});

test('findEpisodeIndex/findLineForEpisode: matches current episode', () => {
  const episodes = {
    lineA: [{ id: '1', title: 'Episode 1' }],
    lineB: [{ id: '2', title: 'Episode 2' }]
  };
  const list = getLineEpisodes(episodes, 'lineB');

  assert.equal(findEpisodeIndex(list, { id: '2', title: 'Episode 2' }), 0);
  assert.equal(findLineForEpisode(episodes, { id: '2', title: 'Episode 2' }), 'lineB');
});

test('episode identity tolerates source id types and never matches missing fields', () => {
  assert.equal(isSameEpisode({ id: 12 }, { id: '12' }), true);
  assert.equal(isSameEpisode({}, {}), false);
  assert.equal(findEpisodeIndex([{}, { title: '第12集' }], {}), -1);
});

test('episode identity survives source changes via number and stored index', () => {
  const sourceEpisodes = [
    { id: 'a', title: '第01集' },
    { id: 'b', title: '第02集' }
  ];
  assert.equal(findEpisodeIndex(sourceEpisodes, { id: 'other', title: 'Episode 2' }), 1);
  assert.equal(findEpisodeIndex([{ id: 'a' }, { id: 'b' }], { id: 'other', index: 1 }), 1);
});

test('getAdjacentEpisode/hasEpisodeLines: handles adjacent episodes and empty lists', () => {
  const list = [{ id: '1' }, { id: '2' }];

  assert.equal(hasEpisodeLines({ line1: list }), true);
  assert.equal(hasEpisodeLines({}), false);
  assert.deepEqual(getAdjacentEpisode(list, 0, 1), { id: '2' });
  assert.equal(getAdjacentEpisode(list, 0, -1), null);
});

test('getPreferredEpisodeLine: prefers a direct m3u8 line over an earlier page line', () => {
  const episodes = {
    hnyun: [
      { title: '01', url: 'https://player.example/watch/1' },
      { title: '02', url: 'https://player.example/watch/2' }
    ],
    hnm3u8: [
      { title: '01', url: 'https://cdn.example/1.m3u8' },
      { title: '02', url: 'https://cdn.example/2.m3u8' }
    ]
  };

  assert.equal(getPreferredEpisodeLine(episodes), 'hnm3u8');
});

test('getPreferredEpisodeLine: keeps source order when equivalent lines tie', () => {
  const episodes = {
    first: [{ title: '01', url: 'https://cdn.example/1.m3u8' }],
    second: [{ title: '01', url: 'https://cdn.example/backup-1.m3u8' }]
  };

  assert.equal(getPreferredEpisodeLine(episodes), 'first');
});
