import { findEpisodeIndex } from '../utils/episodeList.js';

export default {
  data() {
    return {
      visibleEpisodeLimit: 120,
      _episodeRenderFrame: null,
      _episodeRenderTimer: null
    };
  },
  methods: {
    resetVisibleEpisodes() {
      this.cancelEpisodeRender();
      const list = this.episodeRenderItems || [];
      if (!list.length) {
        this.visibleEpisodeLimit = 0;
        return;
      }

      const currentIndex = findEpisodeIndex(list, this.currentVideo?.episode);
      const initialLimit = Math.max(120, currentIndex >= 0 ? currentIndex + 24 : 120);
      this.visibleEpisodeLimit = Math.min(list.length, initialLimit);
      if (this.visibleEpisodeLimit < list.length) this.scheduleEpisodeRender();
    },

    cancelEpisodeRender() {
      if (this._episodeRenderFrame) cancelAnimationFrame(this._episodeRenderFrame);
      if (this._episodeRenderTimer) clearTimeout(this._episodeRenderTimer);
      this._episodeRenderFrame = null;
      this._episodeRenderTimer = null;
    },

    scheduleEpisodeRender() {
      if (this._episodeRenderFrame || this._episodeRenderTimer) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const delay = pressure === 'high' ? 90 : 32;
      this._episodeRenderTimer = setTimeout(() => {
        this._episodeRenderTimer = null;
        this._episodeRenderFrame = requestAnimationFrame(() => {
          this._episodeRenderFrame = null;
          this.growVisibleEpisodes();
        });
      }, delay);
    },

    growVisibleEpisodes() {
      const total = (this.episodeRenderItems || []).length;
      if (this.visibleEpisodeLimit >= total) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const batchSize = pressure === 'high' ? 48 : 84;
      this.visibleEpisodeLimit = Math.min(total, this.visibleEpisodeLimit + batchSize);
      if (this.visibleEpisodeLimit < total) this.scheduleEpisodeRender();
    }
  },
  // mixin 自带清理：rAF/setTimeout 在组件卸载后自动取消，
  // 不依赖每个消费方都记得调用 cancelEpisodeRender()（Vue 会合并执行组件自身与 mixin 的钩子）
  beforeUnmount() {
    this.cancelEpisodeRender();
  }
};
