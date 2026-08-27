import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/episodePlayback.js', import.meta.url),
  'utf8'
);
const {
  isPlayableVideoUrl,
  isSharePageUrl,
  normalizeVideoUrl,
  resolveEpisodeVideoUrl
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`);

test('normalizeVideoUrl: trims and normalizes protocol-relative urls', () => {
  assert.equal(normalizeVideoUrl('  //cdn.example.com/a.m3u8  '), 'https://cdn.example.com/a.m3u8');
  assert.equal(normalizeVideoUrl(''), '');
});

test('isPlayableVideoUrl: allows media-safe protocols only', () => {
  assert.equal(isPlayableVideoUrl('https://cdn.example.com/a.m3u8'), true);
  assert.equal(isPlayableVideoUrl('http://cdn.example.com/a.mp4'), true);
  assert.equal(isPlayableVideoUrl('blob:https://app.local/id'), true);
  assert.equal(isPlayableVideoUrl('file:///D:/video.mp4'), true);
  assert.equal(isPlayableVideoUrl('https://vip.example.com/share/abc'), false);
  assert.equal(isPlayableVideoUrl('javascript:alert(1)'), false);
  assert.equal(isPlayableVideoUrl('/relative/video.m3u8'), false);
});

test('isSharePageUrl: detects share pages after normalization', () => {
  assert.equal(isSharePageUrl('  https://vip.example.com/share/abc  '), true);
  assert.equal(isSharePageUrl('https://cdn.example.com/a.m3u8'), false);
});

test('resolveEpisodeVideoUrl: returns first playable candidate', async () => {
  const episode = {
    realUrl: 'javascript:alert(1)',
    url: 'https://cdn.example.com/fallback.m3u8'
  };

  assert.equal(await resolveEpisodeVideoUrl(episode, null), 'https://cdn.example.com/fallback.m3u8');
});

test('resolveEpisodeVideoUrl: resolves share pages through generic playback resolver', async () => {
  const calls = [];
  const episode = { url: 'https://vip.example.com/share/abc' };
  const electronAPI = {
    async playbackResolve(payload) {
      calls.push(payload.episode.url);
      return { success: true, url: '//cdn.example.com/resolved.m3u8' };
    }
  };

  assert.equal(await resolveEpisodeVideoUrl(episode, electronAPI), 'https://cdn.example.com/resolved.m3u8');
  assert.deepEqual(calls, ['https://vip.example.com/share/abc']);
  // 不得写回 episode.realUrl：episode 可能来自 Vuex state，直接修改会绕过 mutation 污染 store
  assert.equal(episode.realUrl, undefined);
});

test('resolveEpisodeVideoUrl: falls back when share resolution fails', async () => {
  const episode = {
    url: 'https://vip.example.com/share/abc',
    play_url: 'https://cdn.example.com/fallback.m3u8'
  };
  const electronAPI = {
    async playbackResolve() {
      return { success: false };
    }
  };

  assert.equal(await resolveEpisodeVideoUrl(episode, electronAPI), 'https://cdn.example.com/fallback.m3u8');
});
