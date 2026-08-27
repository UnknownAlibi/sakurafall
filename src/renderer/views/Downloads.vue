<template>
  <div class="downloads">
    <!-- 顶栏 -->
    <PageHeader title="离线放映室" subtitle="OFFLINE ROOM / 下载管理">
      <template #icon>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
        </svg>
      </template>
      <div class="dl-stats" v-if="downloadList.length > 0">
        <span class="dl-stat-item dl-stat-active" v-if="activeCount > 0">
          {{ activeCount }} 个进行中
        </span>
        <span class="dl-stat-item dl-stat-completed">
          {{ completedCount }} 个已完成
        </span>
        <span class="dl-stat-item dl-stat-problem" v-if="problematicCount > 0">
          {{ problematicCount }} 个未完成
        </span>
      </div>
    </PageHeader>

    <!-- 下载目录设置 -->
    <div class="dl-dir-bar">
      <div class="dl-dir-info">
        <span class="dl-dir-label">下载目录：</span>
        <span class="dl-dir-path" :title="downloadDir || '未设置'">
          {{ downloadDir || '未设置（使用默认 userData/downloads）' }}
        </span>
      </div>
      <div class="dl-dir-actions">
        <button class="dl-dir-btn" @click="onSelectDir">更改目录</button>
        <button
          class="dl-dir-btn dl-dir-btn-secondary"
          :disabled="!downloadDir"
          @click="onOpenDir"
        >打开目录</button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="dl-loading">
      <div class="anime-loading-mascot" aria-hidden="true"></div>
      <div class="dl-loading-bubble">
        <span>樱月正在整理下载</span>
        <i></i><i></i><i></i>
      </div>
    </div>

    <!-- 下载列表 -->
    <div v-else-if="downloadList.length > 0" class="dl-list">
      <div
        v-for="task in downloadList"
        :key="task.id"
        class="dl-card"
        :class="['status-' + task.status]"
      >
        <!-- 封面 + 信息 -->
        <div class="dl-card-left">
          <div class="dl-cover">
            <CachedImage
              v-if="task.anime && task.anime.cover"
              :src="task.anime.cover"
              :alt="task.anime.name"
              cache-variant="thumbnail"
              :cache-width="160"
              data-cache-resolve="true"
              width="160"
              height="218"
              loading="lazy"
              decoding="async"
              fetchpriority="low"
              @error="() => onCoverError(task)"
            />
            <div v-else class="dl-cover-placeholder">
              <span>{{ (task.anime && task.anime.name || '?').slice(0, 2) }}</span>
            </div>
            <span class="dl-status-badge" :class="'badge-' + task.status">
              {{ statusLabel(task.status) }}
            </span>
          </div>
        </div>

        <div class="dl-card-main">
          <div class="dl-card-title-row">
            <h3 class="dl-card-title" :title="task.anime && task.anime.name">
              {{ task.anime && task.anime.name || '未知番剧' }}
            </h3>
            <span class="dl-card-ep">{{ episodeLabel(task) }}</span>
          </div>

          <!-- 进度条 -->
          <div class="dl-progress">
            <div class="dl-progress-bar">
              <div
                class="dl-progress-fill"
                :style="{ width: (task.progress || 0) + '%' }"
              ></div>
            </div>
            <div class="dl-progress-meta">
              <span class="dl-progress-pct">{{ task.progress || 0 }}%</span>
              <span class="dl-progress-size" v-if="task.totalBytes || task.downloadedBytes">
                {{ formatBytes(task.downloadedBytes) }} / {{ formatBytes(task.totalBytes) }}
              </span>
              <span class="dl-progress-size" v-else-if="task.status === 'completed'">
                {{ formatBytes(task.downloadedBytes) }}
              </span>
              <span class="dl-progress-speed" v-if="task.status === 'downloading' && task.speed">
                {{ formatBytes(task.speed) }}/s
              </span>
              <span class="dl-progress-error" v-if="task.status === 'failed' && task.errorMsg">
                {{ task.errorMsg }}
              </span>
            </div>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="dl-card-actions">
          <button
            v-if="task.status === 'downloading' || task.status === 'pending'"
            class="dl-action-btn"
            title="暂停"
            :disabled="actingTaskId === task.id"
            @click="onPause(task)"
          >⏸</button>
          <button
            v-if="task.status === 'paused' || task.status === 'failed'"
            class="dl-action-btn dl-action-resume"
            title="继续"
            :disabled="actingTaskId === task.id"
            @click="onResume(task)"
          >▶</button>
          <button
            v-if="task.status === 'downloading' || task.status === 'pending'"
            class="dl-action-btn dl-action-cancel"
            title="取消"
            :disabled="actingTaskId === task.id"
            @click="onCancel(task)"
          >✕</button>
          <button
            v-if="task.status === 'completed'"
            class="dl-action-btn dl-action-open"
            title="在文件夹中显示"
            @click="onOpenFile(task)"
          >📂</button>
          <button
            class="dl-action-btn dl-action-remove"
            title="删除记录和文件"
            :disabled="actingTaskId === task.id"
            @click="onRemove(task)"
          >🗑</button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <EmptyState
      v-else
      title="放映室还静悄悄的 (｡•́︿•̀｡)"
      message="在番剧详情页或播放窗口中点击「下载」，把想看的番剧存进离线放映室吧"
    >
      <template #action>
        <button @click="$router.push({ name: 'anime-zone' })" class="dl-go-browse-btn">去挑几部番 ♡</button>
      </template>
    </EmptyState>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import CachedImage from '../components/Common/CachedImage.vue';
