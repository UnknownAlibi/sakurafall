import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEEK_STEP_OPTIONS,
  normalizeSeekStepSeconds
} from '../src/renderer/utils/playerPreferences.js';

test('player seek step accepts the supported playback intervals', () => {
  assert.deepEqual([...SEEK_STEP_OPTIONS], [5, 10, 15, 30]);
  assert.equal(normalizeSeekStepSeconds(5), 5);
  assert.equal(normalizeSeekStepSeconds('15'), 15);
});

test('player seek step falls back when persisted data is invalid', () => {
  assert.equal(normalizeSeekStepSeconds(0), 10);
  assert.equal(normalizeSeekStepSeconds(7), 10);
  assert.equal(normalizeSeekStepSeconds('bad'), 10);
});
