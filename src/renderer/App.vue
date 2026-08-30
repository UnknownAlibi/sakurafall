<template>
  <div id="app">
    <!-- 标题栏（播放窗口使用自己的精简标题栏） -->
    <TitleBar v-if="!isPlayerWindow" />

    <div class="app-workspace" :class="{ 'player-workspace': isPlayerWindow }">
      <!-- 桌面端使用应用级导航轨道，给内容区留下稳定的纵向空间。 -->
      <TabNavigation v-if="!isPlayerWindow" />

      <!-- 主内容区域 -->
      <div class="main-content" :class="{ 'player-window-content': isPlayerWindow }">
        <ErrorBoundary v-if="bootstrapped">
          <router-view v-slot="{ Component, route }">
            <transition :name="`page-${pageDirection}`" :css="pageTransitionsEnabled">
              <KeepAlive include="AnimeZone" :max="1">
                <component :is="Component" :key="route.name" />
              </KeepAlive>
            </transition>
          </router-view>
        </ErrorBoundary>
        <!-- 启动引导期占位：吉祥物增强演出（浮动 + 樱花粒子 + 文案轮播） -->
        <div v-else class="app-boot-placeholder">
          <div class="anime-loading-stage stage-enhanced" aria-hidden="true">
            <span class="loading-petal p1"></span>
            <span class="loading-petal p2"></span>
            <span class="loading-petal p3"></span>
            <span class="loading-petal p4"></span>
            <span class="loading-petal p5"></span>
            <div class="anime-loading-mascot"></div>
            <div class="anime-loading-bubble">
              <Transition name="bubble-text" mode="out-in">
                <span :key="bootPhraseIndex">{{ bootPhrases[bootPhraseIndex] }}</span>
              </Transition>
              <i></i><i></i><i></i>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 全局通知组件 -->
    <GlobalNotification />
    <!-- 顶部路由加载进度条（仅主窗口） -->
    <TopLoadingBar v-if="!isPlayerWindow" />
    <!-- 全局确认弹窗（替代原生 window.confirm，跟随主题） -->
    <ConfirmDialog />
    <!-- 快速导航面板（Ctrl+K，仅主窗口） -->
    <CommandPalette v-if="!isPlayerWindow" />
    <!-- 首次使用引导（仅主窗口，localStorage 标记只显示一次） -->
    <WelcomeOverlay v-if="!isPlayerWindow" />
    <PerformanceGovernor v-if="!isPlayerWindow" />
    <AnimeCursor v-if="!isPlayerWindow" />
    <!-- 开发模式性能面板：Ctrl+Shift+P 切换 -->
    <PerformancePanel v-if="!isPlayerWindow" />
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import TitleBar from './components/Common/TitleBar.vue';
import TabNavigation from './components/Common/TabNavigation.vue';
import GlobalNotification from './components/Common/GlobalNotification.vue';
import ConfirmDialog from './components/Common/ConfirmDialog.vue';
import TopLoadingBar from './components/Common/TopLoadingBar.vue';
import CommandPalette from './components/Common/CommandPalette.vue';
import WelcomeOverlay from './components/Common/WelcomeOverlay.vue';
import ErrorBoundary from './components/Common/ErrorBoundary.vue';
import PerformanceGovernor from './components/Common/PerformanceGovernor.vue';
import PerformancePanel from './components/dev/PerformancePanel.vue';
import AnimeCursor from './components/Common/AnimeCursor.vue';
import { startPerfMarks } from './utils/perfMarks.js';
import { applyThemeCustomization } from './utils/themeRuntime.js';

