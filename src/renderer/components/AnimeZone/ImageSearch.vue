<template>
  <transition name="modal-fade">
    <div class="image-search-modal" @click="handleBackdropClick">
      <div class="modal-content" @click.stop>
        <!-- 顶部渐变装饰条 -->
        <div class="modal-gradient-bar"></div>

        <!-- 关闭按钮 -->
        <button class="close-btn" @click="$emit('close')" title="关闭">
          <span class="close-icon">✕</span>
        </button>

        <div class="modal-body">
          <!-- 标题 -->
          <div class="header-section">
            <h2 class="modal-title">
              <span class="title-icon">🖼️</span>以图搜番
            </h2>
            <p class="modal-subtitle">上传动漫截图，通过 trace.moe 识别番剧名、集数和时间点</p>
          </div>

          <!-- 上传区 -->
          <div
            class="upload-zone"
            :class="{ dragging: isDragging, 'has-preview': !!previewUrl }"
            @click="triggerFilePicker"
            @dragover.prevent="onDragOver"
            @dragleave.prevent="onDragLeave"
            @drop.prevent="onDrop"
            @paste="onPaste"
            tabindex="0"
            ref="uploadZone"
          >
            <img v-if="previewUrl" :src="previewUrl" class="preview-image" alt="预览" />
            <div v-else class="upload-placeholder">
              <div class="upload-icon">📁</div>
              <div class="upload-text">点击选择 / 拖拽 / 粘贴 (Ctrl+V) 图片</div>
              <div class="upload-hint">支持 JPG / PNG / WEBP，单张不超过 1MB（大图自动压缩）</div>
            </div>
            <div v-if="previewUrl" class="upload-overlay">
              <span class="reupload-hint">点击重新选择</span>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="actions-row">
            <button class="action-btn" @click="searchFromClipboard" :disabled="loading">
              <span>📋</span>从剪贴板
            </button>
            <button
              class="action-btn primary"
              @click="searchCurrent"
              :disabled="!previewUrl || loading"
            >
              <span v-if="loading" class="loading-spinner-small"></span>
              <span v-else>🔍</span>
              {{ loading ? '搜索中...' : '开始搜索' }}
            </button>
          </div>

          <!-- 结果区 -->
          <div class="results-section">
            <!-- 加载状态 -->
            <div v-if="loading" class="state-block loading-state">
              <div class="loading-spinner"></div>
              <p>正在识别图片，请稍候...</p>
            </div>

            <!-- 错误状态 -->
            <div v-else-if="errorMsg" class="state-block error-state">
              <div class="state-icon">⚠️</div>
              <h3>搜索失败</h3>
              <p>{{ errorMsg }}</p>
              <button class="retry-btn" @click="searchCurrent">重试</button>
            </div>

            <!-- 空状态 -->
            <div v-else-if="!hasSearched" class="state-block empty-state">
              <div class="state-icon">🎬</div>
              <p>放入一张动漫截图，即可识别番剧</p>
            </div>

            <!-- 无结果 -->
            <div v-else-if="results.length === 0" class="state-block empty-state">
              <div class="state-icon">🔍</div>
              <h3>未找到匹配的番剧</h3>
              <p>试试更清晰的截图，或换个角度的画面</p>
            </div>

            <!-- 结果列表 -->
            <div v-else class="results-list">
              <div class="results-header">
                <span>共 {{ results.length }} 条匹配结果</span>
                <span class="results-tip">相似度 ≥ 85% 为高置信匹配</span>
              </div>
              <div
                v-for="(item, idx) in results"
                :key="idx"
                class="result-card"
                :class="{ 'low-similarity': item.similarity < 0.85 }"
              >
                <div class="result-thumb">
                  <img
                    v-if="item.image"
                    :src="item.image"
                    :alt="item.filename"
                    loading="lazy"
                    @error="onThumbError($event)"
                  />
                  <div v-else class="thumb-placeholder">🖼️</div>
                </div>
                <div class="result-info">
                  <div class="info-top">
                    <h4 class="result-name" :title="displayName(item)">{{ displayName(item) }}</h4>
                    <span class="similarity-badge" :class="similarityClass(item.similarity)">
                      {{ formatSimilarity(item.similarity) }}
                    </span>
                  </div>
                  <div class="info-meta">
                    <span v-if="item.episode != null" class="meta-tag ep-tag">
                      <span class="tag-icon">📺</span>第 {{ item.episode }} 集
                    </span>
                    <span v-if="item.from != null && item.to != null" class="meta-tag time-tag">
                      <span class="tag-icon">⏱️</span>{{ formatTime(item.from) }} - {{ formatTime(item.to) }}
                    </span>
                    <span v-if="item.anilistId" class="meta-tag anilist-tag" :title="'AniList ID: ' + item.anilistId">
                      <span class="tag-icon">🆔</span>AniList #{{ item.anilistId }}
                    </span>
                  </div>
                  <div v-if="item.filename" class="info-filename" :title="item.filename">
                    📄 {{ item.filename }}
                  </div>
                  <div class="info-actions">
                    <button
                      v-if="item.video"
                      class="link-btn"
                      @click="openVideo(item.video)"
                      title="播放 trace.moe 返回的短视频片段"
                    >
                      ▶️ 预览片段
                    </button>
                    <button
                      class="link-btn primary"
                      @click="searchAnimeByName(item)"
                      :disabled="locatingId === idx"
                    >
                      <span v-if="locatingId === idx" class="loading-spinner-small"></span>
                      <span v-else>🔎</span>
                      {{ locatingId === idx ? '查找中...' : '在本站搜索' }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 隐藏的文件输入 -->
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          style="display: none"
          @change="onFilePicked"
        />
      </div>
    </div>
  </transition>
</template>

<script>
export default {
  name: 'ImageSearch',
  emits: ['close', 'locate'],
  data() {
    return {
      previewUrl: '',
      previewDataUrl: '',
      previewFilePath: '',
      isDragging: false,
      loading: false,
      hasSearched: false,
      errorMsg: '',
      results: [],
      locatingId: -1
    };
  },
  computed: {
    hasTraceMoeApi() {
      return !!(window.electronAPI && window.electronAPI.traceMoeSearchFile);
    }
  },
  methods: {
    handleBackdropClick() {
      this.$emit('close');
    },

    triggerFilePicker() {
      this.$refs.fileInput && this.$refs.fileInput.click();
    },

    onFilePicked(event) {
      const file = event.target.files && event.target.files[0];
      if (file) {
        this.loadFile(file);
      }
      // 重置 input 的 value，便于重复选择同一文件
      event.target.value = '';
    },

    onDragOver() {
      this.isDragging = true;
    },

    onDragLeave() {
      this.isDragging = false;
    },

    onDrop(event) {
      this.isDragging = false;
      const files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length > 0) {
        const file = Array.from(files).find(f => f.type.startsWith('image/')) || files[0];
        this.loadFile(file);
      }
    },

    onPaste(event) {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            this.loadFile(file);
            event.preventDefault();
            return;
          }
        }
      }
    },

    /**
     * 加载 File 对象为预览，并保存 dataURL
     */
    loadFile(file) {
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        this.$notify?.warning('图片过大', '请选择小于 10MB 的图片');
        return;
      }
      // 清理旧的预览 URL
      if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(this.previewUrl);
      }
      this.previewUrl = URL.createObjectURL(file);
      this.previewFilePath = '';
      // 读取为 dataURL 供主进程使用
      const reader = new FileReader();
      reader.onload = () => {
        this.previewDataUrl = String(reader.result || '');
      };
      reader.onerror = () => {
        this.previewDataUrl = '';
        this.$notify?.warning('读取失败', '图片读取失败，请重试');
      };
      reader.readAsDataURL(file);
      // 重置已有结果
      this.hasSearched = false;
      this.results = [];
      this.errorMsg = '';
    },

    /**
     * 从剪贴板读取图片并搜索
     */
    async searchFromClipboard() {
      if (!this.hasTraceMoeApi) {
        this.$notify?.error('不可用', '当前环境不支持以图搜番');
        return;
      }
      this.loading = true;
      this.errorMsg = '';
      this.hasSearched = true;
      try {
        const result = await window.electronAPI.traceMoeSearchClipboard();
        this.handleSearchResult(result);
        // 如果剪贴板有图片，主进程会返回结果；这里尝试用主进程读取并展示预览
        // 简单起见，预览图保持空白，由结果列表中的 image 字段提供缩略图
      } catch (error) {
        this.errorMsg = error.message || '剪贴板搜索失败';
        this.results = [];
      } finally {
        this.loading = false;
      }
    },

    /**
     * 用当前预览的图片发起搜索
     */
    async searchCurrent() {
      if (!this.previewDataUrl) {
        this.$notify?.warning('提示', '请先选择或粘贴一张图片');
        return;
      }
      if (!this.hasTraceMoeApi) {
        this.$notify?.error('不可用', '当前环境不支持以图搜番');
        return;
      }
      this.loading = true;
      this.errorMsg = '';
      this.hasSearched = true;
      try {
        const result = await window.electronAPI.traceMoeSearchDataUrl(this.previewDataUrl);
        this.handleSearchResult(result);
      } catch (error) {
        this.errorMsg = error.message || '搜索失败，请稍后重试';
        this.results = [];
      } finally {
        this.loading = false;
      }
    },

    handleSearchResult(result) {
      if (!result) {
        this.errorMsg = '未收到响应';
        this.results = [];
        return;
      }
      if (!result.success) {
        this.errorMsg = result.error || '搜索失败';
        this.results = [];
        return;
      }
      this.results = Array.isArray(result.results) ? result.results : [];
      if (this.results.length === 0 && result.error) {
        this.errorMsg = result.error;
      }
    },

    onThumbError(event) {
      // 缩略图加载失败，替换为占位
      event.target.style.display = 'none';
    },

    /**
     * 显示番剧名：trace.moe 返回的 filename 通常是 "[番剧名] 01.mkv" 形式
     * 提取中括号内的名称，没有则直接用 filename
     */
    displayName(item) {
      const name = item.filename || '';
      const match = name.match(/^\[([^\]]+)\]/);
      if (match) return match[1];
      // 去掉扩展名
      return name.replace(/\.[^.]+$/, '') || '未知番剧';
    },

    formatSimilarity(sim) {
      if (typeof sim !== 'number') return '—';
      return (sim * 100).toFixed(1) + '%';
    },

    similarityClass(sim) {
      if (typeof sim !== 'number') return 'sim-unknown';
      if (sim >= 0.92) return 'sim-high';
      if (sim >= 0.85) return 'sim-medium';
      return 'sim-low';
    },

    /**
     * 把秒数格式化为 mm:ss
     */
    formatTime(seconds) {
      if (typeof seconds !== 'number' || !isFinite(seconds)) return '--:--';
      const total = Math.floor(seconds);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    /**
     * 在新窗口打开 trace.moe 返回的短视频预览
     */
    openVideo(url) {
      if (!url) return;
      if (window.electronAPI && window.electronAPI.updateOpenDownload) {
        // 复用 shell.openExternal 打开外链
        window.electronAPI.updateOpenDownload(url);
      } else if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener');
      }
    },

    /**
     * 点击结果，在本站搜索同名番剧
     * 由父组件 (AnimeZone) 接收 locate 事件，跳转到详情或 CMS 搜索
     */
    async searchAnimeByName(item) {
      const name = this.displayName(item);
      if (!name) {
        this.$notify?.warning('提示', '无法识别番剧名');
        return;
      }
      const idx = this.results.indexOf(item);
      this.locatingId = idx;
      try {
        this.$emit('locate', { name, item });
      } finally {
        // 父组件会关闭弹窗，状态由父组件接管；这里只需还原
        this.locatingId = -1;
      }
    },

    /**
     * 全局粘贴监听（当弹窗打开时，监听 window 的 paste 事件）
     */
    onGlobalPaste(event) {
      // 仅在弹窗内没有聚焦到 upload-zone 时也响应
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            this.loadFile(file);
            event.preventDefault();
            return;
          }
        }
      }
    }
  },
  mounted() {
    // 全局粘贴监听
    window.addEventListener('paste', this.onGlobalPaste);
    // 自动聚焦上传区，便于直接 Ctrl+V
    this.$nextTick(() => {
      this.$refs.uploadZone && this.$refs.uploadZone.focus();
    });
  },
  beforeUnmount() {
    window.removeEventListener('paste', this.onGlobalPaste);
    // 清理 blob URL
    if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
      URL.revokeObjectURL(this.previewUrl);
    }
  }
};
</script>

