<template>
  <div class="my-favorites">
    <!-- 顶栏 -->
    <PageHeader title="我的追番" subtitle="MY WATCHLIST / 私藏放映单">
      <template #icon>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0-.1-7.7Z"/>
        </svg>
      </template>
      <span class="fav-count" v-if="favoriteTotal > 0">共 {{ favoriteTotal }} 部</span>
      <template #actions>
        <span v-if="lastCheckTime" class="fav-last-check">上次检查：{{ formatCheckTime(lastCheckTime) }}</span>
        <span v-if="unreadReminderCount > 0" class="fav-unread-tip">{{ unreadReminderCount }} 条新更新</span>
        <button class="check-update-btn" :disabled="reminderChecking || favoriteTotal === 0" @click="onCheckUpdates">
          <span v-if="reminderChecking">检查中…</span>
          <span v-else>🔍 检查更新</span>
        </button>
      </template>
    </PageHeader>

    <!-- 加载中 -->
    <template v-if="favoriteLoading">
      <div class="anime-loading-stage" aria-hidden="true">
        <div class="anime-loading-mascot"></div>
        <div class="anime-loading-bubble">
          <span>樱月正在整理追番</span>
          <i></i><i></i><i></i>
        </div>
      </div>
      <div class="anime-grid">
        <div v-for="i in 6" :key="'s'+i" class="anime-card skeleton">
          <div class="anime-poster skeleton-shimmer"></div>
          <div class="anime-details">
            <div class="skeleton-line skeleton-shimmer" style="width:70%;height:16px;margin-bottom:8px"></div>
            <div class="skeleton-line skeleton-shimmer" style="width:50%;height:12px"></div>
          </div>
        </div>
      </div>
    </template>

    <!-- 收藏列表 -->
    <div v-else-if="favoriteList.length > 0" class="anime-grid">
      <div v-for="anime in renderedFavoriteList" :key="`${anime.source}:${anime.anime_id}`" @click="openFavoriteDetail(anime)" @keydown.enter.prevent="openFavoriteDetail(anime)" class="anime-card" role="button" tabindex="0">
        <div class="anime-poster">
          <CachedImage
            v-if="anime.cover && !failedImageIds.has(anime.anime_id)"
            :src="anime.cover"
            :alt="anime.name"
            cache-variant="thumbnail"
            :cache-width="360"
            data-cache-resolve="true"
            width="360"
            height="508"
            loading="lazy"
            decoding="async"
            fetchpriority="low"
            @error="onImageError(anime.anime_id)"
          />
          <div v-else class="no-cover-placeholder">
            <span>{{ (anime.name || '').slice(0, 4) }}</span>
          </div>
          <div class="anime-overlay">
            <span class="anime-year-badge" v-if="anime.year">{{ anime.year }}</span>
          </div>
          <span v-if="totalEpisodeBadgeText(anime)" class="anime-ep-total-badge">{{ totalEpisodeBadgeText(anime) }}</span>
          <span v-if="updatedEpisodeBadgeText(anime)" class="anime-ep-badge">{{ updatedEpisodeBadgeText(anime) }}</span>
          <span class="anime-source-badge">{{ sourceLabel(anime.source) }}</span>
          <!-- 取消收藏按钮 -->
          <button
            class="fav-btn favorited"
            :class="{ 'fav-btn-busy': removingFavoriteId === `${anime.source}:${anime.anime_id}` }"
            :disabled="removingFavoriteId === `${anime.source}:${anime.anime_id}`"
            @click.stop="onRemoveFavorite(anime)"
            title="取消收藏"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#fb7299" stroke="#fff" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>

        <div class="anime-details">
          <h3 class="anime-title" :title="anime.name">{{ anime.name }}</h3>
          <!-- 观看进度 -->
          <div v-if="anime.last_episode" class="anime-progress">
            <div class="progress-bar">
              <div class="progress-fill" :style="progressStyle(anime)"></div>
            </div>
            <span class="progress-text">{{ anime.last_episode }}</span>
          </div>
          <div class="anime-meta">
            <span v-if="anime.area" class="anime-area">{{ anime.area }}</span>
            <template v-if="anime.type?.length">
              <span v-for="t in displayTypes(anime.type)" :key="t" class="anime-type-tag">{{ t }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <EmptyState
      v-else
      title="追番列表空空的呢 (´•ω•`)"
      message="去番剧库把喜欢的番剧收进放映单，樱月帮你盯着更新哦"
    >
      <template #action>
        <button @click="$router.push({ name: 'anime-zone' })" class="go-browse-btn">去逛番剧库 ♡</button>
      </template>
    </EmptyState>

    <!-- 分页（复用 AnimeZone 的 Pagination 组件） -->
    <Pagination
      v-if="favoriteTotalPages > 1 && !favoriteLoading"
      :current-page="favoritePage"
      :total-pages="favoriteTotalPages"
      @change="changePage"
    />

    <!-- 详情弹窗：原地打开，不再跳转番剧库 -->
    <AnimeDetail
      v-if="detailAnime"
      :anime="detailAnime"
      :isFavorited="isAnimeFavorited(detailAnime)"
      :opening-episode-key="openingEpisodeKey"
      @close="closeDetail"
      @toggle-fav="onToggleFavorite"
      @play-episode="onPlayEpisode"
    />
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import Pagination from '../components/AnimeZone/Pagination.vue';
import CachedImage from '../components/Common/CachedImage.vue';
import AnimeDetail from '../components/AnimeZone/AnimeDetail.vue';
import PageHeader from '../components/Common/PageHeader.vue';
import EmptyState from '../components/Common/EmptyState.vue';
import animeDetailModal from '../mixins/animeDetailModal.js';
import {
  plannedEpisodeCount,
  availableEpisodeCount,
  airedEpisodeCount
} from '../utils/episodeMetadata.js';

export default {
  name: 'MyFavorites',
  mixins: [animeDetailModal],
  components: { Pagination, CachedImage, AnimeDetail, PageHeader, EmptyState },
  data() {
    return {
      failedImageIds: new Set(),
      visibleFavoriteLimit: 16,
      // 正在取消收藏的条目 key（source:anime_id，防连点）
      removingFavoriteId: null,
      _renderListFrame: null,
      _renderListTimer: null,
      _lastFavoriteListSignature: ''
    };
  },
  computed: {
    ...mapGetters('favorite', [
      'favoriteList',
      'favoriteTotal',
      'favoritePage',
      'favoriteTotalPages',
      'favoriteLoading'
    ]),
    ...mapGetters('anime', ['cmsMultiSources']),
    ...mapGetters('reminder', ['lastCheckTime', 'checking', 'unreadCount']),
    // 建立 source ID -> displayName 的映射，用于收藏列表的来源标签脱敏
    sourceDisplayNameMap() {
      const map = {};
      (this.cmsMultiSources || []).forEach(s => {
        if (s.id) map[s.id] = s.displayName || s.name;
      });
      return map;
    },
    renderedFavoriteList() {
      return this.favoriteList.slice(0, this.visibleFavoriteLimit);
    },
    // 提醒相关计算属性（加前缀避免与 favorite 模块冲突）
    reminderChecking() {
      return this.checking;
    },
    unreadReminderCount() {
      return this.unreadCount;
    }
  },
  watch: {
    favoriteList: {
      handler(list) {
        const signature = this.getFavoriteListSignature(list);
        if (signature === this._lastFavoriteListSignature) return;
        // 纯删除场景（取消收藏）：已展开的渲染数量足够覆盖新列表时跳过重置，避免卡片闪烁重排
        const prevLength = this._lastFavoriteListLength ?? 0;
        this._lastFavoriteListLength = list.length;
        this._lastFavoriteListSignature = signature;
        if (list.length < prevLength && this.visibleFavoriteLimit >= list.length) {
          this.cancelProgressiveRender();
          return;
        }
        this.resetProgressiveRender();
      },
      immediate: true
    },
    favoriteLoading(isLoading) {
      if (isLoading) {
        this.cancelProgressiveRender();
      }
    }
  },
  methods: {
    ...mapActions('favorite', [
      'fetchFavoriteList',
      'removeFavorite'
    ]),

    getFavoriteListSignature(list = this.favoriteList) {
      return (list || [])
        .map(item => `${item?.source || ''}:${item?.anime_id || ''}`)
        .join('|');
    },

    resetProgressiveRender() {
      this.cancelProgressiveRender();
      const total = this.favoriteList.length;
      const firstBatch = Math.min(total, 16);
      this.visibleFavoriteLimit = firstBatch;
      if (firstBatch < total) {
        this.scheduleProgressiveRender();
      }
    },

    cancelProgressiveRender() {
      if (this._renderListFrame) {
        cancelAnimationFrame(this._renderListFrame);
        this._renderListFrame = null;
      }
      if (this._renderListTimer) {
        clearTimeout(this._renderListTimer);
        this._renderListTimer = null;
      }
    },

    scheduleProgressiveRender() {
      if (this._renderListFrame || this._renderListTimer) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const delay = pressure === 'high' ? 90 : 34;

      this._renderListTimer = setTimeout(() => {
        this._renderListTimer = null;
        this._renderListFrame = requestAnimationFrame(() => {
          this._renderListFrame = null;
          this.growVisibleFavoriteList();
        });
      }, delay);
    },

    growVisibleFavoriteList() {
      const total = this.favoriteList.length;
      if (this.visibleFavoriteLimit >= total) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const batchSize = pressure === 'high' ? 6 : 8;
      this.visibleFavoriteLimit = Math.min(total, this.visibleFavoriteLimit + batchSize);
      if (this.visibleFavoriteLimit < total) {
        this.scheduleProgressiveRender();
      }
    },

    sourceLabel(source) {
      // 优先使用 CMS 多源的脱敏展示名（默认资源/源二/源三...）
      if (source && this.sourceDisplayNameMap[source]) {
        return this.sourceDisplayNameMap[source];
      }
      // 非多源模式的回退标签（非凡资源网模式/Bangumi/AniList/本地）
      const labels = {
        ffzy: '非凡', fanzhi: '非凡',
        bangumi: '资料', anilist: '资料', cms: 'CMS',
        local: '本地'
      };
      return labels[source] || source || '未知';
    },

    displayTypes(type) {
      const arr = Array.isArray(type) ? type : [type];
      const bigCats = ['日韩动漫', '国产动漫', '欧美动漫', '港台动漫', '海外动漫', '全部动漫'];
      return arr.filter(t => t && !bigCats.includes(t)).slice(0, 2);
    },

    getPlannedEpisodeCount(anime) {
      return plannedEpisodeCount(anime);
    },

    getAvailableEpisodeCount(anime) {
      return availableEpisodeCount(anime);
    },

    getAiredEpisodeCount(anime) {
      return airedEpisodeCount(anime);
    },

    getUpdatedEpisodeCount(anime) {
      return this.getAvailableEpisodeCount(anime) || this.getAiredEpisodeCount(anime);
    },

    totalEpisodeBadgeText(anime) {
      const total = this.getPlannedEpisodeCount(anime) || this.getAvailableEpisodeCount(anime);
      return total > 0 ? `共${total}集` : '';
    },

    updatedEpisodeBadgeText(anime) {
      const updated = this.getUpdatedEpisodeCount(anime);
      return updated > 0 ? `更新${updated}集` : '';
    },

    progressStyle(anime) {
      if (!anime.episode_count || anime.episode_count <= 0) return { width: '0%' };
      const idx = anime.last_episode_index ?? -1;
      if (idx < 0) return { width: '0%' };
      const pct = Math.min(100, Math.round(((idx + 1) / anime.episode_count) * 100));
      return { width: pct + '%' };
    },

    onImageError(animeId) {
      this.failedImageIds.add(animeId);
      this.failedImageIds = new Set(this.failedImageIds);
    },

    async onRemoveFavorite(anime) {
      if (this.removingFavoriteId) return;
      this.removingFavoriteId = `${anime.source}:${anime.anime_id}`;
      try {
        const source = anime.source || 'legacy';
        const ok = await this.removeFavorite({ id: anime.anime_id, source });
        if (ok) {
          // 即时从列表移除，无需手动刷新
          this.$store.commit('favorite/REMOVE_FAVORITE_FROM_LIST', { id: anime.anime_id, source });
          this.$notify?.success?.('已取消收藏', anime.name || '');
        } else {
          this.$notify?.error?.('操作失败', '取消收藏失败，请重试');
        }
      } finally {
        this.removingFavoriteId = null;
      }
    },

    /**
     * 手动触发一次番剧更新检查
     */
    async onCheckUpdates() {
      if (this.reminderChecking || this.favoriteTotal === 0) return;
      const result = await this.$store.dispatch('reminder/checkUpdates');
      const newCount = result?.newReminders?.length || 0;
      if (newCount > 0) {
        this.$notify.success('发现新更新', `检测到 ${newCount} 部番剧有新集数`);
      } else if (result?.error) {
        this.$notify.error('检查失败', result.error);
      } else {
        this.$notify.info('检查完成', '暂无新更新');
      }
    },

    /**
     * 格式化上次检查时间
     */
    formatCheckTime(ts) {
      if (!ts) return '';
      const now = Date.now();
      const diff = now - Number(ts);
      if (diff < 0) return '刚刚';
      if (diff < 60 * 1000) return '刚刚';
      if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
      if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
      const d = new Date(Number(ts));
      const pad = n => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },

    async changePage(page) {
      if (page >= 1 && page <= this.favoriteTotalPages && page !== this.favoritePage) {
        await this.fetchFavoriteList({ page });
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'auto' });
      }
    },

    /**
     * 点击收藏卡片：原地打开详情弹窗（mixin 提供），不再跳转番剧库
     * 收藏列表项的主键是 anime_id，先映射为 mixin 期望的 id 字段
     */
    openFavoriteDetail(anime) {
      this.viewAnimeDetail({
        ...anime,
        id: anime.anime_id || anime.id,
        source: anime.source || 'legacy'
      });
    }
  },
  async mounted() {
    // 确保源列表已加载，用于收藏卡片来源标签的脱敏展示
    if (!this.cmsMultiSources || this.cmsMultiSources.length === 0) {
      try {
        await this.$store.dispatch('anime/loadCmsMultiSources');
      } catch (e) {
        // 加载失败不影响收藏列表展示
      }
    }
    await this.fetchFavoriteList({ page: 1 });
    // 拉取一次更新提醒列表，用于展示上次检查时间与未读数
    try {
      await this.$store.dispatch('reminder/loadReminders');
    } catch (e) {
      // 提醒加载失败不影响收藏页使用
    }
  },
  beforeUnmount() {
    this.cancelProgressiveRender();
  }
};
</script>

