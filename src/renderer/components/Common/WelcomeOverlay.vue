<template>
  <Transition name="wo-fade">
    <div v-if="visible" class="wo-overlay">
      <div class="wo-card" role="dialog" aria-modal="true" aria-label="欢迎使用">
        <div class="wo-mascot" aria-hidden="true"></div>
        <h2 class="wo-title">欢迎来到 SAKURAFALL</h2>
        <p class="wo-subtitle">樱月已备好放映清单，先带你认认路：</p>
        <ul class="wo-tips">
          <li>
            <span class="wo-tip-icon">📺</span>
            <div><strong>番剧库</strong><small>聚合多数据源搜索，点卡片开详情，选集即播</small></div>
          </li>
          <li>
            <span class="wo-tip-icon">🔍</span>
            <div><strong>发现</strong><small>热播排行与新番时间表，找番不迷路</small></div>
          </li>
          <li>
            <span class="wo-tip-icon">💕</span>
            <div><strong>我的追番</strong><small>收藏追番、续播、更新提醒一站管理</small></div>
          </li>
          <li>
            <span class="wo-tip-icon">⚙️</span>
            <div><strong>小贴士</strong><small>番剧封面需代理，可在「设置 → 代理地址」配置</small></div>
          </li>
        </ul>
        <div class="wo-hint">
          <kbd>Ctrl</kbd>+<kbd>K</kbd> 快速导航 &nbsp;·&nbsp; <kbd>Alt</kbd>+<kbd>1-6</kbd> 切换页面
        </div>
        <button class="wo-start-btn" @click="start">开始使用</button>
      </div>
    </div>
  </Transition>
</template>

<script>
const ONBOARD_FLAG = 'sakurafall-onboarded-v1';

export default {
  name: 'WelcomeOverlay',
  data() {
    return {
      visible: false
    };
  },
  mounted() {
    if (localStorage.getItem(ONBOARD_FLAG)) return;
    // 等启动屏淡出后再展示，避免两层加载动画叠加
    this._showTimer = setTimeout(() => {
      this.visible = true;
    }, 1400);
  },
  beforeUnmount() {
    if (this._showTimer) {
      clearTimeout(this._showTimer);
      this._showTimer = null;
    }
  },
  methods: {
    start() {
      localStorage.setItem(ONBOARD_FLAG, '1');
      this.visible = false;
    }
  }
};
</script>

<style scoped>
.wo-overlay {
  position: fixed;
  inset: 0;
  z-index: 11500;
  background: var(--bg-overlay, rgba(0, 0, 0, 0.5));
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.wo-card {
  width: min(460px, calc(100vw - 48px));
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  padding: 30px 32px 26px;
  box-shadow: var(--shadow-lg);
  text-align: center;
}

.wo-mascot {
  width: 72px;
  height: 72px;
  margin: 0 auto 12px;
  border-radius: 50%;
  background: var(--sakurafall-character-image, var(--primary-light)) center / cover no-repeat, var(--primary-light);
}

.wo-title {
  margin: 0 0 6px;
  font-size: 20px;
  color: var(--text-primary);
}

.wo-subtitle {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--text-secondary);
}

.wo-tips {
  list-style: none;
  margin: 0 0 18px;
  padding: 0;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wo-tips li {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
}

.wo-tip-icon {
  font-size: 18px;
  line-height: 1.4;
}

.wo-tips strong {
  display: block;
  font-size: 13px;
  color: var(--text-primary);
}

.wo-tips small {
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.wo-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 18px;
}

.wo-hint kbd {
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 1px 5px;
  background: var(--bg-surface);
  font-size: 11px;
}

.wo-start-btn {
  padding: 10px 42px;
  border-radius: 999px;
  border: none;
  background: var(--primary-color);
  color: var(--text-inverse);
  font-size: 15px;
  cursor: pointer;
  transition: transform 0.15s var(--ease-smooth), opacity 0.15s var(--ease-smooth);
}

.wo-start-btn:hover {
  opacity: 0.9;
}

.wo-start-btn:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}

.wo-start-btn:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

.wo-fade-enter-active,
.wo-fade-leave-active {
  transition: opacity 0.2s var(--ease-smooth);
}

.wo-fade-enter-active .wo-card,
.wo-fade-leave-active .wo-card {
  transition: transform 0.2s var(--ease-smooth);
}

.wo-fade-enter-from,
.wo-fade-leave-to {
  opacity: 0;
}

.wo-fade-enter-from .wo-card {
  transform: translateY(12px) scale(0.97);
}
</style>
