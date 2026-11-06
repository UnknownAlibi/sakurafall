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
          v-if="item.suggestedStart > 0 && drafts[item.key] !== item.suggestedStart"
          type="button"
          class="source-mapping-suggest"
          title="点击填入智能建议起始集"
          @click="useSuggestion(item)"
        >
          建议: {{ item.suggestedStart }}
        </button>
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
  watch: {
    sources: {
      immediate: true,
      handler(list) {
        for (const item of list || []) {
          if (item?.suggestedStart > 0 && this.drafts[item.key] === undefined) {
            this.drafts[item.key] = item.suggestedStart;
          }
        }
      }
    }
  },
  methods: {
    useSuggestion(item) {
      if (!item?.suggestedStart) return;
      this.drafts[item.key] = item.suggestedStart;
    },
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
  font-size: 12px;
  line-height: 1.45;
}

.source-mapping-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px dashed var(--border-subtle);
}

.source-mapping-row:first-of-type {
  border-top: none;
}

.source-mapping-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.source-mapping-source {
  color: var(--accent-cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.source-mapping-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-mapping-meta {
  color: var(--text-tertiary);
  font-size: 11px;
}

.source-mapping-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.source-mapping-hint,
.source-mapping-unit {
  color: var(--text-secondary);
  font-size: 12px;
}

.source-mapping-input {
  width: 72px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  outline: none;
  transition: border-color 0.15s var(--ease-smooth);
}

.source-mapping-input:focus {
  border-color: var(--primary);
}

.source-mapping-suggest {
  padding: 3px 8px;
  border: 1px dashed rgba(var(--primary-rgb), 0.5);
  border-radius: 999px;
  background: rgba(var(--primary-rgb), 0.1);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-mapping-suggest:hover {
  background: rgba(var(--primary-rgb), 0.2);
  border-style: solid;
}

.source-mapping-apply {
  height: 30px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
  transition: opacity 0.15s var(--ease-smooth), transform 0.15s var(--ease-smooth);
}

.source-mapping-apply:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.source-mapping-apply:not(:disabled):hover {
  opacity: 0.92;
  transform: translateY(-1px);
}

@media (max-width: 680px) {
  .source-mapping-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