<style scoped>
.my-favorites {
  padding: 0 24px 28px;
  min-height: 100vh;
  position: relative;
}

/* ── 顶栏（结构统一使用 Common/PageHeader，仅保留业务专属样式） ── */
.fav-count {
  font-size: 13px;
  color: var(--primary-color);
  font-weight: 500;
}

.fav-last-check {
  font-size: 12px;
  color: var(--text-tertiary);
}

.fav-unread-tip {
  font-size: 12px;
  color: #fff;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  padding: 3px 10px;
  border-radius: 10px;
  font-weight: 500;
}

.check-update-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 16px;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  color: var(--text-inverse);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.2s var(--ease-smooth), opacity 0.2s var(--ease-smooth);
  min-width: 96px;
}

.check-update-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--primary-hover), var(--primary-color));
}

.check-update-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ── 动漫网格 ── */
.anime-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 20px;
  padding-top: 16px;
}

/* ── 动漫卡片 ── */
.anime-card {
  background: var(--bg-card-glass);
  border: 1px solid rgba(var(--primary-rgb), 0.1);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 8px 22px rgba(160, 74, 118, 0.08);
  transition: transform 0.16s var(--ease-smooth), border-color 0.16s var(--ease-smooth), background-color 0.16s var(--ease-smooth);
  contain: layout style paint;
}

