import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/playbackFrameRate.js', import.meta.url),
  'utf8'
);
const {
  estimateSourceFrameRate,
  formatSourceFrameRate,
  normalizeDeclaredFrameRate
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`);

test('normalizeDeclaredFrameRate: preserves standard fractional source rates', () => {
  assert.equal(normalizeDeclaredFrameRate(23.98), 23.976);
  assert.equal(normalizeDeclaredFrameRate('59.94'), 59.94);
  assert.equal(normalizeDeclaredFrameRate(0), 0);
});

test('estimateSourceFrameRate: stabilizes noisy decoder samples to source cadence', () => {
  assert.equal(estimateSourceFrameRate([24.2, 23.8, 24.05, 23.95]), 24);
  assert.equal(estimateSourceFrameRate([59.2, 60.4, 59.8, 60.1, 1]), 59.94);
});

test('estimateSourceFrameRate: waits for enough samples', () => {
  assert.equal(estimateSourceFrameRate([23.9, 24.1, 24]), 0);
});

test('formatSourceFrameRate: avoids a noisy decimal for integer rates', () => {
  assert.equal(formatSourceFrameRate(24), '24');
  assert.equal(formatSourceFrameRate(23.976), '23.976');
  assert.equal(formatSourceFrameRate(0), '');
});