import PageHeader from '../components/Common/PageHeader.vue';
import EmptyState from '../components/Common/EmptyState.vue';

export default {
    name: 'Downloads',
    components: { CachedImage, PageHeader, EmptyState },
    data() {
        return {
            loading: false,
            // 正在执行操作的下载任务 id（防连点 + 按钮禁用）
            actingTaskId: null,
            _failedCovers: new Set()
        };
    },
    computed: {
        ...mapGetters('download', [
            'downloadList',
            'downloadDir',
            'activeCount',
            'completedCount',
            'problematicCount'
        ])
    },
    methods: {
        ...mapActions('download', [
            'loadDownloadList',
            'pauseDownload',
            'resumeDownload',
            'cancelDownload',
            'removeDownload',
            'selectDownloadDir',
            'openDownloadDir',
            'openDownloadFile'
        ]),

        statusLabel(status) {
            const map = {
                pending: '等待中',
                downloading: '下载中',
                paused: '已暂停',
                completed: '已完成',
                failed: '失败'
            };
            return map[status] || status;
        },

        episodeLabel(task) {
            if (!task.episode) return '';
            if (task.episode.title) return task.episode.title;
            if (typeof task.episode.index === 'number' && task.episode.index >= 0) {
                return `第 ${task.episode.index + 1} 集`;
            }
            return '';
        },

        formatBytes(bytes) {
            const n = Number(bytes) || 0;
            if (n < 1024) return `${n} B`;
            if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
            if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
            return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
        },

        onCoverError(task) {
            this._failedCovers.add(task.id);
            this._failedCovers = new Set(this._failedCovers);
        },

        /** 包裹下载操作：防连点 + 成功/失败反馈 */
        async withTaskAction(task, actionLabel, fn) {
            if (this.actingTaskId) return;
            this.actingTaskId = task.id;
            try {
                await fn();
                this.$notify?.success(actionLabel, '操作已执行');
            } catch (error) {
                console.error(`[Downloads] ${actionLabel}失败:`, error);
                this.$notify?.error(`${actionLabel}失败`, error?.message || '请稍后重试');
            } finally {
                this.actingTaskId = null;
            }
        },

        onPause(task) {
            this.withTaskAction(task, '已暂停', () => this.pauseDownload(task.id));
        },

        onResume(task) {
            this.withTaskAction(task, '已继续', () => this.resumeDownload(task.id));
        },

        onCancel(task) {
            this.withTaskAction(task, '已取消', () => this.cancelDownload(task.id));
        },

        async onRemove(task) {
            if (this.actingTaskId) return;
            const confirmed = await this.$confirm({
                title: '删除下载',
                message: `确定删除「${task.anime && task.anime.name || ''} - ${this.episodeLabel(task)}」的下载记录和文件吗？`,
                confirmText: '删除',
                danger: true
            });
            if (!confirmed) return;
            await this.withTaskAction(task, '已删除', () => this.removeDownload(task.id));
        },

        async onOpenFile(task) {
            if (!task.filePath) return;
            const result = await this.openDownloadFile(task.filePath);
            if (result && !result.success && result.error) {
                this.$notify?.error('打开文件失败', result.error);
            }
        },

        async onSelectDir() {
            const dir = await this.selectDownloadDir();
            if (dir) {
                this.$notify?.success('下载目录已更新', dir);
            }
        },

        async onOpenDir() {
            const result = await this.openDownloadDir(this.downloadDir);
            if (result && !result.success && result.error) {
                this.$notify?.error('打开目录失败', result.error);
            }
        }
    },
    async mounted() {
        this.loading = true;
        try {
            await this.loadDownloadList();
        } finally {
            this.loading = false;
        }
    }
};
</script>

