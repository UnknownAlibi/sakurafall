const SUPPORTED_PRESETS = new Set(['light', 'balanced', 'quality']);
const FRAME_TIMEOUT_MS = 1800;

export function normalizeWebgpuAnime4kPreset(preset) {
  return SUPPORTED_PRESETS.has(preset) ? preset : 'balanced';
}

export function resolveWebgpuAnime4kProfile({
  preset = 'balanced',
  inputWidth = 0,
  inputHeight = 0,
  displayWidth = 0,
  displayHeight = 0
} = {}) {
  const requestedPreset = normalizeWebgpuAnime4kPreset(preset);
  const inputEdge = Math.max(Number(inputWidth) || 0, Number(inputHeight) || 0);
  const scale = Math.max(
    (Number(displayWidth) || inputWidth || 1) / Math.max(1, Number(inputWidth) || 1),
    (Number(displayHeight) || inputHeight || 1) / Math.max(1, Number(inputHeight) || 1)
  );
  // A 720p source needs a 2560px CNN intermediate for genuine x2 reconstruction.
  // The presentation canvas remains capped separately; the worker benchmark
  // rejects hardware that cannot sustain this pipeline in real time.
  const shouldUpscale = requestedPreset !== 'light' && inputEdge * 2 <= 2560 && scale > 1.08;

  if (shouldUpscale) {
    return {
      requestedPreset,
      effectivePreset: requestedPreset,
      pipeline: requestedPreset === 'quality' ? 'CNNx2VL' : 'CNNx2M',
      upscale: 2
    };
  }

  return {
    requestedPreset,
    effectivePreset: requestedPreset,
    pipeline: requestedPreset === 'quality' ? 'CNNVL' : (requestedPreset === 'balanced' ? 'CNNM' : 'CNNSoftM'),
    upscale: 1
  };
}

export function getWebgpuAnime4kCapabilities(scope = globalThis) {
  const canvasPrototype = scope.HTMLCanvasElement?.prototype;
  return {
    webgpu: !!scope.navigator?.gpu,
    worker: typeof scope.Worker === 'function',
    offscreenCanvas: typeof scope.OffscreenCanvas === 'function' &&
      typeof canvasPrototype?.transferControlToOffscreen === 'function',
    videoFrame: typeof scope.VideoFrame === 'function'
  };
}

export function canUseWebgpuAnime4k(scope = globalThis) {
  const capabilities = getWebgpuAnime4kCapabilities(scope);
  return Object.values(capabilities).every(Boolean);
}

function resolveOutputSize(width, height, pixelRatio = 1, maxOutputEdge = 1920) {
  let outputWidth = Math.max(1, Math.round((Number(width) || 1) * Math.min(2, Math.max(1, Number(pixelRatio) || 1))));
  let outputHeight = Math.max(1, Math.round((Number(height) || 1) * Math.min(2, Math.max(1, Number(pixelRatio) || 1))));
  const scale = Math.min(1, maxOutputEdge / Math.max(outputWidth, outputHeight));
  outputWidth = Math.max(1, Math.round(outputWidth * scale));
  outputHeight = Math.max(1, Math.round(outputHeight * scale));
  return [outputWidth, outputHeight];
}