export default {
  name: 'App',
  components: {
    TitleBar,
    TabNavigation,
    GlobalNotification,
    ConfirmDialog,
    TopLoadingBar,
    CommandPalette,
    WelcomeOverlay,
    ErrorBoundary,
    PerformanceGovernor,
    PerformancePanel,
    AnimeCursor
  },
  computed: {
    ...mapGetters('settings', ['theme', 'themePackId', 'customCss', 'uiEffectsMode']),
    isPlayerWindow() {
      return !!this.$route.meta?.isPlayerWindow;
    },
    pageTransitionsEnabled() {
      return !this.isPlayerWindow && this.pageVisible && this.uiEffectsMode !== 'performance';
    }
  },
  data() {
    return {
      bootstrapped: false,
      pageVisible: !document.hidden,
      // 方向性页面过渡：forward 新页从右推入 / back 新页从左推入
      pageDirection: 'forward',
      // 启动占位文案轮播
      bootPhraseIndex: 0,
      bootPhrases: ['樱月正在准备放映', '胶片已经装好啦', '找到想看的番了吗', '马上就好...'],
      // Alt+1..7 快速导航（与 TabNavigation 顺序一致）
      quickNavRoutes: ['anime-zone', 'discovery', 'my-favorites', 'downloads', 'bt-hub', 'source-manager', 'settings']
    };
  },
  watch: {
    theme: {
      handler(newTheme) {
        this.applyTheme(newTheme);
      }
    },
    uiEffectsMode: {
      handler(newMode) {
        this.applyUiEffectsMode(newMode);
      }
    },
    themePackId() {
      this.loadThemeCustomization();
    },
    customCss() {
      this.loadThemeCustomization();
    }
  },
  methods: {
    ...mapActions('settings', ['loadSettings']),

    async syncNetworkSettingsToMain() {
      if (!window.electronAPI?.setNetworkConfig) return;
      const s = this.$store.state.settings || {};
      const rawPolicies = s.networkPolicies || null;
      const networkPolicies = rawPolicies && typeof rawPolicies === 'object'
        ? {
          bangumi: String(rawPolicies.bangumi || 'proxy'),
          cms: String(rawPolicies.cms || 'direct'),
          video: String(rawPolicies.video || 'direct'),
          danmaku: String(rawPolicies.danmaku || 'proxy'),
          'trace-moe': String(rawPolicies['trace-moe'] || 'proxy'),
          image: String(rawPolicies.image || 'proxy')
        }
        : null;
      await window.electronAPI.setNetworkConfig({
        requestTimeout: (Number(s.requestTimeout) || 30) * 1000,
        maxConcurrentConnections: Number(s.maxConcurrentConnections) || 5,
        cacheSize: Number(s.cacheSize) || 1000,
        autoCleanCache: s.autoCleanCache !== false,
        proxy: s.proxy || '',
        bangumiMirror: s.bangumiMirror || '',
        networkPolicies
      });
    },

    applyTheme(theme) {
      const root = document.documentElement;
      if (theme === 'auto') {
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        root.setAttribute('data-theme', systemTheme);
      } else {
        root.setAttribute('data-theme', theme);
      }
    },

    handleSystemThemeChange(e) {
      if (this.theme === 'auto') {
        const root = document.documentElement;
        root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    },

    applyUiEffectsMode(mode) {
      const allowedModes = new Set(['anime', 'balanced', 'performance']);
      const nextMode = allowedModes.has(mode) ? mode : 'balanced';
      document.documentElement.setAttribute('data-ui-effects', nextMode);
    },

    async loadThemeCustomization() {
      const requestId = this.themePackId || 'sakurafall-default';
      let pack = null;
      try {
        const [basePack, selectedPack] = await Promise.all([
          window.electronAPI?.themePackGet?.('sakurafall-default'),
          requestId === 'sakurafall-default'
            ? Promise.resolve(null)
            : window.electronAPI?.themePackGet?.(requestId)
        ]);
        pack = selectedPack
          ? {
            ...selectedPack,
            content: {
              ...(basePack?.content || {}),
              ...(selectedPack.content || {}),
              variables: { ...(basePack?.content?.variables || {}), ...(selectedPack.content?.variables || {}) },
              assets: { ...(basePack?.content?.assets || {}), ...(selectedPack.content?.assets || {}) },
              layout: { ...(basePack?.content?.layout || {}), ...(selectedPack.content?.layout || {}) },
              customCss: `${basePack?.content?.customCss || ''}\n${selectedPack.content?.customCss || ''}`
            }
          }
          : basePack;
      } catch (error) {
        console.warn('[Theme] 加载主题包失败:', error.message);
      }
      if (requestId !== (this.themePackId || 'sakurafall-default')) return;
      applyThemeCustomization(pack, this.customCss || '');
    },

    /**
     * 处理系统通知点击后的跳转
     * 收到 { animeId, source, name }，按来源路由到动漫专区
     */
    handleReminderOpen(info) {
      if (!info) return;
      const source = info.source || 'legacy';
      const animeId = info.animeId;
      const name = info.name || '';
      try {
        if (source === 'ffzy' || source === 'fanzhi') {
          this.$router.push({
            name: 'anime-zone',
            query: { openDetail: animeId }
          });
        } else if (source === 'bangumi') {
          this.$router.push({
            name: 'anime-zone',
            query: { search: name, source: 'bangumi' }
          });
        } else {
          // CMS 多源收藏 -> 跳到动漫专区的多源聚合模式
          this.$router.push({
            name: 'anime-zone',
            query: { search: name, source: 'cms-multi' }
          });
        }
      } catch (e) {
        console.error('[Reminder] 跳转路由失败:', e);
      }
    }
  },
  async mounted() {
    // 软件渲染检测：GPU 被禁用（GpuGuard 降级）或极弱显卡时 WebGL 返回 SwiftShader，
    // 标记到 <html data-software-rendering>，CSS 层据此收缩动画开销
    let rendererProbeCanvas = null;
    let rendererProbeContext = null;
    try {
      rendererProbeCanvas = document.createElement('canvas');
      rendererProbeContext = rendererProbeCanvas.getContext('webgl');
      const gl = rendererProbeContext;
      const renderer = gl ? String(gl.getParameter(gl.RENDERER) || '').toLowerCase() : '';
      const software = !gl || renderer.includes('swiftshader')
        || renderer.includes('software') || renderer.includes('llvmpipe');
      if (software) {
        document.documentElement.setAttribute('data-software-rendering', 'true');
        console.warn('[Perf] 检测到软件渲染环境，动画已自动降级');
      }
    } catch (_) { /* 检测失败不阻塞启动 */ }
    finally {
      // The probe must not keep an otherwise unused WebGL context alive for the
      // entire main-window lifetime. The player creates its own context on demand.
      rendererProbeContext?.getExtension('WEBGL_lose_context')?.loseContext();
      if (rendererProbeCanvas) {
        rendererProbeCanvas.width = 1;
        rendererProbeCanvas.height = 1;
      }
    }

    this._handleVisibilityChange = () => {
      this.pageVisible = !document.hidden;
    };
    document.addEventListener('visibilitychange', this._handleVisibilityChange);

    // 方向性过渡：基于 history.state.position 判断前进/后退
    // （Vue Router 4 为每条历史记录维护递增 position，popstate 返回时值变小）
    this._lastHistoryPos = window.history.state?.position ?? 0;
    this._unregisterRouteDirection = this.$router.afterEach(() => {
      const pos = window.history.state?.position ?? this._lastHistoryPos;
      this.pageDirection = pos < this._lastHistoryPos ? 'back' : 'forward';
      this._lastHistoryPos = pos;
    });

    // 启动占位文案轮播：bootstrap 完成后自动停止
    this._bootPhraseTimer = setInterval(() => {
      this.bootPhraseIndex = (this.bootPhraseIndex + 1) % this.bootPhrases.length;
    }, 2400);
    const stopPhraseTimer = () => {
      clearInterval(this._bootPhraseTimer);
      this._bootPhraseTimer = null;
    };
    this._stopBootPhrase = stopPhraseTimer;
    this.$watch('bootstrapped', (ready) => {
      if (ready) stopPhraseTimer();
    });
    // Alt+1..7 快速切换页面（与 TabNavigation 顺序一致，仅主窗口）
    this._handleAltTab = (event) => {
      if (this.isPlayerWindow || !event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Alt' || !/^[1-7]$/.test(event.key)) return;
      const target = this.quickNavRoutes[Number(event.key) - 1];
      if (target && this.$route.name !== target) {
        event.preventDefault();
        this.$router.push({ name: target }).catch(() => {});
      }
    };
    document.addEventListener('keydown', this._handleAltTab);
    this._unbindMainRoute = window.electronAPI?.onNavigateMainRoute?.((route) => {
      const target = typeof route === 'string' && route.startsWith('/') ? route : '/settings';
      if (this.$route.path !== target) this.$router.push(target).catch(() => {});
    });

    try {
      await this.loadSettings();
      await this.syncNetworkSettingsToMain();
      this.applyTheme(this.theme);
      this.applyUiEffectsMode(this.uiEffectsMode);
      await this.loadThemeCustomization();
      this.bootstrapped = true;
      // 启动轻量性能标记（dev 模式输出首屏耗时与 long task）
      startPerfMarks();
      // 启动时同步弹幕凭证和多源配置到主进程。
      const danmakuSettings = this.$store.state.settings;
      if (window.electronAPI?.danmakuSetCredentials) {
        await window.electronAPI.danmakuSetCredentials(
          danmakuSettings.dandanplayAppId || '',
          danmakuSettings.dandanplayAppSecret || ''
        );
      }
      if (window.electronAPI?.danmakuConfigureProviders) {
        await window.electronAPI.danmakuConfigureProviders({
          providers: danmakuSettings.danmakuProviders || {},
          customEndpoint: danmakuSettings.danmakuCustomEndpoint || '',
          customToken: danmakuSettings.danmakuCustomToken || ''
        });
      }
      if (!this.isPlayerWindow) {
        // 绑定下载进度监听（主进程推送 on-download-progress 事件）
        this.$store.dispatch('download/bindProgressListener');
        // 番剧更新提醒：仅在主窗口绑定监听并同步配置
        // 同步启用状态与检查间隔到主进程
        const s = this.$store.state.settings;
        if (window.electronAPI && window.electronAPI.updateReminderConfigure) {
          window.electronAPI.updateReminderConfigure({
            enabled: s.enableUpdateReminder !== false,
            intervalMinutes: s.updateReminderInterval || 60
          });
        }
        // 拉取一次提醒列表（含上次检查时间）
        this.$store.dispatch('reminder/loadReminders');
        // 绑定主进程推送的新提醒事件
        this.$store.dispatch('reminder/bindListener');
        // 绑定系统通知点击后的跳转事件
        this.$store.dispatch('reminder/bindOpenListener', this.handleReminderOpen);
      }
    } catch (error) {
      this.bootstrapped = true;
    }

    // 监听系统主题变化（auto 模式下响应）
    this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this._mediaQuery.addEventListener('change', this.handleSystemThemeChange);
  },
  beforeUnmount() {
    document.removeEventListener('visibilitychange', this._handleVisibilityChange);
    this._unregisterRouteDirection?.();
    if (this._bootPhraseTimer) {
      clearInterval(this._bootPhraseTimer);
      this._bootPhraseTimer = null;
    }
    if (this._handleAltTab) {
      document.removeEventListener('keydown', this._handleAltTab);
      this._handleAltTab = null;
    }
    this._unbindMainRoute?.();
    if (this._mediaQuery) {
      this._mediaQuery.removeEventListener('change', this.handleSystemThemeChange);
    }
    // 解绑提醒监听，避免重复绑定与内存泄漏
    this.$store.dispatch('reminder/unbindListener');
  }
};
</script>

<style>
/* 全局样式重置 */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  font-family: var(--font-family);
  background: var(--bg-base);
  color: var(--text-primary);
  transition: background-color 0.3s ease, color 0.3s ease;
}

#app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.app-workspace.player-workspace {
  display: block;
}

