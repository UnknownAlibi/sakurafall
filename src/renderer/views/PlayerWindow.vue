<template>
  <div class="player-window-page" :class="{ 'mini-mode': isMiniMode }">
    <!-- 简化标题栏：标题 + 置顶 + 最小化/最大化/关闭 -->
    <div class="player-title-bar">
      <div class="player-title-left">
        <span class="player-title-text">{{ videoTitle }}</span>
      </div>
      <div class="player-title-right">
        <button
          class="title-btn enhanced-btn"
          :class="{ 'is-busy': enhancedPlayerBusy }"
          :disabled="enhancedPlayerBusy"
          @click="openEnhancedPlayer()"
          :title="enhancedPlayerBusy ? '正在检查外部播放器' : '使用外部 MPV 播放（可加载 Anime4K）'"
        >
          <span class="enhanced-mark">{{ enhancedPlayerBusy ? '···' : 'MPV' }}</span>
        </button>
        <button class="title-btn pin-btn" @click="toggleAlwaysOnTop" :title="isPinned ? '取消置顶' : '窗口置顶'">
          <svg v-if="isPinned" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 9V4l1-1V2H7v1l1 1v5l-2 2v2h5.2v7l.8 2 .8-2v-7H18v-2l-2-2z"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 9V4l1-1V2H7v1l1 1v5l-2 2v2h5.2v7l.8 2 .8-2v-7H18v-2l-2-2z"/>
          </svg>
        </button>
        <button class="title-btn mini-btn" @click="toggleMiniMode" :title="isMiniMode ? '退出迷你模式' : '迷你模式'">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2"/>
            <rect x="8" y="9" width="8" height="6" fill="currentColor" stroke="none"/>
          </svg>
        </button>
        <button class="title-btn" @click="minimizeWindow" title="最小化">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="title-btn" @click="maximizeWindow" :title="isMaximized ? '还原' : '最大化'">
          <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10"><path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor"/></svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 0v2.5H0V10h7.5V7.5H10V0H2.5zM9 6.5H3.5V1H9v5.5zM1 9V3.5h1.5V7H6.5v1.5H1z" fill="currentColor"/></svg>
        </button>
        <button class="title-btn close-btn" @click="closeWindow" title="关闭">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M5 3.59L1.7.29.3 1.7 3.58 5 .29 8.3l1.41 1.41L5 6.41l3.3 3.3 1.4-1.42L6.42 5l3.3-3.3L8.3.3 5 3.58z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>

    <!-- 主体：播放器 + 选集侧栏 -->
    <div class="player-body">
      <!-- 播放器区域 -->
      <div class="player-section">
        <div v-if="initialResolvePending" class="player-prepare-state" role="status" aria-live="polite">
          <span class="prepare-spinner"></span>
          <strong>{{ pendingVideoTitle || '正在准备播放' }}</strong>
          <span>{{ pendingVideoStage || '正在验证线路并选择可播放地址...' }}</span>
        </div>
        <div v-else-if="initialResolveError" class="player-prepare-state player-prepare-error" role="alert">
          <strong>这一集暂时无法播放</strong>
          <span>{{ initialResolveError }}</span>
          <button type="button" @click="closeWindow">关闭窗口</button>
        </div>
        <VideoPlayer
          v-show="!initialResolvePending && !initialResolveError"
          ref="videoPlayer"
          :has-episodes="hasEpisodes"
          :has-next-episode="!!nextEpisode"
          @video-ended="onVideoEnded"
          @next-episode="playNextEpisode"
          @open-enhanced-player="openEnhancedPlayer"
          @open-settings="openSettings"
        />
        <transition name="enhanced-notice">
          <div v-if="enhancedPlayerNotice" class="enhanced-notice" role="status" aria-live="polite">
            <div class="enhanced-notice-copy">
              <strong>{{ enhancedPlayerNotice.title }}</strong>
              <span>{{ enhancedPlayerNotice.message }}</span>
              <small v-if="enhancedPlayerNotice.hint">{{ enhancedPlayerNotice.hint }}</small>
            </div>
            <button v-if="enhancedPlayerNotice.settings" type="button" @click="openSettings">打开设置</button>
            <button type="button" class="enhanced-notice-close" title="关闭提示" @click="enhancedPlayerNotice = null">×</button>
          </div>
        </transition>
      </div>

      <!-- 选集侧栏 -->
      <div v-if="hasEpisodes" class="episodes-sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">选集</span>
          <span class="sidebar-count">{{ currentLineEpisodes.length }}集</span>
        </div>

        <!-- 线路选择 -->
        <div v-if="Object.keys(episodes).length > 1" class="line-selector">
          <button v-for="(episodeList, lineId) in episodes" :key="lineId" @click="selectLine(lineId)"
            :class="['line-tab', { active: selectedLine === lineId, switching: pendingLineId === lineId }]"
            :aria-busy="pendingLineId === lineId">
            {{ formattedLineNames[lineId] || lineId }}
          </button>
        </div>

        <!-- 搜索筛选（集数较多时显示） -->
        <div v-if="currentLineEpisodes.length > 12" class="episode-search">
          <input
            v-model="episodeFilter"
            type="text"
            class="episode-search-input"
            placeholder="筛选集数..."
          />
          <button v-if="episodeFilter" class="episode-search-clear" @click="episodeFilter = ''" title="清除">×</button>
        </div>

        <!-- 分集网格 -->
        <div ref="episodesListEl" class="episodes-list">
          <button
            v-for="(episode, index) in renderedFilteredEpisodes"
            :key="episode.id || index"
            :ref="el => { if (isCurrentEpisode(episode)) currentEpisodeEl = el }"
            @click="playEpisode(episode)"
            :class="['episode-btn', { active: isCurrentEpisode(episode) }]"
            :title="episode.title || episode.name || `${index + 1}`"
          >
            {{ episode.title || episode.name || `${index + 1}` }}
          </button>
          <div v-if="filteredEpisodes.length === 0" class="no-match">无匹配集数</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import VideoPlayer from '../components/Player/VideoPlayer.vue';
