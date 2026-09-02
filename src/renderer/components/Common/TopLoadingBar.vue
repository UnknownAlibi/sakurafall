<template>
  <Transition name="tlb-fade">
    <div v-if="visible" class="top-loading-bar" role="progressbar" aria-label="页面加载中">
      <div class="tlb-fill" :style="{ width: progress + '%' }"></div>
    </div>
  </Transition>
</template>

<script>
/**
 * 顶部细进度条：路由切换期间在窗口最顶端显示品牌色进度线，
 * 类 YouTube 风格——不确定进度缓增至 ~90%，导航完成冲 100% 后淡出。
 */
export default {
  name: 'TopLoadingBar',
  data() {
    return {
      visible: false,
      progress: 0
    };
  },
  mounted() {
    // 组件内注册守卫：Vue Router 4 返回解除函数，卸载时清理防止泄漏
    this._unregisterBefore = this.$router.beforeEach((to, from, next) => {
      if (to.path !== from.path) this.start();
      next();
    });
    this._unregisterAfter = this.$router.afterEach(() => this.finish());
    this._unregisterError = this.$router.onError(() => this.finish());
  },
  beforeUnmount() {
    this._unregisterBefore?.();
    this._unregisterAfter?.();
    this._unregisterError?.();
    this.cleanup();
  },
  methods: {
    start() {
      this.cleanup();
      this.visible = true;
      this.progress = 12;
      // 越接近 90 增速越慢，营造"接近完成"的感知
      this._tick = setInterval(() => {
        this.progress = Math.min(90, this.progress + (90 - this.progress) * 0.08 + 0.4);
      }, 180);
    },
    finish() {
      clearInterval(this._tick);
      this._tick = null;
      if (!this.visible) return;
      this.progress = 100;
      this._hideTimer = setTimeout(() => {
        this.visible = false;
      }, 280);
    },
    cleanup() {
      clearInterval(this._tick);
      clearTimeout(this._hideTimer);
      this._tick = null;
      this._hideTimer = null;
    }
  }
};
</script>

<style scoped>
.top-loading-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 12000;
  pointer-events: none;
  background: transparent;
}

.tlb-fill {
  height: 100%;
  border-radius: 0 3px 3px 0;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-lavender));
  box-shadow: 0 0 10px rgba(var(--primary-rgb), 0.55);
  transition: width 0.22s var(--ease-smooth);
}

/* 进度条收尾：淡出而非瞬间消失 */
.tlb-fade-leave-active {
  transition: opacity 0.25s ease 0.08s;
}
.tlb-fade-leave-to {
  opacity: 0;
}

/* 纯净模式：不渲染进度条动效（直接隐藏）
   :global() 必须包住整条选择器——写成 :global(X) Y 时 Vue scoped 编译会丢弃 Y，
   规则只剩 [data-ui-effects=...]，等于给根元素加 display:none。 */
:global([data-ui-effects='performance'] .top-loading-bar) {
  display: none;
}
</style>