.anime-card:hover {
  transform: translateY(-2px);
  border-color: rgba(var(--primary-rgb), 0.34);
}

/* ── 海报区 ── */
.anime-poster {
  position: relative;
  width: 100%;
  padding-top: 133%;
  overflow: hidden;
  background: var(--bg-elevated);
}

.anime-poster img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  contain: layout paint;
}

.anime-card:hover .anime-poster img {
  transform: none;
}

.no-cover-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  background:
    radial-gradient(circle at 50% 24%, rgba(255, 255, 255, 0.72), transparent 32%),
    linear-gradient(135deg, rgba(var(--primary-rgb), 0.16) 0%, rgba(66, 199, 238, 0.14) 100%),
    var(--bg-elevated);
  color: var(--primary-color);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1px;
  user-select: none;
  text-shadow: none;
}

.no-cover-placeholder::before {
  content: '';
  width: 58%;
  max-width: 86px;
  aspect-ratio: 1;
  background: var(--sakura-charm-image) center / contain no-repeat;
  filter: drop-shadow(0 10px 18px rgba(var(--primary-rgb), 0.18));
  opacity: 0.94;
}

.no-cover-placeholder span {
  max-width: 82%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.anime-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to bottom, transparent 70%, rgba(0,0,0,0.6));
  pointer-events: none;
}