import episodeProgressiveRender from '../mixins/episodeProgressiveRender.js';
import {
  findEpisodeIndex,
  findCorrespondingEpisode,
  findLineForEpisode,
  formatLineNames,
  getAdjacentEpisode,
  getLineEpisodes,
  getPreferredEpisodeLine,
  hasEpisodeLines,
  isSameEpisode,
  normalizeEpisodes
} from '../utils/episodeList.js';
import { isPlayableVideoUrl, resolveEpisodeVideoUrl } from '../utils/episodePlayback.js';
import { toIpcPlainObject } from '../utils/ipcPayload.js';

export default {
  name: 'PlayerWindow',
  components: { VideoPlayer },
  mixins: [episodeProgressiveRender],
  data() {
    return {
      isMaximized: false,
      isPinned: false,
      isMiniMode: false,
      selectedLine: null,
      removeStateListener: null,
      removeLoadNewListener: null,
      episodeFilter: '',
      currentEpisodeEl: null,
      episodePlayToken: 0,
      pendingLineId: '',
      autoPlayTimer: null,
      initialResolvePending: true,
      initialResolveError: '',
      pendingVideoTitle: '',
      pendingVideoStage: '',
      enhancedPlayerBusy: false,
      enhancedPlayerNotice: null,
      enhancedNoticeTimer: null
    };
  },
  computed: {
    currentVideo() {
      return this.$store.getters['player/currentVideo'];
    },
    autoPlay() {
      return this.$store.getters['settings/autoPlay'];
    },
    mpvPath() {
      return this.$store.getters['settings/mpvPath'];
    },
    enableAnime4K() {
      return this.$store.getters['settings/enableAnime4K'];
    },
    anime4kShaderPaths() {
      return this.$store.getters['settings/anime4kShaderPaths'];
    },
    anime4kPreset() {
      return this.$store.getters['settings/anime4kPreset'];
    },
    videoTitle() {
      if (!this.currentVideo && this.pendingVideoTitle) return this.pendingVideoTitle;
      const animeName = this.currentVideo?.anime?.name || '播放器';
      const episodeTitle = this.currentVideo?.episode?.title || '';
      return episodeTitle ? `${animeName} · ${episodeTitle}` : animeName;
    },
    episodes() {
      return normalizeEpisodes(this.currentVideo?.anime?.episodes);
    },
    hasEpisodes() {
      return hasEpisodeLines(this.episodes);
    },
    formattedLineNames() {
      return formatLineNames(this.episodes);
    },
    currentEpisodeIndex() {
      if (!this.hasEpisodes || !this.currentVideo?.episode || !this.selectedLine) return -1;
      return findEpisodeIndex(this.currentLineEpisodes, this.currentVideo.episode);
    },
    currentLineEpisodes() {
      return this.hasEpisodes && this.selectedLine ? getLineEpisodes(this.episodes, this.selectedLine) : [];
    },
    nextEpisode() {
      return getAdjacentEpisode(this.currentLineEpisodes, this.currentEpisodeIndex, 1);
    },
    // 按关键词筛选集数（匹配标题/名称）
    filteredEpisodes() {
      const list = this.currentLineEpisodes;
      const kw = (this.episodeFilter || '').trim().toLowerCase();
      if (!kw) return list;
      return list.filter(ep => {
        const t = (ep?.title || ep?.name || '').toString().toLowerCase();
        return t.includes(kw);
      });
    },
    renderedFilteredEpisodes() {
      return this.episodeRenderItems.slice(0, this.visibleEpisodeLimit);
    },
    episodeRenderItems() {
      return this.filteredEpisodes;
    },
    currentEpisodeIdentity() {
      const episode = this.currentVideo?.episode;
      if (!episode) return '';
      return [episode.id, episode.title, episode.name, episode.index]
        .map(value => value ?? '')
        .join('|');
    }
  },
  watch: {
    episodes: {
      handler() {
        this.ensureSelectedLine();
        this.$nextTick(() => this.resetVisibleEpisodes());
      },
      immediate: true
    },
    // 切换线路或集数变化后，滚动当前集到可视区
    selectedLine() {
      this.resetVisibleEpisodes();
      this.$nextTick(() => this.scrollCurrentIntoView());
    },
    currentEpisodeIdentity() {
      this.ensureSelectedLine();
      this.resetVisibleEpisodes();
      this.$nextTick(() => this.scrollCurrentIntoView());
    },
    episodeFilter() {
      this.resetVisibleEpisodes();
    }
  },
  methods: {
    async applyIncomingPlayerData(videoData) {
      if (videoData?.pending) {
        this.initialResolvePending = true;
        this.initialResolveError = '';
        this.pendingVideoTitle = videoData.title || '';
        this.pendingVideoStage = videoData.stage || this.pendingVideoStage || '正在验证当前线路...';
        return;
      }
      if (videoData?.error) {
        this.initialResolvePending = false;
        this.initialResolveError = videoData.error;
        this.pendingVideoTitle = videoData.title || this.pendingVideoTitle;
        this.pendingVideoStage = '';
        return;
      }
      if (!videoData?.url) {
        this.initialResolvePending = false;
        this.initialResolveError = '没有获取到可播放地址，请切换其他分集。';
        this.pendingVideoStage = '';
        return;
      }

      this.initialResolvePending = false;
      this.initialResolveError = '';
      this.pendingVideoTitle = videoData.title || '';
      this.pendingVideoStage = '';
      const sameVideo = this.currentVideo?.url === videoData.url
        && this.currentVideo?.episodeId === videoData.episodeId
        && String(this.currentVideo?.lineId || '') === String(videoData.lineId || '');
      if (!sameVideo) {
        this.$refs.videoPlayer?.beginPlaybackTransition?.('incoming-video');
        await this.$store.dispatch('player/playVideo', videoData);
      }
      this.episodeFilter = '';
      this.ensureSelectedLine();
      this.resetVisibleEpisodes();
      this.$nextTick(() => this.scrollCurrentIntoView());
    },

    ensureSelectedLine() {
      if (!this.hasEpisodes) return;
      const keys = Object.keys(this.episodes);
      if (keys.length === 0) return;
      if (this.pendingLineId && Array.isArray(this.episodes[this.pendingLineId])) {
        this.selectedLine = this.pendingLineId;
        return;
      }
      const videoLineId = String(this.currentVideo?.lineId || this.currentVideo?.episode?.lineId || '');
      if (videoLineId && Array.isArray(this.episodes[videoLineId])) {
        this.selectedLine = videoLineId;
        return;
      }
      const currentLine = this.selectedLine && this.episodes[this.selectedLine];
      if (Array.isArray(currentLine) && findEpisodeIndex(currentLine, this.currentVideo?.episode) >= 0) return;
      const found = findLineForEpisode(this.episodes, this.currentVideo?.episode);
      this.selectedLine = found || getPreferredEpisodeLine(this.episodes) || keys[0];
    },

    isCurrentEpisode(episode) {
      const videoLineId = String(this.currentVideo?.lineId || this.currentVideo?.episode?.lineId || '');
      if (videoLineId && String(this.selectedLine || '') !== videoLineId) return false;
      if (isSameEpisode(episode, this.currentVideo?.episode)) return true;
      return this.currentEpisodeIndex >= 0 && this.currentLineEpisodes[this.currentEpisodeIndex] === episode;
    },

    async selectLine(lineId) {
      if (!lineId || (lineId === this.selectedLine && !this.pendingLineId)) return;
      const targetEpisode = findCorrespondingEpisode(
        this.episodes,
        lineId,
        this.currentVideo?.episode,
        this.currentEpisodeIndex
      );
      if (!targetEpisode) {
        this.$notify?.warning('线路不可用', '该线路没有当前集，请选择其他集数');
        return;
      }
      await this.playEpisode(targetEpisode, { lineId, reason: 'line-switch' });
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
      if (this.enhancedPlayerBusy) return;
      const data = payload?.url ? payload : (this.$refs.videoPlayer?.enhancedPlayerPayload || {});
      const url = data.url || this.currentVideo?.url;
      if (!url) {
        this.showEnhancedNotice('暂时无法增强', '当前没有可播放的视频地址');
        return;
      }
      const options = {
        url,
        title: this.videoTitle,
        mpvPath: this.mpvPath,
        enableAnime4K: this.enableAnime4K,
        anime4kShaderPaths: this.anime4kShaderPaths,
        anime4kPreset: this.anime4kPreset,
        startPosition: data.startPosition || 0,
        headers: data.headers || null
      };
      const ipcOptions = toIpcPlainObject(options, {});
      this.enhancedPlayerBusy = true;
      try {
        const check = await window.electronAPI?.enhancedPlayerCheck?.(ipcOptions);
        if (!check?.success) {
          this.showEnhancedNotice(
            '还缺少 mpv',
            check?.message || '未检测到增强播放器，当前按钮无法执行画质增强。',
            check?.repairHint || '可以在设置中一键安装。',
            true
          );
          return;
        }

        const result = await window.electronAPI?.enhancedPlayerOpen?.(ipcOptions);

        if (!result?.success) {
          this.showEnhancedNotice(
            '增强播放启动失败',
            result?.error || result?.message || 'mpv 没有成功打开当前视频。',
            result?.repairHint || '',
            true
          );
          return;
        }

        this.pauseInternalPlayer();
        const anime4kActive = result.enhancementMode === 'anime4k';
        this.showEnhancedNotice(
          anime4kActive ? 'Anime4K 已启动' : 'mpv 已启动',
          anime4kActive
            ? `已加载 ${result.shaderCount || 0} 个 shader，并从当前进度继续播放。`
            : '当前使用 mpv 高质量缩放，Anime4K 未启用。',
          anime4kActive ? '增强会改善线条与缩放观感，但不会凭空补回源视频细节。' : '',
          false,
          6500
        );
      } catch (error) {
        console.error('增强播放失败:', error);
        this.showEnhancedNotice('增强播放失败', error.message || '请检查 mpv 设置', '', true);
      } finally {
        this.enhancedPlayerBusy = false;
      }
    },

    showEnhancedNotice(title, message, hint = '', settings = false, timeout = 0) {
      if (this.enhancedNoticeTimer) clearTimeout(this.enhancedNoticeTimer);
      this.enhancedPlayerNotice = { title, message, hint, settings };
      if (timeout > 0) {
        this.enhancedNoticeTimer = setTimeout(() => {
          this.enhancedPlayerNotice = null;
          this.enhancedNoticeTimer = null;
        }, timeout);
      }
    },

    async playEpisode(episode, options = {}) {
      if (!episode || !this.currentVideo?.anime) return;
      const lineId = String(options.lineId || this.selectedLine || this.currentVideo?.lineId || '');
      const playToken = ++this.episodePlayToken;
      this.pendingLineId = lineId;

      const player = this.$refs.videoPlayer;
      const sourceId = this.currentVideo.sourceId
        || this.currentVideo.anime.sourceId
        || this.currentVideo.anime.source
        || '';
      const providerId = this.currentVideo.providerId
        || this.currentVideo.anime.providerId
        || episode.providerId
        || '';
      const transitionToken = player?.beginPlaybackTransition?.(options.reason || 'episode-switch');
      if (transitionToken === undefined) player?.setPlaybackState?.('resolving');
      const isLatestPlay = () => playToken === this.episodePlayToken
        && (transitionToken === undefined || player?.isPlaybackTransitionCurrent?.(transitionToken));

      try {
        let videoUrl = '';
        let resolvedVideo = null;

        // 优先使用 PlaybackResolverService（主进程，带短期缓存和 token 取消）
        if (window.electronAPI?.playbackResolve) {
          const sourceName = this.currentVideo.sourceName || this.currentVideo.anime.sourceName || '';
          const safeEpisode = toIpcPlainObject({ ...episode, lineId }, {});
          const result = await window.electronAPI.playbackResolve({
            providerId,
            sourceId,
            sourceName,
            sourceType: this.currentVideo.sourceType || this.currentVideo.anime.sourceType || 'cms',
            sourceAnimeId: String(this.currentVideo.anime.id || this.currentVideo.anime.anime_id || ''),
            episode: safeEpisode
          });

          // 旧请求的返回结果必须丢弃
          if (!isLatestPlay()) return;

          if (!result?.success) {
            // 解析失败：构造分类失败对象交给 VideoPlayer 显示
            const failure = {
              message: result?.error || '视频地址解析失败',
              category: result?.category || 'invalid-source',
              reason: result?.reason || 'invalid-source',
              hint: result?.hint || '请重试或换源',
              userMessage: result?.userMessage || result?.error || '视频地址解析失败',
              elapsedMs: result?.elapsedMs || 0
            };
            await this.fallbackAfterEpisodeResolutionFailure(player, failure, {
              sourceId, providerId, lineId
            });
            return;
          }

          resolvedVideo = result;
          videoUrl = result.url;
        } else {
          // 回退：使用 renderer 端解析（兼容旧版本）
          videoUrl = await resolveEpisodeVideoUrl(episode);
          if (!isLatestPlay()) return;
        }

        if (!isPlayableVideoUrl(videoUrl)) {
          if (!isLatestPlay()) return;
          const failure = {
            message: '视频地址不可播放',
            category: 'invalid-source',
            reason: 'invalid-source',
            hint: '请尝试换源或重新选择剧集'
          };
          await this.fallbackAfterEpisodeResolutionFailure(player, failure, {
            sourceId, providerId, lineId
          });
          return;
        }

        const lineEpisodes = getLineEpisodes(this.episodes, lineId);
        const epIndex = lineEpisodes.indexOf(episode);
        await this.$store.dispatch('player/playVideo', {
          title: `${this.currentVideo.anime.name} - ${episode.title}`,
          url: videoUrl,
          anime: this.currentVideo.anime,
          episode: { ...episode, index: epIndex, lineId },
          episodeId: episode.id,
          sourceId,
          sourceName: this.currentVideo.sourceName || this.currentVideo.anime.sourceName || '',
          providerId,
          lineId,
          // Phase 5: 附带 ResolvedVideo 的 headers，供 hls.js / native 加载使用
          resolvedVideo
        });
      } catch (error) {
        if (!isLatestPlay()) return;
        console.error('切换分集失败:', error);
        const failure = {
          message: error?.message || '切换分集失败',
          category: 'unknown',
          reason: 'unknown',
          hint: '请重试或换源'
        };
        await this.fallbackAfterEpisodeResolutionFailure(player, failure, {
          sourceId, providerId, lineId
        });
      } finally {
        if (playToken === this.episodePlayToken) this.pendingLineId = '';
      }
    },

    async fallbackAfterEpisodeResolutionFailure(player, failure, context = {}) {
      if (!player) return false;
      player.rememberFallbackAttempt?.(
        context.sourceId,
        context.providerId,
        context.lineId
      );
      player.recordPlaybackFailure?.(failure);
      player.error = null;
      player.recoveryMessage = failure?.userMessage
        || '\u5f53\u524d\u7ebf\u8def\u4e0d\u53ef\u64ad\uff0c\u6b63\u5728\u5c1d\u8bd5\u540c\u96c6\u5176\u4ed6\u7ebf\u8def';
      player.setPlaybackState?.('recovering');
      return player.autoFallbackToOtherSource?.(failure) || false;
    },

    /**
     * Phase 5: 打开网络设置页（VideoPlayer 通过 @open-settings 触发）
     * 播放窗口本身不渲染设置，引导用户到主窗口设置 → 代理地址
     */
    async openSettings() {
      const result = await window.electronAPI?.showMainRoute?.('/settings');
      if (!result?.success) this.$notify?.info('设置', '请在主窗口打开设置页');
    },

    onVideoEnded() {
      if (this.autoPlay && this.nextEpisode) {
        // 清理旧 timer 防止累积，统一延迟为 2000ms 与主窗口一致
        if (this.autoPlayTimer) clearTimeout(this.autoPlayTimer);
        this.autoPlayTimer = setTimeout(() => {
          this.autoPlayTimer = null;
          this.playEpisode(this.nextEpisode);
        }, 2000);
      }
    },

    playNextEpisode() {
      if (this.nextEpisode) this.playEpisode(this.nextEpisode);
    },

    // 将当前播放集滚动到选集列表的可视区域
    scrollCurrentIntoView() {
      const el = this.currentEpisodeEl;
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    },

    async minimizeWindow() {
      await window.electronAPI?.minimizeWindow();
    },
    async maximizeWindow() {
      await window.electronAPI?.maximizeWindow();
      this.isMaximized = await window.electronAPI?.isMaximized();
    },
    async closeWindow() {
      await window.electronAPI?.closeWindow();
    },
    async toggleAlwaysOnTop() {
      this.isPinned = await window.electronAPI?.playerToggleTop();
    },
    async toggleMiniMode() {
      if (!window.electronAPI?.playerToggleMini) return;
      this.isMiniMode = await window.electronAPI.playerToggleMini();
    }
  },
  async mounted() {
    // 先监听后台解析结果，避免窗口刚加载时错过快速返回的数据。
    if (window.electronAPI?.onPlayerLoadNew) {
      this.removeLoadNewListener = window.electronAPI.onPlayerLoadNew(async (videoData) => {
        try {
          await this.applyIncomingPlayerData(videoData);
        } catch (e) {
          console.error('加载新视频失败:', e);
          this.initialResolvePending = false;
          this.initialResolveError = '播放器初始化失败，请关闭后重试。';
        }
      });
    }

    // 从主进程拉取待播放数据（避免 URL 参数过长/截断问题）
    try {
      if (window.electronAPI?.playerGetData) {
        const videoData = await window.electronAPI.playerGetData();
        await this.applyIncomingPlayerData(videoData);
      }
    } catch (e) {
      console.error('拉取播放数据失败:', e);
      this.initialResolvePending = false;
      this.initialResolveError = '获取播放信息失败，请关闭后重试。';
    }

    // 初始化窗口状态
    if (window.electronAPI?.isMaximized) {
      this.isMaximized = await window.electronAPI.isMaximized();
    }
    if (window.electronAPI?.playerIsTop) {
      this.isPinned = await window.electronAPI.playerIsTop();
    }
    if (window.electronAPI?.playerIsMini) {
      this.isMiniMode = await window.electronAPI.playerIsMini();
    }
    if (window.electronAPI?.onWindowStateChanged) {
      this.removeStateListener = window.electronAPI.onWindowStateChanged((maximized) => {
        this.isMaximized = maximized;
      });
    }
    this.ensureSelectedLine();
    this.resetVisibleEpisodes();
    // 首次加载后滚动当前集到可视区
    this.$nextTick(() => this.scrollCurrentIntoView());
  },
  beforeUnmount() {
    this.episodePlayToken += 1;
    if (this.removeStateListener) this.removeStateListener();
    if (this.removeLoadNewListener) this.removeLoadNewListener();
    if (this.autoPlayTimer) {
      clearTimeout(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
    if (this.enhancedNoticeTimer) clearTimeout(this.enhancedNoticeTimer);
    this.cancelEpisodeRender();
  }
};
</script>

<style scoped>
.player-window-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(circle at 10% 0%, rgba(var(--primary-rgb), 0.2), transparent 34%),
    radial-gradient(circle at 88% 8%, rgba(66, 199, 238, 0.16), transparent 30%),
    #090913;
  overflow: hidden;
}

/* 标题栏 */
.player-title-bar {
  height: 36px;
  background:
    linear-gradient(90deg, rgba(20, 18, 34, 0.96), rgba(42, 28, 54, 0.96) 55%, rgba(22, 44, 58, 0.94));
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0;
  color: #eee;
  font-size: 13px;
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255, 138, 176, 0.12);
}

