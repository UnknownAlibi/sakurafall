// Episode DNA P1：被动特征采集器
//
// 播放前几分钟内以 2Hz 低频采样：
//   - 音频 RMS 能量（经 WebAudio AnalyserNode，路由失败自动降级为仅画面）
//   - 画面平均亮度（32x18 缩略图，跨域受限时自动降级为仅音频）
// 采集完成后交给 Worker 分析（episodeDnaClient），不在主线程做重计算。
//
// 注意：captureStream() 会让 Chromium 把视频元素置为"捕获"状态——被捕获的
// 元素不能丢弃迟到帧，每帧都要克隆给流。因此增强开启时以 allowCaptureStream:
// false 启动，降级为仅画面采样（2Hz 的 32x18 drawImage 是拉取式复制，开销可
// 忽略，不影响解码）。
//
// 归因订正（2026-09-06）：这里曾把 captureStream 写成"开启 CNN 后解码停摆"
// 的根因，该结论不成立。13:38 的打包探针所用的 app.asar（13:26 构建）已包含
// allowCaptureStream 修复，停滞照样复现；真正的成因是增强画布完全不透明地
// 盖住 video，合成器剔除了被覆盖的 video 图层，解码器收不到帧释放信号。
// 修复见 Anime4KCanvas.vue 的 opacity 说明。本开关作为降低每帧额外克隆开销
// 的防御性措施保留，不再自称根因。

const FRAME_W = 32;
const FRAME_H = 18;

export class EpisodeDnaCollector {
  constructor(video, options = {}) {
    this.video = video;
    this.windowMs = Math.max(250, Number(options.windowMs) || 500);
    this.maxSeconds = Math.min(600, Math.max(60, Number(options.maxSeconds) || 240));
    this.timer = null;
    this.times = [];
    this.rms = null;     // Float32Array，音频路由失败时保持 null
    this.luma = null;    // Float32Array，画面采样失败时保持 null
    this.rmsSamples = [];
    this.lumaSamples = [];
    this.audioCtx = null;
    this.analyser = null;
    this.audioBuffer = null;
    this.canvas = null;
    this.ctx2d = null;
    this.audioFailed = false;
    this.videoFailed = false;
    this.allowCaptureStream = options.allowCaptureStream !== false;
    this.lastError = '';
    this.onDone = typeof options.onDone === 'function' ? options.onDone : null;
    this.notified = false;
  }

  start() {
    if (this.timer) return;
    this._initAudio();
    this._initCanvas();
    this.timer = setInterval(() => this._sample(), this.windowMs);
  }

  _initAudio() {
    if (!this.allowCaptureStream) {
      // 增强开启时禁止捕获流（见文件头注释）：降级为仅画面采样
      this.audioFailed = true;
      this.lastError = 'capture-stream-disabled';
      return;
    }
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) { this.audioFailed = true; return; }
      this.audioCtx = new AudioCtx();
      // 不使用 createMediaElementSource：它会把 video 的音频输出永久重定向到
      // WebAudio 图，AudioContext 关闭后视频将永久静音。captureStream 只复制
      // 音频轨用于分析，不影响元素自身播放。
      const stream = typeof this.video.captureStream === 'function'
        ? this.video.captureStream()
        : (typeof this.video.mozCaptureStream === 'function' ? this.video.mozCaptureStream() : null);
      if (!stream || stream.getAudioTracks().length === 0) {
        throw new Error('captureStream-unavailable');
      }
      this.capturedStream = stream;
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.audioBuffer = new Float32Array(this.analyser.fftSize);
      source.connect(this.analyser);
      this.streamSource = source;
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume?.().catch(() => {});
    } catch (error) {
      // 跨域或策略限制：降级为仅画面采样
      this.audioFailed = true;
      this.lastError = error?.message || 'audio-init-failed';
      this._closeAudio();
    }
  }

  _initCanvas() {
    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = FRAME_W;
      this.canvas.height = FRAME_H;
      this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: true });
    } catch (error) {
      this.videoFailed = true;
      this.lastError = error?.message || 'canvas-init-failed';
    }
  }

  _sample() {
    const video = this.video;
    if (!video || video.ended || !Number.isFinite(video.currentTime)) {
      this.stop();
      return;
    }
    if (video.currentTime > this.maxSeconds) {
      this.stop();
      return;
    }
    const t = video.currentTime;
    if (this.times.length > 0 && t - this.times[this.times.length - 1] < this.windowMs / 2000) {
      return; // 暂停/seek 未推进，避免重复窗口
    }
    this.times.push(t);

    if (this.analyser && !this.audioFailed) {
      try {
        this.analyser.getFloatTimeDomainData(this.audioBuffer);
        let sum = 0;
        for (let i = 0; i < this.audioBuffer.length; i++) {
          sum += this.audioBuffer[i] * this.audioBuffer[i];
        }
        this.rmsSamples.push(Math.sqrt(sum / this.audioBuffer.length));
      } catch (error) {
        this.audioFailed = true;
      }
    } else {
      this.rmsSamples.push(0);
    }

    if (this.ctx2d && !this.videoFailed && video.readyState >= 2) {
      try {
        this.ctx2d.drawImage(video, 0, 0, FRAME_W, FRAME_H);
        const data = this.ctx2d.getImageData(0, 0, FRAME_W, FRAME_H).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          total += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        }
        this.lumaSamples.push(total / (data.length / 4));
      } catch (error) {
        // 画布被跨域污染：降级为仅音频
        this.videoFailed = true;
      }
    } else {
      this.lumaSamples.push(0);
    }
  }

  /**
   * 停止采集并返回特征（音频/画面任一可用即返回，全失败返回 null）
   */
  // notify=false 用于切源/销毁场景的静默停止，不触发 onDone 回调
  stop(notify = true) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._closeAudio();
    if (!notify) {
      this.notified = true;
      return null;
    }
    const count = this.times.length;
    if (count < 20) {
      this._notify(null);
      return null;
    }
    const audioUsable = !this.audioFailed && this.rmsSamples.some(v => v > 0);
    const videoUsable = !this.videoFailed && this.lumaSamples.some(v => v > 0);
    if (!audioUsable && !videoUsable) {
      this._notify(null);
      return null;
    }
    const features = {
      windowMs: this.windowMs,
      times: Float32Array.from(this.times),
      rms: audioUsable ? Float32Array.from(this.rmsSamples) : null,
      luma: videoUsable ? Float32Array.from(this.lumaSamples) : null,
      degraded: { audio: !audioUsable, video: !videoUsable, lastError: this.lastError }
    };
    this._notify(features);
    return features;
  }

  _notify(features) {
    if (this.notified || !this.onDone) return;
    this.notified = true;
    try { this.onDone(features); } catch (_) { /* 回调异常不影响采集器 */ }
  }

  _closeAudio() {
    try {
      if (this.streamSource) this.streamSource.disconnect();
      if (this.analyser) this.analyser.disconnect();
      if (this.capturedStream) {
        for (const track of this.capturedStream.getTracks()) track.stop?.();
      }
      if (this.audioCtx) this.audioCtx.close();
    } catch (_) { /* ignore */ }
    this.streamSource = null;
    this.analyser = null;
    this.audioCtx = null;
    this.audioBuffer = null;
    this.capturedStream = null;
  }

  destroy() {
    this.stop(false);
    this.canvas = null;
    this.ctx2d = null;
  }
}
