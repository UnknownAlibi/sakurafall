<template>
  <div v-if="hasError" class="error-boundary">
    <div class="error-box">
      <div class="error-icon">⚠️</div>
      <h3 class="error-title">页面出错了</h3>
      <p class="error-message">{{ errorMessage }}</p>
      <div class="error-actions">
        <button @click="retry" class="error-btn error-btn--primary">重试</button>
        <button @click="goHome" class="error-btn">返回首页</button>
      </div>
    </div>
  </div>
  <slot v-else />
</template>

<script>
export default {
  name: 'ErrorBoundary',
  data() {
    return {
      hasError: false,
      errorMessage: '',
      errorInfo: ''
    };
  },
  errorCaptured(err, instance, info) {
    this.hasError = true;
    this.errorMessage = err?.message || '发生了未知错误';
    this.errorInfo = info || '';
    console.error('[ErrorBoundary] 捕获到组件错误:', err, info, instance);
    window.electronAPI?.runtimeDiagnosticsReport?.('error-boundary', {
      name: String(err?.name || 'Error'),
      message: String(err?.message || err || 'Unknown error'),
      stack: String(err?.stack || ''),
      info: String(info || ''),
      route: String(this.$route?.fullPath || '')
    }).catch(() => {});

    // 阻止错误继续向上传播，避免整个应用崩溃
    return false;
  },
  // 路由切换时复位错误态，避免错误界面卡住影响其它页面
  watch: {
    '$route'() {
      if (this.hasError) {
        this.hasError = false;
        this.errorMessage = '';
        this.errorInfo = '';
      }
    }
  },
  methods: {
    retry() {
      this.hasError = false;
      this.errorMessage = '';
      this.errorInfo = '';
    },
    goHome() {
      this.hasError = false;
      this.errorMessage = '';
      this.errorInfo = '';
      this.$router?.push({ name: 'anime-zone' }).catch(() => {});
    }
  }
};
</script>

<style scoped>
.error-boundary {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  background: var(--bg-base);
}

.error-box {
  max-width: 420px;
  text-align: center;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 32px;
  box-shadow: var(--shadow-md);
}

.error-icon {
  font-size: 48px;
  margin-bottom: 12px;
}

.error-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.error-message {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 20px 0;
  word-break: break-word;
  line-height: 1.5;
}

.error-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}

.error-btn {
  padding: 8px 18px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.error-btn:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.error-btn--primary {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: var(--text-inverse);
}

.error-btn--primary:hover {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
  color: var(--text-inverse);
}
</style>
