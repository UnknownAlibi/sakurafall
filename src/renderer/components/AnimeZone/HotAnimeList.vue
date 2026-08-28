<template>
  <div v-if="items.length > 0" class="hot-section">
    <button
      type="button"
      class="section-header"
      :aria-expanded="String(!collapsed)"
      aria-controls="hot-anime-content"
      @click="toggleCollapsed"
    >
      <span class="section-title">
        <span class="section-icon hot-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22c4.4 0 8-3.6 8-8 0-3.5-2-6.6-5.2-9.5.1 2.2-.9 4-2.4 5.1.2-3.5-1.6-6.1-4.1-7.6.1 3.2-1.4 5.1-2.7 6.8C4.5 10.2 4 11.9 4 14c0 4.4 3.6 8 8 8Z"/>
            <path d="M9.5 17.5c0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5c0-1.1-.6-2.2-1.8-3.3 0 1-.5 1.7-1.2 2.1.1-1.4-.6-2.4-1.6-3-.1 1.8-.4 2.6-.4 4.2Z"/>
          </svg>
        </span>
        热播动漫
      </span>
      <span class="collapse-toggle">{{ collapsed ? '展开' : '收起' }} <span class="collapse-arrow" :class="{ expanded: !collapsed }">›</span></span>
    </button>
    <div class="collapsible-shell" :class="{ collapsed }">
      <div id="hot-anime-content" class="collapsible-body">
        <div class="hot-list">
        <div v-for="(anime, idx) in items" :key="anime.id"
          class="hot-card" role="button" tabindex="0" @click="$emit('view', anime)" @keydown.enter.prevent="$emit('view', anime)" @keydown.space.prevent="$emit('view', anime)">
          <span class="hot-rank" :class="{ 'top3': idx < 3 }">{{ idx + 1 }}</span>
          <div class="hot-cover">
            <CachedImage
              v-if="anime.cover && !failedImageIds.has(anime.id)"
              :src="anime.cover"
              :alt="anime.name"
              cache-variant="thumbnail"
              :cache-width="160"
              data-cache-resolve="true"
              width="160"
              height="214"
              loading="lazy"
              decoding="async"
              fetchpriority="low"
              @error="markImageFailed(anime.id)"
            />
            <div v-else class="hot-no-cover">{{ anime.name ? anime.name.slice(0, 1) : 'B' }}</div>
          </div>
          <div class="hot-info">
            <span class="hot-name" :title="anime.name">{{ anime.name }}</span>
            <div class="hot-meta">
              <span v-if="anime.rating" class="hot-rating">⭐ {{ anime.rating }}</span>
              <span v-if="anime.remarks" class="hot-remarks">{{ anime.remarks }}</span>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import CachedImage from '../Common/CachedImage.vue';

export default {
  name: 'HotAnimeList',
  components: { CachedImage },
  props: {
    items: {
      type: Array,
      default: () => []
    }
  },
  emits: ['view'],
  data() {
    return {
      collapsed: false,
      failedImageIds: new Set(),
      _imageRetriedIds: new Set(),
      _imageRetryTimers: new Set()
    };
  },
  watch: {
    items: {
      handler(list) {
        if (!list || !list.length) return;
        this.failedImageIds = new Set();
        this._imageRetriedIds = new Set();
      },
      immediate: true
    }
  },
  methods: {
    toggleCollapsed() {
      this.collapsed = !this.collapsed;
    },

    markImageFailed(id) {
      this.failedImageIds.add(id);
      this.failedImageIds = new Set(this.failedImageIds);
      // 8秒后允许重试一次（缓存可能已下载完成或网络恢复）
      if (this._imageRetriedIds.has(id)) return;
      this._imageRetriedIds.add(id);
      const timer = setTimeout(() => {
        this._imageRetryTimers.delete(timer);
        this.failedImageIds.delete(id);
        this.failedImageIds = new Set(this.failedImageIds);
      }, 8000);
      this._imageRetryTimers.add(timer);
    }
  },
  beforeUnmount() {
    this._imageRetryTimers.forEach(timer => clearTimeout(timer));
    this._imageRetryTimers.clear();
  }
};
</script>

<style scoped>
.hot-section {
  padding: 22px 0 18px;
  border-bottom: 1px solid var(--divider-color);
}

.section-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.section-header:hover .collapse-toggle {
  color: var(--primary-color);
}

.section-header:focus-visible,
.hot-card:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 3px;
}

.section-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
}

.section-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 22px;
  border-radius: 6px;
  color: #fff;
  background: #ff6b72;
  box-shadow: inset 0 -2px 0 rgba(29, 37, 84, 0.14);
}

.section-icon svg {
  width: 13px;
  height: 13px;
}

.collapse-toggle {
  font-size: 12px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: 2px;
}

.collapse-arrow {
  display: inline-block;
  font-size: 14px;
  font-weight: 700;
  transition: transform 0.18s ease;
}

.collapse-arrow.expanded {
  transform: rotate(90deg);
}

.collapsible-shell {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transition: grid-template-rows 0.22s ease, opacity 0.18s ease;
}

.collapsible-body {
  min-height: 0;
  overflow: hidden;
}

.collapsible-shell.collapsed {
  grid-template-rows: 0fr;
  opacity: 0;
  pointer-events: none;
}

.hot-list {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
  padding-bottom: 8px;
  /* 不用 overflow-x:auto 横向轮播：滚动容器会把整页竖向滚动逼退到主线程(整页卡顿)。
     改为换行布局，与主列表一致，由 GPU 合成器滚动。
     translateZ 把整组卡片缓存为纹理，滚动进视口时只合成不重绘。 */
  transform: translateZ(0);
}

.hot-list::-webkit-scrollbar {
  height: 3px;
}

.hot-list::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 2px;
}

.hot-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  min-width: 0;
  /* contain 让每张卡的绘制(含封面图)缓存为纹理，滚动时只搬纹理不重画，
     与主列表卡片一致——否则每帧主线程重新栅格化封面，造成 ~40ms 停顿。 */
  contain: layout style paint;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.hot-card:hover {
  transform: translateY(-1px);
  border-color: var(--primary-color);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
}

.hot-card:active {
  transform: translateY(0) scale(0.99);
}

.hot-rank {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hot-rank.top3 {
  background: var(--primary-color);
  color: #fff;
}

.hot-cover {
  width: 46px;
  height: 62px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-elevated);
  contain: strict;
}

.hot-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hot-no-cover {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 50% 26%, rgba(255, 255, 255, 0.7), transparent 35%),
    linear-gradient(135deg, rgba(var(--primary-rgb), 0.16), rgba(66, 199, 238, 0.13)),
    var(--bg-elevated);
  color: var(--primary-color);
  font-size: 16px;
  font-weight: 700;
}

.hot-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hot-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hot-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}

.hot-rating {
  color: #d99513;
  font-weight: 600;
}

@media (max-width: 1450px) { .hot-list { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
@media (max-width: 1050px) { .hot-list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 720px) { .hot-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

.hot-remarks {
  color: var(--primary-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
