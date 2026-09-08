const test = require('node:test');
const assert = require('node:assert/strict');
const summarize = require('../scripts/summarize-playback-samples');

const sample = (t, currentTime, extra = {}) => ({
  t, currentTime, steady: true, paused: false, seeking: false,
  presenting: true, backend: 'webgpu-worker', preset: 'balanced', renderedFrames: t * 24 / 1000, ...extra
});

test('steady playback statistics do not join intervals across interactions or warmup', () => {
  const result = summarize([
    sample(0, 0), sample(1000, 1), { t: 1100, interaction: 'seek' },
    sample(6000, 3), sample(7000, 4), sample(8000, 1, { steady: false }),
    sample(12000, 2), sample(13000, 3)
  ]);
  assert.equal(result.steadyPlaybackRate, 1);
  assert.equal(result.measuredPairs, 3);
  assert.equal(result.measuredSteadySeconds, 3);
  assert.equal(result.steadyCnnFps, 24);
});

test('loop wraps and reset frame counters are excluded explicitly, frozen media remains measurable', () => {
  const result = summarize([
    sample(0, 4), sample(1000, 0), sample(2000, 1, { renderedFrames: 2 }),
    sample(3000, 1, { renderedFrames: 2 })
  ]);
  assert.equal(result.excludedWraps, 1);
  assert.equal(result.counterResets, 1);
  assert.equal(result.steadyPlaybackRate, 0.5);
  assert.equal(result.steadyCnnFps, 12);
});
