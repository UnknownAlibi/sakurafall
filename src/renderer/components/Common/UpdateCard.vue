<template>
  <div class="update-card" role="dialog" aria-label="应用更新">
    <header class="update-card-head">
      <span class="update-card-badge" :class="`is-${phase}`" aria-hidden="true">
        <svg v-if="phase === 'available' || phase === 'force'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
        </svg>
        <svg v-else-if="phase === 'ready' || phase === 'downloading' || phase === 'installing'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-3.4-7" /><path d="M21 3v6h-6" />
        </svg>
        <svg v-else-if="phase === 'downloadError' || phase === 'checkError'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" /><path d="M12 17h.01" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
      <div class="update-card-heading">
        <strong>{{ cardTitle }}</strong>
        <p>{{ cardSubtitle }}</p>
      </div>
      <button type="button" class="update-card-close" title="关闭" aria-label="关闭" @click="$emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </header>

    <div class="update-card-body">
      <p v-if="releaseNotes && (phase === 'available' || phase === 'force')" class="update-notes">{{ releaseNotes }}</p>

      <div v-if="phase === 'downloading'" class="update-progress">
        <div class="update-progress-meta">
          <span>正在下载…</span>
          <span>{{ progressLabel }}</span>
        </div>
        <div class="update-progress-bar">
          <div class="update-progress-fill" :style="{ width: `${downloadPercent}%` }"></div>
        </div>
      </div>

      <p v-if="phase === 'downloading'" class="update-hint">下载在主进程进行，可以继续使用，切换页面不会中断。</p>
      <p v-else-if="phase === 'ready'" class="update-hint">安装包已下载完成。重启后会覆盖安装新版，本地数据与设置都会保留。</p>
      <p v-else-if="phase === 'installing'" class="update-hint">正在启动安装程序并重启应用，请稍候…</p>
      <p v-else-if="phase === 'downloadError' || phase === 'checkError'" class="update-error-text">{{ errorText }}</p>
    </div>

    <div class="update-card-actions">
      <button v-if="phase === 'installing'" type="button" class="update-btn update-btn-primary" disabled>正在安装…</button>
      <button v-else-if="phase === 'downloading'" type="button" class="update-btn update-btn-secondary" disabled>下载中</button>

      <template v-else-if="phase === 'ready'">
        <button type="button" class="update-btn update-btn-primary" @click="onInstall">立即重启安装</button>
        <button type="button" class="update-btn update-btn-ghost" @click="$emit('close')">稍后</button>
      </template>

      <template v-else-if="phase === 'available' || phase === 'force'">
        <button v-if="canDownload" type="button" class="update-btn update-btn-primary" @click="onUpdate">立即更新</button>
        <span v-else class="update-hint">更新源未提供安全的下载地址</span>
        <button type="button" class="update-btn update-btn-ghost" @click="onIgnore">忽略此版本</button>
      </template>

      <button v-else-if="phase === 'checking'" type="button" class="update-btn update-btn-secondary" disabled>正在检查…</button>
      <button v-else-if="phase === 'downloadError'" type="button" class="update-btn update-btn-primary" @click="onUpdate">重试更新</button>
      <button v-else type="button" class="update-btn update-btn-primary" @click="onCheck">
        {{ phase === 'checkError' ? '重试检查' : '检查更新' }}
      </button>
    </div>

    <footer class="update-card-foot">
      <span>当前版本 v{{ currentVersion || '—' }}</span>
      <button type="button" class="update-link" @click="toggleSource">
        {{ sourceOpen ? '收起更新源' : '更新源' }}
      </button>
    </footer>

    <!-- 更新源配置内嵌在卡片里：更新功能自成一体，不再跳设置页 -->
    <div v-if="sourceOpen" class="update-source">
      <input
        v-model="sourceInput"
        type="url"
        class="update-source-input"
        spellcheck="false"
        placeholder="https://example.com/latest.json"
        aria-label="更新源地址"
        @keyup.enter="saveSource"
      />
      <button type="button" class="update-btn update-btn-secondary" :disabled="sourceSaving" @click="saveSource">
        {{ sourceSaving ? '保存中' : '保存' }}
      </button>
    </div>
    <p v-if="sourceOpen" class="update-source-hint">
      填写 latest.json 的 HTTPS 地址（本机 http://127.0.0.1 也可）
    </p>
  </div>
