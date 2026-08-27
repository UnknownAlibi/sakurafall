<template>
  <div class="cast-overlay" @click.self="onOverlayClick">
    <div class="cast-dialog">
      <!-- 头部 -->
      <div class="cast-header">
        <div class="cast-title">
          <svg class="cast-title-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>
            <line x1="2" y1="20" x2="2.01" y2="20"/>
          </svg>
          <div>
            <h3>投屏到 DLNA 设备</h3>
            <p>{{ subtitle }}</p>
          </div>
        </div>
        <button class="cast-close" @click="onClose" title="关闭">×</button>
      </div>

      <!-- 设备列表区 -->
      <div v-if="!activeDevice" class="cast-body">
        <!-- 搜索中 -->
        <div v-if="searching" class="cast-state">
          <div class="loading-spinner small"></div>
          <span>正在搜索局域网内的 DLNA 设备...</span>
          <button class="hint-btn" @click="onRefresh">重新搜索</button>
        </div>

        <!-- 无设备 -->
        <div v-else-if="devices.length === 0" class="cast-state empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.32)" stroke-width="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <span>未发现可投屏的 DLNA 设备</span>
          <span class="cast-tip">请确认电视/盒子与本机处于同一局域网并已开启 DLNA</span>
          <button class="hint-btn primary" @click="onRefresh">重新搜索</button>
        </div>

        <!-- 设备列表 -->
        <div v-else class="device-list">
          <button
            v-for="device in devices"
            :key="device.id"
            class="device-item"
            @click="onSelectDevice(device)"
          >
            <svg class="device-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            <span class="device-name" :title="device.name">{{ device.name }}</span>
            <svg class="device-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 投屏控制区（已选中设备后） -->
      <div v-else class="cast-body control-body">
        <div class="active-device">
          <svg class="active-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
          </svg>
          <span class="active-name" :title="activeDevice.name">{{ activeDevice.name }}</span>
          <button class="switch-device-btn" @click="onSwitchDevice">切换设备</button>
        </div>

        <div class="control-row">
          <button class="control-btn" :disabled="actionPending" @click="onTogglePlay" :title="isCastingPlaying ? '暂停' : '播放'">
            <svg v-if="isCastingPlaying" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1"/>
              <rect x="14" y="4" width="4" height="16" rx="1"/>
            </svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>

          <button class="control-btn" :disabled="actionPending" @click="onSeekRelative(-seekStepSeconds)" :title="`快退 ${seekStepSeconds}s`">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>

          <button class="control-btn" :disabled="actionPending" @click="onSeekRelative(seekStepSeconds)" :title="`快进 ${seekStepSeconds}s`">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>

          <button class="control-btn stop-btn" :disabled="actionPending" @click="onStop" title="停止投屏">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="5" width="14" height="14" rx="2"/>
            </svg>
          </button>
        </div>

        <!-- 进度条 -->
        <div class="cast-progress">
          <input
            type="range"
            class="cast-slider"
            min="0"
            :max="duration || 0"
            :value="draggingTime != null ? draggingTime : position"
            step="0.5"
            :style="{ background: progressGradient }"
            @mousedown="draggingTime = position"
            @input="onSliderInput"
            @change="onSliderCommit"
          />
          <div class="cast-time">
            <span>{{ formatTime(position) }}</span>
            <span class="separator">/</span>
            <span>{{ formatTime(duration) }}</span>
          </div>
        </div>

        <div v-if="errorMessage" class="cast-error">{{ errorMessage }}</div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CastDialog',
  props: {
    // 当前视频信息（投屏用）
    video: {
      type: Object,
      default: null
    },
    seekStepSeconds: {
      type: Number,
      default: 10
    }
  },
  emits: ['close', 'cast-start', 'cast-stop'],
  data() {
    return {
      searching: false,
      devices: [],
      activeDevice: null,
      isCastingPlaying: false,
      position: 0,
      duration: 0,
      actionPending: false,
      errorMessage: '',
      pollTimer: null,
      draggingTime: null,
      lastCommittedSeek: 0
    };
  },
  computed: {
    subtitle() {
      if (this.activeDevice) {
        return `正在投屏到：${this.activeDevice.name}`;
      }
      if (this.video?.anime?.name) {
        const ep = this.video?.episode?.title || '';
        return ep ? `${this.video.anime.name} - ${ep}` : this.video.anime.name;
      }
      return '选择设备开始投屏';
    },
    progressGradient() {
      const max = this.duration || 0;
      const cur = this.draggingTime != null ? this.draggingTime : this.position;
      const pct = max > 0 ? Math.min(100, Math.max(0, (cur / max) * 100)) : 0;
      return `linear-gradient(to right, var(--player-progress) 0%, var(--player-progress) ${pct}%, rgba(255,255,255,0.2) ${pct}%, rgba(255,255,255,0.2) 100%)`;
    }
  },
  methods: {
    // 搜索设备
    async onRefresh() {
      this.searching = true;
      this.errorMessage = '';
      this.devices = [];
      try {
        const result = await window.electronAPI.dlnaDiscover({ timeout: 5000 });
        if (result && result.success) {
          this.devices = result.devices || [];
        } else {
          this.errorMessage = result?.error || '搜索失败';
        }
      } catch (e) {
        this.errorMessage = e.message || '搜索失败';
      } finally {
        this.searching = false;
      }
    },

    // 选中设备开始投屏
    async onSelectDevice(device) {
      if (!this.video?.url) {
        this.errorMessage = '当前没有可投屏的视频';
        return;
      }
      this.actionPending = true;
      this.errorMessage = '';
      const title = this.video?.episode?.title
        ? `${this.video.anime?.name || ''} - ${this.video.episode.title}`
        : (this.video?.anime?.name || this.video?.title || '视频');

      try {
        const result = await window.electronAPI.dlnaCast({
          deviceId: device.id,
          url: this.video.url,
          title
        });
        if (result && result.success) {
          this.activeDevice = device;
          this.isCastingPlaying = true;
          this.startPolling();
          this.$emit('cast-start', device);
        } else {
          this.errorMessage = result?.error || '投屏失败';
        }
      } catch (e) {
        this.errorMessage = e.message || '投屏失败';
      } finally {
        this.actionPending = false;
      }
    },

    // 切换设备：返回设备列表（不发送 stop，让用户自行选择）
    onSwitchDevice() {
      this.stopPolling();
      this.activeDevice = null;
      this.position = 0;
      this.duration = 0;
      this.isCastingPlaying = false;
      this.onRefresh();
    },

    // 暂停 / 恢复
    async onTogglePlay() {
      if (this.actionPending || !this.activeDevice) return;
      this.actionPending = true;
      try {
        let result;
        if (this.isCastingPlaying) {
          result = await window.electronAPI.dlnaPause(this.activeDevice.id);
          if (result?.success) this.isCastingPlaying = false;
        } else {
          result = await window.electronAPI.dlnaResume(this.activeDevice.id);
          if (result?.success) this.isCastingPlaying = true;
        }
        if (result && !result.success) {
          this.errorMessage = result.error || '操作失败';
        } else {
          this.errorMessage = '';
        }
      } catch (e) {
        this.errorMessage = e.message || '操作失败';
      } finally {
        this.actionPending = false;
      }
    },

    // 停止投屏
    async onStop() {
      if (this.actionPending || !this.activeDevice) return;
      this.actionPending = true;
      try {
        const result = await window.electronAPI.dlnaStop(this.activeDevice.id);
        if (result && !result.success) {
          this.errorMessage = result.error || '停止失败';
        }
      } catch (e) {
        // 即使停止失败也要清理本地状态，避免卡死
        this.errorMessage = e.message || '停止失败';
      } finally {
        this.actionPending = false;
        this.stopPolling();
        this.activeDevice = null;
        this.isCastingPlaying = false;
        this.position = 0;
        this.duration = 0;
        this.$emit('cast-stop');
      }
    },

    // 快进 / 快退
    async onSeekRelative(delta) {
      if (this.actionPending || !this.activeDevice) return;
      const target = Math.max(0, (this.position || 0) + delta);
      await this.commitSeek(target);
    },

    onSliderInput(event) {
      this.draggingTime = parseFloat(event.target.value) || 0;
    },

    async onSliderCommit(event) {
      const target = parseFloat(event.target.value) || 0;
      this.draggingTime = null;
      await this.commitSeek(target);
    },

    async commitSeek(seconds) {
      if (this.actionPending || !this.activeDevice) return;
      // 防止 getPosition 同步过来后立即覆盖用户拖动结果
      this.lastCommittedSeek = seconds;
      this.position = seconds;
      this.actionPending = true;
      try {
        const result = await window.electronAPI.dlnaSeek(this.activeDevice.id, seconds);
        if (result && !result.success) {
          this.errorMessage = result.error || '跳转失败';
        } else {
          this.errorMessage = '';
        }
      } catch (e) {
        this.errorMessage = e.message || '跳转失败';
      } finally {
        this.actionPending = false;
      }
    },

    // 定时轮询设备播放位置同步 UI
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(async () => {
        if (!this.activeDevice) return;
        try {
          const result = await window.electronAPI.dlnaGetPosition(this.activeDevice.id);
          if (result && result.success) {
            // 用户正在拖动 / 刚 seek 时不覆盖
            if (this.draggingTime == null &&
                Math.abs(this.lastCommittedSeek - result.position) > 1.5) {
              this.lastCommittedSeek = result.position;
            }
            if (this.draggingTime == null) {
              this.position = result.position || 0;
            }
            this.duration = result.duration || this.duration || 0;
          }
        } catch (e) {
          // 单次轮询失败不报错，避免频繁弹错误
        }
      }, 2000);
    },

    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    },

    formatTime(seconds) {
      if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return '00:00';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }
      return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    },

    onClose() {
      // 关闭对话框但保留投屏状态（用户可能想边投屏边做别的）
      // 如果需要关闭即停止，可改为先 onStop 再 emit('close')
      this.stopPolling();
      this.$emit('close');
    },

    onOverlayClick() {
      // 点击遮罩关闭（保留投屏）
      this.onClose();
    }
  },
  mounted() {
    this.onRefresh();
  },
  beforeUnmount() {
    this.stopPolling();
  }
};
</script>

