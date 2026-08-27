/**
 * 性能打点工具（P1：性能观测面板）
 *
 * 统一记录关键操作的耗时，供开发模式下的性能面板展示。
 * 生产环境自动降级为 no-op，不影响性能。
 *
 * 使用方式：
 *   import { perf } from '@/utils/perfMarks';
 *   const mark = perf.start('list-query');
 *   // ... 执行操作 ...
 *   perf.end(mark);  // 或 perf.end(mark, { items: 24 })
 */

import budgets from '../../shared/performance-budgets.json';

const isDev = process.env.NODE_ENV === 'development' ||
  (typeof window !== 'undefined' && window.location?.hostname === 'localhost');

const records = [];
const MAX_RECORDS = 200;
const pendingStarts = new Map();

/**
 * 开始计时
 * @param {string} label - 操作标签，如 'list-query'、'image-cache'
 * @returns {string} markId，传给 perf.end()
 */
function start(label) {
  const id = `${label}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
  pendingStarts.set(id, { label, startTime: performance.now() });
  return id;
}

/**
 * 结束计时并记录
 * @param {string} markId - perf.start 返回的 id
 * @param {Object} meta - 附加元数据（如 { items: 24, fromCache: true }）
 */
function end(markId, meta = {}) {
  if (!markId) return;
  const pending = pendingStarts.get(markId);
  if (!pending) return;
  pendingStarts.delete(markId);
  const duration = performance.now() - pending.startTime;
  record(pending.label, duration, meta);
}

function record(label, duration, meta = {}) {
  const value = Math.round((Number(duration) || 0) * 100) / 100;
  const budgetMs = Number(budgets.operations?.[label]) || 0;
  records.push({
    label,
    duration: value,
    timestamp: Date.now(),
    budgetMs,
    overBudget: budgetMs > 0 && value > budgetMs,
    meta
  });
  if (records.length > MAX_RECORDS) {
    records.shift();
  }
}

/**
 * 获取所有性能记录
 */
function getRecords() {
  return records.slice();
}

/**
 * 按标签聚合统计（平均/最大/最小/次数）
 */
function getSummary() {
  const groups = {};
  for (const r of records) {
    if (!groups[r.label]) {
      groups[r.label] = { label: r.label, count: 0, total: 0, min: Infinity, max: 0, avg: 0, budgetMs: r.budgetMs || 0, violations: 0 };
    }
    const g = groups[r.label];
    g.count++;
    g.total += r.duration;
    g.min = Math.min(g.min, r.duration);
    g.max = Math.max(g.max, r.duration);
    if (r.overBudget) g.violations += 1;
  }
  const result = Object.values(groups);
  for (const g of result) {
    g.avg = g.count > 0 ? Math.round((g.total / g.count) * 100) / 100 : 0;
    g.min = g.min === Infinity ? 0 : Math.round(g.min * 100) / 100;
    g.max = Math.round(g.max * 100) / 100;
    g.total = Math.round(g.total * 100) / 100;
  }
  return result.sort((a, b) => b.total - a.total);
}

function getBudgetViolations() {
  return records.filter(record => record.overBudget);
}

/**
 * 清空记录
 */
function clear() {
  records.length = 0;
  pendingStarts.clear();
}

/**
 * 测量同步函数执行时间
 */
function measure(label, fn) {
  const mark = start(label);
  try {
    return fn();
  } finally {
    end(mark);
  }
}

/**
 * 测量异步函数执行时间
 */
async function measureAsync(label, fn) {
  const mark = start(label);
  try {
    return await fn();
  } finally {
    end(mark);
  }
}

export const perf = {
  start,
  end,
  record,
  measure,
  measureAsync,
  getRecords,
  getSummary,
  getBudgetViolations,
  clear,
  isDev,
  budgets
};

/**
 * 启动轻量性能标记（dev 模式输出首屏耗时与 long task）
 * 兼容原有 App.vue 调用
 */
export function startPerfMarks() {
  if (!isDev) return;
  // 首屏耗时
  window.addEventListener('load', () => {
    const tti = performance.now();
    const mark = start('first-screen');
    end(mark, { tti: Math.round(tti) });
    console.log(`[Perf] 首屏耗时: ${Math.round(tti)}ms`);
  });
  // Long task 监控
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            console.warn(`[Perf] Long task: ${Math.round(entry.duration)}ms`);
          }
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (_e) {
      // PerformanceObserver 不支持 longtask 时忽略
    }
  }
}