export class Anime4kWebgpuClient {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.disposed = false;
    this.frameSequence = 0;
    this.droppedFrames = 0;
    this.renderedFrames = 0;
    this.profile = null;
    this.pendingFrameId = 0;
    this.frameTimeoutId = null;
  }

  async initialize() {
    if (!canUseWebgpuAnime4k()) {
      const missing = Object.entries(getWebgpuAnime4kCapabilities())
        .filter(([, available]) => !available)
        .map(([name]) => name)
        .join(', ');
      throw new Error(`WebGPU Worker 能力不完整：${missing || 'unknown'}`);
    }

    const offscreenCanvas = this.canvas.transferControlToOffscreen();
    const displayWidth = this.options.displayWidth || this.canvas.clientWidth || this.options.inputWidth;
    const displayHeight = this.options.displayHeight || this.canvas.clientHeight || this.options.inputHeight;
    this.profile = resolveWebgpuAnime4kProfile({ ...this.options, displayWidth, displayHeight });
    const [outputWidth, outputHeight] = resolveOutputSize(
      displayWidth,
      displayHeight,
      this.options.pixelRatio,
      this.options.maxOutputEdge
    );

    this.worker = new Worker(new URL('./anime4kWebgpu.worker.js', import.meta.url), { type: 'module' });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebGPU Worker 初始化超时')), 15000);
      const fail = (error) => {
        clearTimeout(timeout);
        const normalized = error instanceof Error ? error : new Error(String(error?.message || error || 'Worker 初始化失败'));
        if (this.ready) this.options.onFatal?.(normalized);
        else reject(normalized);
      };
      this.worker.onerror = fail;
      this.worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.ready = true;
          this.profile = { ...this.profile, ...message.profile };
          this.options.onReady?.(message);
          resolve();
          return;
        }
        if (message.type === 'frame-complete') {
          if (message.id !== this.pendingFrameId) return;
          this.clearFrameTimeout();
          this.busy = false;
          this.renderedFrames += 1;
          this.options.onStats?.({
            renderMs: message.renderMs,
            renderedFrames: this.renderedFrames,
            droppedFrames: this.droppedFrames
          });
          return;
        }
        if (message.type === 'fatal') {
          this.clearFrameTimeout();
          this.busy = false;
          const error = new Error(message.message || 'WebGPU Worker 异常');
          if (!this.ready) fail(error);
          else this.options.onFatal?.(error);
        }
      };
      this.worker.postMessage({
        type: 'initialize',
        canvas: offscreenCanvas,
        inputWidth: this.options.inputWidth,
        inputHeight: this.options.inputHeight,
        outputWidth,
        outputHeight,
        profile: this.profile
      }, [offscreenCanvas]);
    });
    return this;
  }

  setDisplaySize(width, height, pixelRatio = 1) {
    if (!this.ready || this.disposed) return;
    const [outputWidth, outputHeight] = resolveOutputSize(width, height, pixelRatio, this.options.maxOutputEdge);
    this.worker.postMessage({ type: 'resize', outputWidth, outputHeight });
  }

  clearFrameTimeout() {
    if (this.frameTimeoutId != null) clearTimeout(this.frameTimeoutId);
    this.frameTimeoutId = null;
  }

  armFrameTimeout(frameId) {
    this.clearFrameTimeout();
    this.frameTimeoutId = setTimeout(() => {
      if (this.disposed || !this.busy || this.pendingFrameId !== frameId) return;
      this.busy = false;
      this.options.onFatal?.(new Error('Anime4K GPU 帧响应超时'));
    }, FRAME_TIMEOUT_MS);
  }

  renderFrame(source, metadata = null) {
    const isVideo = typeof globalThis.HTMLVideoElement === 'function' && source instanceof globalThis.HTMLVideoElement;
    if (!this.ready || this.disposed || this.busy || !source || (isVideo && source.readyState < 2)) {
      if (this.busy) this.droppedFrames += 1;
      return false;
    }

    this.busy = true;
    this.frameSequence += 1;
    this.pendingFrameId = this.frameSequence;
    let frame;
    try {
      const mediaTime = Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : (Number(source.currentTime) || 0);
      frame = new globalThis.VideoFrame(source, { timestamp: Math.round(mediaTime * 1_000_000) });
      this.worker.postMessage({ type: 'frame', id: this.frameSequence, frame }, [frame]);
      this.armFrameTimeout(this.frameSequence);
      return true;
    } catch (error) {
      this.busy = false;
      try { frame?.close(); } catch (_) { /* transfer may already own the frame */ }
      this.options.onFatal?.(error);
      return false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFrameTimeout();
    this.ready = false;
    this.busy = false;
    const worker = this.worker;
    try { worker?.postMessage({ type: 'dispose' }); } catch (_) { /* worker may already be gone */ }
    // Give the worker a short window to unconfigure the canvas and destroy the
    // GPUDevice. Immediate terminate skips its cleanup handler and retains large
    // driver allocations until Chromium eventually trims the GPU process.
    if (worker) setTimeout(() => worker.terminate(), 200);
    this.worker = null;
  }
}

export async function createAnime4kWebgpuPipeline(canvas, options) {
  const client = new Anime4kWebgpuClient(canvas, options);
  try {
    return await client.initialize();
  } catch (error) {
    client.dispose();
    throw error;
  }
}
