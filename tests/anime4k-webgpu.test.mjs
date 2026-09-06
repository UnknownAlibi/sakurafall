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

test('WebGPU profile reserves balanced x2 CNN for SD and protects 720p decoding', () => {
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
    upscale: 2,
    frameBudgetMs: 35
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
  }).pipeline, 'CNNx2M');
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'quality',
    inputWidth: 960,
    inputHeight: 540,
    displayWidth: 1920,
    displayHeight: 1080
  }).pipeline, 'CNNx2M');
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

test('WebGPU worker reports stage timings and the client tracks frame-rate health', () => {
  const worker = fs.readFileSync(new URL('../src/renderer/player/anime4kWebgpu.worker.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../src/renderer/player/anime4kWebgpuClient.js', import.meta.url), 'utf8');
  // Init-phase timing: adapter/device/pipeline/warmup breakdown reaches the UI.
  assert.match(worker, /initTimes/);
  assert.match(worker, /adapterMs/);
  assert.match(worker, /deviceMs/);
  assert.match(worker, /pipelineMs/);
  assert.match(worker, /warmupMs/);
  assert.match(worker, /totalMs/);
  // Per-frame timing: upload/encode/GPU wait breakdown on every frame-complete.
  assert.match(worker, /stageMs/);
  assert.match(worker, /uploadMs/);
  assert.match(worker, /encodeMs/);
  assert.match(worker, /gpuMs/);
  assert.match(client, /stageMs: message\.stageMs/);
  // Frame-rate health metrics: frame age, fps EMA and drop rate.
  assert.match(client, /frameAgeMs/);
  assert.match(client, /fpsEma/);
  assert.match(client, /dropRate/);
  const canvas = fs.readFileSync(new URL('../src/renderer/components/Player/Anime4KCanvas.vue', import.meta.url), 'utf8');
  assert.match(canvas, /perfStageEma/);
  assert.match(canvas, /fps: this\.backend === 'webgpu'/);
  assert.match(canvas, /frameAgeMs/);
  assert.match(canvas, /dropRate/);
});

test('WebGPU frame budget adapts to source frame rate and init failures downgrade before giving up', () => {
  // Budget scales with source fps: 24 fps -> 35 ms, 30 fps -> 28 ms, floor 16 ms.
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'balanced', inputWidth: 960, inputHeight: 540,
    displayWidth: 1920, displayHeight: 1080, inputFps: 24
  }).frameBudgetMs, 35);
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'balanced', inputWidth: 960, inputHeight: 540,
    displayWidth: 1920, displayHeight: 1080, inputFps: 30
  }).frameBudgetMs, 28);
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'balanced', inputWidth: 960, inputHeight: 540,
    displayWidth: 1920, displayHeight: 1080, inputFps: 60
  }).frameBudgetMs, 16);
  // Missing/invalid fps falls back to the 24 fps default budget.
  assert.equal(resolveWebgpuAnime4kProfile({
    preset: 'balanced', inputWidth: 960, inputHeight: 540,
    displayWidth: 1920, displayHeight: 1080, inputFps: 0
  }).frameBudgetMs, 35);

  const worker = fs.readFileSync(new URL('../src/renderer/player/anime4kWebgpu.worker.js', import.meta.url), 'utf8');
  // The worker benchmark must honor the propagated budget instead of a fixed 36 ms.
  assert.match(worker, /frameBudgetMs/);
  assert.match(worker, /message\.profile\?\.frameBudgetMs/);

  const canvas = fs.readFileSync(new URL('../src/renderer/components/Player/Anime4KCanvas.vue', import.meta.url), 'utf8');
  // Source fps is estimated from media-time deltas and feeds the init budget.
  assert.match(canvas, /sourceFpsEstimate/);
  assert.match(canvas, /inputFps: this\.sourceFpsEstimate/);
  // Runtime slow-frame threshold scales with the estimated fps, not a constant.
  assert.match(canvas, /webgpuSlowFrameThreshold\(\)/);
  // Init-time benchmark rejection retries lower presets before display-safe mode.
  assert.match(canvas, /实时性能不足/);
  assert.match(canvas, /lowerPreset\(candidate\)/);
});

test('Anime4K canvas restarts by source and only shows after a verified frame', () => {
  const source = fs.readFileSync(new URL('../src/renderer/components/Player/Anime4KCanvas.vue', import.meta.url), 'utf8');
  assert.match(source, /sourceKey/);
  assert.match(source, /v-show="showCanvas"/);
  assert.match(source, /if \(!this\.presenting\)/);
});