</template>

<script>
import { mapGetters, mapState } from 'vuex';

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 更新下拉卡片。
 * 单独成组件并被 UpdateCenter 异步加载：卡片含大量状态分支与样式，
 * 常驻在标题栏的主 chunk 里会顶破体积预算，且首屏并不需要它。
 */
export default {
  name: 'UpdateCard',
  emits: ['close'],
  data() {
    return {
      // 更新源配置（内嵌在卡片里，更新功能不依赖设置页）
      sourceOpen: false,
      sourceInput: '',
      sourceSaving: false
    };
  },
  computed: {
    ...mapState('update', ['checking', 'result']),
    ...mapGetters('update', [
      'canDownload',
      'checkError',
      'currentVersion',
      'downloadError',
      'downloadPercent',
      'downloadReceived',
      'downloadStatus',
      'downloadTotal',
      'forceUpdate',
      'latestVersion',
      'releaseDate',
      'releaseNotes',
      'updateVisible'
    ]),
    /** 卡片当前该展示哪一面 */
    phase() {
      if (this.downloadStatus === 'installing') return 'installing';
      if (this.downloadStatus === 'downloading') return 'downloading';
      if (this.downloadStatus === 'ready') return 'ready';
      if (this.downloadStatus === 'error') return 'downloadError';
      if (this.checking) return 'checking';
      if (this.checkError) return 'checkError';
      if (this.updateVisible) return this.forceUpdate ? 'force' : 'available';
      if (this.result && !this.result.hasUpdate) return 'uptodate';
      return 'idle';
    },
    progressLabel() {
      if (!this.downloadTotal) {
        const received = formatBytes(this.downloadReceived);
        return received ? `已下载 ${received}` : '准备中…';
      }
      return `${this.downloadPercent}% · ${formatBytes(this.downloadReceived)} / ${formatBytes(this.downloadTotal)}`;
    },
    errorText() {
      if (this.phase === 'downloadError') return this.downloadError || '下载或安装失败，可重试';
      return this.checkError || '所有更新源均不可用';
    },
    cardTitle() {
      switch (this.phase) {
        case 'available': return '发现新版本';
        case 'force': return '需要更新';
        case 'downloading': return '正在下载更新';
        case 'ready': return '更新已就绪';
        case 'installing': return '正在安装更新';
        case 'checking': return '正在检查更新';
        case 'uptodate': return '已是最新版本';
        case 'downloadError': return '更新失败';
        case 'checkError': return '检查更新失败';
        default: return '应用更新';
      }
    },
    cardSubtitle() {
      if (this.phase === 'available' || this.phase === 'force') {
        const date = this.releaseDate ? ` · 发布于 ${this.releaseDate}` : '';
        return `v${this.latestVersion}${date}`;
      }
      if (this.phase === 'downloading' || this.phase === 'ready' || this.phase === 'installing') {
        return this.latestVersion ? `v${this.latestVersion}` : '';
      }
      if (this.phase === 'uptodate') return `当前 v${this.currentVersion || '—'}`;
      if (this.phase === 'checking') return '正在获取最新版本信息…';
      return `当前 v${this.currentVersion || '—'}`;
    }
  },
  methods: {
    onCheck() {
      this.$store.dispatch('update/check');
    },
    onUpdate() {
      this.$store.dispatch('update/download', {
        url: this.result?.downloadUrl,
        sha256: this.result?.sha256,
        latestVersion: this.latestVersion,
        releaseNotes: this.releaseNotes
      });
    },
    onInstall() {
      this.$store.dispatch('update/installNow');
    },
    onIgnore() {
      this.$store.dispatch('update/ignoreVersion');
    },
    async toggleSource() {
      this.sourceOpen = !this.sourceOpen;
      // 首次展开时才拉取当前更新源，避免启动多打一次 IPC
      if (this.sourceOpen && !this.sourceInput) await this.loadSource();
    },
    async loadSource() {
      try {
        this.sourceInput = (await window.electronAPI?.updateGetUrl?.()) || '';
      } catch (_error) {
        this.sourceInput = '';
      }
    },
    async saveSource() {
      const url = (this.sourceInput || '').trim();
      if (!url) {
        this.$store.dispatch('update/notify', { type: 'warning', title: '请输入更新源地址' });
        return;
      }
      this.sourceSaving = true;
      try {
        const saved = await window.electronAPI?.updateSetUrl?.(url);
        if (saved) {
          this.sourceInput = (await window.electronAPI?.updateGetUrl?.()) || url;
          this.$store.dispatch('update/notify', { type: 'success', title: '更新源已保存' });
        } else {
          this.$store.dispatch('update/notify', {
            type: 'error',
            title: '更新源无效',
            message: '请使用 HTTPS 地址（本机 127.0.0.1 允许 http）'
          });
        }
      } catch (error) {
        this.$store.dispatch('update/notify', { type: 'error', title: '保存失败', message: error.message });
      } finally {
        this.sourceSaving = false;
      }
    }
  }
};
</script>