.player-title-left {
  padding-left: 14px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.player-title-text {
  font-weight: 500;
  font-size: 12px;
  opacity: 0.9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-title-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.title-btn {
  width: 46px;
  height: 36px;
  border: none;
  background: transparent;
  color: #eee;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth);
  -webkit-app-region: no-drag;
}

.title-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.title-btn.close-btn:hover {
  background: #e81123;
  color: #fff;
}

.pin-btn.active {
  color: #fb7299;
}

.enhanced-btn {
  color: #7ef3e8;
}

.enhanced-btn:disabled {
  cursor: wait;
  opacity: 0.82;
}

.enhanced-btn.is-busy .enhanced-mark {
  animation: enhanced-pulse 0.75s ease-in-out infinite alternate;
}

.enhanced-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 18px;
  border: 1px solid rgba(126, 243, 232, 0.5);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
}

@keyframes enhanced-pulse {
  to { opacity: 0.45; transform: scale(0.92); }
}

/* 主体 */
.player-body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.player-section {
  flex: 1;
  background: #000;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.enhanced-notice {
  position: absolute;
  z-index: 12;
  top: 14px;
  left: 50%;
  width: min(520px, calc(100% - 28px));
  min-height: 58px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 42px 11px 14px;
  border: 1px solid rgba(126, 243, 232, 0.3);
  border-radius: 8px;
  background: rgba(18, 17, 31, 0.96);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.34);
  color: #fff;
  -webkit-app-region: no-drag;
}

