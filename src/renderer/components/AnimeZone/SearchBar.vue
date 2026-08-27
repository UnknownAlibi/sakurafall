<template>
  <div class="search-box">
    <input
      :value="value"
      @input="$emit('input', $event.target.value)"
      @keyup.enter="$emit('search')"
      type="text"
      :placeholder="placeholder"
      class="search-input"
    />
    <button @click="$emit('search')" class="search-btn" :disabled="!value || !value.trim()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </button>
    <button v-if="hasKeyword" @click="$emit('clear')" class="clear-btn" title="清除搜索">✕</button>
  </div>
</template>

<script>
export default {
  name: 'SearchBar',
  props: {
    value: {
      type: String,
      default: ''
    },
    placeholder: {
      type: String,
      default: '搜索...'
    },
    hasKeyword: {
      type: String,
      default: ''
    }
  },
  emits: ['input', 'search', 'clear']
};
</script>

<style scoped>
.search-box {
  display: flex;
  align-items: center;
  background: var(--bg-card-glass);
  border-radius: 8px;
  padding: 0;
  flex-shrink: 0;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  border: 1px solid rgba(var(--primary-rgb), 0.16);
}

.search-box:focus-within {
  border-color: var(--primary-color);
  background: var(--bg-input);
}

.search-input {
  border: none;
  background: transparent;
  padding: 7px 12px;
  font-size: 13px;
  outline: none;
  width: 200px;
  color: var(--text-primary);
}

.search-input::placeholder {
  color: var(--text-tertiary);
}

.search-btn {
  padding: 6px 12px;
  background: linear-gradient(135deg, var(--primary-color), #ff9ec4);
  color: var(--text-inverse);
  border: none;
  border-radius: 0 6px 6px 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: background 0.15s;
  height: 100%;
}

.search-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--primary-hover), var(--primary-color));
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.clear-btn {
  padding: 0 8px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--tag-text);
  font-size: 14px;
  line-height: 1;
}

.clear-btn:hover {
  color: var(--primary-color);
}

@media (max-width: 768px) {
  .search-box {
    width: 100%;
  }

  .search-input {
    flex: 1;
    width: auto;
  }
}
</style>
