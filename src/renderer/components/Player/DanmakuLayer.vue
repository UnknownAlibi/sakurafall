<template>
  <canvas ref="canvas" class="danmaku-canvas"></canvas>
</template>

<script>
import DanmakuEngine from './DanmakuEngine.js';
import { selectDanmakuEpisode } from '../../utils/danmakuMatch.js';

export default {
  name: 'DanmakuLayer',
  props: {
    // 是否启用弹幕
    enabled: { type: Boolean, default: false },
    // 视频当前时间（秒）
    currentTime: { type: Number, default: 0 },
    // 是否正在播放
    isPlaying: { type: Boolean, default: false },
    // 番剧名（用于搜索 dandanplay）
    animeName: { type: String, default: '' },
    // 当前播放集数，用于匹配正确的 episodeId
    episodeNumber: { type: Number, default: 0 },
    // 弹弹play episodeId（外部指定，可选，保留旧 prop 名以兼容现有调用）
    danmakuAnimeId: { type: [String, Number], default: '' },
    // 弹幕设置
    fontSize: { type: Number, default: 20 },
    opacity: { type: Number, default: 1.0 },
    speed: { type: Number, default: 1.0 },
    displayAreaRatio: { type: Number, default: 0.75 }
  },
  emits: ['loaded', 'error', 'status', 'select-anime'],
  data() {
    return {
      engine: null,
      loaded: false,
      loading: false,
      loadToken: 0,
      // dandanplay 搜索候选（用户未指定 animeId 时用于手动选择）
      searchCandidates: []
    };
  },
  watch: {
    enabled(val) {
      if (this.engine) {
        this.engine.setVisible(val);
      }
      if (val && !this.loaded && !this.loading) {
        this.loadDanmaku();
      }
    },
    currentTime(val) {
      if (this.engine) {
        this.engine.setTime(val);
      }
    },
    isPlaying(val) {
      if (this.engine) {
        this.engine.setPlaying(val);
      }
    },
    fontSize(val) { if (this.engine) this.engine.setFontSize(val); },
    opacity(val) { if (this.engine) this.engine.setOpacity(val); },
    speed(val) { if (this.engine) this.engine.setSpeed(val); },
    displayAreaRatio(val) { if (this.engine) this.engine.setDisplayAreaRatio(val); },
    // 切换番剧时重新加载
    animeName() {
      this.loaded = false;
      if (this.enabled) this.loadDanmaku();
    },
    episodeNumber() {
      this.loaded = false;
      if (this.enabled) this.loadDanmaku();
    },
    danmakuAnimeId() {
      this.loaded = false;
      if (this.enabled) this.loadDanmaku();
    }
  },
  mounted() {
    this.engine = new DanmakuEngine(this.$refs.canvas);
    this.engine.setFontSize(this.fontSize);
    this.engine.setOpacity(this.opacity);
    this.engine.setSpeed(this.speed);
    this.engine.setDisplayAreaRatio(this.displayAreaRatio);
    this.engine.setVisible(this.enabled);
    this.engine.setPlaying(this.isPlaying);
    this.engine.start();

    if (this.enabled) {
      this.loadDanmaku();
    }
  },
  beforeUnmount() {
    this.loadToken += 1;
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
    }
  },
  methods: {
    /**
     * 加载弹幕：优先使用指定 animeId，否则用番剧名搜索
     */
    async loadDanmaku() {
      const token = ++this.loadToken;
      this.loading = true;
      this.$emit('status', {
        state: 'loading',
        message: this.episodeNumber > 0
          ? `正在匹配第 ${this.episodeNumber} 集弹幕…`
          : '正在匹配弹幕…'
      });

      try {
        let comments = [];
        let match = null;

        if (this.danmakuAnimeId) {
          // 已指定弹弹play episodeId
          comments = await window.electronAPI.danmakuGetComments(this.danmakuAnimeId);
        } else if (this.animeName) {
          // 用番剧名搜索弹弹play，再精确匹配当前集的 episodeId
          const ready = await window.electronAPI.danmakuIsReady();
          if (!ready) {
            const error = new Error('请先在设置中配置弹弹play AppID 和 AppSecret，或导入本地 XML 弹幕');
            error.code = 'DANMAKU_NOT_CONFIGURED';
            throw error;
          }
          const candidates = await window.electronAPI.danmakuSearch(this.animeName);
          if (token !== this.loadToken) return;
          if (candidates && candidates.length > 0) {
            this.searchCandidates = candidates;
            match = selectDanmakuEpisode(candidates, this.animeName, this.episodeNumber);
            if (match?.episodeId) {
              comments = await window.electronAPI.danmakuGetComments(match.episodeId);
              if (token !== this.loadToken) return;
            }
          }
        }

        if (token !== this.loadToken) return;
        if (comments && comments.length > 0) {
          this.engine.setComments(comments);
          this.engine.setTime(this.currentTime);
          this.loaded = true;
          this.$emit('loaded', { count: comments.length, match });
        } else {
          this.engine.setComments([]);
          this.loaded = true;
          this.$emit('loaded', { count: 0, match });
        }
      } catch (e) {
        if (token !== this.loadToken) return;
        console.error('[DanmakuLayer] 加载弹幕失败:', e);
        this.$emit('error', e.message || '加载弹幕失败');
      } finally {
        if (token === this.loadToken) this.loading = false;
      }
    },

    /**
     * 手动选择 dandanplay 番剧后加载
     */
    async loadByAnimeId(animeId) {
      if (!animeId) return;
      const token = ++this.loadToken;
      this.loading = true;
      try {
        const comments = await window.electronAPI.danmakuGetComments(animeId);
        if (token !== this.loadToken || !this.engine) return;
        this.engine.setComments(comments || []);
        this.loaded = true;
        this.$emit('loaded', { count: (comments || []).length });
      } catch (e) {
        if (token !== this.loadToken) return;
        this.$emit('error', e.message);
      } finally {
        if (token === this.loadToken) this.loading = false;
      }
    },

    /**
     * 导入本地 XML 弹幕文件
     */
    async importLocalXml(filePath) {
      if (!filePath) return;
      const token = ++this.loadToken;
      this.loading = true;
      try {
        const comments = await window.electronAPI.danmakuParseXml(filePath);
        if (token !== this.loadToken || !this.engine) return;
        this.engine.setComments(comments || []);
        this.loaded = true;
        this.$emit('loaded', { count: (comments || []).length, source: 'local' });
      } catch (e) {
        if (token !== this.loadToken) return;
        this.$emit('error', e.message);
      } finally {
        if (token === this.loadToken) this.loading = false;
      }
    },

    /**
     * 清空弹幕
     */
    clearDanmaku() {
      if (this.engine) {
        this.engine.setComments([]);
        this.loaded = false;
      }
    },

    /**
     * seek 时重置弹幕时间轴
     */
    onSeek(time) {
      if (this.engine) {
        this.engine.setTime(time);
      }
    }
  }
};
</script>

<style scoped>
.danmaku-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 50;
}
</style>
