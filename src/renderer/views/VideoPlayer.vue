<template>
  <div class="video-player-page">
    <!-- 空状态：没有选择视频 -->
    <div v-if="!currentVideo" class="empty-state">
      <svg class="empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
        <polygon points="10 8 16 12 10 16 10 8"/>
      </svg>
      <p class="empty-title">还没有选择视频</p>
      <p class="empty-desc">去番剧库选一部开始看吧</p>
      <button @click="goToAnimeZone" class="empty-action">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
          <line x1="7" y1="2" x2="7" y2="22"/>
          <line x1="17" y1="2" x2="17" y2="22"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
        </svg>
        <span>去选动漫</span>
      </button>
    </div>

    <!-- 有视频时的正常布局 -->
    <template v-else>
      <!-- 播放器区域 -->
      <div class="player-section">
        <VideoPlayer
          ref="videoPlayer"
          @video-ended="onVideoEnded"
          @open-enhanced-player="openEnhancedPlayer"
          @open-settings="$router.push('/settings')"
        />
      </div>

      <!-- 下方信息面板 -->
      <div class="info-panel">
        <!-- 视频信息区 -->
        <div class="video-info">
          <h1 class="video-title">{{ videoTitle }}</h1>
          <div class="video-meta">
            <span v-if="currentVideo?.anime?.year" class="meta-tag">{{ currentVideo.anime.year }}</span>
            <span v-if="currentVideo?.anime?.area" class="meta-tag">{{ currentVideo.anime.area }}</span>
            <span v-if="animeType" class="meta-tag">{{ animeType }}</span>
            <span v-if="currentVideo?.episode?.title" class="meta-tag meta-tag--accent">{{ currentVideo.episode.title }}</span>
          </div>
          <div class="video-actions">
            <button v-if="previousEpisode" @click="playEpisode(previousEpisode)" class="action-btn" title="上一集">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h2v10H3V3zm3.5 5l7.5 5V3L6.5 8z"/></svg>
              <span>上一集</span>
            </button>
            <button v-if="nextEpisode" @click="playEpisode(nextEpisode)" class="action-btn action-btn--primary" title="下一集">
              <span>下一集</span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M11 3h2v10h-2V3zm-8 0l7.5 5L3 13V3z"/></svg>
            </button>
            <button @click="toggleAutoPlay" :class="['action-btn', { 'action-btn--active': autoPlay }]">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0 0 1 14 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5v-7zM4.5 3A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 11.5 3h-7zM6 5.5l4.5 2.5L6 10.5V5.5z"/></svg>
              <span>自动连播</span>
            </button>
            <button :disabled="enhancedPlayerBusy" @click="openEnhancedPlayer" class="action-btn action-btn--enhanced" title="使用 mpv + Anime4K 增强播放">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 16l-1.7-5L6 9.3l4.3-1.7L12 3z"/>
                <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>
              </svg>
              <span>{{ enhancedPlayerBusy ? '检查中...' : 'AI增强播放' }}</span>
            </button>
          </div>
        </div>

        <!-- 选集区域 -->
        <div v-if="hasEpisodes" class="episodes-section">
          <!-- 线路选择 -->
          <div v-if="Object.keys(episodes).length > 1" class="line-selector">
            <span class="line-label">线路</span>
            <div class="line-tabs">
              <button v-for="(episodeList, lineId) in episodes" :key="lineId" @click="selectLine(lineId)"
                :class="['line-tab', { active: selectedLine === lineId }]">
                {{ formattedLineNames[lineId] || lineId }}
              </button>
            </div>
          </div>

          <!-- 分集标题 -->
          <div class="episodes-header">
            <span class="episodes-title">选集</span>
            <span class="episodes-count">{{ currentLineEpisodes.length }}集</span>
          </div>

          <!-- 分集网格 -->
          <div class="episodes-grid">
            <button v-for="(episode, index) in renderedCurrentLineEpisodes" :key="episode.id || index"
              @click="playEpisode(episode)"
              :class="['episode-btn', { active: currentVideo?.episode?.id === episode.id }]">
              {{ episode.title || episode.name || `${index + 1}` }}
            </button>
          </div>
        </div>

        <!-- 无分集提示 -->
        <div v-else class="no-episodes">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/></svg>
          <p>暂无分集信息</p>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import VideoPlayer from '../components/Player/VideoPlayer.vue';