<style scoped>
.downloads {
    padding: 0 24px 28px;
    min-height: 100vh;
    position: relative;
}

/* ── 顶栏（结构统一使用 Common/PageHeader，仅保留统计样式） ── */
.dl-stats {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.dl-stat-item {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 500;
}

.dl-stat-active {
    color: var(--primary-color);
    background: var(--primary-light);
}

.dl-stat-completed {
    color: var(--success-color);
    background: rgba(40, 167, 69, 0.1);
}

.dl-stat-problem {
    color: var(--warning-color);
    background: rgba(240, 160, 32, 0.1);
}

/* ── 下载目录栏 ── */
.dl-dir-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    margin-top: 16px;
    background: var(--bg-card-glass);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    flex-wrap: wrap;
}

.dl-dir-info {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
}

.dl-dir-label {
    font-size: 13px;
    color: var(--text-secondary);
    flex-shrink: 0;
}

.dl-dir-path {
    font-size: 13px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.dl-dir-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
}

.dl-dir-btn {
    padding: 6px 14px;
    font-size: 12px;
    background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
    color: var(--text-inverse);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.2s var(--ease-smooth);
}

.dl-dir-btn:hover {
    background: linear-gradient(135deg, var(--primary-hover), var(--primary-color));
}

.dl-dir-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.dl-dir-btn-secondary {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
}

.dl-dir-btn-secondary:hover {
    background: var(--primary-lighter);
    border-color: var(--primary-color);
}

/* ── 加载状态 ── */
.dl-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 60px 0;
}

.dl-loading-bubble {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 34px;
    padding: 8px 14px;
    border: 1px solid rgba(var(--primary-rgb), 0.18);
    border-radius: 8px;
    background: var(--bg-card-glass);
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 600;
}

.dl-loading-bubble i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--primary-color);
    opacity: 0.35;
    animation: dl-dot 1s ease-in-out infinite;
}

.dl-loading-bubble i:nth-child(2) { animation-delay: 0.15s; }
.dl-loading-bubble i:nth-child(3) { animation-delay: 0.3s; }

@keyframes dl-dot {
    0%, 100% { opacity: 0.35; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(-3px); }
}

/* ── 下载列表 ── */
.dl-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
}

.dl-card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px;
    background: var(--bg-card-glass);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(160, 74, 118, 0.06);
    transition: border-color 0.2s var(--ease-smooth);
}

.dl-card:hover {
    border-color: rgba(var(--primary-rgb), 0.3);
}

.dl-card.status-completed {
    border-left: 3px solid var(--success-color);
}

.dl-card.status-failed {
    border-left: 3px solid var(--danger-color);
}

.dl-card.status-downloading {
    border-left: 3px solid var(--primary-color);
}

.dl-card.status-paused {
    border-left: 3px solid var(--warning-color);
}

.dl-card.status-pending {
    border-left: 3px solid var(--accent-cyan);
}

/* ── 封面 ── */
.dl-card-left {
    flex-shrink: 0;
}

