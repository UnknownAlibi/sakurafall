/**
 * 动漫详情弹窗共享 mixin
 * 把 AnimeZone 的详情弹窗（打开/关闭/收藏切换/播放解析）抽离，
 * 让「我的追番」等页面可以原地打开详情，无需跳转到番剧库。
 *
 * 依赖（由宿主组件环境提供）：
 * - Vuex 模块 favorite（addFavorite/removeFavorite/favoriteMap）、anime（详情/源选择等 action）
 * - this.$notify 全局通知、window.electronAPI
 * - 可选钩子 afterDetailClose()：弹窗关闭后调用（AnimeZone 用它重启分集可用性探测）
 */
import { mapGetters } from 'vuex';
import {
  coordinateSubjectDetail,
  createDetailPlaceholder,
  isSettledDetailStage
} from '../services/subjectDetailCoordinator.js';
import {
  closePlayerPreparation,
  openPlayerPreparation,
  updatePlayerPreparation
} from '../services/playerWindowBridge.js';

export default {
  data() {
    return {
      // 当前详情弹窗数据（null = 关闭）
      detailAnime: null,
      // 正在打开的分集标识（用于按钮 loading 态）
      openingEpisodeKey: ''
    };
  },

  computed: {
    ...mapGetters('favorite', ['favoriteMap'])
  },

  created() {
    // 请求令牌：使过期的详情/播放请求失效（组件销毁或新请求后旧响应作废）
    this._detailRequestToken = 0;
    this._playRequestToken = 0;
    this._pendingPlayerWindowId = null;
    // 从其他页面跳转打开详情时的来源页（关闭弹窗后回去）
    this._detailReturnTo = null;
  },

  methods: {
    /**
     * 判断动漫是否已收藏
     */
    isAnimeFavorited(anime) {
      const source = anime.source || 'legacy';
      return !!this.favoriteMap[`${source}:${anime.id}`];
    },

    /**
     * 详情弹窗内切换收藏状态
     */
    async onToggleFavorite(anime) {
      const source = anime.source || 'legacy';
      const wasFav = this.isAnimeFavorited(anime);

      let ok = false;
      try {
        if (wasFav) {
          ok = await this.$store.dispatch('favorite/removeFavorite', { id: anime.id, source });
          if (ok) {
            // 同步把它从「我的追番」列表里移除，保证收藏页即时刷新
            this.$store.commit('favorite/REMOVE_FAVORITE_FROM_LIST', { id: anime.id, source });
          }
        } else {
          ok = await this.$store.dispatch('favorite/addFavorite', anime);
        }
      } catch (error) {
        console.error('[DetailModal] 切换收藏异常:', error);
        ok = false;
      }

      if (ok) {
        this.$notify?.success(wasFav ? '已取消收藏' : '收藏成功', anime.name || '');
      } else {
        this.$notify?.error('收藏失败', '本地收藏写入失败，请重试');
      }
    },

    toPlainObject(value) {
      if (value === null || value === undefined) return value;
      return JSON.parse(JSON.stringify(value));
    },

    createPlaybackResolvePayload(anime = {}, episode = {}) {
      return {
        providerId: anime.providerId || episode.providerId || '',
        sourceId: anime.sourceId || episode.sourceId || anime.source || '',
        sourceName: anime.sourceName || '',
        sourceType: anime.sourceType || episode.sourceType || '',
        sourceAnimeId: String(anime.id || anime.anime_id || ''),
        episode: this.toPlainObject(episode) || {}
      };
    },

    scheduleCmsEpisodeFallback(anime = {}, episode = {}, episodeIndex = 0, isActive = () => true) {
      let timer = null;
      let settle = null;
      const promise = new Promise(resolve => {
        settle = resolve;
        if (!anime?.name) {
          resolve({ cancelled: true });
          return;
        }
        timer = setTimeout(async () => {
          timer = null;
          if (!isActive()) {
            resolve({ cancelled: true });
            return;
          }
          try {
            resolve(await this.$store.dispatch('anime/selectBestCmsEpisodeSource', {
              keyword: anime.name,
              target: {
                episodeTitle: episode?.title || '',
                episodeIndex,
                allowFirstFallback: true,
                excludeSourceIds: [anime.sourceId || anime.source].filter(Boolean),
                taskScope: 'episodePlaybackFallback'
              }
            }));
          } catch (error) {
            resolve({ best: null, candidates: [], error: error?.message || String(error) });
          }
        }, 350);
      });

      return {
        promise,
        cancelPending() {
          if (!timer) return false;
          clearTimeout(timer);
          timer = null;
          settle?.({ cancelled: true });
          return true;
        }
      };
    },

    /**
     * 打开详情弹窗：先放骨架占位，再由资料协调器分阶段回填
     */
    async viewAnimeDetail(anime) {
      const detailToken = ++this._detailRequestToken;
      const isActive = () => detailToken === this._detailRequestToken;
      const perfMark = window.__perf?.start('detail-metadata');
      let perfEnded = false;
      this.showEpisodeSelector(createDetailPlaceholder(anime));

      try {
        await coordinateSubjectDetail({
          anime,
          isActive,
          loadLegacyDetail: item => this.loadLegacySourceDetail(item),
          onStage: (detail, context = {}) => {
            if (!isActive()) return;
            if (context.listUpdates) {
              this.$store.commit('anime/UPDATE_ANIME_IN_LIST', { id: anime.id, updates: context.listUpdates });
            }
            // Source and index-cache stages are useful for warming caches, but exposing
            // them makes the open modal repeatedly reflow. Present one settled snapshot.
            if (isSettledDetailStage(context)) {
              this.showEpisodeSelector({
                ...detail,
                name: anime.name || detail.name
              });
            }
            if (context.phase === 'complete' && !perfEnded) {
              perfEnded = true;
              window.__perf?.end(perfMark, { bgmId: detail.bgm_id || null, source: anime.source || '' });
            }
          }
        });
        if (!perfEnded) {
          perfEnded = true;
          window.__perf?.end(perfMark, { cancelled: !isActive() });
        }
      } catch (error) {
        if (!perfEnded) {
          perfEnded = true;
          window.__perf?.end(perfMark, { failed: true });
        }
        if (!isActive()) return;
        console.error('[DetailModal] 详情协调失败:', error);
        this.$notify?.error('错误', '获取动漫详情失败');
      }
    },

    /**
     * 旧数据源（非凡 / CMS）详情兜底
     */
    async loadLegacySourceDetail(anime) {
      if (anime.source === 'ffzy') {
        return this.$store.dispatch('anime/fetchFanzhiDetail', { id: anime.id, silent: true });
      }
      // 元数据来源（AniList）无片源 provider，交由 subjectDetail 提供资料
      if (anime.source && anime.source !== 'bangumi' && anime.source !== 'anilist') {
        return this.$store.dispatch('anime/fetchCmsMultiDetail', { id: anime.id, sourceId: anime.source, silent: true });
      }
      if (!anime.source) return this.$store.dispatch('anime/fetchAnimeDetail', anime.id);
      return null;
    },

    /**
     * 显示详情弹窗
     */
    showEpisodeSelector(anime) {
      this.detailAnime = anime;
      this.onDetailModalOpen?.();
    },

    /**
     * 关闭详情弹窗。
     * 若是带 returnTo 跳转过来的（如「发现」页），关闭后回到来源页。
     */
    closeDetail() {
      this._detailRequestToken += 1;
      this._playRequestToken += 1;
      const pendingPlayerWindowId = this._pendingPlayerWindowId;
      this.openingEpisodeKey = '';
      this._pendingPlayerWindowId = null;
      closePlayerPreparation(window.electronAPI, pendingPlayerWindowId).catch(() => {});
      this.detailAnime = null;
      if (this._detailReturnTo) {
        const target = this._detailReturnTo;
        this._detailReturnTo = null;
        this.$router.push({ name: target }).catch(() => {});
        return;
      }
      this.$nextTick(() => this.afterDetailClose?.());
    },

    /**
     * 处理弹窗中的播放请求（按需解析播放地址）
     */
    async onPlayEpisode({ anime, episode, episodeIndex, lineIndex: _lineIndex, lineId, requestKey, playPosition = 0 }) {
      const playToken = ++this._playRequestToken;
      const isLatestPlayRequest = () => playToken === this._playRequestToken;
      const openingKey = requestKey || `${lineId || 'line'}:${episode?.id || episode?.url || episode?.title || episodeIndex}`;
      const pendingTitle = `${anime.name} - ${episode.title}`;
      let playerWindowId = null;

      this.openingEpisodeKey = openingKey;
      if (window.electronAPI?.openPlayerWindow) {
        try {
          playerWindowId = await openPlayerPreparation(window.electronAPI, {
            title: pendingTitle, episode, lineId
          });
          if (isLatestPlayRequest()) {
            this._pendingPlayerWindowId = playerWindowId;
          } else if (playerWindowId) {
            await closePlayerPreparation(window.electronAPI, playerWindowId);
            return;
          }
        } catch (error) {
          console.warn('[DetailModal] 提前打开播放窗口失败，将在解析后重试:', error);
        }
      }

      let videoUrl = null;
      let resolvedVideo = null;
      let lastResolveFailure = null;
      const hasPlaybackResolver = !!window.electronAPI?.playbackResolve;
      const fallbackProbe = this.scheduleCmsEpisodeFallback(
        anime,
        episode,
        episodeIndex,
        isLatestPlayRequest
      );

      if (hasPlaybackResolver) {
        try {
          const resolved = await window.electronAPI.playbackResolve(
            this.createPlaybackResolvePayload(anime, episode)
          );
          if (!isLatestPlayRequest()) return;
          if (resolved?.success && resolved.url) {
            resolvedVideo = resolved;
            videoUrl = resolved.url;
            episode.realUrl = resolved.url;
            fallbackProbe.cancelPending();
          } else {
            lastResolveFailure = resolved;
          }
        } catch (error) {
          lastResolveFailure = { error: error?.message || String(error) };
        }
      }

      if (!hasPlaybackResolver && !videoUrl && episode.realUrl) {
        videoUrl = episode.realUrl;
      } else if (!hasPlaybackResolver && !videoUrl && episode.url && !episode.url.includes('/share/')) {
        videoUrl = episode.url;
      } else if (!hasPlaybackResolver && !videoUrl && episode.url) {
        try {
          const info = await this.$store.dispatch('anime/fetchFanzhiPlayUrl', episode.url);
          if (!isLatestPlayRequest()) return;
          if (info && info.url) {
            videoUrl = info.url;
            episode.realUrl = info.url; // 缓存，下次不再解析
          }
        } catch (err) {
          // 解析失败，继续尝试 CMS API 回退
        }
      }

      if (videoUrl && !videoUrl.includes('/share/')) {
        fallbackProbe.cancelPending();
      }

      if (!videoUrl || videoUrl.includes('/share/')) {
        try {
          const bestResult = await fallbackProbe.promise;
          if (!isLatestPlayRequest() || bestResult?.cancelled) return;
          const candidates = [bestResult?.best, ...(bestResult?.candidates || [])]
            .filter(candidate => candidate?.url && candidate?.anime && candidate?.episode)
            .filter((candidate, index, items) => items.findIndex(item => (
              item.sourceId === candidate.sourceId && item.url === candidate.url
            )) === index)
            .slice(0, 4);
          for (const candidate of candidates) {
            if (!isLatestPlayRequest()) return;
            const candidateAnime = {
              ...candidate.anime,
              source: candidate.anime?.source || candidate.sourceId,
              sourceId: candidate.sourceId || candidate.anime?.sourceId,
              providerId: candidate.providerId || candidate.anime?.providerId || `cms:${candidate.sourceId}`,
              sourceType: candidate.anime?.sourceType || 'cms',
              sourceName: candidate.sourceName || candidate.anime?.sourceName
            };
            const candidateEpisode = {
              ...candidate.episode,
              title: candidate.episode?.title || episode.title,
              url: candidate.episode?.url || candidate.url
            };
            const resolved = hasPlaybackResolver
              ? await window.electronAPI.playbackResolve(
                  this.createPlaybackResolvePayload(candidateAnime, candidateEpisode)
                )
              : { success: true, url: candidate.url };
            if (!isLatestPlayRequest()) return;
            if (!resolved?.success || !resolved.url) {
              lastResolveFailure = resolved;
              continue;
            }
            resolvedVideo = hasPlaybackResolver ? resolved : null;
            videoUrl = resolved.url;
            anime = candidateAnime;
            episode = candidateEpisode;
            episodeIndex = candidateEpisode.index ?? episodeIndex;
            lineId = candidate.lineId || lineId;
            break;
          }
        } catch (err) {
          lastResolveFailure = { error: err?.message || String(err) };
        }
      }

      if (!videoUrl || videoUrl.includes('/share/')) {
        if (!isLatestPlayRequest()) return;
        const failureMessage = lastResolveFailure?.error || '已配置片源中没有可用的同集视频';
        await updatePlayerPreparation(window.electronAPI, playerWindowId, {
          title: pendingTitle, error: failureMessage
        }).catch(() => false);
        if (this.openingEpisodeKey === openingKey) this.openingEpisodeKey = '';
        this._pendingPlayerWindowId = null;
        this.$notify?.error('播放失败', failureMessage);
        return;
      }

      if (!isLatestPlayRequest()) return;
      this.detailAnime = null;

      const perfMark = window.__perf?.start('player-open');
      try {
        const safeAnime = this.toPlainObject(anime);
        const safeEpisode = this.toPlainObject(episode);
        const videoData = {
          title: `${safeAnime.name} - ${safeEpisode.title}`,
          url: videoUrl,
          anime: safeAnime,
          episode: { title: safeEpisode.title, url: safeEpisode.url, id: safeEpisode.id, index: episodeIndex },
          episodeId: safeEpisode.id || safeEpisode.url,
          lineId: lineId || '',
          playPosition: Math.max(0, Number(playPosition) || 0),
          resolvedVideo: this.toPlainObject(resolvedVideo)
        };

        // 优先用独立播放窗口（边看边找），回退到路由跳转
        if (window.electronAPI?.openPlayerWindow) {
          // 播放窗口是独立 Vue 实例，通过 IPC 传递数据，无需主窗口 dispatch
          if (!isLatestPlayRequest()) return;
          let updated = false;
          updated = await updatePlayerPreparation(window.electronAPI, playerWindowId, videoData);
          if (!updated) {
            await window.electronAPI.openPlayerWindow(videoData);
          }
        } else {
          if (!isLatestPlayRequest()) return;
          await this.$store.dispatch('player/playVideo', videoData);
          this.$router.push({ name: 'video-player' });
        }
        if (this.openingEpisodeKey === openingKey) this.openingEpisodeKey = '';
        this._pendingPlayerWindowId = null;
        window.__perf?.end(perfMark, { source: safeAnime.source || '', episode: episodeIndex });
      } catch (err) {
        window.__perf?.end(perfMark, { failed: true });
        if (!isLatestPlayRequest()) return;
        console.error('[DetailModal] 打开播放器失败:', err);
        await updatePlayerPreparation(window.electronAPI, playerWindowId, {
          title: pendingTitle, error: '播放器初始化失败，请关闭窗口后重试。'
        }).catch(() => false);
        if (this.openingEpisodeKey === openingKey) this.openingEpisodeKey = '';
        this._pendingPlayerWindowId = null;
        this.$notify?.error('播放失败', '请重试或切换其他分集');
      }
    }
  }
};