import episodeProgressiveRender from '../mixins/episodeProgressiveRender.js';
import {
  findEpisodeIndex,
  findLineForEpisode,
  formatLineNames,
  getAdjacentEpisode,
  getLineEpisodes,
  hasEpisodeLines,
  normalizeEpisodes
} from '../utils/episodeList.js';
import { isPlayableVideoUrl, resolveEpisodeVideoUrl } from '../utils/episodePlayback.js';
import { toIpcPlainObject } from '../utils/ipcPayload.js';

export default {
  name: 'VideoPlayerPage',
  components: { VideoPlayer },
  mixins: [episodeProgressiveRender],
  data() {
    return {
      selectedLine: null,
      autoPlay: true,
      episodePlayToken: 0,
      autoPlayTimer: null,
      enhancedPlayerBusy: false,
    };
  },
  computed: {
    ...mapGetters('player', ['currentVideo', 'isPlaying']),
    ...mapGetters('anime', ['currentAnime']),
    ...mapGetters('settings', ['mpvPath', 'enableAnime4K', 'anime4kShaderPaths', 'anime4kPreset']),

    videoTitle() {
      const animeName = this.currentVideo?.anime?.name || '未知动漫';
      const episodeTitle = this.currentVideo?.episode?.title || '';
      return episodeTitle ? `${animeName} · ${episodeTitle}` : animeName;
    },

    animeType() {
      const type = this.currentVideo?.anime?.type;
      if (!type) return '';
      return Array.isArray(type) ? type.join(' / ') : type;
    },

    episodes() {
      const anime = this.currentVideo?.anime || this.currentAnime;
      return normalizeEpisodes(anime?.episodes);
    },

    formattedLineNames() {
      return formatLineNames(this.episodes);
    },

    hasEpisodes() {
      return hasEpisodeLines(this.episodes);
    },

    currentEpisodeIndex() {
      if (!this.hasEpisodes || !this.currentVideo?.episode || !this.selectedLine) {
        return -1;
      }
      return findEpisodeIndex(this.currentLineEpisodes, this.currentVideo.episode);
    },

    currentLineEpisodes() {
      return this.hasEpisodes && this.selectedLine ? getLineEpisodes(this.episodes, this.selectedLine) : [];
    },

    renderedCurrentLineEpisodes() {
      return this.episodeRenderItems.slice(0, this.visibleEpisodeLimit);
    },

    episodeRenderItems() {
      return this.currentLineEpisodes;
    },

    nextEpisode() {
      return getAdjacentEpisode(this.currentLineEpisodes, this.currentEpisodeIndex, 1);
    },

    previousEpisode() {
      return getAdjacentEpisode(this.currentLineEpisodes, this.currentEpisodeIndex, -1);
    }
  },
  watch: {
    // episodes 异步到达时补默认线路（保持 computed 纯函数）
    episodes: {
      handler() {
        this.ensureSelectedLine();
        this.$nextTick(() => this.resetVisibleEpisodes());
      },
      immediate: true
    },

    selectedLine() {
      this.resetVisibleEpisodes();
    },

    'currentVideo.episode.id'() {
      this.resetVisibleEpisodes();
    }
  },
  methods: {
    ...mapActions('player', ['playVideo']),
    ...mapActions('anime', ['fetchAnimeDetail']),

    // episodes 异步到达或当前线路失效时，补一个默认线路（替代原 computed 内副作用）
    ensureSelectedLine() {
      if (!this.hasEpisodes) return;
      const keys = Object.keys(this.episodes);
      if (keys.length === 0) return;
      // 当前线路仍有效则保留
      if (this.selectedLine && Array.isArray(this.episodes[this.selectedLine])) return;
      // 否则尝试匹配当前集所在线路，否则取第一条
      const foundLine = findLineForEpisode(this.episodes, this.currentVideo?.episode);
      this.selectedLine = foundLine || keys[0];
    },

    toggleAutoPlay() {
      this.autoPlay = !this.autoPlay;
    },

    pauseInternalPlayer() {
      const player = this.$refs.videoPlayer;
      if (player?.pausePlayback) {
        player.pausePlayback('enhanced-player');
        return;
      }
      const videoElement = this.$refs.videoPlayer?.$refs?.videoElement;
      if (videoElement && !videoElement.paused) {
        videoElement.pause();
      }
    },

    async openEnhancedPlayer(payload) {
      if (!this.currentVideo?.url) return;
      if (this.enhancedPlayerBusy) return;
      this.enhancedPlayerBusy = true;
      const data = payload?.url ? payload : (this.$refs.videoPlayer?.enhancedPlayerPayload || {});
      const options = {
        url: data.url || this.currentVideo.url,
        title: this.videoTitle,
        mpvPath: this.mpvPath,
        enableAnime4K: this.enableAnime4K,
        anime4kShaderPaths: this.anime4kShaderPaths,
        anime4kPreset: this.anime4kPreset,
        startPosition: data.startPosition || 0,
        headers: data.headers || null
      };
      const ipcOptions = toIpcPlainObject(options, {});
      try {
        const check = await window.electronAPI?.enhancedPlayerCheck?.(ipcOptions);
        if (!check?.success) {
          this.$notify?.warning('还缺少 mpv', `${check?.message || '未检测到增强播放器'}，可在设置中一键安装`);
          return;
        }
        const result = await window.electronAPI?.enhancedPlayerOpen?.(ipcOptions);

        if (!result?.success) {
          throw new Error(result?.error || result?.message || '增强播放器启动失败');
        }

        this.pauseInternalPlayer();
        this.$notify?.success(
          result.enhancementMode === 'anime4k' ? 'Anime4K 已启动' : 'mpv 已启动',
          result.enhancementMode === 'anime4k' ? `已加载 ${result.shaderCount || 0} 个 shader` : '当前使用 mpv 高质量缩放'
        );
      } catch (error) {
        console.error('增强播放失败:', error);
        this.$notify?.error('增强播放失败', error.message || '请检查 mpv 设置');
      } finally {
        this.enhancedPlayerBusy = false;
      }
    },

    async playEpisode(episode) {
      if (!episode || !this.currentVideo?.anime) return;
      const playToken = ++this.episodePlayToken;
      const isLatestPlay = () => playToken === this.episodePlayToken;

      try {
        const videoUrl = await resolveEpisodeVideoUrl(episode);
        if (!isLatestPlay()) return;

        if (!isPlayableVideoUrl(videoUrl)) {
          this.$notify?.error('错误', '视频地址解析失败，请重试');
          return;
        }

        // 获取当前集在列表中的索引（用于记录观看进度）
        const epIndex = this.currentLineEpisodes?.indexOf(episode) ?? -1;

        await this.playVideo({
          title: `${this.currentVideo.anime.name} - ${episode.title}`,
          url: videoUrl,
          anime: this.currentVideo.anime,
          episode: { ...episode, index: epIndex },
          episodeId: episode.id
        });
      } catch (error) {
        this.$notify?.error('错误', '播放分集失败');
      }
    },

    selectLine(lineId) {
      this.selectedLine = lineId;
    },

    onVideoEnded() {
      if (this.autoPlay && this.nextEpisode) {
        if (this.autoPlayTimer) clearTimeout(this.autoPlayTimer);
        this.autoPlayTimer = setTimeout(() => {
          this.autoPlayTimer = null;
          this.playEpisode(this.nextEpisode);
        }, 2000);
      }
    },

    goToAnimeZone() {
      this.$router.push({ name: 'anime-zone' });
    }
  },
  mounted() {
    this.$nextTick(() => {
      this.ensureSelectedLine();
      this.resetVisibleEpisodes();
    });
  },
  beforeUnmount() {
    this.episodePlayToken += 1;
    this.cancelEpisodeRender();
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
  }
};
</script>

