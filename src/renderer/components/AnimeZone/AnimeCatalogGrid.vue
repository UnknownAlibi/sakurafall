<template>
  <section class="anime-list-section" aria-live="polite">
    <template v-if="loading">
      <!-- 骨架屏直接呈现内容形状，无需额外吉祥物占位 -->
      <div class="anime-grid" :class="{ 'skeleton-fade-in': skeletonVisible }">
        <div
          v-for="index in 12"
          :key="`s${index}`"
          class="anime-card skeleton"
          :style="{ animationDelay: `${((index - 1) % 6) * 55}ms` }"
        >
          <div class="anime-poster skeleton-shimmer"></div>
          <div class="anime-details">
            <div class="skeleton-line skeleton-shimmer skeleton-title"></div>
            <div class="skeleton-line skeleton-shimmer skeleton-meta"></div>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="animeList.length" class="anime-grid" :class="{ 'virtual-grid': virtualized }">
      <div v-if="virtualized && topSpacer > 0" class="anime-grid-spacer" :style="{ height: `${topSpacer}px` }"></div>
      <article
        v-for="(anime, index) in renderedList"
        v-memo="[anime, isFavorited(anime), isImageFailed(anime.id)]"
        :key="`${anime.source || 'anime'}:${anime.id}`"
        :data-anime-id="anime.id"
        :data-anime-key="animeKey(anime)"
        class="anime-card"
        :style="cardEnterStyle(index)"
        role="button"
        tabindex="0"
        @click="$emit('view', anime)"
        @keydown.enter.prevent="$emit('view', anime)"
      >
        <div class="anime-poster">
          <CachedImage
            v-if="anime.cover && !isImageFailed(anime.id)"
            :src="anime.cover"
            :alt="anime.name"
            cache-variant="thumbnail"
            :cache-width="480"
            data-cache-resolve="true"
            width="360"
            height="508"
            :loading="coverLoading(index)"
            decoding="async"
            :fetchpriority="coverFetchPriority(index)"
            @error="$emit('image-error', anime.id)"
            @load="$emit('image-load', $event, anime.id)"
          />
          <div v-else class="no-cover-placeholder"><span>{{ String(anime.name || '').slice(0, 4) }}</span></div>
          <div class="anime-overlay"></div>
          <span class="anime-ep-total-badge" :class="{ pending: !totalBadge(anime) }">
            {{ totalBadge(anime) || '总集数待定' }}
          </span>
          <span class="anime-ep-badge" :class="{ pending: !updatedBadge(anime) }">
            {{ updatedBadge(anime) || '进度同步中' }}
          </span>
          <span v-if="(anime.source === 'bangumi' || anime.source === 'anilist') && anime.rating" class="anime-rating-badge">★ {{ formatRating(anime.rating) }}</span>
          <button
            class="fav-btn"
            :class="{ favorited: isFavorited(anime) }"
            :title="isFavorited(anime) ? '取消收藏' : '收藏'"
            @click.stop="$emit('toggle-favorite', anime)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" :fill="isFavorited(anime) ? '#fb7299' : 'none'" stroke="#fb7299" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
        <div class="anime-details">
          <h3 class="anime-title" :title="anime.name">{{ anime.name }}</h3>
          <div class="anime-meta">
            <span v-if="anime.year" class="anime-year">{{ anime.year }}</span>
            <span v-if="anime.area" class="anime-area">{{ anime.area }}</span>
            <span v-for="type in displayTypes(anime.type)" :key="type" class="anime-type-tag">{{ type }}</span>
          </div>
        </div>
      </article>
      <div v-if="virtualized && bottomSpacer > 0" class="anime-grid-spacer" :style="{ height: `${bottomSpacer}px` }"></div>
    </div>

    <div v-else class="empty-state">
      <div class="empty-art" aria-hidden="true"></div>
      <div class="empty-icon">{{ loadError ? '!' : '◇' }}</div>
      <h3>{{ loadError ? '加载失败' : (searchKeyword ? '未找到相关动漫' : '暂无动漫数据') }}</h3>
      <p>{{ loadError || (searchKeyword ? '换个关键词试试' : '暂时没有可显示的条目') }}</p>
      <button class="refresh-btn" @click="$emit('retry')">{{ loadError ? '重试' : (searchKeyword ? '清除搜索' : '刷新数据') }}</button>
    </div>
  </section>
</template>

