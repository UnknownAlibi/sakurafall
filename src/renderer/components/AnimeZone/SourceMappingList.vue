<template>
  <div class="source-mapping-panel">
    <div class="source-mapping-head">
      <strong>需要手动确认的合集源</strong>
      <span>标题能对上，但无法确定季/集偏移。指定本季第 1 集对应合集中的第几集后再采用。</span>
    </div>
    <div v-for="item in sources" :key="item.key" class="source-mapping-row">
      <div class="source-mapping-info">
        <span class="source-mapping-source">{{ item.sourceName }}</span>
        <span class="source-mapping-title">{{ item.title || '合集源' }}</span>
        <span class="source-mapping-meta">共 {{ item.totalEpisodes }} 集{{ item.lineCount > 1 ? ` · ${item.lineCount} 条线路` : '' }}</span>
      </div>
      <div class="source-mapping-controls">
        <span class="source-mapping-hint">本季第 1 集 = 合集第</span>
        <input
          v-model.number="drafts[item.key]"
          class="source-mapping-input"
          type="number"
          min="1"
          :max="item.totalEpisodes"
          inputmode="numeric"
          placeholder="如 177"
          @keydown.enter.prevent="apply(item)"
        >
        <span class="source-mapping-unit">集</span>
        <button
          type="button"
          class="source-mapping-apply"
          :disabled="!isValid(item)"
          @click="apply(item)"
        >
          映射并采用
        </button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'SourceMappingList',
  props: {
    sources: {
      type: Array,
      default: () => []
    }
  },
  emits: ['apply'],
  data() {
    return {
      drafts: {}
    };
  },
  methods: {
    startValue(item) {
      const value = Number(this.drafts[item.key]);
      return Number.isInteger(value) ? value : 0;
    },
    isValid(item) {
      const value = this.startValue(item);
      return value >= 1 && value <= Number(item.totalEpisodes || 0);
    },
    apply(item) {
      if (!this.isValid(item)) return;
      this.$emit('apply', {
        key: item.key,
        index: item.index,
        start: this.startValue(item)
      });
    }
  }
};
</script>

<style scoped>
.source-mapping-panel {
  width: 100%;
  margin: 0 0 16px;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-surface) 42%, transparent);
  text-align: left;
}

.source-mapping-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}

.source-mapping-head strong {
  color: var(--text-primary);
  font-size: 13.5px;
  font-weight: 750;
}

.source-mapping-head span {
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.5;
}

.source-mapping-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-top: 1px solid var(--border-subtle);
}

.source-mapping-row:first-of-type {
  border-top: 0;
}

.source-mapping-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.source-mapping-source {
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 700;
}

.source-mapping-title,
.source-mapping-meta {
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-mapping-controls {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.source-mapping-hint,
.source-mapping-unit {
  color: var(--text-tertiary);
  font-size: 11px;
}

.source-mapping-input {
  width: 76px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 12px;
  text-align: center;
}

.source-mapping-apply {
  height: 30px;
  padding: 0 11px;
  border: 0;
  border-radius: 8px;
  background: var(--primary-color);
  color: #fff;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.source-mapping-apply:hover:not(:disabled) {
  opacity: 0.86;
}

.source-mapping-apply:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

@media (max-width: 720px) {
  .source-mapping-row {
    align-items: flex-start;
    flex-direction: column;
  }

  .source-mapping-controls {
    width: 100%;
  }
}
</style>