<style scoped>
.video-player-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  overflow: hidden;
}

/* ===== 空状态 ===== */
.empty-state {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: #1a1a2e;
}

.empty-icon {
  margin-bottom: 8px;
  opacity: 0.4;
}

.empty-title {
  font-size: 18px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.5);
  margin: 0;
}

.empty-desc {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.35);
  margin: 0 0 12px 0;
}

.empty-action {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 28px;
  background: #fb7299;
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.2s;
}

.empty-action:hover {
  background: #e85d84;
}

/* ===== 播放器区域 ===== */
.player-section {
  flex-shrink: 0;
  background: #000;
  aspect-ratio: 16 / 9;
  max-height: 60vh;
}

/* ===== 下方信息面板 ===== */
.info-panel {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  background: #1a1a2e;
}

.info-panel::-webkit-scrollbar {
  width: 6px;
}

.info-panel::-webkit-scrollbar-track {
  background: transparent;
}

.info-panel::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}

/* ===== 视频信息 ===== */
.video-info {
  margin-bottom: 16px;
}

.video-title {
  font-size: 18px;
  font-weight: 600;
  color: #eee;
  margin: 0 0 10px 0;
  line-height: 1.4;
}

.video-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 14px;
}

.meta-tag {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.08);
  padding: 3px 10px;
  border-radius: 4px;
  line-height: 1.5;
}