<script>
import CachedImage from '../Common/CachedImage.vue';
import { totalEpisodeBadge, updatedEpisodeBadge } from '../../utils/episodeMetadata.js';

const BIG_CATEGORIES = new Set(['日韩动漫', '国产动漫', '欧美动漫', '港台动漫', '海外动漫', '全部动漫']);

export default {
  name: 'AnimeCatalogGrid',
  components: { CachedImage },
  props: {
    loading: Boolean,
    animeList: { type: Array, default: () => [] },
    renderedList: { type: Array, default: () => [] },
    virtualized: Boolean,
    topSpacer: { type: Number, default: 0 },
    bottomSpacer: { type: Number, default: 0 },
    favoriteMap: { type: Object, default: () => ({}) },
    failedImageIds: { type: Object, default: () => new Set() },
    searchKeyword: { type: String, default: '' },
    loadError: { type: String, default: '' }
  },
  emits: ['view', 'toggle-favorite', 'image-error', 'image-load', 'retry', 'card-visible'],
  data() {
    return {
      _visibilityObserver: null,
      _visibilityFrame: null,
      _visibilityFallbackEmitted: false,
      skeletonVisible: false
    };
  },
  mounted() {
    this.refreshSkeletonFade();
    this.scheduleVisibilityObserver();
  },
  activated() {
    this.scheduleVisibilityObserver();
  },
  deactivated() {
    this.cancelSkeletonAnimations();
    this.resetVisibilityObserver();
  },
  updated() {
    this.refreshSkeletonFade();
    this.scheduleVisibilityObserver();
  },
  watch: {
    loading(value) {
      if (value) {
        this.resetVisibilityObserver();
        this.skeletonVisible = false;
      } else {
        this.cancelSkeletonAnimations();
        this.scheduleVisibilityObserver();
      }
      this.refreshSkeletonFade();
    }
  },
  beforeUnmount() {
    this.cancelSkeletonAnimations();
    if (this._visibilityFrame !== null) {
      cancelAnimationFrame(this._visibilityFrame);
      this._visibilityFrame = null;
    }
    this._visibilityObserver?.disconnect();
    this._visibilityObserver = null;
  },
  methods: {
    totalBadge: totalEpisodeBadge,
    updatedBadge: updatedEpisodeBadge,
    formatRating(value) {
      const rating = Number(value);
      return Number.isFinite(rating) ? rating.toFixed(1) : value;
    },
    // 卡片入场保持轻微错峰，但首屏最后一张不再晚约四分之一秒出现。
    cardEnterStyle(index) {
      const delay = Math.min(index, 6) * 16;
      return { '--enter-delay': `${delay}ms` };
    },
    // skeleton 淡入：loading 显现后下一帧触发 opacity 0 -> 1
    refreshSkeletonFade() {
      if (!this.loading || this.skeletonVisible) return;
      this.$nextTick(() => {
        if (this.loading) this.skeletonVisible = true;
      });
    },
    cancelSkeletonAnimations() {
      const grid = this.$el?.querySelector?.('.anime-grid.skeleton-fade-in');
      if (!grid) return;
      const animations = typeof grid.getAnimations === 'function'
        ? grid.getAnimations({ subtree: true })
        : [];
      animations.forEach(animation => animation.cancel());
    },
    isImageFailed(id) {
      return this.failedImageIds?.has?.(id) || this.failedImageIds?.has?.(String(id));
    },
    isFavorited(anime) {
      return !!this.favoriteMap[`${anime.source || 'legacy'}:${anime.id}`];
    },
    animeKey(anime) {
      return `${anime?.source || 'anime'}:${anime?.id}`;
    },
    coverLoading(index) {
      // 虚拟窗口移动时不能让新挂载的一整行封面重新抢占高优先级解码。
      if (this.virtualized) return 'lazy';
      return index < 12 ? 'eager' : 'lazy';
    },
    coverFetchPriority(index) {
      if (this.virtualized) return 'low';
      return index < 12 ? 'high' : 'low';
    },
    scheduleVisibilityObserver() {
      if (this.loading || this.renderedList.length === 0 || this._visibilityFrame !== null) return;
      this._visibilityFrame = requestAnimationFrame(() => {
        this._visibilityFrame = null;
        this.observeVisibleCards();
      });
    },
    resetVisibilityObserver() {
      this._visibilityObserver?.disconnect();
      this._visibilityObserver = null;
      this._visibilityFallbackEmitted = false;
      this.$el?.querySelectorAll?.('.anime-card[data-visibility-observed]').forEach(card => {
        delete card.dataset.visibilityObserved;
      });
    },
    observeVisibleCards() {
      const cards = Array.from(this.$el.querySelectorAll('.anime-card[data-anime-key]'));
      if (cards.length === 0) return;

      if (typeof window.IntersectionObserver !== 'function') {
        if (!this._visibilityFallbackEmitted) {
          this._visibilityFallbackEmitted = true;
          // 回退路径：直接让所有可见卡片进入已入场状态，避免一直停留在 opacity:0
          cards.forEach(card => card.classList.add('card-entered'));
          this.renderedList.slice(0, 12).forEach(anime => this.$emit('card-visible', anime));
        }
        return;
      }

      if (!this._visibilityObserver) {
        const scrollRoot = document.querySelector('.main-content');
        const root = scrollRoot?.contains(cards[0]) ? scrollRoot : null;
        this._visibilityObserver = new IntersectionObserver(entries => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            this._visibilityObserver?.unobserve(entry.target);
            entry.target.dataset.visibilityObserved = 'done';
            // 进入视口：添加 card-entered 类触发入场过渡
            entry.target.classList.add('card-entered');
            const anime = this.renderedList.find(item => this.animeKey(item) === entry.target.dataset.animeKey);
            if (anime) this.$emit('card-visible', anime);
          });
        }, {
          root,
          rootMargin: '320px 0px',
          threshold: 0.01
        });
      }

      cards.forEach(card => {
        if (card.dataset.visibilityObserved) return;
        card.dataset.visibilityObserved = 'pending';
        this._visibilityObserver.observe(card);
      });
    },
    displayTypes(value) {
      const items = Array.isArray(value) ? value : [value];
      return items
        .map(type => {
          // Bangumi 原始 API 的 type 是整数（2=动画），本地索引也存整数，
          // 过滤掉纯数字值，避免卡片上显示 "2"
          const str = String(type ?? '').trim();
          if (!str || /^\d+$/.test(str)) return null;
          return str;
        })
        .filter(type => type && !BIG_CATEGORIES.has(type))
        .slice(0, 2);
    }
  }
};
</script>

