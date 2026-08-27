<template>
  <section class="catalog-controls" aria-label="番剧目录筛选">
    <div class="main-list-toolbar">
      <div class="list-toolbar-title">
        <div>
          <small>作品目录</small>
          <h3>番剧索引</h3>
        </div>
        <span v-if="!loading">{{ totalItems }} 个结果</span>
      </div>

      <div v-if="selectedType !== 'season'" class="toolbar-row">
        <span class="toolbar-label">排序</span>
        <div class="toolbar-chip-list">
          <button
            v-for="option in sortOptions"
            :key="option.id"
            :class="['toolbar-chip', { active: selectedSort === option.id }]"
            type="button"
            @click="$emit('select-sort', option.id)"
          >{{ option.name }}</button>
        </div>
      </div>

      <div class="toolbar-row bangumi-type-row">
        <span class="toolbar-label type-row-label">类型</span>
        <div class="toolbar-chip-list bangumi-type-list">
          <button
            v-for="option in typeOptions"
            :key="option.id"
            :class="['toolbar-chip', 'bangumi-type-chip', { active: selectedType === option.id }]"
            type="button"
            @click="$emit('select-type', option.id)"
          >{{ option.name }}</button>
        </div>
      </div>

      <div v-if="selectedType !== 'season'" class="toolbar-row browse-filter-row">
        <span class="toolbar-label browse-filter-label">年份</span>
        <select class="browse-filter-select" :value="selectedYear" @change="$emit('year-change', $event)">
          <option value="">全部年份</option>
          <option v-for="year in yearOptions" :key="year" :value="year">{{ year }} 年</option>
        </select>
      </div>
    </div>

    <div v-if="selectedType === 'season'" class="season-selector-row">
      <span class="season-label">季度</span>
      <select
        class="season-select"
        :value="seasonYear ? `${seasonYear}-${seasonQuarter}` : ''"
        @change="$emit('season-change', $event)"
      >
        <option value="">本季新番（日历）</option>
        <option
          v-for="option in seasonOptions"
          :key="`${option.year}-${option.quarter}`"
          :value="`${option.year}-${option.quarter}`"
        >{{ option.label }}</option>
      </select>
      <span class="season-current">{{ currentSeasonLabel }}</span>
    </div>

    <div v-if="hasStatus && !loading" class="search-status">
      <span v-if="searchKeyword">搜索: "{{ searchKeyword }}"</span>
      <span v-if="selectedType !== 'season' && selectedSort !== 'date'" class="genre-status-tag">排序: {{ activeSortName }}</span>
      <span v-if="selectedType !== 'all'" class="genre-status-tag">类型: {{ activeTypeName }}</span>
      <span v-if="selectedYear" class="genre-status-tag">年份: {{ selectedYear }}</span>
      <button v-if="searchKeyword" class="clear-search-btn" @click="$emit('clear-search')">清除搜索</button>
      <button v-if="selectedType !== 'all'" class="clear-search-btn" @click="$emit('select-type', 'all')">清除类型</button>
      <button v-if="selectedYear" class="clear-search-btn" @click="$emit('clear-year')">清除年份</button>
    </div>
  </section>
</template>

<script>
export default {
  name: 'AnimeCatalogToolbar',
  props: {
    loading: Boolean,
    totalItems: { type: Number, default: 0 },
    selectedType: { type: String, default: 'all' },
    selectedSort: { type: String, default: 'date' },
    selectedYear: { type: [String, Number], default: '' },
    searchKeyword: { type: String, default: '' },
    typeOptions: { type: Array, default: () => [] },
    sortOptions: { type: Array, default: () => [] },
    yearOptions: { type: Array, default: () => [] },
    seasonOptions: { type: Array, default: () => [] },
    seasonYear: { type: [String, Number], default: null },
    seasonQuarter: { type: [String, Number], default: null },
    currentSeasonLabel: { type: String, default: '' },
    activeTypeName: { type: String, default: '' },
    activeSortName: { type: String, default: '' }
  },
  emits: ['select-type', 'select-sort', 'year-change', 'season-change', 'clear-search', 'clear-year'],
  computed: {
    hasStatus() {
      return !!(this.searchKeyword || this.selectedType !== 'all' || this.selectedYear ||
        (this.selectedType !== 'season' && this.selectedSort !== 'date'));
    }
  }
};
</script>

