<template>
  <div
    class="infinite-list-footer"
    :class="{ complete, failed: !!error }"
    aria-live="polite"
  >
    <template v-if="loading">
      <span class="infinite-loader" aria-hidden="true"><i></i><i></i><i></i></span>
      <span>正在加载更多番剧</span>
    </template>
    <button v-else-if="error" class="load-more-retry" @click="$emit('retry')">
      <span>加载失败</span>
      <strong>重新加载</strong>
    </button>
    <span v-else-if="limitReason" class="infinite-limit">{{ limitReason }}</span>
    <template v-else-if="complete">
      <span class="infinite-complete-mark" aria-hidden="true"></span>
      <span>本次筛选已全部加载</span>
    </template>
    <span v-else class="infinite-progress">
      已加载 {{ formatCount(loaded) }} 条
      <template v-if="total > 0"> · 全库结果 {{ formatCount(total) }} 条</template>
    </span>
  </div>
</template>

<script>
export default {
  name: 'AnimeInfiniteFooter',
  props: {
    loading: Boolean,
    error: { type: String, default: '' },
    limitReason: { type: String, default: '' },
    complete: Boolean,
    loaded: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  emits: ['retry'],
  methods: {
    formatCount(value) {
      return Math.max(0, Number(value) || 0).toLocaleString('zh-CN');
    }
  }
};
</script>

<style scoped>
.infinite-list-footer {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 18px;
  border-top: 1px solid rgba(var(--primary-rgb), 0.14);
  color: var(--text-tertiary);
  font-size: 12px;
}

.infinite-loader {
  width: 38px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.infinite-loader i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--primary-color);
  animation: infinite-load-dot 0.8s ease-in-out infinite alternate;
}

.infinite-loader i:nth-child(2) { animation-delay: 0.12s; }
.infinite-loader i:nth-child(3) { animation-delay: 0.24s; }
.infinite-progress { font-variant-numeric: tabular-nums; }

.infinite-limit {
  color: var(--text-secondary);
  text-align: center;
}

.infinite-complete-mark {
  width: 30px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--primary-color));
}

.load-more-retry {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  border-radius: 7px;
  background: var(--bg-card-glass);
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.18s ease, color 0.18s ease, background-color 0.18s ease;
}

.load-more-retry strong {
  color: var(--primary-color);
  font-size: 12px;
}

.load-more-retry:hover {
  border-color: var(--primary-color);
  background: var(--primary-lighter);
}

@keyframes infinite-load-dot {
  to {
    transform: translateY(-4px);
    opacity: 0.42;
  }
}
</style>