.enhanced-notice-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.enhanced-notice-copy strong { font-size: 13px; color: #aaf8ef; }
.enhanced-notice-copy span { font-size: 12px; line-height: 1.45; color: rgba(255, 255, 255, 0.86); }
.enhanced-notice-copy small { font-size: 11px; line-height: 1.4; color: rgba(255, 255, 255, 0.52); }

.enhanced-notice > button {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(126, 243, 232, 0.35);
  border-radius: 6px;
  background: rgba(126, 243, 232, 0.1);
  color: #c7fff8;
  cursor: pointer;
}

.enhanced-notice > .enhanced-notice-close {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 28px;
  min-height: 28px;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: rgba(255, 255, 255, 0.58);
  font-size: 18px;
}

.enhanced-notice-enter-active,
.enhanced-notice-leave-active { transition: opacity 0.18s var(--ease-smooth), transform 0.18s var(--ease-smooth); }
.enhanced-notice-enter-from,
.enhanced-notice-leave-to { opacity: 0; transform: translate(-50%, -8px); }

.player-prepare-state {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 28px;
  background: #09080d;
  color: rgba(255, 255, 255, 0.68);
  text-align: center;
}

.player-prepare-state strong {
  max-width: 560px;
  color: #fff;
  font-size: 16px;
  font-weight: 650;
}

.prepare-spinner {
  width: 34px;
  height: 34px;
  margin-bottom: 4px;
  border: 3px solid rgba(255, 138, 176, 0.16);
  border-top-color: #ff8ab0;
  border-radius: 50%;
  animation: player-prepare-spin 0.72s linear infinite;
}

@keyframes player-prepare-spin {
  to { transform: rotate(360deg); }
}

.player-prepare-error span {
  max-width: 520px;
}

.player-prepare-error button {
  min-height: 34px;
  margin-top: 5px;
  padding: 0 16px;
  border: 1px solid rgba(255, 138, 176, 0.5);
  border-radius: 7px;
  background: rgba(255, 138, 176, 0.12);
  color: #ffd5e3;
  cursor: pointer;
}

/* 选集侧栏 */
.episodes-sidebar {
  width: 236px;
  background:
    linear-gradient(180deg, rgba(28, 23, 43, 0.98), rgba(18, 17, 31, 0.98)),
    var(--app-ambient-bg) right top / 360px auto no-repeat;
  border-left: 1px solid rgba(255, 138, 176, 0.12);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.sidebar-title {
  font-size: 13px;
  color: #eee;
  font-weight: 600;
}

.sidebar-count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.52);
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
}

