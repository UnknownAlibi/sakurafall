<template>
  <div class="title-bar">
    <div class="title-bar-left">
      <BrandMark :size="28" />
      <div class="app-title-group">
        <div class="app-signature">SAKURAFALL</div>
      </div>
    </div>
    
    <div class="title-bar-center">
      <div class="current-page-group">
        <div class="current-page">{{ currentPageTitle }}</div>
        <div class="current-page-kicker">{{ currentPageKicker }}</div>
      </div>
    </div>
    
    <div class="title-bar-right">
      <!-- 主题切换按钮 -->
      <button class="title-btn theme-btn" @click="toggleTheme" :title="themeTooltip">
        <!-- 太阳图标（亮色模式下显示，点击切到深色） -->
        <svg v-if="isDark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/>
          <line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/>
          <line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <!-- 月亮图标（深色模式下显示，点击切到亮色） -->
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
      <button class="title-btn" @click="minimizeWindow" title="最小化">
        <svg width="10" height="1" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor"/>
        </svg>
      </button>
      <button class="title-btn" @click="maximizeWindow" :title="isMaximized ? '还原' : '最大化'">
        <!-- 最大化图标 -->
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor"/>
        </svg>
        <!-- 还原图标（两个重叠矩形） -->
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <path d="M2.5 0v2.5H0V10h7.5V7.5H10V0H2.5zM9 6.5H3.5V1H9v5.5zM1 9V3.5h1.5V7H6.5v1.5H1z" fill="currentColor"/>
        </svg>
      </button>
      <button class="title-btn close-btn" @click="closeWindow" title="关闭">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M5 3.59L1.7.29.3 1.7 3.58 5 .29 8.3l1.41 1.41L5 6.41l3.3 3.3 1.4-1.42L6.42 5l3.3-3.3L8.3.3 5 3.58z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import BrandMark from './BrandMark.vue';

export default {
  name: 'TitleBar',
  components: { BrandMark },
  data() {
    return {
      isMaximized: false,
      removeListener: null
    };
  },
  computed: {
    ...mapGetters('settings', ['theme']),
    isDark() {
      if (this.theme === 'dark') return true;
      if (this.theme === 'auto') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      return false;
    },
    themeTooltip() {
      return this.isDark ? '切换到亮色模式' : '切换到深色模式';
    },
    currentPageTitle() {
      return this.$route.meta?.title || 'SAKURAFALL';
    },
    currentPageKicker() {
      const labels = {
        'anime-zone': 'ANIME ARCHIVE',
        discovery: 'ON AIR',
        'my-favorites': 'MY WATCHLIST',
        downloads: 'OFFLINE ROOM',
        'source-manager': 'SOURCE STUDIO',
        settings: 'CONTROL ROOM'
      };
      return labels[this.$route.name] || 'SAKURAFALL ANIME';
    }
  },
  async mounted() {
    // 获取初始窗口状态
    if (window.electronAPI?.isMaximized) {
      this.isMaximized = await window.electronAPI.isMaximized();
    }
    // 监听窗口状态变化
    if (window.electronAPI?.onWindowStateChanged) {
      this.removeListener = window.electronAPI.onWindowStateChanged((maximized) => {
        this.isMaximized = maximized;
      });
    }
  },
  beforeUnmount() {
    if (this.removeListener) {
      this.removeListener();
    }
  },
  methods: {
    ...mapActions('settings', ['updateTheme']),

    toggleTheme() {
      const newTheme = this.isDark ? 'light' : 'dark';
      this.updateTheme(newTheme);
    },

    async minimizeWindow() {
      if (window.electronAPI) {
        await window.electronAPI.minimizeWindow();
      }
    },
    
    async maximizeWindow() {
      if (window.electronAPI) {
        await window.electronAPI.maximizeWindow();
      }
    },
    
    async closeWindow() {
      if (window.electronAPI) {
        await window.electronAPI.closeWindow();
      }
    }
  }
};
</script>

<style scoped>
.title-bar {
  height: 38px;
  background: var(--titlebar-bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0;
  color: var(--titlebar-text);
  font-size: 13px;
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  transition: background-color 0.2s ease, color 0.2s ease;
  box-shadow: inset 0 -1px 0 rgba(54, 189, 215, 0.72);
}

[data-theme="dark"] .title-bar {
  background: #221c3a;
  box-shadow: inset 0 -2px 0 rgba(74, 214, 231, 0.52);
}

.title-bar-left {
  display: flex;
  align-items: center;
  padding-left: 12px;
  gap: 8px;
  /* 右侧按钮区域宽度: 46*4 = 184px，左侧需要等宽才能让标题视觉居中 */
  width: 184px;
  flex-shrink: 0;
}

.title-bar-center {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
}

.title-bar-right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 184px;
  flex-shrink: 0;
}

.app-icon-img {
  width: 25px;
  height: 25px;
  flex-shrink: 0;
  object-fit: contain;
  filter: drop-shadow(0 1px 1px rgba(24, 24, 68, 0.28));
}

.app-title-group {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.app-title {
  font-weight: 700;
  color: var(--titlebar-text);
  font-size: 13px;
  letter-spacing: 0;
  white-space: nowrap;
}

.app-signature {
  color: var(--titlebar-text);
  font-family: 'Segoe UI', sans-serif;
  font-size: 10px;
  font-weight: 700;
  opacity: 0.82;
  letter-spacing: 0;
}

.current-page {
  font-weight: 700;
  color: var(--titlebar-text);
  opacity: 0.85;
  font-size: 12px;
  line-height: 1;
}

.current-page-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.current-page-kicker {
  font-family: 'Segoe UI', sans-serif;
  font-size: 9px;
  font-weight: 700;
  color: var(--titlebar-text);
  opacity: 0.58;
}

/* 标准窗口控件按钮 */
.title-btn {
  width: 46px;
  height: 38px;
  border: none;
  background: transparent;
  color: var(--titlebar-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s;
  -webkit-app-region: no-drag;
}

.title-btn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: var(--titlebar-text);
}

.title-btn.close-btn:hover {
  background: #e81123;
  color: #fff;
}

.title-btn svg {
  display: block;
}

/* 主题切换按钮 hover 旋转效果 */
.theme-btn:hover svg {
  transform: rotate(30deg);
  transition: transform 0.3s ease;
}

@media (max-width: 768px) {
  .title-bar {
    height: 32px;
    font-size: 12px;
  }
  
  .app-title {
    display: none;
  }

  .app-signature {
    display: none;
  }
  
  .title-btn {
    width: 40px;
    height: 32px;
  }

  .title-bar-left {
    width: 160px;
  }

  .title-bar-right {
    width: 160px;
  }
}
</style>