<style scoped>
.cast-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(2px);
}

.cast-dialog {
  width: min(420px, calc(100% - 32px));
  max-height: min(80vh, 560px);
  display: flex;
  flex-direction: column;
  padding: 18px 18px 16px;
  border: 1px solid rgba(255, 138, 176, 0.16);
  border-radius: 12px;
  background:
    linear-gradient(180deg, rgba(31, 27, 48, 0.96), rgba(18, 17, 31, 0.96));
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.4);
  color: #fff;
}

.cast-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.cast-title {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-width: 0;
}

.cast-title-icon {
  color: var(--player-progress);
  flex-shrink: 0;
  margin-top: 2px;
}

.cast-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.94);
}

.cast-title p {
  margin: 4px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.56);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.cast-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.74);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  flex-shrink: 0;
}

.cast-close:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

.cast-body {
  flex: 1;
  min-height: 200px;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.cast-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px 12px;
  color: rgba(255, 255, 255, 0.68);
  font-size: 13px;
  text-align: center;
}

.cast-state.empty svg {
  margin-bottom: 4px;
}

.cast-tip {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.42);
  max-width: 280px;
  line-height: 1.5;
}

.loading-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: var(--player-progress);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.loading-spinner.small {
  width: 20px;
  height: 20px;
  border-width: 2px;
}

