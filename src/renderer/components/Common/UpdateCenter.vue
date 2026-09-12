<template>
  <div ref="root" class="update-center">
    <!-- 标题栏常驻徽标：有更新/下载中/待重启都在这里体现，不依赖任何页面。
         卡片体积较大，改为异步组件——点开才加载，避免顶破主 chunk 预算。 -->
    <button
      type="button"
      class="update-badge"
      :class="`is-${badgeState}`"
      :title="badgeTooltip"
      :aria-label="badgeTooltip"
      :aria-expanded="cardOpen ? 'true' : 'false'"
      aria-haspopup="dialog"
      @click="toggleCard"
    >
      <!-- 下载中 / 安装中：环形进度 -->
      <span v-if="badgeState === 'downloading' || badgeState === 'installing'" class="update-ring" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle class="ring-track" cx="12" cy="12" r="8.5" />
          <circle
            class="ring-value"
            cx="12"
            cy="12"
            r="8.5"
            :style="{ strokeDasharray: RING_CIRCUMFERENCE, strokeDashoffset: ringOffset }"
          />
        </svg>
      </span>
      <!-- 已就绪：下载完成，等用户重启 -->
      <svg v-else-if="badgeState === 'ready'" class="update-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v10" />
        <path d="m7 8 5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
      <!-- 有更新：上箭头（Chrome/Edge 同款语义） -->
      <svg v-else-if="badgeState === 'available' || badgeState === 'force'" class="update-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 20V7" />
        <path d="m6 13 6-6 6 6" />
        <path d="M5 4h14" />
      </svg>
      <!-- 空闲 / 检查失败：低存在感刷新图标 -->
      <svg v-else class="update-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 0 1-15.1 6.6L3 16" />
        <path d="M3 21v-5h5" />
        <path d="M3 12A9 9 0 0 1 18.1 5.4L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      <span v-if="badgeState === 'available' || badgeState === 'force'" class="update-dot" aria-hidden="true"></span>
    </button>

    <Transition name="update-card">
      <UpdateCard v-if="cardOpen" @close="closeCard" />
    </Transition>
  </div>
</template>

<script>
import { defineAsyncComponent } from 'vue';
import { mapGetters } from 'vuex';

const RING_CIRCUMFERENCE = 2 * Math.PI * 8.5;

const UpdateCard = defineAsyncComponent(() => import('./UpdateCard.vue'));

export default {
  name: 'UpdateCenter',
  components: { UpdateCard },
  data() {
    return {
      cardOpen: false,
      RING_CIRCUMFERENCE
    };
  },
  computed: {
    ...mapGetters('update', [
      'badgeState',
      'checkError',
      'downloadPercent',
      'downloadStatus',
      'latestVersion'
    ]),
    ringOffset() {
      const percent = this.downloadStatus === 'installing' ? 100 : this.downloadPercent;
      return RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, percent)) / 100);
    },
    badgeTooltip() {
      switch (this.badgeState) {
        case 'available':
          return `发现新版本 v${this.latestVersion}，点击查看`;
        case 'force':
          return `需要更新到 v${this.latestVersion}，点击查看`;
        case 'downloading':
          return `正在下载更新 ${this.downloadPercent}%`;
        case 'installing':
          return '正在安装更新，应用即将重启';
        case 'ready':
          return '更新已就绪，点击重启安装';
        case 'error':
          return `更新检查失败：${this.checkError}`;
        default:
          return '检查应用更新';
      }
    }
  },
  watch: {
    cardOpen(open) {
      if (open) {
        document.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
        document.addEventListener('keydown', this.handleKeydown);
      } else {
        this.removeGlobalListeners();
      }
    }
  },
  mounted() {
    // 全局只在这里绑定一次主进程推送：徽标是常驻的，比任何页面都更适合持有监听
    this.$store.dispatch('update/bindListeners');
    this.$store.dispatch('update/loadVersion');
    this.$store.dispatch('update/syncDownloadState');
  },
  beforeUnmount() {
    this.removeGlobalListeners();
    this.$store.dispatch('update/unbindListeners');
  },
  methods: {
    removeGlobalListeners() {
      document.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
      document.removeEventListener('keydown', this.handleKeydown);
    },
    toggleCard() {
      this.cardOpen = !this.cardOpen;
    },
    closeCard() {
      this.cardOpen = false;
    },
    handleOutsidePointerDown(event) {
      if (!this.$refs.root?.contains(event.target)) this.closeCard();
    },
    handleKeydown(event) {
      if (event.key === 'Escape') this.closeCard();
    }
  }
};
</script>

<style scoped>
.update-center {
  position: relative;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

/* ===== 徽标 ===== */
.update-badge {
  position: relative;
  width: 46px;
  height: 38px;
  border: none;
  background: transparent;
  color: var(--titlebar-text);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.update-badge:hover {
  background: rgba(255, 255, 255, 0.18);
}

.update-badge:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--primary-color) 70%, white);
  outline-offset: -2px;
}

.update-glyph {
  display: block;
  width: 16px;
  height: 16px;
}

.update-badge.is-available .update-glyph,
.update-badge.is-force .update-glyph,
.update-badge.is-ready .update-glyph {
  color: var(--primary-color);
}

.update-badge.is-available .update-glyph,
.update-badge.is-force .update-glyph {
  animation: update-bob 2.2s var(--ease-smooth) infinite;
}

/* 有更新的红点：不抢眼但一定能看见 */
.update-dot {
  position: absolute;
  top: 8px;
  right: 12px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary-color);
  box-shadow: 0 0 0 2px var(--titlebar-bg);
  animation: update-pulse 1.8s ease-in-out infinite;
}

.update-ring {
  display: block;
  width: 18px;
  height: 18px;
}

.update-ring svg {
  width: 18px;
  height: 18px;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
}

.update-ring .ring-track,
.update-ring .ring-value {
  fill: none;
  stroke-width: 2.6;
}

.update-ring .ring-track {
  stroke: rgba(255, 255, 255, 0.25);
}

.update-ring .ring-value {
  stroke: var(--primary-color);
  stroke-linecap: round;
  transition: stroke-dashoffset 220ms var(--ease-smooth);
}

.update-badge.is-installing .update-ring svg {
  animation: update-spin 1.1s linear infinite;
}

/* 卡片出现/消失（卡片本体样式在 UpdateCard.vue） */
.update-card-enter-active,
.update-card-leave-active {
  transition: opacity 160ms var(--ease-smooth), transform 160ms var(--ease-smooth);
}

.update-card-enter-from,
.update-card-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@keyframes update-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@keyframes update-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1.5px); }
}

@keyframes update-spin {
  to { transform: rotate(360deg); }
}

/* 纯净模式与弱机降级：只保留状态，不跑动画 */
[data-ui-effects="performance"] .update-dot,
[data-ui-effects="performance"] .update-badge.is-available .update-glyph,
[data-ui-effects="performance"] .update-badge.is-force .update-glyph,
[data-ui-effects="performance"] .update-badge.is-installing .update-ring svg {
  animation: none;
}

@media (max-width: 768px) {
  .update-badge {
    width: 40px;
    height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .update-dot,
  .update-badge.is-available .update-glyph,
  .update-badge.is-force .update-glyph,
  .update-badge.is-installing .update-ring svg,
  .update-card-enter-active,
  .update-card-leave-active,
  .update-ring .ring-value {
    animation: none;
    transition: none;
  }
}
</style>
