<template>
  <div class="update-settings">
    <div class="update-toolbar">
      <div class="update-heading">
        <span class="update-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 1-15.1 6.6L3 16" />
            <path d="M3 21v-5h5" />
            <path d="M3 12A9 9 0 0 1 18.1 5.4L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </span>
        <div>
          <h3>应用更新</h3>
          <p>检查新版本，并在应用内完成下载和安装</p>
        </div>
      </div>
      <button type="button" class="update-button update-button-primary" :disabled="checkingUpdate" @click="checkForUpdates">
        <svg :class="{ spinning: checkingUpdate }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
          <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
        </svg>
        <span>{{ checkingUpdate ? '正在检查' : '检查更新' }}</span>
      </button>
    </div>

    <Transition name="update-reveal">
      <section
        v-if="updateResult"
        class="update-result"
        :class="{ 'has-update': updateResult.hasUpdate, 'no-update': !updateResult.hasUpdate && !updateResult.error, 'update-error': updateResult.error }"
        role="status"
        aria-live="polite"
      >
        <span class="update-result-icon" aria-hidden="true">
          <svg v-if="updateResult.error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4" /><path d="M12 17h.01" />
          </svg>
          <svg v-else-if="updateResult.hasUpdate" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>

        <div class="update-result-body">
          <template v-if="updateResult.error">
            <strong>检查失败</strong>
            <p>{{ updateResult.error }}</p>
          </template>
          <template v-else-if="updateResult.hasUpdate">
            <strong>发现新版本 v{{ updateResult.latestVersion }}</strong>
            <p v-if="updateResult.releaseDate" class="release-date">发布于 {{ updateResult.releaseDate }}</p>
            <p v-if="updateResult.releaseNotes" class="release-notes">{{ updateResult.releaseNotes }}</p>
          </template>
          <template v-else>
            <strong>已经是最新版本</strong>
            <p>当前版本 v{{ updateResult.currentVersion }}</p>
          </template>
        </div>

        <div v-if="updateResult.hasUpdate" class="update-result-action">
          <button
            v-if="updateResult.downloadUrl && !updateDownloadPath && !updateDownloading"
            type="button"
            class="update-button update-button-primary"
            @click="startUpdateDownload(updateResult.downloadUrl)"
          >
            下载更新
          </button>
          <button
            v-else-if="updateDownloadPath"
            type="button"
            class="update-button update-button-primary"
            @click="installUpdate(updateDownloadPath)"
          >
            安装并重启
          </button>
          <div v-else-if="updateDownloading" class="update-progress" aria-label="更新下载进度">
            <div class="update-progress-meta">
              <span>正在下载</span>
              <span>{{ updateDownloadPercent }}%</span>
            </div>
            <div class="update-progress-bar">
              <div class="update-progress-fill" :style="{ width: updateDownloadPercent + '%' }"></div>
            </div>
          </div>
          <span v-else class="update-unavailable">更新源未提供安全的下载地址</span>
        </div>
      </section>
    </Transition>

    <div class="update-source-row">
      <div class="update-source-copy">
        <label for="update-source-url">更新源</label>
        <p>填写 latest.json 的 HTTPS 地址</p>
      </div>
      <div class="update-source-control">
        <input id="update-source-url" v-model="updateUrlInput" type="url" class="update-source-input" spellcheck="false" placeholder="https://example.com/latest.json" />
        <button type="button" class="update-button update-button-secondary" @click="saveUpdateUrl">保存</button>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'UpdateSettings',
  data() {
    return {
      checkingUpdate: false,
      updateResult: null,
      updateUrlInput: '',
      // 应用内更新：下载进度与安装包路径
      updateDownloading: false,
      updateDownloadPercent: 0,
      updateDownloadPath: '',
      removeUpdateListener: null,
      removeUpdateProgressListener: null
    };
  },
  mounted() {
    this.loadUpdateUrl();
    // 监听启动时的静默更新检查结果（保存注销函数，避免重复挂载累积监听器）
    if (window.electronAPI?.onUpdateAvailable) {
      this.removeUpdateListener = window.electronAPI.onUpdateAvailable((info) => {
        this.updateResult = info;
        if (this.$notify && info.hasUpdate) {
          this.$notify.success('发现新版本', `v${info.latestVersion} 已发布，可在设置页下载`);
        }
      });
    }
  },
  beforeUnmount() {
    if (this.removeUpdateListener) {
      this.removeUpdateListener();
      this.removeUpdateListener = null;
    }
    if (this.removeUpdateProgressListener) {
      this.removeUpdateProgressListener();
      this.removeUpdateProgressListener = null;
    }
  },
  methods: {
    async checkForUpdates() {
      this.checkingUpdate = true;
      this.updateResult = null;
      try {
        if (window.electronAPI && window.electronAPI.updateCheck) {
          const result = await window.electronAPI.updateCheck();
          this.updateResult = result;
          if (result.hasUpdate) {
            if (this.$notify) {
              this.$notify.success('发现新版本', `v${result.latestVersion} 已发布`);
            }
          } else if (!result.error) {
            if (this.$notify) {
              this.$notify.success('已是最新版本', `当前 v${result.currentVersion}`);
            }
          }
        } else {
          if (this.$notify) {
            this.$notify.warning('提示', '当前版本不支持更新检查');
          }
        }
      } catch (error) {
        console.error('检查更新失败:', error);
        this.updateResult = { error: error.message, hasUpdate: false };
        if (this.$notify) {
          this.$notify.error('错误', '检查更新失败: ' + error.message);
        }
      } finally {
        this.checkingUpdate = false;
      }
    },

    // 应用内更新：下载安装包（带进度），完成后可一键安装重启
    async startUpdateDownload(url) {
      if (this.updateDownloading) return;
      this.updateDownloading = true;
      this.updateDownloadPercent = 0;
      this.updateDownloadPath = '';
      try {
        if (!window.electronAPI?.updateDownload) throw new Error('当前版本不支持应用内更新');
        this.removeUpdateProgressListener?.();
        this.removeUpdateProgressListener = window.electronAPI.onUpdateDownloadProgress?.((p) => {
          if (p && typeof p.percent === 'number') this.updateDownloadPercent = p.percent;
        }) || null;
        const result = await window.electronAPI.updateDownload(url);
        if (result?.success && result.path) {
          this.updateDownloadPath = result.path;
          this.updateDownloadPercent = 100;
          if (this.$notify) this.$notify.success('下载完成', '点击「安装并重启」完成更新');
        } else {
          throw new Error(result?.error || '下载失败');
        }
      } catch (error) {
        console.error('下载更新失败:', error);
        if (this.$notify) this.$notify.error('错误', '下载更新失败: ' + error.message);
      } finally {
        this.updateDownloading = false;
      }
    },

    // 启动安装程序并退出应用（覆盖安装，用户数据保留在 userData）
    async installUpdate(filePath) {
      try {
        if (!window.electronAPI?.updateInstall) throw new Error('当前版本不支持应用内更新');
        const result = await window.electronAPI.updateInstall(filePath);
        if (!result?.success) throw new Error(result?.error || '启动安装程序失败');
      } catch (error) {
        console.error('启动安装失败:', error);
        if (this.$notify) this.$notify.error('错误', '启动安装失败: ' + error.message);
      }
    },

    async saveUpdateUrl() {
      const url = (this.updateUrlInput || '').trim();
      if (!url) {
        if (this.$notify) this.$notify.warning('提示', '请输入更新源地址');
        return;
      }
      try {
        if (window.electronAPI && window.electronAPI.updateSetUrl) {
          const saved = await window.electronAPI.updateSetUrl(url);
          if (saved) {
            if (this.$notify) this.$notify.success('成功', '更新源地址已保存');
          } else if (this.$notify) {
            this.$notify.error('错误', '更新源地址无效，请使用 HTTPS 地址');
          }
        }
      } catch (error) {
        console.error('保存更新源失败:', error);
        if (this.$notify) this.$notify.error('错误', '保存失败: ' + error.message);
      }
    },

    async loadUpdateUrl() {
      try {
        if (window.electronAPI && window.electronAPI.updateGetUrl) {
          this.updateUrlInput = await window.electronAPI.updateGetUrl();
        }
      } catch (error) {
        // 加载失败使用空值，不影响页面
      }
    }
  }
};
</script>

