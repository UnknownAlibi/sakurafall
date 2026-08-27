import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import store from './store';
import { perf } from './utils/perfMarks';
import { preloadImageCache } from './utils/imageCache';
import { openConfirm } from './services/confirmService';

// 暴露性能打点工具到 window，供 store/components 使用（生产环境自动 no-op）
window.__perf = perf;

function serializeRuntimeError(error, context = {}) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown error'),
    stack: String(error?.stack || ''),
    route: String(router.currentRoute?.value?.fullPath || location.hash || ''),
    context
  };
}

function reportRuntimeError(type, error, context = {}) {
  window.electronAPI?.runtimeDiagnosticsReport?.(type, serializeRuntimeError(error, context)).catch(() => {});
}

// 导入样式文件
import './assets/styles/variables.css';
import './assets/styles/themes.css';
import './assets/styles/main.css';
import './assets/styles/theme-anime.css';
import './assets/styles/kawaii.css';
import './assets/styles/polish.css';

// 生产环境禁用普通调试日志，保留错误日志
if (!import.meta.env.DEV) {
  console.log = () => {};
}

// 创建应用实例
const app = createApp(App);
const isPlayerRenderer = location.hash.includes('/player-window');

// Restore local cover mappings while the first list request is in flight.
if (!isPlayerRenderer) preloadImageCache().catch(() => {});

// 配置全局属性
app.config.globalProperties.$showNotification = function (notification) {
  // 使用 Vuex 显示通知
  this.$store.dispatch('notification/showNotification', notification);
};

// 注册全局方法
// 第三个参数 duration 可选（毫秒，<=0 表示常驻，不传用默认 4000）
app.config.globalProperties.$notify = {
  success: (title, message, duration) => {
    store.dispatch('notification/showNotification', {
      type: 'success',
      title,
      message,
      ...(duration !== undefined ? { duration } : {})
    });
  },
  error: (title, message, duration) => {
    store.dispatch('notification/showNotification', {
      type: 'error',
      title,
      message,
      ...(duration !== undefined ? { duration } : {})
    });
  },
  warning: (title, message, duration) => {
    store.dispatch('notification/showNotification', {
      type: 'warning',
      title,
      message,
      ...(duration !== undefined ? { duration } : {})
    });
  },
  info: (title, message, duration) => {
    store.dispatch('notification/showNotification', {
      type: 'info',
      title,
      message,
      ...(duration !== undefined ? { duration } : {})
    });
  }
};

// 全局确认弹窗：await this.$confirm({ title, message, danger }) -> boolean
app.config.globalProperties.$confirm = openConfirm;

// Vue errors must be registered before mount so bootstrap failures are captured.
app.config.errorHandler = (err, _vm, info) => {
  console.error('应用错误:', err);
  reportRuntimeError('vue-error', err, { info: String(info || '') });
  store.dispatch('notification/showNotification', {
    type: 'error',
    title: '页面操作失败',
    message: err?.message || '发生了未知错误'
  });
};

// 挂载插件
app.use(store);
app.use(router);

// 挂载应用
app.mount('#app');

function removeInitialLoading() {
  setTimeout(() => {
    document.body.classList.add('loaded');
    setTimeout(() => {
      const loading = document.getElementById('loading');
      if (loading) {
        loading.remove();
      }
    }, 500);
  }, 1000);
}

function preventDefaultFileDrop() {
  const prevent = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  document.addEventListener('dragover', prevent);
  document.addEventListener('drop', prevent);
}

removeInitialLoading();
preventDefaultFileDrop();

// 空闲时预加载全部路由 chunk，消除首次切页时懒加载导致的白屏间隙。
// Electron 本地文件加载开销可忽略；仅主窗口执行（播放窗口用不到其它页面）。
if (!isPlayerRenderer) {
  const preloadRoutes = () => {
    router.getRoutes().forEach(route => {
      const component = route.components?.default;
      if (typeof component === 'function') {
        component().catch(() => {});
      }
    });
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(preloadRoutes, { timeout: 3000 });
  } else {
    setTimeout(preloadRoutes, 1500);
  }
}

// 开发环境的调试信息
if (import.meta.env.DEV) {
  console.log('🚀 SAKURAFALL启动成功');
  console.log('📱 当前环境：开发环境');
  console.log('🌐 路由模式：Hash');
  
}

// 全局未捕获的Promise错误
window.addEventListener('unhandledrejection', event => {
  console.error('未处理的Promise错误:', event.reason);
  reportRuntimeError('unhandled-rejection', event.reason);
  
  // 显示错误通知
  store.dispatch('notification/showNotification', {
    type: 'error',
    title: '操作未完成',
    message: event.reason?.message || '发生了未处理的异步错误'
  });

  event.preventDefault();
});

window.addEventListener('error', event => {
  reportRuntimeError('window-error', event.error || event.message, {
    filename: String(event.filename || ''),
    line: Number(event.lineno) || 0,
    column: Number(event.colno) || 0
  });
});

export default app;