.anime-year-badge {
  position: absolute;
  bottom: 30px;
  left: 6px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
}

.anime-ep-total-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  background: rgba(var(--primary-rgb), 0.86);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 700;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}

.anime-ep-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(36, 177, 112, 0.9);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 700;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}

.anime-source-badge {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(var(--primary-rgb), 0.85);
  color: #fff;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
  pointer-events: none;
}

/* ── 收藏按钮 ── */
.fav-btn {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: rgba(var(--primary-rgb), 0.85);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s var(--ease-smooth), transform 0.2s var(--ease-smooth), opacity 0.2s var(--ease-smooth);
  z-index: 2;
  padding: 0;
}

.fav-btn:hover {
  background: var(--primary-hover);
  transform: scale(1.15);
}

.fav-btn:active {
  transform: scale(0.92);
}

/* 取消收藏执行中：半透明 + 禁止交互 */
.fav-btn.fav-btn-busy,
.fav-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  pointer-events: none;
}

/* ── 卡片信息 ── */
.anime-details {
  padding: 10px 10px 12px;
}

.anime-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 4px 0;
  color: var(--text-primary);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}

/* ── 观看进度 ── */
.anime-progress {
  margin-bottom: 6px;
}

.progress-bar {
  height: 4px;
  background: var(--border-color);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 3px;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-cyan));
  border-radius: 2px;
  transition: width 0.16s var(--ease-smooth);
}

.progress-text {
  font-size: 10px;
  color: var(--primary-color);
  font-weight: 500;
}

.anime-meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-tertiary);
}

.anime-ep-text {
  padding: 1px 6px;
  background: rgba(40, 167, 69, 0.1);
  color: var(--success-color);
  border-radius: 4px;
  font-weight: 600;
}

.anime-area {
  padding: 1px 6px;
  background: var(--primary-lighter);
  border-radius: 4px;
}

.anime-type-tag {
  padding: 1px 6px;
  background: var(--tag-bg);
  color: var(--primary-color);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
}

/* 加载动效（anime-loading-stage / skeleton / shimmer / loading-dot）已抽取到 main.css 全局共享样式 */

/* ── 空状态（结构统一使用 Common/EmptyState，仅保留动作按钮样式） ── */
.go-browse-btn {
  padding: 10px 28px;
  background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
  color: var(--text-inverse);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.2s;
}

.go-browse-btn:hover {
  background: linear-gradient(135deg, var(--primary-hover), var(--primary-color));
}

/* ── 响应式 ── */
@media (max-width: 768px) {
  .anime-grid {
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 12px;
  }
}
</style>