.hint-btn {
  margin-top: 6px;
  padding: 6px 18px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.86);
  cursor: pointer;
  font-size: 12px;
  transition: background 0.15s, border-color 0.15s;
}

.hint-btn:hover {
  background: rgba(var(--primary-rgb), 0.16);
  border-color: rgba(var(--primary-rgb), 0.4);
}

.hint-btn.primary {
  background: linear-gradient(135deg, var(--player-progress), var(--accent-lavender));
  border-color: transparent;
  color: #fff;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.device-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.055);
  color: #fff;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}

.device-item:hover {
  background: rgba(var(--primary-rgb), 0.13);
  border-color: rgba(var(--primary-rgb), 0.35);
}

.device-icon {
  color: var(--player-progress);
  flex-shrink: 0;
}

.device-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-arrow {
  color: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}

/* ===== 投屏控制区 ===== */
.control-body {
  gap: 14px;
}

.active-device {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--primary-rgb), 0.1);
  border: 1px solid rgba(var(--primary-rgb), 0.22);
}

.active-icon {
  color: var(--player-progress);
  flex-shrink: 0;
}

.active-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switch-device-btn {
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  font-size: 11px;
  transition: background 0.15s;
}

.switch-device-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.control-row {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.control-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 138, 176, 0.3);
}

.control-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.control-row .control-btn:first-child {
  width: 46px;
  height: 46px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.92), rgba(156, 123, 255, 0.88));
  border-color: transparent;
}

.control-row .control-btn:first-child:hover:not(:disabled) {
  filter: brightness(1.1);
}

.stop-btn:hover:not(:disabled) {
  background: rgba(255, 80, 80, 0.2);
  border-color: rgba(255, 80, 80, 0.4);
}

.cast-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.cast-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}

.cast-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--player-progress), var(--accent-cyan));
  cursor: pointer;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.12);
}

.cast-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--player-progress);
  cursor: pointer;
  border: none;
}

.cast-time {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  color: rgba(255, 255, 255, 0.78);
}

.cast-time .separator {
  opacity: 0.5;
}

.cast-error {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 80, 80, 0.12);
  border: 1px solid rgba(255, 80, 80, 0.28);
  color: #ff8a8a;
  font-size: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 600px) {
  .cast-dialog {
    padding: 14px 12px;
  }
  .cast-title p {
    max-width: 200px;
  }
}
</style>
