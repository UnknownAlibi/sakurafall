<template>
  <div v-if="schedule.length > 0" class="schedule-section">
    <button
      type="button"
      class="section-header"
      :aria-expanded="String(!collapsed)"
      aria-controls="bangumi-schedule-content"
      @click="toggleCollapsed"
    >
      <span class="section-title">
        <span class="section-icon schedule-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="5" width="18" height="16" rx="2"/>
            <path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>
          </svg>
        </span>
        新番时间表
      </span>
      <span class="collapse-toggle">{{ collapsed ? '展开' : '收起' }} <span class="collapse-arrow" :class="{ expanded: !collapsed }">›</span></span>
    </button>
    <div class="collapsible-shell" :class="{ collapsed }">
      <div id="bangumi-schedule-content" class="collapsible-body">
      <div class="schedule-tabs">
        <button v-for="day in schedule" :key="day.weekday.id"
          :class="['schedule-tab', { active: activeTab === day.weekday.id, today: day.weekday.id === todayDay }]"
          @click="activeTab = day.weekday.id">
          {{ day.weekday.cn }}
          <span v-if="day.weekday.id === todayDay" class="today-dot"></span>
        </button>
      </div>
      <div class="schedule-grid">
        <div v-for="anime in renderedCurrentDayItems" :key="anime.id"
          v-memo="[anime.id, anime.cover, anime.name, anime.rating, anime.remarks]"
          class="schedule-card" role="button" tabindex="0" @click="$emit('view', anime)" @keydown.enter.prevent="$emit('view', anime)" @keydown.space.prevent="$emit('view', anime)">
          <div class="schedule-cover">
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
            <div v-else class="schedule-no-cover">{{ anime.name ? anime.name.slice(0, 1) : '新' }}</div>
            <span v-if="anime.rating" class="schedule-rating">{{ formatRating(anime.rating) }}</span>
          </div>
          <div class="schedule-info">
            <span class="schedule-name" :title="anime.name">{{ anime.name }}</span>
            <span class="schedule-remarks">
              <template v-if="anime.remarks">{{ anime.remarks }}</template>
              <template v-if="anime.rating"> · {{ anime.rating }}分</template>
            </span>
          </div>
        </div>
        <div v-if="currentDayItems.length === 0" class="schedule-empty">暂无番剧</div>
      </div>
      <button
        v-if="visibleItemLimit < currentDayItems.length"
        class="schedule-more-btn"
        type="button"
        @click="showMoreItems"
      >
        显示更多 {{ currentDayItems.length - visibleItemLimit }} 部
      </button>
      </div>
    </div>
  </div>
</template>

<script>
import CachedImage from '../Common/CachedImage.vue';

export default {
  name: 'BangumiSchedule',
  components: { CachedImage },
  props: {
    schedule: {
      type: Array,
      default: () => []
    }
  },
  emits: ['view'],
  data() {
    const weekday = new Date().getDay();
    return {
      collapsed: false,
      activeTab: weekday === 0 ? 7 : weekday,
      failedImageIds: new Set(),
      _imageRetriedIds: new Set(),
      _imageRetryTimers: new Set(),
      visibleItemLimit: 14
    };
  },
  computed: {
    todayDay() {
      const weekday = new Date().getDay();
      return weekday === 0 ? 7 : weekday;
    },
    currentDayItems() {
      const day = this.schedule.find(d => d.weekday.id === this.activeTab);
      return day ? (day.items || []) : [];
    },
    renderedCurrentDayItems() {
      return this.currentDayItems.slice(0, this.visibleItemLimit);
    }
  },
  watch: {
    schedule: {
      handler() {
        this.failedImageIds = new Set();
        this._imageRetriedIds = new Set();
        this.resetProgressiveRender();
      },
      immediate: true
    },
    activeTab() {
      this.resetProgressiveRender();
    },
    collapsed(value) {
      if (!value) {
        this.$nextTick(() => this.resetProgressiveRender());
      }
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
    },

    formatRating(value) {
      const rating = Number(value);
      return Number.isFinite(rating) ? rating.toFixed(1) : value;
    },

    resetProgressiveRender() {
      const total = this.currentDayItems.length;
      this.visibleItemLimit = Math.min(total, 14);
    },

    showMoreItems() {
      const total = this.currentDayItems.length;
      if (this.visibleItemLimit >= total) return;
      this.visibleItemLimit = Math.min(total, this.visibleItemLimit + 14);
    }
  },
  beforeUnmount() {
    this._imageRetryTimers.forEach(timer => clearTimeout(timer));
    this._imageRetryTimers.clear();
  }
};
</script>

<style scoped>
.schedule-section {
  padding: 22px 0 16px;
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
.schedule-card:focus-visible {
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
  background: var(--accent-cyan);
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

.schedule-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.schedule-tab {
  min-width: 72px;
  padding: 6px 14px;
  border: 1px solid transparent;
  background: var(--bg-card);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  position: relative;
  transition: transform 0.16s ease, background-color 0.16s ease, color 0.16s ease, border-color 0.16s ease;
}

.schedule-tab:hover {
  transform: translateY(-1px);
  color: var(--primary-color);
  background: var(--primary-lighter);
}

.schedule-tab:active {
  transform: translateY(0) scale(0.98);
}

.schedule-tab.active {
  border-color: var(--brand-ink);
  background: var(--brand-ink);
  color: #fff;
  font-weight: 600;
}

.schedule-tab.today:not(.active) {
  border: 1.5px solid var(--primary-color);
  color: var(--primary-color);
  font-weight: 500;
}

.today-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--primary-color);
  margin-left: 4px;
  vertical-align: middle;
}

.schedule-tab.active .today-dot {
  background: #fff;
}

.schedule-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
  /* translateZ 把整组卡片缓存为纹理，滚动进视口时只合成不重绘 */
  transform: translateZ(0);
}

.schedule-card {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 76px;
  padding: 7px;
  cursor: pointer;
  border-radius: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  /* contain 让每张卡的绘制(含封面图)缓存为纹理，滚动时只搬纹理不重画，
     与主列表卡片一致--否则每帧主线程重新栅格化封面，造成停顿。 */
  contain: layout style paint;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.schedule-card:hover {
  transform: translateY(-1px);
  border-color: var(--primary-color);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
}

.schedule-card:active {
  transform: translateY(0) scale(0.99);
}

.schedule-cover {
  flex: 0 0 46px;
  position: relative;
  width: 46px;
  height: 62px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-elevated);
  contain: strict;
}

.schedule-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.schedule-no-cover {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-light);
  color: var(--primary-color);
  font-size: 11px;
  font-weight: 700;
}

.schedule-rating {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.62);
  color: #ffd86b;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.4;
}

.schedule-info {
  min-width: 0;
  flex: 1;
  padding: 0;
}

.schedule-name {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-remarks {
  display: block;
  font-size: 10px;
  color: var(--primary-color);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schedule-empty {
  grid-column: 1 / -1;
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
  font-size: 13px;
}

.schedule-more-btn {
  display: block;
  width: 100%;
  margin-top: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card-glass);
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.schedule-more-btn:hover {
  transform: translateY(-1px);
  border-color: var(--primary-color);
  background: var(--primary-light);
}
</style>
