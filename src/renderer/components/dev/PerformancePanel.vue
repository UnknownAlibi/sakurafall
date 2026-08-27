<template>
  <div v-if="visible" class="perf-panel">
    <div class="perf-header">
      <span class="perf-title">性能面板</span>
      <div class="perf-actions">
        <button class="perf-btn" @click="refresh">刷新</button>
        <button class="perf-btn" @click="clear">清空</button>
        <button class="perf-btn perf-close" @click="visible = false">×</button>
      </div>
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
      recentRecords: []
    };
  },
  mounted() {
    // Ctrl+Shift+P 切换性能面板（仅开发模式）
    document.addEventListener('keydown', this.onKeyDown);
    // 每 2 秒自动刷新（面板可见时）
    this._refreshTimer = setInterval(() => {
      if (this.visible) this.refresh();
    }, 2000);
  },
  beforeUnmount() {
    document.removeEventListener('keydown', this.onKeyDown);
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  },
  methods: {
    onKeyDown(e) {
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        this.visible = !this.visible;
        if (this.visible) this.refresh();
      }
    },
    refresh() {
      this.summary = perf.getSummary();
      this.recentRecords = perf.getRecords().slice(-15).reverse();
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