.main-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  position: relative;
  background:
    linear-gradient(180deg, var(--theme-ambient-light-top, rgba(255, 251, 253, 0.82)) 0%, var(--theme-ambient-light-mid, rgba(254, 248, 250, 0.92)) 52%, var(--bg-base) 100%),
    var(--app-ambient-bg) center top / cover no-repeat,
    var(--bg-base);
  transition: background-color 0.3s ease;
}

[data-theme="dark"] .main-content {
  background:
    linear-gradient(180deg, var(--theme-ambient-dark-top, rgba(26, 18, 32, 0.7)) 0%, var(--theme-ambient-dark-mid, rgba(26, 18, 32, 0.88)) 52%, var(--bg-base) 100%),
    var(--app-ambient-bg) center top / cover no-repeat,
    var(--bg-base);
}

/* 标准演出（balanced）沿用完整演出的背景与界面动效，仅由鼠标组件切回系统鼠标。 */

/* 纯净模式：无任何装饰背景 */
[data-ui-effects="performance"] .main-content {
  background: var(--bg-base);
}

/* ===== 方向性页面过渡：前进从右推入 / 后退从左推入 ===== */
.page-forward-enter-active,
.page-forward-leave-active,
.page-back-enter-active,
.page-back-leave-active {
  transition: opacity 0.22s var(--ease-smooth), transform 0.22s var(--ease-smooth);
}