<style scoped>
/* ===== 遮罩层 ===== */
.image-search-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(30, 15, 25, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

/* ===== 弹窗主体 ===== */
.modal-content {
  position: relative;
  background: var(--bg-card-glass);
  border-radius: 12px;
  width: 100%;
  max-width: 720px;
  max-height: 88vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 18px 40px rgba(80, 34, 66, 0.2);
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  z-index: 1;
  contain: layout style paint;
}

.modal-gradient-bar {
  height: 3px;
  background: linear-gradient(90deg, var(--primary-color), var(--accent-lavender), var(--accent-cyan), var(--accent-gold));
  flex-shrink: 0;
}

.close-btn {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 32px;
  height: 32px;
  border: none;
  background: var(--bg-card-glass);
  border: 1px solid rgba(var(--primary-rgb), 0.18);
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  transition: background-color 0.2s ease;
}

.close-icon {
  font-size: 13px;
  color: var(--primary-color);
}

.close-btn:hover {
  background: var(--primary-color);
}

.close-btn:hover .close-icon {
  color: var(--text-inverse);
}

.modal-body {
  padding: 24px 28px;
  overflow-y: auto;
  flex: 1;
}

.modal-body::-webkit-scrollbar {
  width: 6px;
}

.modal-body::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 3px;
}

