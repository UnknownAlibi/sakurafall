<template>
  <div class="setting-item gpu-compositing-item">
    <div class="setting-label">
      <label>GPU 合成</label>
      <p class="setting-desc">
        开启（默认）：保留显卡合成，只关闭 Windows 的 DirectComposition 覆盖层路径，用于规避全屏画面冻结、下方空白、控制栏唤不出。
        关闭：整页退化为 CPU 合成，播放负载会明显升高，仅在开启后全屏仍异常时作为兜底。
      </p>
      <p class="gpu-compositing-state">
        当前：{{ activeLabel }}
        <span v-if="restartRequired && !devMode" class="gpu-compositing-pending">· 重启后生效</span>
        <span v-if="restartRequired && devMode" class="gpu-compositing-pending">· 重新运行 npm run dev 后生效</span>
        <span v-if="envLocked" class="gpu-compositing-pending">· 已由启动参数强制开启</span>
      </p>
      <p v-if="error" class="gpu-compositing-error">{{ error }}</p>
    </div>
    <div class="setting-control gpu-compositing-control">
      <label class="switch">
        <input
          type="checkbox"
          v-model="enabled"
          :disabled="loading || envLocked"
          @change="save"
        />
        <span class="slider"></span>
      </label>
      <button
        v-if="restartRequired && !devMode"
        class="gpu-restart-btn"
        @click="relaunch"
      >重启应用</button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'GpuCompositingCard',
  data() {
    return {
      enabled: false,
      active: false,
      restartRequired: false,
      envLocked: false,
      devMode: false,
      loading: true,
      error: ''
    };
  },
  computed: {
    activeLabel() {
      return this.active
        ? 'GPU 合成（DirectComposition 已关闭）'
        : 'CPU 合成（兜底模式）';
    }
  },
  async mounted() {
    await this.load();
  },
  methods: {
    async load() {
      try {
        const info = await window.electronAPI?.gpuCompositingGet?.();
        if (!info) {
          this.error = '当前环境不支持该设置';
          return;
        }
        this.enabled = info.enabled === true;
        this.active = info.active === true;
        this.restartRequired = info.restartRequired === true;
        this.envLocked = info.envLocked === true;
        this.devMode = info.devMode === true;
      } catch (error) {
        this.error = error?.message || '读取 GPU 合成状态失败';
      } finally {
        this.loading = false;
      }
    },
    async save() {
      this.error = '';
      try {
        const result = await window.electronAPI?.gpuCompositingSet?.(this.enabled);
        if (!result?.success) {
          this.error = result?.error || '保存失败';
          this.enabled = !this.enabled;
          return;
        }
        this.restartRequired = result.restartRequired === true;
      } catch (error) {
        this.error = error?.message || '保存失败';
        this.enabled = !this.enabled;
      }
    },
    async relaunch() {
      this.error = '';
      try {
        const result = await window.electronAPI?.appRelaunch?.();
        if (result && result.success === false) {
          this.error = result.error || '重启失败，请手动重启应用';
        }
      } catch (error) {
        this.error = error?.message || '重启失败，请手动重启应用';
      }
    }
  }
};
</script>

<style scoped>
/* 根节点沿用 Settings.vue 的 .setting-item 布局（scoped 样式会作用到子组件根元素），
   内部元素样式需自带，因为父级 scoped 选择器不会穿透到子组件内部。 */
.setting-label {
  flex: 1;
}

.setting-label label {
  display: block;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.setting-desc {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.gpu-compositing-state {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--text-tertiary);
}

.gpu-compositing-pending {
  margin-left: 4px;
  color: var(--primary-color);
}

.gpu-compositing-error {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--error-color);
}

.setting-control {
  min-width: 200px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}

.switch {
  position: relative;
  display: inline-block;
  width: 50px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--border-color-strong);
  transition: 0.3s;
  border-radius: 24px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: var(--bg-surface);
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--primary-color);
}

input:checked + .slider:before {
  transform: translateX(26px);
}

input:disabled + .slider {
  cursor: not-allowed;
  opacity: 0.55;
}

.gpu-restart-btn {
  padding: 6px 14px;
  border: 1px solid var(--primary-color);
  border-radius: 8px;
  background: transparent;
  color: var(--primary-color);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.2s, color 0.2s;
}

.gpu-restart-btn:hover {
  background: var(--primary-color);
  color: var(--text-inverse);
}

.gpu-compositing-control {
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .setting-control {
    min-width: auto;
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