<style scoped>
/* ===== 下拉卡片 ===== */
.update-card {
  position: absolute;
  top: calc(100% + 8px);
  right: 6px;
  z-index: 4000;
  width: 336px;
  padding: 14px 16px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
  -webkit-app-region: no-drag;
  font-size: 13px;
  line-height: 1.45;
}

.update-card-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.update-card-badge {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--primary-color) 14%, var(--bg-input));
  color: var(--primary-color);
}

.update-card-badge svg {
  width: 16px;
  height: 16px;
}

.update-card-badge.is-uptodate {
  background: color-mix(in srgb, var(--success-color) 15%, var(--bg-input));
  color: var(--success-color);
}

.update-card-badge.is-downloadError,
.update-card-badge.is-checkError {
  background: color-mix(in srgb, var(--error-color) 14%, var(--bg-input));
  color: var(--error-color);
}

.update-card-heading {
  min-width: 0;
  flex: 1;
}

.update-card-heading strong {
  display: block;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.35;
}

.update-card-heading p {
  margin: 2px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.update-card-close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  display: grid;
  place-items: center;
}

.update-card-close svg {
  width: 14px;
  height: 14px;
}

.update-card-close:hover {
  background: var(--bg-input);
  color: var(--text-primary);
}

.update-card-body {
  margin-top: 10px;
}

.update-notes {
  max-height: 132px;
  margin: 0 0 10px;
  padding: 8px 10px;
  overflow-y: auto;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-width: thin;
}

.update-hint {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.update-error-text {
  margin: 8px 0 0;
  color: var(--error-color);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.update-progress-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}

.update-progress-bar {
  height: 7px;
  overflow: hidden;
  border-radius: 4px;
  background: color-mix(in srgb, var(--primary-color) 13%, var(--bg-base));
}

.update-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--primary-color);
  transition: width 220ms var(--ease-smooth);
}

.update-card-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.update-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 7px 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 160ms var(--ease-smooth), border-color 160ms var(--ease-smooth), color 160ms var(--ease-smooth);
}

.update-btn-primary {
  background: var(--primary-color);
  color: var(--text-inverse);
}

.update-btn-primary:hover:not(:disabled) {
  background: var(--primary-hover, var(--primary-color));
}

.update-btn-secondary {
  border-color: var(--border-color-strong);
  background: var(--bg-input);
  color: var(--text-primary);
}

.update-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 600;
}

.update-btn-ghost:hover {
  color: var(--text-primary);
  background: var(--bg-input);
}

.update-btn:disabled {
  opacity: 0.65;
  cursor: default;
}

.update-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--divider-color);
  color: var(--text-tertiary);
  font-size: 12px;
}

.update-link {
  border: none;
  background: transparent;
  color: var(--primary-color);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
}

.update-link:hover {
  text-decoration: underline;
}

/* ===== 内嵌的更新源配置 ===== */
.update-source {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.update-source-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 6px 10px;
  border: 1px solid var(--border-color-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  transition: border-color 160ms var(--ease-smooth);
}

.update-source-input:hover {
  border-color: color-mix(in srgb, var(--primary-color) 48%, var(--border-color-strong));
}

.update-source-input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--primary-color) 65%, transparent);
  outline-offset: 1px;
}

.update-source-input::placeholder {
  color: var(--text-tertiary);
}

.update-source-hint {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.4;
}

@media (max-width: 768px) {
  .update-card {
    width: min(320px, calc(100vw - 24px));
  }
}

@media (prefers-reduced-motion: reduce) {
  .update-progress-fill {
    transition: none;
  }
}
</style>
