<template>
  <span class="performance-governor" aria-hidden="true"></span>
</template>

<script>
import { perf } from '../../utils/perfMarks.js';
import budgets from '../../../shared/performance-budgets.json';

// 事件驱动的性能降级：
// 滚动时只设置 data-scroll-state；卡顿检测交给 long task observer。
// 避免常驻 requestAnimationFrame 轮询本身给 Electron 渲染线程添负担。

const SCROLL_IDLE_MS = 240;
const LONG_TASK_THRESHOLD = 8;
const LONG_TASK_WINDOW_MS = 5000;
const PRESSURE_RECOVERY_MS = 3000;

// 滚动帧率采样默认关闭，不占用生产环境的帧预算。但门槛不能是 perf.isDev：
// 打包后页面跑在 file:// 下，isDev 恒为 false，用户机器上永远采不到数据，
// 这类"只在开发机复现不了"的卡顿就无从定位。改为显式开关控制。
function scrollProfilingEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.__sakurafallScrollProfile !== undefined) return window.__sakurafallScrollProfile === true;
  try {
    return window.localStorage.getItem('sakurafall:scroll-profile') === '1';
  } catch (_error) {
    return false;
  }
}

export default {
  name: 'PerformanceGovernor',
  data() {
    return {
      scrollIdleTimer: null,
      longTaskObserver: null,
      longTaskTimestamps: [],
      pressureHigh: false,
      pressureRecoveryTimer: null,
      frameSampleId: null,
      frameSampleStartedAt: 0,
      frameSampleLastAt: 0,
      frameSamples: [],
      lastFrameSampleAt: 0,
      lastScrollAt: 0,
      enableScrollProfiling: false
    };
  },
  mounted() {
    this.root = document.documentElement;
    this.handleScroll = this.handleScroll.bind(this);
    this.enableScrollProfiling = scrollProfilingEnabled();

    // 性能面板可以在运行时切换开关，无需重启
    window.__sakurafallSetScrollProfile = enabled => {
      this.enableScrollProfiling = !!enabled;
      if (!enabled) {
        this.root.removeAttribute('data-render-fps');
        if (this.frameSampleId) cancelAnimationFrame(this.frameSampleId);
        this.frameSampleId = null;
      }
    };

    document.addEventListener('wheel', this.handleScroll, { passive: true, capture: true });
    document.addEventListener('scroll', this.handleScroll, { passive: true, capture: true });

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'longtask') {
              this.recordLongTask();
            }
          }
        });
        this.longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch (e) {
        // 不支持 longtask 时，仅保留滚动状态降级。
      }
    }
  },
  beforeUnmount() {
    document.removeEventListener('wheel', this.handleScroll, { capture: true });
    document.removeEventListener('scroll', this.handleScroll, { capture: true });

    if (this.scrollIdleTimer) clearTimeout(this.scrollIdleTimer);
    if (this.pressureRecoveryTimer) clearTimeout(this.pressureRecoveryTimer);
    if (this.frameSampleId) cancelAnimationFrame(this.frameSampleId);
    this.longTaskObserver?.disconnect?.();
    this.root?.removeAttribute('data-scroll-state');
    this.root?.removeAttribute('data-performance-pressure');
    this.root?.removeAttribute('data-render-fps');
    delete window.__sakurafallSetScrollProfile;
  },
  methods: {
    handleScroll() {
      if (this.root.getAttribute('data-scroll-state') !== 'scrolling') {
        this.root.setAttribute('data-scroll-state', 'scrolling');
      }

      this.lastScrollAt = performance.now();
      if (this.enableScrollProfiling) this.startFrameSample();
      if (this.scrollIdleTimer) return;

      const finishScroll = () => {
        const remaining = SCROLL_IDLE_MS - (performance.now() - this.lastScrollAt);
        if (remaining > 0) {
          this.scrollIdleTimer = setTimeout(finishScroll, remaining);
          return;
        }
        this.scrollIdleTimer = null;
        this.root.removeAttribute('data-scroll-state');
      };
      this.scrollIdleTimer = setTimeout(finishScroll, SCROLL_IDLE_MS);
    },

    startFrameSample() {
      const now = performance.now();
      const config = budgets.scroll;
      if (this.frameSampleId || now - this.lastFrameSampleAt < config.sampleCooldownMs) return;
      this.frameSampleStartedAt = now;
      this.frameSampleLastAt = now;
      this.frameSamples = [];

      const sample = timestamp => {
        const delta = timestamp - this.frameSampleLastAt;
        this.frameSampleLastAt = timestamp;
        if (delta > 0 && delta < 250) this.frameSamples.push(delta);
        if (timestamp - this.frameSampleStartedAt < config.sampleDurationMs) {
          this.frameSampleId = requestAnimationFrame(sample);
          return;
        }
        this.frameSampleId = null;
        this.lastFrameSampleAt = timestamp;
        this.finishFrameSample();
      };
      this.frameSampleId = requestAnimationFrame(sample);
    },

    finishFrameSample() {
      if (this.frameSamples.length < 4) return;
      const total = this.frameSamples.reduce((sum, value) => sum + value, 0);
      const averageFrameMs = total / this.frameSamples.length;
      const fps = Math.min(120, 1000 / averageFrameMs);
      const longFrames = this.frameSamples.filter(value => value > budgets.scroll.longFrameMs).length;
      const longFrameRatio = longFrames / this.frameSamples.length;
      this.root.setAttribute('data-render-fps', String(Math.round(fps)));
      perf.record('scroll-frame', averageFrameMs, {
        fps: Math.round(fps),
        longFrameRatio: Math.round(longFrameRatio * 1000) / 1000,
        samples: this.frameSamples.length
      });
      if (fps < budgets.scroll.minimumFps || longFrameRatio > budgets.scroll.maximumLongFrameRatio) {
        this.triggerPressure();
      }
      this.frameSamples = [];
    },

    recordLongTask() {
      const now = Date.now();
      this.longTaskTimestamps.push(now);
      this.pruneLongTasks(now);

      if (this.longTaskTimestamps.length >= LONG_TASK_THRESHOLD) {
        this.triggerPressure();
      }
    },

    pruneLongTasks(now = Date.now()) {
      const cutoff = now - LONG_TASK_WINDOW_MS;
      while (this.longTaskTimestamps.length > 0 && this.longTaskTimestamps[0] < cutoff) {
        this.longTaskTimestamps.shift();
      }
    },

    triggerPressure() {
      if (this.pressureHigh) return;
      this.pressureHigh = true;
      this.root.setAttribute('data-performance-pressure', 'high');
      this.longTaskTimestamps = [];
      this.scheduleRecoveryCheck();
    },

    scheduleRecoveryCheck() {
      if (this.pressureRecoveryTimer) clearTimeout(this.pressureRecoveryTimer);
      this.pressureRecoveryTimer = setTimeout(() => {
        this.pressureRecoveryTimer = null;
        this.pruneLongTasks();
        if (this.longTaskTimestamps.length < LONG_TASK_THRESHOLD / 2) {
          this.recoverPressure();
        } else {
          this.scheduleRecoveryCheck();
        }
      }, PRESSURE_RECOVERY_MS);
    },

    recoverPressure() {
      if (!this.pressureHigh) return;
      this.pressureHigh = false;
      this.root.removeAttribute('data-performance-pressure');
      this.longTaskTimestamps = [];
    }
  }
};
</script>

<style scoped>
.performance-governor {
  display: none;
}
</style>