.dl-cover {
    position: relative;
    width: 56px;
    height: 76px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--bg-elevated);
}

.dl-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.dl-cover-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.16) 0%, rgba(66, 199, 238, 0.14) 100%);
    color: var(--primary-color);
    font-size: 16px;
    font-weight: 700;
}

.dl-status-badge {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 10px;
    padding: 2px 0;
    color: #fff;
    background: rgba(0, 0, 0, 0.6);
}

.dl-status-badge.badge-completed { background: rgba(40, 167, 69, 0.85); }
.dl-status-badge.badge-failed { background: rgba(255, 71, 87, 0.85); }
.dl-status-badge.badge-downloading { background: rgba(var(--primary-rgb), 0.85); }
.dl-status-badge.badge-paused { background: rgba(240, 160, 32, 0.85); }
.dl-status-badge.badge-pending { background: rgba(66, 199, 238, 0.85); }

/* ── 卡片主体 ── */
.dl-card-main {
    flex: 1;
    min-width: 0;
}

.dl-card-title-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}

.dl-card-title {
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.dl-card-ep {
    font-size: 12px;
    color: var(--text-tertiary);
    flex-shrink: 0;
}

/* ── 进度条 ── */
.dl-progress-bar {
    height: 6px;
    background: var(--border-color);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 6px;
}

.dl-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--primary-color), var(--accent-cyan));
    border-radius: 3px;
    transition: width 0.3s var(--ease-smooth);
}

.status-completed .dl-progress-fill {
    background: linear-gradient(90deg, var(--success-color), #5fcf78);
}

.status-failed .dl-progress-fill {
    background: linear-gradient(90deg, var(--danger-color), #ff6b6b);
}

.status-paused .dl-progress-fill {
    background: linear-gradient(90deg, var(--warning-color), #ffc869);
}

.dl-progress-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--text-tertiary);
    flex-wrap: wrap;
}

.dl-progress-pct {
    font-weight: 600;
    color: var(--primary-color);
    min-width: 36px;
}

.dl-progress-size {
    color: var(--text-tertiary);
}

.dl-progress-speed {
    color: var(--accent-cyan);
    font-weight: 500;
}

.dl-progress-error {
    color: var(--danger-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
}

/* ── 操作按钮 ── */
.dl-card-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}

.dl-action-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: 1px solid var(--border-color);
    background: var(--bg-elevated);
    cursor: pointer;
    font-size: 13px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth);
    padding: 0;
}

.dl-action-btn:hover {
    background: var(--primary-lighter);
    border-color: var(--primary-color);
    color: var(--primary-color);
}

.dl-action-resume:hover {
    color: var(--success-color);
    border-color: var(--success-color);
    background: rgba(40, 167, 69, 0.08);
}

.dl-action-cancel:hover {
    color: var(--warning-color);
    border-color: var(--warning-color);
    background: rgba(240, 160, 32, 0.08);
}

.dl-action-remove:hover {
    color: var(--danger-color);
    border-color: var(--danger-color);
    background: rgba(255, 71, 87, 0.08);
}

.dl-action-open:hover {
    color: var(--accent-cyan);
    border-color: var(--accent-cyan);
    background: rgba(66, 199, 238, 0.08);
}

/* ── 空状态（结构统一使用 Common/EmptyState，仅保留动作按钮样式） ── */
.dl-go-browse-btn {
    padding: 10px 28px;
    background: linear-gradient(135deg, var(--primary-color), var(--accent-lavender));
    color: var(--text-inverse);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    transition: background 0.2s;
}

.dl-go-browse-btn:hover {
    background: linear-gradient(135deg, var(--primary-hover), var(--primary-color));
}

/* ── 响应式 ── */
@media (max-width: 768px) {
    .downloads {
        padding: 0 12px 20px;
    }

    .dl-card {
        flex-wrap: wrap;
    }

    .dl-card-main {
        width: 100%;
        order: 3;
        margin-top: 8px;
    }

    .dl-card-actions {
        margin-left: auto;
    }

    .dl-progress-error {
        max-width: 100%;
    }
}
</style>