<style scoped>
.update-settings {
  margin-top: 22px;
  border-top: 1px solid var(--divider-color);
  color: var(--text-primary);
}

.update-toolbar,
.update-source-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 0;
}

.update-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.update-heading-icon,
.update-result-icon {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--primary-color) 14%, var(--bg-input));
  color: var(--primary-color);
}

.update-heading-icon svg,
.update-result-icon svg,
.update-button svg {
  width: 18px;
  height: 18px;
}

.update-heading h3,
.update-source-copy label {
  display: block;
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0;
}

.update-heading p,
.update-source-copy p {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.45;
}

.update-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  padding: 8px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 160ms var(--ease-smooth), background-color 160ms var(--ease-smooth), border-color 160ms var(--ease-smooth), color 160ms var(--ease-smooth), box-shadow 160ms var(--ease-smooth);
}

.update-button-primary {
  background: var(--primary-color);
  color: var(--text-inverse);
  box-shadow: 0 5px 14px color-mix(in srgb, var(--primary-color) 22%, transparent);
}

.update-button-secondary {
  border-color: var(--border-color-strong);
  background: var(--bg-input);
  color: var(--text-primary);
}

.update-button:hover:not(:disabled) {
  transform: translateY(-1px);
}

.update-button-primary:hover:not(:disabled) {
  background: var(--primary-hover);
}

