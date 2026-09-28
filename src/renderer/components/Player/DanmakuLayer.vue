<template>
  <canvas ref="canvas" class="danmaku-canvas"></canvas>
</template>

<script>
import { mapGetters } from 'vuex';
import DanmakuEngine from './DanmakuEngine.js';
import { remapDanmakuComments } from '../../utils/danmakuAlignment.js';
import { normalizeIdentityText } from '../../utils/episodeIdentity.js';
import danmakuAlignmentModule from '../../store/modules/danmakuAlignment.js';

export default {
  name: 'DanmakuLayer',
  // 按需注册对齐模块：只有打开了播放器才需要它，避免进主包预算
  beforeCreate() {
    if (this.$store && !this.$store.state.danmakuAlignment) {
      this.$store.registerModule('danmakuAlignment', danmakuAlignmentModule);
    }
  },
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
    animeMetadata: { type: Object, default: () => ({}) },
    providerIds: { type: Array, default: () => [] },
    sourceOverrides: { type: Object, default: () => ({}) },
    // 时间轴对齐的归属：剧集身份 + 播放源（同一集换源各自校准）
    episodeKey: { type: String, default: '' },
    sourceId: { type: String, default: '' },
    // 当前源上的自动检测结果（父组件采集）：片头候选 + 插入区间（如 HLS 广告段）
    videoIntro: { type: Object, default: null },
    adRanges: { type: Array, default: () => [] },
    // 弹弹play episodeId（外部指定，可选，保留旧 prop 名以兼容现有调用）
    danmakuAnimeId: { type: [String, Number], default: '' },
    // 弹幕设置
    fontSize: { type: Number, default: 20 },
    opacity: { type: Number, default: 1.0 },
    speed: { type: Number, default: 1.0 },
    displayAreaRatio: { type: Number, default: 0.75 },
    // 同屏弹幕上限（密度，20-150）
    maxActive: { type: Number, default: 80 }
  },
  emits: ['loaded', 'error', 'status', 'select-anime'],
  data() {
    return {
      engine: null,
      loaded: false,
      loading: false,
      loadToken: 0,
      runtimeOverrides: {},
      // 原始（未对齐）弹幕：对齐配置变化时基于它重新映射，避免二次偏移
      rawComments: [],
      // dandanplay 搜索候选（用户未指定 animeId 时用于手动选择）
      searchCandidates: []
    };
  },
  computed: {
    ...mapGetters('danmakuAlignment', ['alignment']),
    // 与 episodeIdentity 的约定保持一致：Bangumi 作品用 bgm:<id>，否则用归一化标题
    resolvedBgmId() {
      const metadata = this.animeMetadata || {};
      return Number(metadata.bgmId || metadata.bgm_id || metadata.subjectId || metadata.id) || null;
    },
    resolvedWorkKey() {
      if (this.resolvedBgmId) return `bgm:${this.resolvedBgmId}`;
      const title = normalizeIdentityText(this.animeName);
      return title ? `title:${title}` : '';
    },
    // 按当前校准把弹幕时间映射到视频时间轴（被删/广告区间的弹幕直接丢弃）
    alignedComments() {
      const duration = Number(this.animeMetadata?.duration) || 0;
      return remapDanmakuComments(this.rawComments, this.alignment, { videoDuration: duration });
    }
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
    maxActive(val) { if (this.engine) this.engine.setMaxActive(val); },
    // 切换番剧时重新加载
    animeName() {
      this.runtimeOverrides = this.readStoredOverrides();
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
    },
    // 校准变化（手动偏移 / 分段锚点）立即重映射，无需重新拉取弹幕
    alignment: {
      deep: true,
      handler() {
        this.applyComments();
      }
    },
    // 换集或换源：读取该组合已保存的校准
    episodeKey() {
      this.syncAlignmentContext();
    },
    sourceId() {
      this.syncAlignmentContext();
    },
    // 自动检测结果到达：交给对齐模块推导初值（用户可在设置面板里一键应用）
    videoIntro() {
      this.ingestDetections();
    },
    adRanges: {
      deep: true,
      handler() {
        this.ingestDetections();
      }
    }
  },
  mounted() {
    this.runtimeOverrides = this.readStoredOverrides();
    this.syncAlignmentContext();
    this.engine = new DanmakuEngine(this.$refs.canvas);
    this.engine.setFontSize(this.fontSize);
    this.engine.setOpacity(this.opacity);
    this.engine.setSpeed(this.speed);
    this.engine.setDisplayAreaRatio(this.displayAreaRatio);
    this.engine.setMaxActive(this.maxActive);
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
    /** 把「剧集身份 + 播放源」交给对齐模块，读取已保存的校准 */
    syncAlignmentContext() {
      this.$store.dispatch('danmakuAlignment/loadFor', {
        episodeKey: this.episodeKey,
        workKey: this.resolvedWorkKey,
        bgmId: this.resolvedBgmId,
        episodeNumber: this.episodeNumber,
        sourceId: this.sourceId
      });
    },

    /** 记录当前源的检测结果，供「自动对齐」推导锚点（不自动改变用户已有校准） */
    ingestDetections() {
      this.$store.commit('danmakuAlignment/SET_DETECTIONS', {
        videoIntro: this.videoIntro || null,
        adRanges: Array.isArray(this.adRanges) ? this.adRanges : [],
        canonicalIntroLength: 0
      });
    },

    /** 用当前校准重映射弹幕并写入引擎（原始列表保留在 rawComments） */
    applyComments() {
      if (!this.engine) return;
      this.engine.setComments(this.alignedComments);
      this.engine.setTime(this.currentTime);
    },

    matchStorageKey() {
      const metadata = this.animeMetadata || {};
      const identity = metadata.bgmId || metadata.bgm_id || metadata.subjectId || metadata.id || this.animeName;
      return `danmaku-match:${String(identity || '').trim().toLowerCase()}`;
    },

    readStoredOverrides() {
      try {
        return JSON.parse(localStorage.getItem(this.matchStorageKey()) || '{}');
      } catch (_) {
        return {};
      }
    },

    saveStoredOverrides() {
      try { localStorage.setItem(this.matchStorageKey(), JSON.stringify(this.runtimeOverrides || {})); } catch (_) { /* optional */ }
    },

    /**
     * 通过主进程统一解析多个弹幕源；单个源失败不会中断其它来源。
     */
    async loadDanmaku(forceRefresh = false) {
      const token = ++this.loadToken;
      this.loading = true;
      this.$emit('status', {
        state: 'loading',
        message: this.episodeNumber > 0
          ? `正在匹配第 ${this.episodeNumber} 集弹幕…`
          : '正在匹配弹幕…'
      });

      try {
        const metadata = this.animeMetadata || {};
        const aliases = [
          metadata.name_cn,
          metadata.nameCn,
          metadata.original_name,
          metadata.originalName,
          metadata.rawName,
          ...(Array.isArray(metadata.aliases) ? metadata.aliases : []),
          ...(Array.isArray(metadata.alias) ? metadata.alias : [])
        ].filter(Boolean);
        const overrides = {
          ...JSON.parse(JSON.stringify(this.sourceOverrides || {})),
          ...JSON.parse(JSON.stringify(this.runtimeOverrides || {}))
        };
        if (this.danmakuAnimeId) {
          overrides.dandanplay = { ...(overrides.dandanplay || {}), episodeId: this.danmakuAnimeId };
        }
        const result = await window.electronAPI.danmakuResolve({
          animeName: this.animeName,
          aliases,
          bgmId: metadata.bgmId || metadata.bgm_id || metadata.subjectId || metadata.id || '',
          episodeNumber: this.episodeNumber,
          duration: metadata.duration || 0,
          providerIds: this.providerIds,
          overrides,
          forceRefresh
        });
        if (token !== this.loadToken) return;
        const comments = result?.comments || [];
        const successful = (result?.sources || []).filter(source => source.status === 'ok');
        const match = successful[0]?.match || null;
        this.searchCandidates = (result?.sources || []).flatMap(source => source.candidates || []);

        if (token !== this.loadToken) return;
        if (comments && comments.length > 0) {
          this.rawComments = comments;
          this.applyComments();
          this.loaded = true;
          this.$emit('loaded', { count: this.alignedComments.length, match, sources: result?.sources || [], cached: result?.cached === true });
        } else {
          this.rawComments = [];
          this.engine.setComments([]);
          this.loaded = true;
          this.$emit('loaded', { count: 0, match, sources: result?.sources || [], error: result?.error || '' });
        }
      } catch (e) {
        if (token !== this.loadToken) return;
        console.error('[DanmakuLayer] 加载弹幕失败:', e);
        this.$emit('error', e.message || '加载弹幕失败');
      } finally {
        if (token === this.loadToken) this.loading = false;
      }
    },

    async loadWithOverride(providerId, candidate) {
      if (!providerId || !candidate) return;
      if (providerId === 'bilibili') {
        this.runtimeOverrides = {
          ...this.runtimeOverrides,
          bilibili: { seasonId: candidate.seasonId || candidate.id, title: candidate.title || '' }
        };
      } else if (providerId === 'acfun') {
        this.runtimeOverrides = {
          ...this.runtimeOverrides,
          acfun: { albumId: candidate.albumId || candidate.id, title: candidate.title || '' }
        };
      } else if (providerId === 'tencent') {
        this.runtimeOverrides = {
          ...this.runtimeOverrides,
          tencent: { cid: candidate.id, title: candidate.title || '' }
        };
      } else if (providerId === 'iqiyi') {
        this.runtimeOverrides = {
          ...this.runtimeOverrides,
          iqiyi: { linkId: candidate.id, title: candidate.title || '' }
        };
      } else if (providerId === 'youku') {
        this.runtimeOverrides = {
          ...this.runtimeOverrides,
          youku: { showId: candidate.id, title: candidate.title || '' }
        };
      }
      this.saveStoredOverrides();
      this.loaded = false;
      await this.loadDanmaku(true);
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
        this.rawComments = comments || [];
        this.applyComments();
        this.loaded = true;
        this.$emit('loaded', { count: this.rawComments.length });
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
        const localComments = await window.electronAPI.danmakuParseXml(filePath);
        if (token !== this.loadToken || !this.engine) return;
        this.rawComments = [
          ...this.rawComments,
          ...(localComments || []).map(comment => ({ ...comment, source: 'local' }))
        ].sort((a, b) => a.time - b.time);
        this.applyComments();
        this.loaded = true;
        this.$emit('loaded', {
          count: this.alignedComments.length,
          source: 'local',
          sources: [{ id: 'local', name: '本地 XML', status: 'ok', count: (localComments || []).length }]
        });
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
        this.rawComments = [];
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
