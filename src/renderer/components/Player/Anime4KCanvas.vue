<template>
  <canvas
    v-show="active"
    :key="canvasEpoch"
    ref="canvas"
    class="anime4k-canvas"
    aria-hidden="true"
  ></canvas>
</template>

<script>
import { createAnime4kPipeline } from '../../player/anime4kWebgl.js';
import {
  canUseWebgpuAnime4k,
  createAnime4kWebgpuPipeline
} from '../../player/anime4kWebgpuClient.js';

const MAX_VIDEO_EDGE = 1920;
const WEBGL_SLOW_FRAME_MS = 22;
const WEBGPU_SLOW_FRAME_MS = 34;
const WEBGPU_HARD_FRAME_MS = 100;
const WEBGPU_CALLBACK_STALL_MS = 450;
const PERF_WINDOW = 90;
const CALLBACK_LAG_MS = 240;
const MEDIA_JUMP_SECONDS = 0.18;

function lowerPreset(preset) {
  if (preset === 'quality') return 'balanced';
  if (preset === 'balanced') return 'light';
  return '';
}

export default {
  name: 'Anime4KCanvas',
  props: {
    enabled: { type: Boolean, default: false },
    preset: { type: String, default: 'balanced' }
  },
  emits: ['status-change', 'auto-disabled'],
  data() {
    return {
      active: false,
      canvasEpoch: 0
    };
  },
  watch: {
    enabled(value) {
      if (value) this.start();
      else this.stop();
    },
    preset() {
      this._runtimePresetOverride = '';
      if (this.enabled) this.restart();
    }
  },
  mounted() {
    this._lifecycleGeneration = 0;
    this._canvasTransferred = false;
    this._fullscreenHandler = () => {
      const shouldChangeBackend = (this.backend === 'webgl' && this.isFullscreen()) ||
        (this.fullscreenSafeMode && !this.isFullscreen());
      if (shouldChangeBackend) this.restart();
      else this.syncDisplaySize();
    };
    document.addEventListener('fullscreenchange', this._fullscreenHandler);
    if (this.enabled) this.start();
  },
  beforeUnmount() {
    document.removeEventListener('fullscreenchange', this._fullscreenHandler);
    this._fullscreenHandler = null;
    this.stop();
  },
  methods: {
    findVideo() {
      const root = this.$el?.parentElement;
      return root ? root.querySelector('video.video-element') : null;
    },
    notify(title, message) {
      try { this.$notify?.warning(title, message); } catch (_) { /* notifications must not break playback */ }
    },
    isFullscreen() {
      return !!document.fullscreenElement;
    },
    async ensureWritableCanvas() {
      if (!this._canvasTransferred) return this.$refs.canvas;
      this.canvasEpoch += 1;
      this._canvasTransferred = false;
      await this.$nextTick();
      return this.$refs.canvas;
    },
    startFullscreenSafeMode(reason = '') {
      if (!this.video) return;
      this.backend = 'fullscreen-safe';
      this.fullscreenSafeMode = true;
      this.video.classList.add('anime4k-fullscreen-safe');
      this.active = false;
      this.emitStatus({ fallbackReason: reason });
    },
    buildStatus(extra = {}) {
      if (!this.video) return { active: false };
      if (this.fullscreenSafeMode) {
        return {
          active: true,
          backend: 'css',
          mode: 'fullscreen-safe',
          preset: 'fullscreen-safe',
          requestedPreset: this.preset,
          adaptive: true,
          inputWidth: this.video.videoWidth || 0,
          inputHeight: this.video.videoHeight || 0,
          ...extra
        };
      }

      if (!this.active || !this.engine) return { active: false };
      const output = this.backend === 'webgpu'
        ? [this.engine.profile?.outputWidth || 0, this.engine.profile?.outputHeight || 0]
        : (this.engine.outputSize || [0, 0]);
      return {
        active: true,
        backend: this.backend === 'webgpu' ? 'webgpu-worker' : 'webgl-main',
        mode: this.backend === 'webgpu' ? 'webgpu-worker' : 'webgl',
        pipeline: this.engine.profile?.pipeline || '',
        preset: this.effectivePreset || this.preset,
        requestedPreset: this.preset,
        adaptive: (this.effectivePreset || this.preset) !== this.preset,
        passthrough: !!this.passthrough,
        inputWidth: this.video.videoWidth || 0,
        inputHeight: this.video.videoHeight || 0,
        outputWidth: output[0] || 0,
        outputHeight: output[1] || 0,
        renderMs: this.perfEma || 0,
        renderedFrames: this.engine.renderedFrames || 0,
        droppedFrames: this.engine.droppedFrames || 0,
        ...extra
      };
    },
    emitStatus(extra = {}) {
      const status = this.buildStatus(extra);
      const key = JSON.stringify(status);
      if (key === this._lastStatusKey) return;
      this._lastStatusKey = key;
      this.$emit('status-change', status);
    },
    syncDisplaySize() {
      const target = this.$el?.parentElement;
      if (!target || !this.engine) return;
      this.engine.setDisplaySize?.(target.clientWidth, target.clientHeight, window.devicePixelRatio || 1);
      this.emitStatus();
    },
    setupResizeTracking() {
      this.cleanupResizeTracking();
      const target = this.$el?.parentElement;
      if (!target || !this.engine) return;
      const sync = () => this.syncDisplaySize();
      if (typeof ResizeObserver === 'function') {
        this._resizeObserver = new ResizeObserver(sync);
        this._resizeObserver.observe(target);
      }
      this._windowResizeHandler = sync;
      window.addEventListener('resize', sync, { passive: true });
      sync();
    },
    cleanupResizeTracking() {
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;
      if (this._windowResizeHandler) {
        window.removeEventListener('resize', this._windowResizeHandler);
        this._windowResizeHandler = null;
      }
    },
    async createWebgpuBackend(canvas, video, generation) {
      if (!canUseWebgpuAnime4k()) throw new Error('当前 Electron 不支持完整的 WebGPU Worker 视频管线');
      const target = canvas.parentElement;
      this._canvasTransferred = true;
      const requestedPreset = this._runtimePresetOverride || this.preset;
      return createAnime4kWebgpuPipeline(canvas, {
        preset: requestedPreset,
        inputWidth: video.videoWidth,
        inputHeight: video.videoHeight,
        displayWidth: target?.clientWidth || video.videoWidth,
        displayHeight: target?.clientHeight || video.videoHeight,
        pixelRatio: window.devicePixelRatio || 1,
        maxOutputEdge: 1920,
        onStats: (stats) => {
          if (generation !== this._lifecycleGeneration || this.backend !== 'webgpu') return;
          this.perfEma = this.perfEma ? this.perfEma * 0.92 + stats.renderMs * 0.08 : stats.renderMs;
          this.perfFrames += 1;
          if (stats.renderedFrames <= 2 && stats.renderMs > WEBGPU_HARD_FRAME_MS) {
            this.handleWebgpuFailure(new Error(`CNN 实时性能不足（${stats.renderMs.toFixed(0)}ms/帧）`));
            return;
          }
          if (this.perfFrames % 30 === 0) this.emitStatus();
          if (this.perfFrames >= PERF_WINDOW && this.perfEma > WEBGPU_SLOW_FRAME_MS) this.handleSlowWebgpu();
        },
        onFatal: (error) => {
          if (generation === this._lifecycleGeneration) this.handleWebgpuFailure(error);
        }
      });
    },
    async createWebglBackend(canvas, video) {
      this.passthrough = localStorage.getItem('player-anime4k-debug') === 'passthrough';
      return createAnime4kPipeline(canvas, this._runtimePresetOverride || this.preset, {
        passthrough: this.passthrough,
        inputWidth: video.videoWidth,
        inputHeight: video.videoHeight,
        maxOutputEdge: 1920
      });
    },
    async start() {
      const generation = ++this._lifecycleGeneration;
      this.cleanupRuntime();
      if (!this.enabled) return;
      const canvas = await this.ensureWritableCanvas();
      if (generation !== this._lifecycleGeneration || !this.enabled) return;
      const video = this.findVideo();
      if (!video) return;
      this.video = video;

      if (!video.videoWidth || !video.videoHeight) {
        this._metadataHandler = () => {
          this._metadataHandler = null;
          if (this.enabled && generation === this._lifecycleGeneration) this.restart();
        };
        video.addEventListener('loadedmetadata', this._metadataHandler, { once: true });
        return;
      }
      if (video.videoWidth > MAX_VIDEO_EDGE || video.videoHeight > MAX_VIDEO_EDGE) {
        this.notify('超分未启用', `当前源为 ${video.videoWidth}x${video.videoHeight}，原始分辨率已经较高`);
        this.$emit('auto-disabled', 'resolution');
        return;
      }

      let webgpuError = this._skipWebgpuOnce && this._webgpuFallbackReason
        ? new Error(this._webgpuFallbackReason)
        : null;
      let engine = null;
      let backend = '';
      let effectivePreset = '';
      if (!this._skipWebgpuOnce) {
        try {
          engine = await this.createWebgpuBackend(canvas, video, generation);
          backend = 'webgpu';
          effectivePreset = engine.profile?.effectivePreset || this._runtimePresetOverride || this.preset;
        } catch (error) {
          webgpuError = error;
        }
      }
      this._skipWebgpuOnce = false;
      this._webgpuFallbackReason = '';

      if (!this.enabled || generation !== this._lifecycleGeneration) {
        engine?.dispose?.();
        return;
      }
      if (!engine) {
        if (this.isFullscreen()) {
          this.startFullscreenSafeMode(webgpuError?.message || 'WebGPU Worker 不可用');
          return;
        }
        const fallbackCanvas = await this.ensureWritableCanvas();
        if (generation !== this._lifecycleGeneration || !this.enabled) return;
        try {
          engine = await this.createWebglBackend(fallbackCanvas, video);
          backend = 'webgl';
          effectivePreset = engine.effectivePreset || this._runtimePresetOverride || this.preset;
        } catch (error) {
          const reason = webgpuError?.message || error?.message || 'GPU 渲染不可用';
          this.notify('超分不可用', reason);
          this.$emit('auto-disabled', 'unsupported');
          return;
        }
      }

      if (!this.enabled || generation !== this._lifecycleGeneration) {
        engine?.dispose?.();
        return;
      }

      this.engine = engine;
      this.backend = backend;
      this.effectivePreset = effectivePreset;
      this.active = true;
      this.perfEma = 0;
      this.perfFrames = 0;
      this.lastCallbackAt = 0;
      this.lastMediaTime = 0;
      await this.$nextTick();
      if (!this.engine || !this.enabled) return;
      this.setupResizeTracking();
      if (backend === 'webgpu') this.setupWebgpuPlaybackWatchdog();
      this.emitStatus(webgpuError ? { recoveredFrom: 'webgpu' } : {});
      if (video.readyState >= 2) this.onFrame();
      else this.scheduleNext();
    },
    cleanupRuntime() {
      if (this._rvfcId != null && this.video?.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._rvfcId);
      this._rvfcId = null;
      if (this._rafId != null) cancelAnimationFrame(this._rafId);
      this._rafId = null;
      if (this._metadataHandler && this.video) this.video.removeEventListener('loadedmetadata', this._metadataHandler);
      this._metadataHandler = null;
      this.cleanupResizeTracking();
      if (this._webgpuWatchdogId != null) clearInterval(this._webgpuWatchdogId);
      this._webgpuWatchdogId = null;
      if (this.engine) {
        try { this.engine.dispose?.(); } catch (_) { /* GPU context may already be gone */ }
      }
      this.engine = null;
      this.video?.classList.remove('anime4k-fullscreen-safe');
      this.fullscreenSafeMode = false;
      this.backend = '';
      this.active = false;
      this._lastStatusKey = '';
    },
    stop() {
      this._lifecycleGeneration += 1;
      const wasActive = this.active || this.fullscreenSafeMode;
      this.cleanupRuntime();
      this.video = null;
      this.effectivePreset = '';
      if (wasActive) this.$emit('status-change', { active: false });
    },
    async restart() {
      this.stop();
      if (this.enabled) await this.start();
    },
    scheduleNext() {
      if (!this.enabled || !this.engine || !this.video) return;
      if (typeof this.video.requestVideoFrameCallback === 'function') {
        this._rvfcId = this.video.requestVideoFrameCallback((now, metadata) => this.onFrame(now, metadata));
      } else {
        this._rafId = requestAnimationFrame(() => this.onFrame());
      }
    },
    setupWebgpuPlaybackWatchdog() {
      if (this._webgpuWatchdogId != null) clearInterval(this._webgpuWatchdogId);
      this.lastCallbackAt = performance.now();
      this._webgpuWatchdogId = setInterval(() => {
        if (!this.enabled || this.backend !== 'webgpu' || !this.video || this.video.paused || this.video.seeking) {
          this.lastCallbackAt = performance.now();
          return;
        }
        if (performance.now() - this.lastCallbackAt > WEBGPU_CALLBACK_STALL_MS) {
          this.handleWebgpuFailure(new Error('CNN 阻塞了视频解码帧'));
        }
      }, 100);
    },
    onFrame(now = performance.now(), metadata = null) {
      if (!this.enabled || !this.engine || !this.video) return;
      const video = this.video;
      if (this.backend === 'webgpu') {
        this.lastCallbackAt = now;
        this.engine.renderFrame(video, metadata);
        this.scheduleNext();
        return;
      }

      const mediaTime = Number(metadata?.mediaTime);
      const callbackGap = this.lastCallbackAt ? now - this.lastCallbackAt : 0;
      const mediaJump = Number.isFinite(mediaTime) && this.lastMediaTime ? mediaTime - this.lastMediaTime : 0;
      this.lastCallbackAt = now;
      if (Number.isFinite(mediaTime)) this.lastMediaTime = mediaTime;
      if (!video.paused && callbackGap > CALLBACK_LAG_MS && mediaJump > MEDIA_JUMP_SECONDS) {
        this.handleTerminalFailure('frame-lag', '主线程 WebGL 增强跟不上视频帧率');
        return;
      }
      if (video.readyState >= 2) {
        try {
          const cost = this.engine.renderFrame(video);
          this.perfEma = this.perfEma ? this.perfEma * 0.92 + cost * 0.08 : cost;
          this.perfFrames += 1;
          if (this.perfFrames >= PERF_WINDOW && this.perfEma > WEBGL_SLOW_FRAME_MS) {
            this.handleTerminalFailure('performance', `主线程 WebGL 平均耗时 ${this.perfEma.toFixed(1)}ms/帧`);
            return;
          }
        } catch (error) {
          this.handleTerminalFailure('error', error?.message || 'WebGL 渲染异常');
          return;
        }
      }
      this.scheduleNext();
    },
    handleSlowWebgpu() {
      if (this._handlingBackendFailure) return;
      const nextPreset = lowerPreset(this.effectivePreset || this.preset);
      if (nextPreset) {
        this._handlingBackendFailure = true;
        this._runtimePresetOverride = nextPreset;
        this.notify('增强已自动调节', `GPU 实时耗时偏高，已切换到${nextPreset === 'light' ? '轻量' : '均衡'}档`);
        this.restart().finally(() => { this._handlingBackendFailure = false; });
        return;
      }
      this.handleTerminalFailure('performance', `WebGPU 平均耗时 ${this.perfEma.toFixed(1)}ms/帧`);
    },
    handleWebgpuFailure(error) {
      if (this._handlingBackendFailure) return;
      this._handlingBackendFailure = true;
      this._skipWebgpuOnce = true;
      this._webgpuFallbackReason = error?.message || 'Worker 渲染异常';
      this.notify('WebGPU 已降级', `${error?.message || 'Worker 渲染异常'}，正在切换兼容模式`);
      this.restart().finally(() => { this._handlingBackendFailure = false; });
    },
    handleTerminalFailure(reason, message) {
      this.stop();
      this.notify('超分已停用', `${message}，已切回原生视频以保证播放流畅`);
      this.$emit('auto-disabled', reason);
    }
  }
};
</script>

<style scoped>
.anime4k-canvas {
  position: absolute;
  inset: 0;
  z-index: 5;
  width: 100%;
  height: 100%;
  background: #000;
  pointer-events: none;
}

:global(.video-element.anime4k-fullscreen-safe) {
  filter: contrast(1.055) saturate(1.035) brightness(1.01);
}
</style>