.update-button-secondary:hover:not(:disabled) {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.update-button:focus-visible,
.update-source-input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--primary-color) 65%, white);
  outline-offset: 2px;
}

.update-button:disabled {
  opacity: 0.65;
  cursor: wait;
  box-shadow: none;
}

.update-result {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 4px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
}

.update-result.has-update {
  border-color: color-mix(in srgb, var(--primary-color) 55%, var(--border-color));
  background: color-mix(in srgb, var(--primary-color) 8%, var(--bg-input));
}

.update-result.no-update {
  border-color: color-mix(in srgb, var(--success-color) 50%, var(--border-color));
  background: color-mix(in srgb, var(--success-color) 7%, var(--bg-input));
}

.update-result.no-update .update-result-icon {
  background: color-mix(in srgb, var(--success-color) 15%, var(--bg-input));
  color: var(--success-color);
}

.update-result.update-error {
  border-color: color-mix(in srgb, var(--error-color) 52%, var(--border-color));
  background: color-mix(in srgb, var(--error-color) 7%, var(--bg-input));
}

.update-result.update-error .update-result-icon {
  background: color-mix(in srgb, var(--error-color) 14%, var(--bg-input));
  color: var(--error-color);
}

.update-result-body {
  min-width: 0;
}

.update-result-body strong {
  display: block;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.4;
}

.update-result-body p {
  margin: 3px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.update-result-body .release-notes {
  max-height: 108px;
  margin-top: 8px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.update-result-action {
  min-width: 132px;
}

.update-progress {
  width: 190px;
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

.update-unavailable {
  display: block;
  max-width: 190px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.4;
  text-align: right;
}

.update-source-row {
  align-items: flex-end;
  border-top: 1px solid var(--divider-color);
}

.update-source-copy {
  min-width: 150px;
}

.update-source-control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: min(100%, 560px);
}

.update-source-input {
  width: 100%;
  min-width: 0;
  height: 38px;
  padding: 8px 11px;
  border: 1px solid var(--border-color-strong);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  letter-spacing: 0;
  transition: border-color 160ms var(--ease-smooth), box-shadow 160ms var(--ease-smooth);
}

.update-source-input:hover {
  border-color: color-mix(in srgb, var(--primary-color) 48%, var(--border-color-strong));
}

.update-source-input::placeholder {
  color: var(--text-tertiary);
}

.spinning {
  animation: update-spin 850ms linear infinite;
}

.update-reveal-enter-active,
.update-reveal-leave-active {
  transition: opacity 180ms var(--ease-smooth), transform 180ms var(--ease-smooth);
}

.update-reveal-enter-from,
.update-reveal-leave-to {
  opacity: 0;
  transform: translateY(-5px);
}

@keyframes update-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 720px) {
  .update-toolbar,
  .update-source-row {
    align-items: stretch;
    flex-direction: column;
    gap: 14px;
  }

  .update-toolbar > .update-button,
  .update-source-control {
    width: 100%;
  }

  .update-result {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }

  .update-result-action {
    grid-column: 1 / -1;
    min-width: 0;
  }

  .update-result-action .update-button,
  .update-progress {
    width: 100%;
  }

  .update-unavailable {
    max-width: none;
    text-align: left;
  }
}

@media (prefers-reduced-motion: reduce) {
  .update-button,
  .update-progress-fill,
  .update-reveal-enter-active,
  .update-reveal-leave-active {
    transition: none;
  }
}
</style>
