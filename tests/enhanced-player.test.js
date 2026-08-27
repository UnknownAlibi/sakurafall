const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const service = require('../src/main/services/EnhancedPlayerService');

test('bundled Anime4K preset resolves real shader files', () => {
  const selection = service.resolveShaderSelection({
    enableAnime4K: true,
    anime4kPreset: 'balanced'
  });

  assert.equal(selection.source, 'bundled');
  assert.equal(selection.paths.length, 5);
  assert.deepEqual(selection.missing, []);
  assert.ok(selection.paths.every(shaderPath => fs.existsSync(shaderPath)));
});

test('balanced enhanced playback enables buffering and cadence smoothing', () => {
  const args = service.buildArgs({
    url: 'https://example.com/video.m3u8',
    enableAnime4K: true,
    anime4kPreset: 'balanced'
  });

  assert.ok(args.includes('--video-sync=display-resample'));
  assert.ok(args.includes('--interpolation=yes'));
  assert.ok(args.includes('--cache-secs=90'));
  assert.ok(args.includes('--cache-pause=yes'));
  assert.equal(args.filter(arg => arg.startsWith('--glsl-shader=')).length, 5);
});

test('light preset avoids interpolation for lower GPU load', () => {
  const args = service.buildArgs({
    url: 'https://example.com/video.m3u8',
    enableAnime4K: true,
    anime4kPreset: 'light'
  });

  assert.ok(!args.includes('--interpolation=yes'));
  assert.ok(args.includes('--video-sync=audio'));
  assert.equal(args.filter(arg => arg.startsWith('--glsl-shader=')).length, 3);
});

test('enhanced player rejects non-media protocols', () => {
  assert.throws(() => service.buildArgs({ url: 'javascript:alert(1)' }), /播放地址无效/);
});