.page-forward-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.page-forward-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}

.page-back-enter-from {
  opacity: 0;
  transform: translateX(-30px);
}

.page-back-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

/* 过渡期间离场页脱离文档流（绝对定位），避免新旧两页堆叠把容器撑高 */
.page-forward-leave-active,
.page-back-leave-active {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* 纯净模式：Vue 不挂载过渡；以下规则也负责清理切档瞬间可能残留的过渡类。 */
[data-ui-effects="performance"] .page-forward-enter-active,
[data-ui-effects="performance"] .page-forward-leave-active,
[data-ui-effects="performance"] .page-back-enter-active,
[data-ui-effects="performance"] .page-back-leave-active,
[data-ui-effects="performance"] .page-forward-enter-from,
[data-ui-effects="performance"] .page-forward-leave-to,
[data-ui-effects="performance"] .page-back-enter-from,
[data-ui-effects="performance"] .page-back-leave-to {
  opacity: 1 !important;
  transform: none !important;
  transition: none !important;
}

/* 启动占位文案轮播过渡 */
.bubble-text-enter-active,
.bubble-text-leave-active {
  transition: opacity 0.28s var(--ease-smooth), transform 0.28s var(--ease-smooth);
}

.bubble-text-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.bubble-text-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

[data-theme="dark"][data-ui-effects="performance"] .main-content {
  background: var(--bg-base);
}

.main-content.player-window-content {
  overflow: hidden;
  background: var(--player-bg);
}

.app-boot-placeholder {
  min-height: 100%;
}

@media (max-width: 820px) {
  .app-workspace {
    flex-direction: column;
  }
}
</style>
