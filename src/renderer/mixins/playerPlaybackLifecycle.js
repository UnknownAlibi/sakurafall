import {
  classifyHlsFailure,
  describeNativeVideoError,
  formatPlaybackFailureForDisplay
} from '../utils/playbackDiagnostics.js';
import { shouldAutoFallback } from '../utils/playbackFallbackPolicy.js';

export default {
  methods: {
    setPlaybackState(state) {
      this.playbackState = state;
      switch (state) {
        case 'idle':
          this.loading = false;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'resolving':
          this.loading = true;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'resolved':
          this.loading = true;
          break;
        case 'loading':
          this.loading = true;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'playing':
          this.loading = false;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'recovering':
          this.autoRecovering = true;
          this.error = null;
          this.loading = false;
          break;
        case 'failed':
          this.loading = false;
          this.autoRecovering = false;
          break;
        default:
          break;
      }
    },

    beginPlaybackTransition(reason = 'playback-transition') {
      const transitionToken = ++this.playbackTransitionToken;
      this.resolveRequestToken += 1;
      this.sourcePanelRequestToken += 1;
      this.fallbackRequestToken += 1;
      this.clearTrackedTimers();
      this.mediaLoadGeneration += 1;
      this.activeMediaGeneration = -1;
      this.activeMediaMode = '';
      this.activeMediaUrl = '';
      this.forceStopAndClean(reason);
      this.setPlaybackState('resolving');
      return transitionToken;
    },

    isPlaybackTransitionCurrent(transitionToken) {
      return transitionToken === this.playbackTransitionToken;
    },

    isCurrentMediaSession(mode = '') {
      return this.activeMediaGeneration === this.mediaLoadGeneration
        && (!mode || this.activeMediaMode === mode);
    },

    handleHLSError(data, Hls, hlsInstance = this.hls, generation = this.mediaLoadGeneration) {
      if (generation !== this.mediaLoadGeneration || this.hls !== hlsInstance) return;
      if (this.hlsRecoveryAttemptPending) return;
      this.clearPlaybackStartupWatchdog();
      this.hlsRecoveryAttemptPending = true;
      this.hlsErrorCount += 1;
      const exhausted = this.hlsErrorCount >= this.maxHlsRecoveryAttempts;

      const retry = (operation) => {
        const video = this.$refs.videoElement;
        const canKeepPresenting = !video?.error
          && video?.readyState >= 3
          && this.getBufferedAhead(video) >= 0.75;
        if (!canKeepPresenting) this.setPlaybackState('recovering');
        this.trackTimer(setTimeout(() => {
          if (generation !== this.mediaLoadGeneration || this.hls !== hlsInstance) return;
          operation();
          if (!exhausted) this.hlsRecoveryAttemptPending = false;
        }, 1000));
        this.scheduleHlsRecoveryWatchdog(data, Hls, hlsInstance, generation);
      };

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        this.recoveryMessage = exhausted
          ? '线路出现连续网络异常，正在确认是否仍可继续播放...'
          : `视频网络异常，正在尝试恢复 (${this.hlsErrorCount}/${this.maxHlsRecoveryAttempts})`;
        retry(() => hlsInstance.startLoad());
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        this.recoveryMessage = exhausted
          ? '线路出现连续解码异常，正在确认播放是否已经中断...'
          : `视频解码异常，正在尝试恢复 (${this.hlsErrorCount}/${this.maxHlsRecoveryAttempts})`;
        retry(() => hlsInstance.recoverMediaError());
      } else {
        this.recoveryMessage = '线路出现异常，正在确认播放是否已经中断...';
        const video = this.$refs.videoElement;
        if (!video || video.readyState < 3 || this.getBufferedAhead(video) < 0.75) {
          this.setPlaybackState('recovering');
        }
        this.scheduleHlsRecoveryWatchdog(data, Hls, hlsInstance, generation);
      }
    },

    createHlsFailure(data, Hls) {
      const failure = classifyHlsFailure(data, Hls);
      failure.attempts = this.hlsErrorCount;
      if (data?.type === Hls.ErrorTypes.NETWORK_ERROR) {
        failure.userMessage = '视频加载失败，正在尝试自动切换其他源';
      } else if (data?.type === Hls.ErrorTypes.MEDIA_ERROR) {
        failure.userMessage = '视频解码失败，正在尝试自动切换其他源';
      }
      return failure;
    },

    createNativeVideoFailure() {
      return describeNativeVideoError(this.$refs.videoElement?.error);
    },

    recordPlaybackFailure(failure) {
      this.lastPlaybackFailure = failure;
      this.reportSourcePlaybackResult(false, failure?.reason || 'playback-failed', failure);
    },

    formatFailureForDisplay(failure) {
      return formatPlaybackFailureForDisplay(failure);
    },

    finalPlaybackErrorMessage(failure) {
      return `自动换源未成功：${failure?.message || '视频播放失败'}`;
    },

    getCurrentSourceId() {
      return this.currentVideo?.sourceId
        || this.currentVideo?.anime?.sourceId
        || this.currentVideo?.anime?.source
        || '';
    },

    normalizeFallbackSourceId(sourceId) {
      return String(sourceId || '').trim().replace(/^(?:cms|xpath|media):/i, '');
    },

    rememberFallbackSource(...sourceIds) {
      for (const sourceId of sourceIds) {
        const normalized = this.normalizeFallbackSourceId(sourceId);
        if (normalized && !this.triedFallbackSourceIds.includes(normalized)) {
          this.triedFallbackSourceIds.push(normalized);
        }
      }
    },

    rememberFallbackAttempt(sourceId, providerId, lineId) {
      const normalizedSource = this.normalizeFallbackSourceId(sourceId);
      const normalizedProvider = this.normalizeFallbackSourceId(providerId);
      if (lineId && normalizedSource) {
        this.rememberFallbackSource(`${normalizedSource}|${lineId}`);
        if (normalizedProvider && normalizedProvider !== normalizedSource) {
          this.rememberFallbackSource(normalizedProvider);
        }
        return;
      }
      this.rememberFallbackSource(sourceId, providerId);
    },

    async requestPlayback(trigger = 'auto') {
      const video = this.$refs.videoElement;
      if (!video || this.casting) return false;
      this.playbackIntent = true;
      try {
        await video.play();
        this.playRetryCount = 0;
        return true;
      } catch (error) {
        if (error?.name === 'AbortError' && this.playbackIntent && this.playRetryCount < 3) {
          const generation = this.mediaLoadGeneration;
          this.playRetryCount += 1;
          this.trackTimer(setTimeout(() => {
            const currentVideo = this.$refs.videoElement;
            if (generation === this.mediaLoadGeneration
              && this.playbackIntent
              && currentVideo?.paused
              && currentVideo.readyState >= 2) {
              this.requestPlayback('abort-retry');
            }
          }, 220));
        } else if (error?.name !== 'AbortError') {
          this.playbackIntent = false;
          this.setPlaying(false);
          this.showCenterPlay = true;
          this.revealControls(false);
          console.warn(`[VideoPlayer] play rejected (${trigger}):`, error?.message || error);
        }
        return false;
      }
    },

    pausePlayback(reason = 'user') {
      const video = this.$refs.videoElement;
      if (!video) return;
      this.playbackIntent = false;
      if (reason !== 'user') this.suppressPauseEventsUntil = performance.now() + 500;
      video.pause();
    },

    clearHlsRecoveryWatchdog() {
      if (!this.hlsRecoveryWatchdog) return;
      clearTimeout(this.hlsRecoveryWatchdog);
      this.hlsRecoveryWatchdog = null;
    },

    clearPlaybackStartupWatchdog() {
      if (!this.playbackStartupWatchdog) return;
      clearTimeout(this.playbackStartupWatchdog);
      this.playbackStartupWatchdog = null;
    },

    schedulePlaybackStartupWatchdog(
      generation = this.mediaLoadGeneration,
      url = this.currentVideo?.url || '',
      options = {}
    ) {
      this.clearPlaybackStartupWatchdog();
      const observation = this.createFallbackObservation();
      const forcedPlaybackAttempted = options.forcedPlaybackAttempted === true;
      const delay = Math.max(1000, Number(options.delay) || 15000);
      this.playbackStartupWatchdog = this.trackTimer(setTimeout(async () => {
        this.playbackStartupWatchdog = null;
        if (generation !== this.mediaLoadGeneration || this.currentVideo?.url !== url) return;
        const video = this.$refs.videoElement;
        const progressed = (Number(video?.currentTime) || 0) >= observation.currentTime + 0.2
          || Number(this.lastPlaybackProgressAt) > observation.observationStartedAt;
        if (progressed) return;

        const hasPlayableBuffer = !video?.error
          && Number(video?.readyState) >= 3
          && this.getBufferedAhead(video) >= 0.5;
        if (hasPlayableBuffer && !forcedPlaybackAttempted) {
          this.playbackIntent = true;
          await this.requestPlayback('startup-watchdog');
          if (generation === this.mediaLoadGeneration && this.currentVideo?.url === url) {
            this.schedulePlaybackStartupWatchdog(generation, url, {
              forcedPlaybackAttempted: true,
              delay: 6000
            });
          }
          return;
        }

        const failure = video?.error
          ? this.createNativeVideoFailure()
          : {
              source: this.activeMediaMode || 'media',
              category: 'resolver-timeout',
              reason: 'playback-startup-timeout',
              message: '\u5f53\u524d\u7ebf\u8def\u957f\u65f6\u95f4\u6ca1\u6709\u4ea7\u751f\u53ef\u64ad\u653e\u753b\u9762',
              userMessage: '\u5f53\u524d\u7ebf\u8def\u542f\u52a8\u8d85\u65f6\uff0c\u6b63\u5728\u5c1d\u8bd5\u5176\u4ed6\u7ebf\u8def',
              hint: '\u64ad\u653e\u5668\u5df2\u8df3\u8fc7\u65e0\u9996\u5e27\u3001\u65e0\u7f13\u51b2\u8fdb\u5ea6\u7684\u7ebf\u8def\u3002'
            };
        this.recordPlaybackFailure(failure);
        this.playbackIntent = false;
        this.activeMediaGeneration = -1;
        this.activeMediaMode = '';
        this.activeMediaUrl = '';
        if (this.hls) {
          this.hls.destroy();
          this.hls = null;
        }
        if (video) {
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
        this.setPlaybackState('recovering');
        this.autoFallbackToOtherSource(failure);
      }, delay));
    },

    createFallbackObservation(video = this.$refs.videoElement) {
      return {
        currentTime: Number(video?.currentTime) || 0,
        observationStartedAt: performance.now(),
        lastProgressAt: Number(this.lastPlaybackProgressAt) || 0
      };
    },

    playbackFallbackSnapshot(observation, video = this.$refs.videoElement) {
      return {
        playbackIntent: this.playbackIntent,
        ended: video?.ended === true,
        errorCode: Number(video?.error?.code) || 0,
        readyState: Number(video?.readyState) || 0,
        bufferAhead: this.getBufferedAhead(video),
        currentTime: Number(video?.currentTime) || 0,
        observedTime: Number(observation?.currentTime) || 0,
        observationStartedAt: Number(observation?.observationStartedAt) || 0,
        lastProgressAt: Number(this.lastPlaybackProgressAt) || 0
      };
    },

    finishRecoveryWithoutFallback(video = this.$refs.videoElement) {
      this.hlsErrorCount = 0;
      this.hlsRecoveryAttemptPending = false;
      this.autoRecovering = false;
      this.recoveryMessage = '';
      this.lastPlaybackFailure = null;
      if (video?.readyState >= 2) this.setPlaybackState('playing');
      if (video?.paused && this.playbackIntent) this.requestPlayback('recovery-confirmed');
    },

    scheduleNativeFallbackConfirmation(failure, generation = this.mediaLoadGeneration) {
      if (this.nativeFallbackConfirmationPending) return;
      const activeUrl = this.activeMediaUrl;
      const observation = this.createFallbackObservation();
      this.nativeFallbackConfirmationPending = true;
      this.recoveryMessage = '检测到媒体异常，正在确认当前线路是否已经中断...';
      this.setPlaybackState('recovering');
      this.trackTimer(setTimeout(() => {
        this.nativeFallbackConfirmationPending = false;
        if (generation !== this.mediaLoadGeneration
          || this.activeMediaMode !== 'native'
          || this.activeMediaUrl !== activeUrl) return;
        const video = this.$refs.videoElement;
        if (!shouldAutoFallback(this.playbackFallbackSnapshot(observation, video))) {
          this.finishRecoveryWithoutFallback(video);
          return;
        }
        this.recordPlaybackFailure(failure);
        this.activeMediaGeneration = -1;
        this.activeMediaMode = '';
        this.activeMediaUrl = '';
        this.autoFallbackToOtherSource(failure);
      }, 1800));
    },

    scheduleHlsRecoveryWatchdog(data, Hls, recoveringInstance = this.hls, generation = this.mediaLoadGeneration) {
      this.clearPlaybackStartupWatchdog();
      this.clearHlsRecoveryWatchdog();
      const observation = this.createFallbackObservation();
      this.hlsRecoveryWatchdog = setTimeout(() => {
        this.hlsRecoveryWatchdog = null;
        if (generation !== this.mediaLoadGeneration || this.hls !== recoveringInstance) return;
        const video = this.$refs.videoElement;
        if (!shouldAutoFallback(this.playbackFallbackSnapshot(observation, video))) {
          this.finishRecoveryWithoutFallback(video);
          return;
        }

        const failure = this.createHlsFailure(data, Hls);
        this.hlsRecoveryAttemptPending = false;
        failure.reason = `${failure.reason || 'hls-error'}-recovery-timeout`;
        failure.message = '当前视频线路恢复超时';
        failure.userMessage = '当前线路持续无响应，正在自动切换其他源';
        failure.hint = '播放器已跳过无响应线路。';
        this.recordPlaybackFailure(failure);
        if (this.hls) {
          this.hls.destroy();
          this.hls = null;
        }
        this.activeMediaGeneration = -1;
        this.activeMediaMode = '';
        this.activeMediaUrl = '';
        this.setPlaybackState('recovering');
        this.autoFallbackToOtherSource(failure);
      }, 12000);
    }
  }
};