<style scoped>
.anime-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 20px; padding-top: 20px; }
.anime-grid.virtual-grid { align-items: start; }
.anime-grid-spacer { grid-column: 1 / -1; min-height: 0; pointer-events: none; }
.anime-card { min-width: 0; overflow: hidden; border: 1px solid transparent; border-radius: var(--radius-lg); background: var(--bg-card); box-shadow: var(--shadow-sm); cursor: pointer; contain: layout paint style; transition: opacity 0.3s var(--ease-smooth), transform 0.3s var(--ease-smooth), border-color 0.18s ease, box-shadow 0.18s ease; transition-delay: var(--enter-delay, 0ms); }
/* 真实卡片入场前隐藏（skeleton 不参与入场，单独淡入） */
.anime-card:not(.card-entered):not(.skeleton) { opacity: 0; transform: translateY(16px) scale(0.98); }
.anime-card.card-entered { opacity: 1; transform: translateY(0) scale(1); }
.anime-card.card-entered:hover { transform: translateY(-4px); border-color: rgba(240, 100, 141, 0.35); box-shadow: var(--shadow-anime); transition-duration: 0.18s; transition-delay: 0ms; }
.anime-card.card-entered:active { transform: scale(0.98); transition-duration: 0.1s; transition-delay: 0ms; }
.anime-card:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
/* 滚动中/高压状态下挂载的卡片直接就位：连续滚动时虚拟窗口每平移一次会
   批量挂载约 24 张卡片，若每张都跑 300ms 入场过渡 + 封面 0.2s 淡入，
   会形成持续的合成层提升与光栅化churn（大窗口下尤为明显）。
   停止滚动后规则失效，未入场卡片恢复正常入场动画。 */