.modal-body::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}

/* ===== 头部 ===== */
.header-section {
  margin-bottom: 18px;
}

.modal-title {
  margin: 0 0 6px 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-icon {
  font-size: 22px;
}

.modal-subtitle {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary);
}

/* ===== 上传区 ===== */
.upload-zone {
  position: relative;
  border: 2px dashed rgba(var(--primary-rgb), 0.32);
  border-radius: 10px;
  background: var(--bg-elevated);
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.2s ease, background-color 0.2s ease;
  outline: none;
  overflow: hidden;
}

.upload-zone:hover,
.upload-zone:focus {
  border-color: var(--primary-color);
  background: var(--primary-lighter);
}

.upload-zone.dragging {
  border-color: var(--primary-color);
  background: var(--primary-light);
  border-style: solid;
}

.upload-zone.has-preview {
  padding: 0;
  min-height: 240px;
}

.upload-placeholder {
  text-align: center;
  padding: 32px 20px;
  color: var(--text-tertiary);
}

.upload-icon {
  font-size: 40px;
  margin-bottom: 10px;
  opacity: 0.6;
}

.upload-text {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

.upload-hint {
  font-size: 11px;
  color: var(--text-tertiary);
}

.preview-image {
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
  display: block;
}

.upload-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s ease;
  font-size: 13px;
  font-weight: 500;
}