<style scoped>
.main-list-toolbar,
.season-selector-row,
.search-status {
  margin-top: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
}

.main-list-toolbar {
  margin-top: 16px;
  padding: 14px 16px;
  position: relative;
  overflow: hidden;
}

.main-list-toolbar::after {
  content: '';
  position: absolute;
  inset: 0 0 auto auto;
  width: 42px;
  height: 3px;
  border: 0;
  background: var(--accent-cyan);
  pointer-events: none;
}

.list-toolbar-title,
.toolbar-row,
.season-selector-row,
.search-status {
  display: flex;
  align-items: center;
}

.list-toolbar-title {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.list-toolbar-title > div { display: flex; flex-direction: column; gap: 3px; }
.list-toolbar-title h3 { margin: 0; font-size: 17px; color: var(--text-primary); }
.list-toolbar-title small { color: var(--brand-cyan-deep); font-size: 11px; font-weight: 600; }
.list-toolbar-title > span { font-size: 12px; color: var(--text-tertiary); }

.toolbar-row { min-height: 32px; gap: 10px; }
.toolbar-row + .toolbar-row { margin-top: 8px; }
.toolbar-label { min-width: 34px; flex-shrink: 0; font-size: 12px; color: var(--text-tertiary); font-weight: 600; }
.toolbar-chip-list { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.toolbar-chip {
  padding: 5px 12px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.15s var(--ease-smooth), background-color 0.15s var(--ease-smooth), border-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth);
}

.toolbar-chip:hover { transform: translateY(-1px); color: var(--primary-color); border-color: rgba(240, 100, 141, 0.28); background: var(--primary-lighter); }
.toolbar-chip:active { transform: scale(0.96); transition-duration: 0.1s; }
.toolbar-chip.active { border-color: var(--brand-ink); color: #fff; font-weight: 700; background: var(--brand-ink); }

.browse-filter-row { padding: 0; border: 0; background: transparent; }
.season-selector-row { gap: 10px; padding: 10px 12px; }
.season-label { min-width: 28px; font-size: 12px; color: var(--tag-text); }
.season-select,
.browse-filter-select {
  max-width: 220px;
  padding: 5px 28px 5px 9px;
  border: 1px solid var(--border-color-strong);
  border-radius: 6px;
  outline: 0;
  background-color: var(--bg-input);
  color: var(--text-primary);
  color-scheme: light;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s var(--ease-smooth), background-color 0.15s var(--ease-smooth), box-shadow 0.15s var(--ease-smooth);
}
.season-select option,
.browse-filter-select option {
  background-color: var(--bg-elevated);
  color: var(--text-primary);
}
:global([data-theme="dark"]) .season-select,
:global([data-theme="dark"]) .browse-filter-select {
  color-scheme: dark;
}
.season-select:hover,
.browse-filter-select:hover { border-color: var(--primary-color); }
.season-select:focus-visible,
.browse-filter-select:focus-visible {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}
.season-current { color: var(--primary-color); font-size: 12px; font-weight: 500; }

.search-status { gap: 10px; padding: 10px 12px; color: var(--text-secondary); font-size: 13px; flex-wrap: wrap; }
.genre-status-tag { padding: 2px 10px; border-radius: 10px; background: var(--primary-light); color: var(--primary-color); font-weight: 500; }
.clear-search-btn { padding: 3px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-surface); color: var(--text-secondary); font-size: 12px; cursor: pointer; transition: transform 0.15s var(--ease-smooth), border-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth); }
.clear-search-btn:hover { transform: translateY(-1px); border-color: var(--primary-color); color: var(--primary-color); }
.clear-search-btn:active { transform: scale(0.96); transition-duration: 0.1s; }
</style>
