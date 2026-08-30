import {
  buildPlayerMediaMetadata,
  createPlayerMediaSession
} from '../utils/playerMediaSession.js';

export default {
  computed: {
    mediaSessionMetadataKey() {
      const video = this.currentVideo;
      return [
        video?.anime?.name,
        video?.episode?.title,
        video?.episode?.name,
        video?.anime?.cover,
        video?.anime?.image,
        video?.sourceName
      ].map(value => value || '').join('|');
    }
  },

  watch: {
    controlsVisible: 'syncFullscreenCursorState',
    loading: 'syncFullscreenCursorState',
    error: 'syncFullscreenCursorState',
    buffering: 'syncFullscreenCursorState',
    isFullscreen(fullscreen) {
      this.syncFullscreenCursorState();
      if (fullscreen) this.$nextTick(() => this.revealControls(true));
      else this.revealControls(this.isPlaying);
    },
    mediaSessionMetadataKey() {
      this.updateMediaSessionMetadata();
    },
    hasNextEpisode(value) {
      this._mediaSessionController?.setNextEnabled(this.hasEpisodes && value);
    },
    hasEpisodes(value) {
      this._mediaSessionController?.setNextEnabled(value && this.hasNextEpisode);
    }
  },

  methods: {
    setupMediaSession() {
      this._mediaSessionController = createPlayerMediaSession({
        onPlay: () => {
          const video = this.$refs.videoElement;
          if (video?.paused) this.requestPlayback('media-session');
        },
        onPause: () => {
          const video = this.$refs.videoElement;
          if (video && !video.paused) this.pausePlayback('user');
        },
        onStop: () => {
          this.pausePlayback('user');
          this.handleSeek(0);
        },
        onSeekBy: delta => this.seekRelative(delta),
        onSeekTo: (time, fastSeek) => {
          const video = this.$refs.videoElement;
          if (fastSeek && typeof video?.fastSeek === 'function') {
            this.markIntentionalSeek();
            video.fastSeek(time);
          } else {
            this.handleSeek(time);
          }
        },
        onNext: () => this.$emit('next-episode'),
        getSeekStep: () => this.seekStepSeconds
      });
      this._mediaSessionController.mount();
      this._mediaSessionController.setNextEnabled(this.hasEpisodes && this.hasNextEpisode);
      this.updateMediaSessionMetadata();
    },

    bindMediaSessionEvents() {
      const video = this.$refs.videoElement;
      if (!video) return;
      const setState = state => this._mediaSessionController?.setPlaybackState(state);
      const sync = force => this._mediaSessionController?.updatePosition(video, force);
      this._mediaSessionEventHandlers = {
        play: () => { setState('playing'); sync(true); },
        pause: () => { setState(video.ended ? 'none' : 'paused'); sync(true); },
        ended: () => setState('none'),
        loadedmetadata: () => sync(true),
        timeupdate: () => sync(false),
        ratechange: () => sync(true),
        seeked: () => sync(true)
      };
      Object.entries(this._mediaSessionEventHandlers)
        .forEach(([event, handler]) => video.addEventListener(event, handler));
    },

    updateMediaSessionMetadata() {
      this._mediaSessionController?.updateMetadata(buildPlayerMediaMetadata(this.currentVideo));
    },

    syncFullscreenCursorState() {
      const hidden = this.isFullscreen && !this.controlsVisible && !this.loading && !this.error && !this.buffering;
      if (hidden) document.documentElement.setAttribute('data-player-cursor-hidden', 'true');
      else document.documentElement.removeAttribute('data-player-cursor-hidden');
    },

    teardownMediaSession() {
      const video = this.$refs.videoElement;
      if (video && this._mediaSessionEventHandlers) {
        Object.entries(this._mediaSessionEventHandlers)
          .forEach(([event, handler]) => video.removeEventListener(event, handler));
      }
      this._mediaSessionEventHandlers = null;
      this._mediaSessionController?.destroy();
      this._mediaSessionController = null;
    }
  },

  mounted() {
    this.setupMediaSession();
    this.bindMediaSessionEvents();
  },

  beforeUnmount() {
    this.teardownMediaSession();
    document.documentElement.removeAttribute('data-player-cursor-hidden');
  }
};