.upload-zone.has-preview:hover .upload-overlay {
  opacity: 1;
}

.reupload-hint {
  padding: 6px 16px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 14px;
  backdrop-filter: blur(4px);
}

/* ===== 操作按钮 ===== */
.actions-row {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  justify-content: flex-end;
}

.action-btn {
  padding: 8px 18px;
  border: 1px solid var(--border-color-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.action-btn:hover:not(:disabled) {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.primary {
  background: linear-gradient(135deg, var(--primary-color), #ff9ec4);
  color: var(--text-inverse);
  border-color: transparent;
}

.action-btn.primary:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--primary-hover), var(--primary-color));
  color: var(--text-inverse);
}

/* ===== 结果区 ===== */
.results-section {
  margin-top: 20px;
}

.state-block {
  text-align: center;
  padding: 36px 20px;
  color: var(--text-tertiary);
}

.state-icon {
  font-size: 36px;
  margin-bottom: 10px;
  opacity: 0.7;
}

.state-block h3 {
  margin: 6px 0 8px 0;
  font-size: 16px;
  color: var(--text-secondary);
}

.state-block p {
  margin: 0 0 14px 0;
  font-size: 13px;
}

.loading-state .loading-spinner,
.error-state .state-icon,
.empty-state .state-icon {
  display: block;
  margin: 0 auto 10px;
}

.loading-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--primary-light);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.loading-spinner-small {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  vertical-align: middle;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.retry-btn {
  padding: 6px 18px;
  background: var(--primary-color);
  color: var(--text-inverse);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.retry-btn:hover {
  background: var(--primary-hover);
}

/* ===== 结果列表 ===== */
.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 10px;
  padding: 0 4px;
}

.results-tip {
  color: var(--text-tertiary);
  opacity: 0.85;
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.result-card {
  display: flex;
  gap: 14px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-surface);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.result-card:hover {
  border-color: var(--primary-color);
  box-shadow: var(--shadow-sm);
}

.result-card.low-similarity {
  opacity: 0.78;
}

.result-thumb {
  flex-shrink: 0;
  width: 120px;
  height: 70px;
  border-radius: 6px;
  overflow: hidden;
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
}

.result-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb-placeholder {
  font-size: 22px;
  opacity: 0.5;
}

.result-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.info-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}

.result-name {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.similarity-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}

.sim-high {
  background: rgba(40, 167, 69, 0.15);
  color: var(--success-color);
}

.sim-medium {
  background: rgba(240, 160, 32, 0.15);
  color: var(--warning-color);
}

.sim-low {
  background: rgba(255, 68, 68, 0.15);
  color: var(--error-color);
}

.sim-unknown {
  background: var(--tag-bg);
  color: var(--tag-text);
}

.info-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  background: var(--tag-bg);
  color: var(--tag-text);
}

