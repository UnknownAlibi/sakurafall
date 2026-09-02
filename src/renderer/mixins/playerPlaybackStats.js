import { estimateSourceFrameRate } from '../utils/playbackFrameRate.js';

export default {
  methods: {
    readDecodedFrameCount(video) {
      const quality = video?.getVideoPlaybackQuality?.();
      if (Number.isFinite(quality?.totalVideoFrames)) {
        this.playbackTotalFrames = Number(quality.totalVideoFrames) || 0;
        this.playbackDroppedFrames = Number(quality.droppedVideoFrames) || 0;
        return quality.totalVideoFrames;
      }
      return Number.isFinite(video?.webkitDecodedFrameCount) ? video.webkitDecodedFrameCount : null;
    },

    samplePlaybackStats(resetBaseline = false) {
      const video = this.$refs.videoElement;
      if (!video) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        this.playbackWidth = video.videoWidth;
        this.playbackHeight = video.videoHeight;
      }

      const totalFrames = this.readDecodedFrameCount(video);
      const sampledAt = performance.now();
      if (resetBaseline || !Number.isFinite(totalFrames) || !Number.isFinite(this._statsLastFrames)) {
        this._statsLastFrames = totalFrames;
        this._statsLastSampleAt = sampledAt;
        return;
      }

      const frameDelta = totalFrames - this._statsLastFrames;
      const elapsedSeconds = (sampledAt - this._statsLastSampleAt) / 1000;
      if (elapsedSeconds < 1.8) return;
      this._statsLastFrames = totalFrames;
      this._statsLastSampleAt = sampledAt;
      if (video.paused || frameDelta <= 0 || elapsedSeconds > 5) return;

      const measuredFps = frameDelta / elapsedSeconds / Math.max(0.1, Number(video.playbackRate) || 1);
      if (measuredFps < 1 || measuredFps > 240) return;
      const smoothedFps = this.playbackDecodedFps > 0
        ? this.playbackDecodedFps * 0.7 + measuredFps * 0.3
        : measuredFps;
      this.playbackDecodedFps = Math.round(smoothedFps * 10) / 10;

      if (this.sourceFrameRateOrigin !== 'manifest' && !this.sourceFrameRate) {
        this.frameRateSamples = [...this.frameRateSamples.slice(-7), measuredFps];
        const estimatedRate = estimateSourceFrameRate(this.frameRateSamples);
        if (estimatedRate) {
          this.sourceFrameRate = estimatedRate;
          this.sourceFrameRateOrigin = 'estimated';
        }
      }
    },

    startPlaybackStats() {
      this.stopPlaybackStats();
      this.samplePlaybackStats(true);
      this._playbackStatsTimer = setInterval(() => this.samplePlaybackStats(), 1000);
    },

    stopPlaybackStats(reset = false) {
      if (this._playbackStatsTimer) {
        clearInterval(this._playbackStatsTimer);
        this._playbackStatsTimer = null;
      }
      this._statsLastFrames = null;
      this._statsLastSampleAt = 0;
      if (reset) {
        this.playbackWidth = 0;
        this.playbackHeight = 0;
        this.sourceFrameRate = 0;
        this.sourceFrameRateOrigin = '';
        this.playbackDecodedFps = 0;
        this.playbackTotalFrames = 0;
        this.playbackDroppedFrames = 0;
        this.frameRateSamples = [];
      }
    }
  }
};
