<template>
  <div class="window-chrome">
    <div class="window-chrome-brand" aria-hidden="true">
      <BrandMark :size="20" />
      <span class="window-chrome-word">SAKURAFALL</span>
    </div>

    <div class="window-chrome-controls">
      <UpdateCenter />
      <button class="chrome-btn theme-btn" @click="toggleTheme" :title="themeTooltip" :aria-label="themeTooltip">
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
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      </button>
      <button class="chrome-btn" @click="minimizeWindow" title="最小化" aria-label="最小化">
        <svg width="10" height="1" viewBox="0 0 10 1">
          <rect width="10" height="1" fill="currentColor"/>
        </svg>
      </button>
      <button class="chrome-btn" @click="maximizeWindow" :title="isMaximized ? '还原' : '最大化'" :aria-label="isMaximized ? '还原' : '最大化'">
        <svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor"/>
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <path d="M2.5 0v2.5H0V10h7.5V7.5H10V0H2.5zM9 6.5H3.5V1H9v5.5zM1 9V3.5h1.5V7H6.5v1.5H1z" fill="currentColor"/>
        </svg>
      </button>
      <button class="chrome-btn close-btn" @click="closeWindow" title="关闭" aria-label="关闭">
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
import UpdateCenter from './UpdateCenter.vue';

export default {
  name: 'WindowChrome',
  components: { BrandMark, UpdateCenter },
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
    }
  },
  async mounted() {
    if (window.electronAPI?.isMaximized) {
      this.isMaximized = await window.electronAPI.isMaximized();
    }
    if (window.electronAPI?.onWindowStateChanged) {
      this.removeListener = window.electronAPI.onWindowStateChanged((maximized) => {
        this.isMaximized = maximized;
      });
    }
  },
  beforeUnmount() {
    if (this.removeListener) this.removeListener();
  },
  methods: {
    ...mapActions('settings', ['updateTheme']),
    toggleTheme() {
      this.updateTheme(this.isDark ? 'light' : 'dark');
    },
    async minimizeWindow() {
      await window.electronAPI?.minimizeWindow();
    },
    async maximizeWindow() {
      await window.electronAPI?.maximizeWindow();
    },
    async closeWindow() {
      await window.electronAPI?.closeWindow();
    }
  }
};
</script>

<style scoped>
.window-chrome {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--app-chrome-height, 34px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 14px;
  -webkit-app-region: drag;
  user-select: none;
  z-index: 1000;
  color: var(--text-secondary);
}

.window-chrome-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  opacity: 0.86;
  pointer-events: none;
}

.window-chrome-word {
  font-family: 'Segoe UI', sans-serif;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.window-chrome-controls {
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--border-color) 78%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
  box-shadow: 0 4px 14px rgba(24, 24, 68, 0.07);
  -webkit-app-region: no-drag;
  /* UpdateCenter 沿用标题栏变量，这里覆盖成内容区文本色 */
  --titlebar-text: var(--text-secondary);
  --titlebar-bg: var(--bg-surface);
}

.chrome-btn {
  width: 30px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease, color 0.15s ease;
  -webkit-app-region: no-drag;
}

.chrome-btn:hover {
  background: var(--primary-lighter);
  color: var(--primary-color);
}

.chrome-btn.close-btn:hover {
  background: #e81123;
  color: #fff;
}

.chrome-btn svg {
  display: block;
}

.theme-btn:hover svg {
  transform: rotate(30deg);
  transition: transform 0.3s ease;
}

.window-chrome-controls :deep(.update-badge) {
  width: 30px;
  height: 26px;
}

.window-chrome-controls :deep(.update-badge:hover) {
  background: var(--primary-lighter);
}

@media (max-width: 760px) {
  .window-chrome {
    padding-left: 10px;
  }

  .window-chrome-word {
    display: none;
  }
}
</style>