.tag-icon {
  font-size: 10px;
}

.ep-tag {
  background: rgba(40, 167, 69, 0.1);
  color: var(--success-color);
}

.time-tag {
  background: rgba(66, 199, 238, 0.1);
  color: var(--accent-cyan);
}

.anilist-tag {
  background: var(--primary-light);
  color: var(--primary-color);
}

.info-filename {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Consolas', 'Monaco', monospace;
}

.info-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.link-btn {
  padding: 4px 12px;
  border: 1px solid var(--border-color-strong);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.link-btn:hover:not(:disabled) {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.link-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.link-btn.primary {
  background: var(--primary-color);
  color: var(--text-inverse);
  border-color: transparent;
}

.link-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover);
  color: var(--text-inverse);
}

/* ===== 过渡动画 ===== */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.25s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-active .modal-content,
.modal-fade-leave-active .modal-content {
  transition: transform 0.25s ease;
}

.modal-fade-enter-from .modal-content {
  transform: scale(0.96);
}

.modal-fade-leave-to .modal-content {
  transform: scale(0.96);
}

/* ===== 响应式 ===== */
@media (max-width: 600px) {
  .modal-body {
    padding: 18px 16px;
  }

  .result-card {
    flex-direction: column;
  }

  .result-thumb {
    width: 100%;
    height: 140px;
  }

  .actions-row {
    flex-direction: column;
  }

  .action-btn {
    width: 100%;
    justify-content: center;
  }
}
</style>
