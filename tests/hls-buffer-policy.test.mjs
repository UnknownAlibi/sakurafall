import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHlsBufferPolicy } from '../src/renderer/utils/hlsBufferPolicy.js';

test('smooth VOD keeps a useful buffer without the old 160 MB floor', () => {
  const policy = resolveHlsBufferPolicy({ smoothStreaming: true, deviceMemory: 8 });
  assert.equal(policy.maxBufferLength, 60);
  assert.equal(policy.maxMaxBufferLength, 120);
  assert.equal(policy.bufferBudgetMB, 96);
});

test('low-memory devices use a bounded smooth playback policy', () => {
  const policy = resolveHlsBufferPolicy({ smoothStreaming: true, deviceMemory: 4 });
  assert.equal(policy.constrained, true);
  assert.equal(policy.maxBufferLength, 36);
  assert.equal(policy.bufferBudgetMB, 48);
});

test('live playlists do not accumulate VOD-sized buffers', () => {
  const policy = resolveHlsBufferPolicy({ smoothStreaming: true, live: true, deviceMemory: 8 });
  assert.equal(policy.maxBufferLength, 18);
  assert.equal(policy.maxMaxBufferLength, 36);
  assert.equal(policy.bufferBudgetMB, 48);
});

test('high-bitrate VOD can grow within a hard memory ceiling', () => {
  const policy = resolveHlsBufferPolicy({
    smoothStreaming: true,
    deviceMemory: 16,
    bitrate: 12_000_000
  });
  assert.equal(policy.bufferBudgetMB, 116);
  assert.ok(policy.bufferBudgetMB <= 128);
});
