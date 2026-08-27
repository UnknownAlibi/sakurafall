import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  canUseWebgpuAnime4k,
  getWebgpuAnime4kCapabilities,
  normalizeWebgpuAnime4kPreset,
  resolveWebgpuAnime4kProfile
} from '../src/renderer/player/anime4kWebgpuClient.js';

test('WebGPU Anime4K capability probe requires every frame-transfer primitive', () => {
  class Canvas {}
  Canvas.prototype.transferControlToOffscreen = () => ({});
  const complete = {
    navigator: { gpu: {} },
    Worker: function Worker() {},
    OffscreenCanvas: function OffscreenCanvas() {},
    VideoFrame: function VideoFrame() {},
    HTMLCanvasElement: Canvas
  };
  assert.deepEqual(getWebgpuAnime4kCapabilities(complete), {
    webgpu: true,
    worker: true,
    offscreenCanvas: true,
    videoFrame: true
  });
  assert.equal(canUseWebgpuAnime4k(complete), true);
  assert.equal(canUseWebgpuAnime4k({ ...complete, VideoFrame: undefined }), false);
});

test('WebGPU profile uses x2 CNN only when the doubled output fits the realtime budget', () => {
  assert.deepEqual(resolveWebgpuAnime4kProfile({
    preset: 'balanced',
    inputWidth: 960,
    inputHeight: 540,
    displayWidth: 1920,
    displayHeight: 1080
  }), {
    requestedPreset: 'balanced',
    effectivePreset: 'balanced',
    pipeline: 'CNNx2M',
    upscale: 2
  });
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'balanced',
    inputWidth: 1280,
    inputHeight: 720,
    displayWidth: 1920,
    displayHeight: 1080
  }).pipeline, 'CNNM');
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'light',
    inputWidth: 960,
    inputHeight: 540,
    displayWidth: 1920,
    displayHeight: 1080
  }).pipeline, 'CNNSoftM');
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'quality',
    inputWidth: 1280,
    inputHeight: 720,
    displayWidth: 1920,
    displayHeight: 1080
  }).pipeline, 'CNNVL');
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'quality',
    inputWidth: 960,
    inputHeight: 540,
    displayWidth: 1920,
    displayHeight: 1080
  }).pipeline, 'CNNx2VL');
});

test('WebGPU profile restores 1080p without allocating a 4K CNN output', () => {
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'quality',
    inputWidth: 1920,
    inputHeight: 1080,
    displayWidth: 3840,
    displayHeight: 2160
  }).pipeline, 'CNNVL');
  assert.equal(normalizeWebgpuAnime4kPreset('unknown'), 'balanced');
});

test('WebGPU worker prewarms shaders and guards its one-frame mailbox', () => {
  const worker = fs.readFileSync(new URL('../src/renderer/player/anime4kWebgpu.worker.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../src/renderer/player/anime4kWebgpuClient.js', import.meta.url), 'utf8');
  assert.match(client, /transferControlToOffscreen/);
  assert.match(client, /new globalThis\.VideoFrame/);
  assert.match(client, /this\.busy/);
  assert.match(client, /\[frame\]/);
  assert.match(worker, /copyExternalImageToTexture/);
  assert.match(worker, /warmupPipeline/);
  assert.match(worker, /CNN 实时性能不足/);
  assert.match(worker, /onSubmittedWorkDone/);
  assert.match(worker, /Anime4K 单帧渲染/);
  assert.match(client, /armFrameTimeout/);
  assert.match(worker, /frame\.close\(\)/);
  assert.match(worker, /inputTexture\?\.destroy/);
  assert.match(worker, /device\?\.destroy/);
  assert.match(client, /setTimeout\(\(\) => worker\.terminate\(\), 200\)/);
});