.meta-tag--accent {
  color: #fb7299;
  background: rgba(var(--primary-rgb), 0.15);
}

/* ===== 操作按钮 ===== */
.video-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.65);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
  white-space: nowrap;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #eee;
}

.action-btn--primary {
  background: #fb7299;
  color: #fff;
}

.action-btn--primary:hover {
  background: #e85d84;
  color: #fff;
}

.action-btn--active {
  background: rgba(var(--primary-rgb), 0.15);
  color: #fb7299;
}

.action-btn--active:hover {
  background: rgba(var(--primary-rgb), 0.25);
  color: #fb7299;
}

.action-btn--enhanced {
  background: rgba(78, 205, 196, 0.16);
  color: #7ef3e8;
}

.action-btn--enhanced:hover {
  background: rgba(78, 205, 196, 0.26);
  color: #a8fff7;
}

/* ===== 选集区域 ===== */
.episodes-section {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 14px;
}

/* 线路选择 */
.line-selector {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.line-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}

.line-tabs {
  display: flex;
  gap: 6px;
}

.line-tab {
  padding: 5px 14px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.5);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
}

.line-tab:hover {
  color: #eee;
  background: rgba(255, 255, 255, 0.14);
}

.line-tab.active {
  background: #fb7299;
  color: #fff;
}

/* 分集标题 */
.episodes-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.episodes-title {
  font-size: 14px;
  color: #eee;
  font-weight: 500;
}

.episodes-count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

/* 分集网格 */
.episodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 8px;
}

.episode-btn {
  padding: 8px 4px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.6);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  text-align: center;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.episode-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #eee;
  border-color: rgba(255, 255, 255, 0.1);
}

.episode-btn.active {
  background: rgba(var(--primary-rgb), 0.15);
  color: #fb7299;
  border-color: #fb7299;
}

/* ===== 无分集 ===== */
.no-episodes {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 12px;
}

.no-episodes p {
  color: rgba(255, 255, 255, 0.4);
  font-size: 14px;
  margin: 0;
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .info-panel {
    padding: 12px 14px;
  }

  .video-title {
    font-size: 16px;
  }

  .player-section {
    max-height: 40vh;
  }

  .episodes-grid {
    grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
    gap: 6px;
  }

  .episode-btn {
    padding: 6px 2px;
    font-size: 12px;
  }
}
</style>
