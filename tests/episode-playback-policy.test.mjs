import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(path.resolve('src/renderer/utils/episodePlaybackPolicy.js')).href;
const { isSuspiciousSniffedMediaEnd } = await import(moduleUrl);

test('short webview-sniff media is not treated as a completed episode', () => {
  assert.equal(isSuspiciousSniffedMediaEnd({ duration: 3.1, resolvedBy: 'webview-sniff' }), true);
});

test('normal episodes and non-sniffed short media keep ordinary ended behavior', () => {
  assert.equal(isSuspiciousSniffedMediaEnd({ duration: 1420, resolvedBy: 'webview-sniff' }), false);
  assert.equal(isSuspiciousSniffedMediaEnd({ duration: 3.1, resolvedBy: 'direct' }), false);
});

test('player guards suspicious sniffed media before emitting video-ended', () => {
  const source = fs.readFileSync('src/renderer/components/Player/VideoPlayer.vue', 'utf8');
  const handler = source.slice(source.indexOf('    onVideoEnded() {'), source.indexOf('    onWaiting() {'));
  assert.ok(handler.indexOf('isSuspiciousSniffedMediaEnd') < handler.indexOf("this.$emit('video-ended')"));
  assert.match(handler, /sniffed-short-media/);
  assert.match(handler, /autoFallbackToOtherSource/);
});
