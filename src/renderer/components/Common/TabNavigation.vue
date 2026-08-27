<template>
  <div class="tab-navigation">
    <div class="tab-list">
      <button v-for="tab in tabs" :key="tab.name" :class="['tab-btn', { active: currentTab === tab.name }]"
        @click="switchTab(tab.name)">
        <span class="tab-icon-shell">
          <component :is="tab.iconComponent" class="tab-icon" />
        </span>
        <span class="tab-copy">
          <span class="tab-text">{{ tab.label }}</span>
          <span class="tab-kicker">{{ tab.kicker }}</span>
        </span>
        <!-- 我的追番 tab 显示未读更新提醒角标 -->
        <span v-if="tab.name === 'my-favorites' && unreadReminderCount > 0" class="tab-badge">
          {{ unreadReminderCount > 99 ? '99+' : unreadReminderCount }}
        </span>
      </button>
    </div>
  </div>
</template>

<script>
import { h, markRaw } from 'vue';
import { mapGetters } from 'vuex';

// SVG 图标组件
const IconAnime = {
  name: 'IconAnime',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('rect', { x: 2, y: 2, width: 20, height: 20, rx: 2.18, ry: 2.18 }),
      h('line', { x1: 7, y1: 2, x2: 7, y2: 22 }),
      h('line', { x1: 17, y1: 2, x2: 17, y2: 22 }),
      h('line', { x1: 2, y1: 12, x2: 22, y2: 12 }),
      h('line', { x1: 2, y1: 7, x2: 7, y2: 7 }),
      h('line', { x1: 2, y1: 17, x2: 7, y2: 17 }),
      h('line', { x1: 17, y1: 17, x2: 22, y2: 17 }),
      h('line', { x1: 17, y1: 7, x2: 22, y2: 7 })
    ]);
  }
};

// 发现页图标（指南针）
const IconDiscover = {
  name: 'IconDiscover',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('circle', { cx: 12, cy: 12, r: 10 }),
      h('polygon', { points: '16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76' })
    ]);
  }
};

const IconSettings = {
  name: 'IconSettings',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('circle', { cx: 12, cy: 12, r: 3 }),
      h('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' })
    ]);
  }
};

const IconFavorite = {
  name: 'IconFavorite',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('path', { d: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z' })
    ]);
  }
};

const IconDownload = {
  name: 'IconDownload',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
      h('polyline', { points: '17 10 12 15 7 10' }),
      h('line', { x1: 12, y1: 15, x2: 12, y2: 3 })
    ]);
  }
};

// 数据源管理图标（信号塔样式）
const IconSource = {
  name: 'IconSource',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('path', { d: 'M2 20h20' }),
      h('path', { d: 'M5 20V8l7-5 7 5v12' }),
      h('circle', { cx: '12', cy: '12', r: '2' })
    ]);
  }
};

// BT 资源站图标（磁铁）
const IconBtHub = {
  name: 'IconBtHub',
  render() {
    return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [
      h('path', { d: 'M6 15l-4-4a6.5 6.5 0 0 1 9-9l4 4' }),
      h('path', { d: 'M12 12l4 4' }),
      h('path', { d: 'M9 18l3 3a5.5 5.5 0 0 0 8-8l-3-3' }),
      h('line', { x1: 4, y1: 20, x2: 7, y2: 17 }),
      h('line', { x1: 12, y1: 12, x2: 15, y2: 15 })
    ]);
  }
};

export default {
  name: 'TabNavigation',
  data() {
    return {
      tabs: markRaw([
        { name: 'anime-zone', label: '番剧库', kicker: 'LIBRARY', iconComponent: IconAnime },
        { name: 'discovery', label: '发现', kicker: 'DISCOVER', iconComponent: IconDiscover },
        { name: 'my-favorites', label: '我的追番', kicker: 'FOLLOW', iconComponent: IconFavorite },
        { name: 'downloads', label: '下载', kicker: 'OFFLINE', iconComponent: IconDownload },
        { name: 'bt-hub', label: 'BT 资源', kicker: 'BT HUB', iconComponent: IconBtHub },
        { name: 'source-manager', label: '数据源', kicker: 'SOURCES', iconComponent: IconSource },
        { name: 'settings', label: '设置', kicker: 'SETTINGS', iconComponent: IconSettings }
      ])
    };
  },
  methods: {
    switchTab(tabName) {
      if (this.currentTab !== tabName) {
        this.$router.push({ name: tabName });
      }
    }
  },
  computed: {
    currentTab() {
      return this.$route.name;
    },
    // 未读更新提醒数（用于"我的追番"角标）
    ...mapGetters('reminder', ['unreadCount']),
    unreadReminderCount() {
      return this.unreadCount || 0;
    }
  }
};
</script>

<style scoped>
.tab-navigation {
  background: var(--nav-bg);
  width: 92px;
  padding: 10px 8px;
  border-right: 1px solid var(--border-color);
  flex: 0 0 92px;
  transition: background-color 0.3s ease, border-color 0.3s ease;
}

.tab-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tab-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  min-height: 58px;
  padding: 6px 4px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-tertiary);
  transition: background-color 0.2s ease, color 0.2s ease;
  position: relative;
  font-weight: 400;
  margin: 0;
}

.tab-btn:hover {
  color: var(--primary-color);
  background: var(--primary-lighter);
}

.tab-btn.active {
  color: var(--brand-ink);
  font-weight: 600;
  background: var(--nav-active-bg);
}

.tab-btn.active::after {
  content: '';
  position: absolute;
  top: 12px;
  right: -8px;
  bottom: 12px;
  width: 3px;
  background: var(--primary-color);
  border-radius: 3px 0 0 3px;
}

.tab-icon-shell {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 30px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: inherit;
  transition: background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.tab-btn:hover .tab-icon-shell {
  border-color: var(--border-color-strong);
  background: var(--bg-card);
}

.tab-btn.active .tab-icon-shell {
  color: #fff;
  border-color: var(--brand-ink);
  background: var(--brand-ink);
}

.tab-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.tab-text {
  white-space: nowrap;
  line-height: 1.1;
}

.tab-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.tab-kicker {
  display: none;
}

.tab-btn.active .tab-kicker {
  color: var(--primary-color);
  opacity: 1;
}

/* 未读更新提醒角标 */
.tab-badge {
  position: absolute;
  top: 4px;
  right: 8px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: linear-gradient(135deg, #fb7299, #ff6b6b);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  box-shadow: 0 2px 6px rgba(var(--primary-rgb), 0.4);
  pointer-events: none;
}

@media (max-width: 820px) {
  .tab-navigation {
    width: 100%;
    padding: 4px 8px;
    border-right: 0;
    border-bottom: 1px solid var(--border-color);
    flex: 0 0 auto;
    overflow-x: auto;
  }

  .tab-list {
    flex-direction: row;
    gap: 2px;
  }

  .tab-btn {
    flex: 1 0 72px;
    min-height: 44px;
    padding: 5px 8px;
    font-size: 12px;
    gap: 3px;
  }

  .tab-icon-shell {
    width: 22px;
    height: 22px;
    flex-basis: 22px;
  }

  .tab-btn.active::after {
    top: auto;
    right: 12px;
    bottom: -4px;
    left: 12px;
    width: auto;
    height: 3px;
    border-radius: 3px 3px 0 0;
  }
}
</style>