.line-selector {
  display: flex;
  gap: 4px;
  padding: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.line-tab {
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  transition: background-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth), border-color 0.15s var(--ease-smooth);
}

.line-tab:hover {
  background: rgba(255, 255, 255, 0.14);
  color: #eee;
}

.line-tab.active {
  background: linear-gradient(135deg, #fb7299, #9c7bff);
  color: #fff;
  border-color: transparent;
}

.line-tab.switching {
  animation: line-switch-pulse 0.8s ease-in-out infinite alternate;
}

@keyframes line-switch-pulse {
  to { box-shadow: 0 0 0 3px rgba(251, 114, 153, 0.18); }
}

/* 集数搜索框 */
.episode-search {
  position: relative;
  padding: 6px 10px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.episode-search-input {
  width: 100%;
  height: 28px;
  padding: 0 24px 0 8px;
  background: rgba(255, 255, 255, 0.075);
  border: 1px solid rgba(255, 138, 176, 0.12);
  border-radius: 8px;
  color: #eee;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s;
}

.episode-search-input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.episode-search-input:focus {
  border-color: #fb7299;
}

.episode-search-clear {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border: none;
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.episode-search-clear:hover {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
}

.no-match {
  grid-column: 1 / -1;
  text-align: center;
  color: rgba(255, 255, 255, 0.35);
  font-size: 12px;
  padding: 20px 0;
}

.episodes-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: grid;
  /* 固定 3 列，侧栏宽度足够；文字允许换行避免挤压 */
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  align-content: start;
}

.episodes-list::-webkit-scrollbar {
  width: 6px;
}

.episodes-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}

.episode-btn {
  min-height: 38px;
  padding: 6px 3px;
  background: rgba(255, 255, 255, 0.075);
  color: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  text-align: center;
  transition: background-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth), border-color 0.15s var(--ease-smooth);
  /* 允许换行，长标题（如"OVA 特别篇"）不再被截断挤压 */
  word-break: break-all;
  line-height: 1.3;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.episode-btn:hover {
  background: rgba(255, 255, 255, 0.13);
  color: #eee;
  border-color: rgba(255, 138, 176, 0.26);
}

.episode-btn.active {
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.26), rgba(156, 123, 255, 0.22));
  color: #fff;
  border-color: rgba(var(--primary-rgb), 0.76);
}

@media (max-width: 700px) {
  .episodes-sidebar {
    width: 160px;
  }
  .episodes-list {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* ===== Phase 9: 迷你模式 ===== */
/* 迷你模式：隐藏选集侧栏、标题文字、AI/置顶按钮，仅保留视频 + 迷你切换 + 最小化/关闭 */
.player-window-page.mini-mode .episodes-sidebar {
  display: none;
}
.player-window-page.mini-mode .player-title-text,
.player-window-page.mini-mode .enhanced-btn,
.player-window-page.mini-mode .pin-btn {
  display: none;
}
.player-window-page.mini-mode .player-title-bar {
  height: 28px;
  -webkit-app-region: drag;
}
.player-window-page.mini-mode .player-body {
  flex: 1;
}
/* 迷你模式下显式声明按钮为 no-drag，覆盖父级 .player-title-bar 的 drag，
   否则 Electron 会把按钮点击当作窗口拖拽，导致点击无响应 */
.player-window-page.mini-mode .player-title-right,
.player-window-page.mini-mode .player-title-right .title-btn {
  -webkit-app-region: no-drag;
  pointer-events: auto;
}
.player-window-page.mini-mode .mini-btn {
  color: rgba(var(--primary-rgb), 0.9);
}
</style>
