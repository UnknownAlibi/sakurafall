<template>
  <div v-if="visible" class="perf-panel">
    <div class="perf-header">
      <span class="perf-title">性能面板</span>
      <div class="perf-actions">
        <button
          class="perf-btn"
          :class="{ 'perf-btn-on': scrollProfileOn }"
          @click="toggleScrollProfile"
        >滚动采样 {{ scrollProfileOn ? '开' : '关' }}</button>
        <button class="perf-btn" @click="refresh">刷新</button>
        <button class="perf-btn" @click="clear">清空</button>
        <button class="perf-btn perf-close" @click="visible = false">×</button>
      </div>
    </div>
    <div class="perf-live">
      <span class="perf-live-label">实时 FPS</span>
      <strong class="perf-live-value" :class="{ 'perf-slow': liveFps !== '—' && Number(liveFps) < 45 }">{{ liveFps }}</strong>
      <span v-if="longFrameRatio !== null" class="perf-live-meta">长帧占比 {{ longFrameRatio }}</span>
      <span v-else-if="scrollProfileOn" class="perf-live-meta">滚动列表即可采样</span>
      <span v-else class="perf-live-meta">开启「滚动采样」后滚动列表</span>
    </div>
    <div class="perf-body">
      <div v-if="summary.length === 0" class="perf-empty">暂无性能数据</div>
      <table v-else class="perf-table">
        <thead>
          <tr>
            <th>标签</th>
            <th>次数</th>
            <th>平均</th>
            <th>最小</th>
            <th>最大</th>
            <th>预算</th>
            <th>总计</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in summary" :key="row.label">
            <td class="perf-label">{{ row.label }}</td>
            <td>{{ row.count }}</td>
            <td :class="{ 'perf-slow': row.avg > 500 }">{{ row.avg }}ms</td>
            <td>{{ row.min }}ms</td>
            <td :class="{ 'perf-slow': row.max > 1000 }">{{ row.max }}ms</td>
            <td :class="{ 'perf-slow': row.violations > 0 }">{{ row.budgetMs ? `${row.budgetMs}ms / ${row.violations}` : '—' }}</td>
            <td>{{ row.total }}ms</td>
          </tr>
        </tbody>
      </table>
      <div v-if="recentRecords.length > 0" class="perf-recent">
        <div class="perf-recent-title">最近记录</div>
        <div v-for="(r, i) in recentRecords" :key="i" class="perf-record">
          <span class="perf-record-label">{{ r.label }}</span>
          <span :class="['perf-record-dur', { 'perf-slow': r.duration > 500 }]">{{ r.duration }}ms</span>
          <span v-if="r.meta && Object.keys(r.meta).length > 0" class="perf-record-meta">{{ JSON.stringify(r.meta) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { perf } from '../../utils/perfMarks';

export default {
  name: 'PerformancePanel',
  data() {
    return {
      visible: false,
      summary: [],
      recentRecords: [],
      scrollProfileOn: false,
      liveFps: '—',
      longFrameRatio: null
    };
  },
  mounted() {
    // Ctrl+Shift+P 切换性能面板（生产构建同样可用，方便在真机上定位卡顿）
    document.addEventListener('keydown', this.onKeyDown);
    this.scrollProfileOn = this.readScrollProfile();
    // 每 2 秒自动刷新（面板可见时）
    this._refreshTimer = setInterval(() => {
      if (this.visible) this.refresh();
    }, 2000);
    // FPS 需要更实时的反馈，单独用更短的周期
    this._fpsTimer = setInterval(() => {
      if (this.visible) this.readLiveFps();
    }, 400);
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKeyDown);
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    if (this._fpsTimer) clearInterval(this._fpsTimer);
  },
  methods: {
    readScrollProfile() {
      if (typeof window === 'undefined') return false;
      if (window.__sakurafallScrollProfile !== undefined) return window.__sakurafallScrollProfile === true;
      try {
        return window.localStorage.getItem('sakurafall:scroll-profile') === '1';
      } catch (_error) {
        return false;
      }
    },
    toggleScrollProfile() {
      const next = !this.scrollProfileOn;
      try {
        window.localStorage.setItem('sakurafall:scroll-profile', next ? '1' : '0');
      } catch (_error) { /* 隐私模式下写失败时仍允许本次会话生效 */ }
      window.__sakurafallScrollProfile = next;
      this.scrollProfileOn = next;
      if (typeof window.__sakurafallSetScrollProfile === 'function') {
        window.__sakurafallSetScrollProfile(next);
      }
      if (!next) {
        this.liveFps = '—';
        this.longFrameRatio = null;
      }
    },
    readLiveFps() {
      const fps = document.documentElement.getAttribute('data-render-fps');
      this.liveFps = fps ? String(fps) : '—';
    },
    onKeyDown(e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        this.visible = !this.visible;
        if (this.visible) {
          this.refresh();
          this.readLiveFps();
        }
      }
    },
    refresh() {
      this.summary = perf.getSummary();
      const records = perf.getRecords();
      this.recentRecords = records.slice(-15).reverse();
      const scrollFrame = records.filter(item => item.label === 'scroll-frame').pop();
      this.longFrameRatio = scrollFrame?.meta?.longFrameRatio ?? null;
    },
    clear() {
      perf.clear();
      this.summary = [];
      this.recentRecords = [];
    }
  }
};
</script>

<style scoped>
.perf-panel {
  position: fixed;
  top: 60px;
  right: 20px;
  width: 420px;
  max-height: 70vh;
  background: rgba(30, 30, 35, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  z-index: 99999;
  font-size: 12px;
  color: #e0e0e0;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(8px);
}

.perf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.perf-title {
  font-weight: 700;
  font-size: 13px;
}

.perf-actions {
  display: flex;
  gap: 6px;
}

.perf-btn {
  padding: 3px 10px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  color: #ccc;
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.perf-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.perf-close {
  font-size: 14px;
  line-height: 1;
  padding: 3px 8px;
}

.perf-btn-on {
  background: rgba(76, 175, 122, 0.24);
  border-color: rgba(76, 175, 122, 0.55);
  color: #b9f0d1;
}

.perf-live {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.perf-live-label {
  color: #9aa0a6;
  font-size: 11px;
}

.perf-live-value {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  color: #7fd8a8;
}

.perf-live-meta {
  margin-left: auto;
  color: #888;
  font-size: 11px;
}

.perf-body {
  overflow-y: auto;
  padding: 10px 14px;
  flex: 1;
}

.perf-empty {
  text-align: center;
  color: #888;
  padding: 20px;
}

.perf-table {
  width: 100%;
  border-collapse: collapse;
}

.perf-table th {
  text-align: left;
  padding: 4px 6px;
  color: #999;
  font-weight: 600;
  font-size: 10px;
  text-transform: uppercase;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.perf-table td {
  padding: 4px 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.perf-label {
  font-family: monospace;
  color: #7ec;
}

.perf-slow {
  color: #ff9966;
  font-weight: 600;
}

.perf-recent {
  margin-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 10px;
}

.perf-recent-title {
  font-size: 10px;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.perf-record {
  display: flex;
  gap: 8px;
  padding: 2px 0;
  font-size: 11px;
  font-family: monospace;
}

.perf-record-label {
  color: #7ec;
  min-width: 120px;
}

.perf-record-dur {
  color: #aaa;
  min-width: 60px;
}

.perf-record-meta {
  color: #777;
  font-size: 10px;
}
</style>