[data-scroll-state="scrolling"] .anime-card,
[data-performance-pressure="high"] .anime-card,
[data-scroll-state="scrolling"] .anime-card :deep(img),
[data-performance-pressure="high"] .anime-card :deep(img) { transition: none !important; }
.anime-poster { position: relative; width: 100%; aspect-ratio: 360 / 508; overflow: hidden; background: var(--primary-light); }
.anime-poster :deep(img) { width: 100%; height: 100%; display: block; object-fit: cover; opacity: 0; transition: opacity 0.2s ease, transform 0.24s ease; }
.anime-poster :deep(img.loaded) { opacity: 1; }
.anime-card.card-entered:hover .anime-poster :deep(img) { transform: scale(1.025); }
.no-cover-placeholder { width: 100%; height: 100%; display: grid; place-items: center; padding: 14px; background: linear-gradient(160deg, rgba(var(--primary-rgb), 0.12), rgba(129, 117, 215, 0.1)); color: var(--text-secondary); font-size: 14px; font-weight: 600; text-align: center; }
.anime-overlay { position: absolute; inset: auto 0 0; height: 36%; background: linear-gradient(transparent, rgba(18, 20, 35, 0.66)); pointer-events: none; }
.anime-ep-total-badge,
.anime-ep-badge,
.anime-rating-badge { position: absolute; z-index: 2; padding: 3px 8px; border-radius: var(--radius-sm); color: #fff; font-size: 10.5px; font-weight: 700; line-height: 1.2; }
.anime-ep-total-badge { left: 7px; bottom: 7px; background: rgba(var(--primary-rgb), 0.9); }
.anime-ep-badge { top: 7px; right: 7px; min-width: 58px; text-align: center; background: rgba(25, 173, 123, 0.92); }
.anime-ep-badge.pending { background: rgba(27, 31, 52, 0.74); color: rgba(255, 255, 255, 0.82); }
.anime-ep-total-badge.pending { background: rgba(27, 31, 52, 0.68); color: rgba(255, 255, 255, 0.82); }
.anime-rating-badge { top: 7px; left: 7px; background: rgba(255, 154, 61, 0.94); }
.fav-btn { position: absolute; z-index: 3; right: 7px; bottom: 7px; width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: rgba(255, 255, 255, 0.92); box-shadow: 0 2px 8px rgba(18, 20, 35, 0.22); cursor: pointer; transition: transform 0.16s ease, background-color 0.16s ease; }
.fav-btn:hover { transform: scale(1.1); background: #fff; }
.anime-details { min-height: 82px; padding: 12px 12px 11px; }
.anime-title { min-height: 40px; margin: 0 0 8px; display: -webkit-box; overflow: hidden; color: var(--text-primary); font-size: 14.5px; font-weight: 600; line-height: 1.4; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.anime-meta { display: flex; gap: 6px; min-height: 20px; overflow: hidden; align-items: center; }
.anime-year,
.anime-area,
.anime-type-tag { max-width: 90px; overflow: hidden; padding: 2.5px 8px; border-radius: var(--radius-pill); background: var(--primary-light); color: var(--text-secondary); font-size: 10.5px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.anime-year { background: rgba(54, 189, 215, 0.1); color: var(--brand-cyan-deep); }
.anime-type-tag { color: var(--primary-color); }
.skeleton { pointer-events: none; opacity: 0.38; transition: opacity 0.22s var(--ease-smooth); }
.skeleton-fade-in .skeleton { opacity: 1; }
/* 骨架卡交错上浮入场：与真实卡片入场语言一致 */
.skeleton-fade-in .skeleton { animation: skeleton-card-in 0.5s var(--ease-smooth) both; }
@keyframes skeleton-card-in {
  from { opacity: 0.38; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.skeleton-title { width: 70%; height: 16px; margin-bottom: 8px; }
.skeleton-meta { width: 50%; height: 12px; }
.skeleton-shimmer { border-radius: 4px; background: linear-gradient(90deg, var(--primary-light), var(--bg-surface), var(--primary-light)); background-size: 200% 100%; animation: skeleton-shimmer 1.2s linear infinite; }
.empty-state { display: grid; place-items: center; min-height: 290px; padding: 36px; color: var(--text-secondary); text-align: center; }
.empty-state h3 { margin: 8px 0 4px; color: var(--text-primary); }
.empty-state p { margin: 0 0 14px; font-size: 12px; }
.empty-icon { width: 48px; height: 48px; display: grid; place-items: center; border: none; border-radius: 50%; background: var(--primary-light); color: var(--primary-color); font-size: 22px; }
.refresh-btn { padding: 8px 20px; border: none; border-radius: var(--radius-pill); background: var(--primary-color); color: #fff; font-weight: 600; cursor: pointer; }

@keyframes skeleton-shimmer { to { background-position: -200% 0; } }
@media (max-width: 1400px) { .anime-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
@media (max-width: 1100px) { .anime-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 860px) { .anime-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 640px) { .anime-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; } }
</style>
