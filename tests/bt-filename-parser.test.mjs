import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAnimeFilename,
  parseResolution,
  parseVideoCodec
} from '../src/main/services/bt/FilenameParser.js';

test('parses standard fansub filename with full metadata', () => {
  const r = parseAnimeFilename('[VCB-Studio] Fate/stay night [01][Ma10p_1080p][x265_flac].mkv');
  assert.equal(r.group, 'VCB-Studio');
  assert.equal(r.title, 'Fate/stay night');
  assert.equal(r.episode, 1);
  assert.equal(r.resolution, '1080P');
  assert.equal(r.videoCodec, 'x265');
  assert.equal(r.audioCodec, 'FLAC');
  assert.equal(r.bitDepth, 10);
});

test('parses LoliHouse style name with season and episode range', () => {
  const r = parseAnimeFilename('[LoliHouse] Bocchi the Rock! - 08 [WebRip 1080p HEVC-10bit AAC].mkv');
  assert.equal(r.group, 'LoliHouse');
  assert.equal(r.title, 'Bocchi the Rock!');
  assert.equal(r.episode, 8);
  assert.equal(r.resolution, '1080P');
  assert.equal(r.videoCodec, 'H.265');
  assert.equal(r.audioCodec, 'AAC');
});

test('parses Chinese episode markers', () => {
  const r = parseAnimeFilename('[澄空学园&华盟字幕社] 孤独摇滚 第05话 [720p][x264].mp4');
  assert.equal(r.group, '澄空学园&华盟字幕社');
  assert.equal(r.title, '孤独摇滚');
  assert.equal(r.episode, 5);
  assert.equal(r.resolution, '720P');
  assert.equal(r.videoCodec, 'x264');
});

test('detects complete collection and uncensored marks', () => {
  const complete = parseAnimeFilename('[SubsPlease] Frieren - 完结 [1080p][x265].mkv');
  assert.equal(complete.isComplete, true);
  assert.equal(complete.episode, null);
  const uncensored = parseAnimeFilename('[XX] Some Anime 无修正 [1080p].mkv');
  assert.equal(uncensored.isUncensored, true);
});

test('detects special kinds like NCOP and OVA', () => {
  assert.equal(parseAnimeFilename('[Group] Anime NCOP [1080p].mkv').special, 'NCOP');
  assert.equal(parseAnimeFilename('[Group] Anime OVA 01 [1080p].mkv').special, 'OVA');
});

test('parses season number in multiple formats', () => {
  assert.equal(parseAnimeFilename('[G] Anime S02 01 [1080p].mkv').season, 2);
  assert.equal(parseAnimeFilename('[G] Anime 第二季 01 [1080p].mkv').season, 2);
  assert.equal(parseAnimeFilename('[G] Anime Season 3 01 [1080p].mkv').season, 3);
});

test('handles v2 republish and half episodes', () => {
  assert.equal(parseAnimeFilename('[G] Anime [03v2] [1080p].mkv').episode, 3);
  assert.equal(parseAnimeFilename('[G] Anime [03.5] [1080p].mkv').episode, 3);
});

test('subtitle language detection', () => {
  assert.equal(parseAnimeFilename('[G] Anime 01 [CHT] [1080p].mkv').subtitleLang, '繁中');
  assert.equal(parseAnimeFilename('[G] Anime 01 [简体] [1080p].mkv').subtitleLang, '简中');
  assert.equal(parseAnimeFilename('[G] Anime 01 [双语] [1080p].mkv').subtitleLang, '双语');
});

test('empty and malformed inputs do not throw', () => {
  assert.deepEqual(parseAnimeFilename('').title, null);
  const r = parseAnimeFilename('random text no brackets');
  assert.equal(r.group, null);
  assert.equal(r.title, 'random text no brackets');
});

test('resolution and codec helpers', () => {
  assert.equal(parseResolution('2160p'), '4K');
  assert.equal(parseResolution('1920x1080'), null);
  assert.equal(parseVideoCodec('AV1 10bit'), 'av1');
});

test('bracket episode wins over dash pattern', () => {
  const r = parseAnimeFilename('[G] Title - 12 [2023][1080p].mkv');
  assert.equal(r.episode, 12);
});
