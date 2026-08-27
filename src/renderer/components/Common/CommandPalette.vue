<template>
  <Transition name="cp-fade">
    <div v-if="visible" class="cp-overlay" @click.self="close">
      <div class="cp-panel" role="dialog" aria-modal="true" aria-label="快速导航">
        <div class="cp-input-row">
          <svg class="cp-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            ref="cpInput"
            v-model="query"
            class="cp-input"
            type="text"
            placeholder="跳转到…（番剧库 / 发现 / 追番 / 下载 / BT资源 / 数据源 / 设置）"
            @keydown="onInputKeydown"
          />
          <kbd class="cp-kbd">ESC</kbd>
        </div>
        <ul v-if="filteredCommands.length" class="cp-list" role="listbox">
          <li
            v-for="(cmd, index) in filteredCommands"
            :key="cmd.name"
            :class="['cp-item', { active: index === activeIndex }]"
            role="option"
            :aria-selected="index === activeIndex"
            @mouseenter="activeIndex = index"
            @click="run(cmd)"
          >
            <span class="cp-item-kicker">{{ cmd.kicker }}</span>
            <span class="cp-item-label">{{ cmd.label }}</span>
            <kbd class="cp-kbd cp-item-hotkey">Alt+{{ index + 1 }}</kbd>
          </li>
        </ul>
        <div v-else class="cp-empty">没有匹配的页面</div>
      </div>
    </div>
  </Transition>
</template>

<script>
// 与 TabNavigation 一致的导航顺序（Alt+1..7 同序）
const COMMANDS = [
  { name: 'anime-zone', label: '番剧库', kicker: 'LIBRARY' },
  { name: 'discovery', label: '发现', kicker: 'DISCOVER' },
  { name: 'my-favorites', label: '我的追番', kicker: 'FOLLOW' },
  { name: 'downloads', label: '下载管理', kicker: 'OFFLINE' },
  { name: 'bt-hub', label: 'BT 资源站', kicker: 'BT HUB' },
  { name: 'source-manager', label: '数据源管理', kicker: 'SOURCES' },
  { name: 'settings', label: '应用设置', kicker: 'SETTINGS' }
];

export default {
  name: 'CommandPalette',
  data() {
    return {
      visible: false,
      query: '',
      activeIndex: 0
    };
  },
  computed: {
    filteredCommands() {
      const q = this.query.trim().toLowerCase();
      if (!q) return COMMANDS;
      return COMMANDS.filter(c =>
        c.label.toLowerCase().includes(q) ||
        c.kicker.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
      );
    }
  },
  watch: {
    query() {
      this.activeIndex = 0;
    },
    visible(visible) {
      if (visible) {
        this.query = '';
        this.activeIndex = 0;
        this.$nextTick(() => this.$refs.cpInput?.focus());
      }
    }
  },
  mounted() {
    this._onKey = (event) => {
      // Ctrl+K / Cmd+K 唤起或关闭
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.visible = !this.visible;
        return;
      }
      // 面板打开时 ESC 优先关闭面板（捕获阶段拦截，避免触发其它 ESC 行为）
      if (event.key === 'Escape' && this.visible) {
        event.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this._onKey, true);
  },
  beforeUnmount() {
    if (this._onKey) {
      document.removeEventListener('keydown', this._onKey, true);
      this._onKey = null;
    }
  },
  methods: {
    close() {
      this.visible = false;
    },
    run(cmd) {
      this.close();
      if (this.$route.name !== cmd.name) {
        this.$router.push({ name: cmd.name }).catch(() => {});
      }
    },
    onInputKeydown(event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.activeIndex = (this.activeIndex + 1) % this.filteredCommands.length;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.activeIndex = (this.activeIndex - 1 + this.filteredCommands.length) % this.filteredCommands.length;
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const cmd = this.filteredCommands[this.activeIndex];
        if (cmd) this.run(cmd);
      }
    }
  }
};
</script>

<style scoped>
.cp-overlay {
  position: fixed;
  inset: 0;
  z-index: 11000;
  background: var(--bg-overlay, rgba(0, 0, 0, 0.4));
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 14vh;
}

.cp-panel {
  width: min(520px, calc(100vw - 48px));
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.cp-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-color);
}

.cp-search-icon {
  width: 18px;
  height: 18px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.cp-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 15px;
}

.cp-input::placeholder {
  color: var(--text-tertiary);
}

.cp-kbd {
  font-size: 11px;
  color: var(--text-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 2px 6px;
  background: var(--bg-surface);
  flex-shrink: 0;
}

.cp-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.cp-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background-color 0.12s var(--ease-smooth), color 0.12s var(--ease-smooth);
}

.cp-item.active {
  background: var(--primary-light);
  color: var(--primary-color);
}

.cp-item-kicker {
  font-size: 10px;
  letter-spacing: 1px;
  opacity: 0.7;
  width: 64px;
  flex-shrink: 0;
}

.cp-item-label {
  flex: 1;
  font-size: 14px;
}

.cp-item-hotkey {
  opacity: 0;
}

.cp-item.active .cp-item-hotkey {
  opacity: 0.8;
}

.cp-empty {
  padding: 26px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

.cp-fade-enter-active,
.cp-fade-leave-active {
  transition: opacity 0.16s var(--ease-smooth);
}

.cp-fade-enter-active .cp-panel,
.cp-fade-leave-active .cp-panel {
  transition: transform 0.16s var(--ease-smooth);
}

.cp-fade-enter-from,
.cp-fade-leave-to {
  opacity: 0;
}

.cp-fade-enter-from .cp-panel {
  transform: translateY(-8px) scale(0.98);
}
</style>
