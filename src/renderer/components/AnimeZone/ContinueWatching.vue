<template>
  <div v-if="items.length > 0" class="continue-section">
    <div class="continue-header" @click="toggleCollapsed" @keydown.enter.prevent="toggleCollapsed" @keydown.space.prevent="toggleCollapsed" role="button" tabindex="0">
      <h3 class="continue-title">
        <span class="continue-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="13" r="8"/>
            <path d="M12 9v4l2.5 1.5M9 2h6M12 2v3"/>
          </svg>
        </span>
        继续观看
      </h3>
      <span class="collapse-toggle">{{ collapsed ? '展开' : '收起' }} <span class="collapse-arrow" :class="{ expanded: !collapsed }">›</span></span>
    </div>
    <div class="collapsible-body" :class="{ collapsed }">
      <div class="continue-list">
        <div v-for="item in displayedItems" :key="itemKey(item)"
          class="continue-card" :class="{ 'is-resuming': resumingKey === itemKey(item) }" role="button" tabindex="0" @click="$emit('resume', item)" @keydown.enter.prevent="$emit('resume', item)" @keydown.space.prevent="$emit('resume', item)">
          <button class="continue-delete-btn" @click.stop="$emit('remove', item)" title="删除记录">✕</button>
          <div class="continue-cover">
            <CachedImage
              v-if="item.cover"
              :src="item.cover"
              :alt="item.name"
              cache-variant="thumbnail"
              :cache-width="160"
              data-cache-resolve="true"
              width="160"
              height="208"
              loading="lazy"
              decoding="async"
              fetchpriority="low"
              @error="(e) => e.target.style.display='none'"
            />
            <div v-else class="continue-no-cover">{{ (item.name || '').slice(0, 2) }}</div>
            <span v-if="resumingKey === itemKey(item)" class="continue-resume-spinner" aria-label="正在续播"></span>
            <div class="continue-play-icon">▶</div>
          </div>
          <div class="continue-info">
            <span class="continue-name" :title="item.name">{{ item.name }}</span>
            <span class="continue-ep">{{ item.episode_title || '未知集数' }}</span>
          </div>
        </div>
        <button v-if="items.length > 4" class="continue-toggle-btn" @click="showAll = !showAll">
          {{ showAll ? '收起' : `还有 ${items.length - 4} 部` }}
          <span class="toggle-arrow" :class="{ expanded: showAll }">›</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import CachedImage from '../Common/CachedImage.vue';

export default {
  name: 'ContinueWatching',
  components: { CachedImage },
  props: {
    items: {
      type: Array,
      default: () => []
    },
    resumingKey: {
      type: String,
      default: ''
    }
  },
  emits: ['resume', 'remove'],
  data() {
    return {
      collapsed: false,
      showAll: false
    };
  },
  computed: {
    displayedItems() {
      return this.showAll ? this.items : this.items.slice(0, 4);
    }
  },
  methods: {
    itemKey(item) {
      return `${item?.source || 'legacy'}:${String(item?.anime_id ?? item?.id ?? '')}`;
    },
    toggleCollapsed() {
      this.collapsed = !this.collapsed;
    }
  }
};
</script>

<style scoped>
.continue-section {
  padding: 12px 0 0;
  margin-bottom: 4px;
}

.continue-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  cursor: pointer;
  user-select: none;
}

.continue-header:focus-visible,
.continue-card:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 3px;
}

.continue-header:hover .collapse-toggle {
  color: var(--primary-color);
}

.continue-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.continue-title-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 22px;
  border-radius: 6px;
  color: #fff;
  background: var(--brand-ink);
  box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.14);
}

.continue-title-icon svg {
  width: 13px;
  height: 13px;
}

.continue-list {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding-bottom: 8px;
  /* 不用 overflow-x:auto：滚动容器会把整页竖向滚动逼退到主线程。改为换行，由合成器滚动。
     translateZ 缓存为纹理，滚动进视口时只合成不重绘。 */
  transform: translateZ(0);
}

.continue-list::-webkit-scrollbar {
  height: 4px;
}

.continue-list::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 2px;
}

.continue-card {
  flex: 0 0 auto;
  width: 180px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-card-glass);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease;
  position: relative;
  contain: layout style paint;
}

.continue-card:hover {
  border-color: var(--primary-color);
}

.continue-card.is-resuming {
  border-color: var(--primary-color);
  background: var(--primary-lighter);
  pointer-events: none;
}

.continue-delete-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
  z-index: 3;
  padding: 0;
}

.continue-card:hover .continue-delete-btn {
  opacity: 1;
}

.continue-delete-btn:hover {
  background: rgba(220, 53, 69, 0.85);
}

.continue-cover {
  position: relative;
  width: 40px;
  height: 52px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--primary-lighter);
}

.continue-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.continue-no-cover {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--bg-elevated), var(--border-color-strong));
  color: var(--text-inverse);
  font-size: 12px;
  font-weight: 700;
}

.continue-play-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 20px;
  height: 20px;
  background: rgba(var(--primary-rgb), 0.9);
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  opacity: 0;
  transition: opacity 0.2s;
}

.continue-card:hover .continue-play-icon {
  opacity: 1;
}

.continue-resume-spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  width: 20px;
  height: 20px;
  margin: -10px 0 0 -10px;
  border: 3px solid rgba(255, 255, 255, 0.55);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  background: rgba(35, 29, 48, 0.62);
  animation: continue-spin 0.7s linear infinite;
}

@keyframes continue-spin {
  to { transform: rotate(360deg); }
}

.continue-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.continue-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.continue-ep {
  font-size: 10px;
  color: var(--primary-color);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.continue-toggle-btn {
  flex: 0 0 auto;
  padding: 8px 16px;
  background: var(--bg-card-glass);
  border: 1px dashed var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, color 0.16s ease;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.continue-toggle-btn:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.toggle-arrow {
  display: inline-block;
  transition: transform 0.25s ease;
  font-size: 14px;
  font-weight: 700;
}

.toggle-arrow.expanded {
  transform: rotate(90deg);
}

/* 共用折叠样式 */
.collapse-toggle {
  font-size: 12px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: 2px;
  transition: color 0.2s;
}

.collapse-arrow {
  display: inline-block;
  transition: transform 0.25s ease;
  font-size: 14px;
  font-weight: 700;
}

.collapse-arrow.expanded {
  transform: rotate(90deg);
}

.collapsible-body {
  max-height: 400px;
  overflow: hidden;
  transition: max-height 0.35s ease, opacity 0.25s ease;
  opacity: 1;
}

.collapsible-body.collapsed {
  max-height: 0;
  opacity: 0;
  margin: 0;
}
</style>
