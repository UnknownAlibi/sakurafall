<template>
  <div class="bt-hub">
    <!-- 顶栏 -->
    <PageHeader title="BT 资源站" subtitle="BT HUB / 压制组资源检索" kawaii-mark>
      <template #icon>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      </template>
      <div class="bt-stats" v-if="searched && !loading">
        <span class="bt-stat-item">共 {{ items.length }} 条资源</span>
      </div>
    </PageHeader>

    <!-- 搜索区 -->
    <div class="bt-search-bar">
      <div class="bt-search-input-wrap">
        <svg class="bt-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref="searchInput"
          v-model="keyword"
          class="bt-search-input"
          type="text"
          placeholder="搜索番名 / 压制组资源，如：孤独摇滚、VCB-Studio"
          maxlength="80"
          @keydown.enter="onSearch"
        />
        <button
          v-if="keyword"
          class="bt-clear-btn"
          title="清空"
          @click="onClear"
        >×</button>
      </div>
      <div class="bt-provider-filter">
        <button
          v-for="p in providerOptions"
          :key="p.key"
          :class="['bt-provider-btn', { active: provider === p.key }]"
          @click="onSwitchProvider(p.key)"
        >{{ p.label }}</button>
      </div>
      <button
        class="bt-search-btn"
        :disabled="loading || !keyword.trim()"
        @click="onSearch"
      >{{ loading ? '搜索中…' : '搜索' }}</button>
    </div>

    <!-- 源错误提示 -->
    <div v-if="errors.length > 0" class="bt-errors">
      <div v-for="err in errors" :key="err.provider" class="bt-error-item">
        <span class="bt-error-source">{{ err.providerName }}</span>
        <span class="bt-error-msg">{{ err.message }}</span>
      </div>
      <div class="bt-error-tip">境外源可能需要代理（设置 → 网络设置 → 代理地址）</div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="bt-loading">
      <div class="anime-loading-mascot" aria-hidden="true"></div>
      <div class="bt-loading-bubble">
        <span>樱月正在翻压制组的仓库</span>
        <i></i><i></i><i></i>
      </div>
    </div>

    <!-- 结果列表 -->
    <div v-else-if="items.length > 0" class="bt-list">
      <div class="bt-workflow-tip">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span class="bt-workflow-text">点击「边播边下」可在应用内直接观看（自动缓冲当前集）；也可用 BT 客户端完整下载后，把下载目录添加为本地媒体库</span>
        <button class="bt-add-library-btn" :disabled="addingLibrary" @click="onAddLocalLibrary">
          {{ addingLibrary ? '添加中…' : '添加本地媒体库' }}
        </button>
      </div>
      <div v-for="item in items" :key="item.id" class="bt-card">
        <div class="bt-card-main">
          <div class="bt-card-title-row">
            <span v-if="item.parsed.group" class="bt-group-badge">{{ item.parsed.group }}</span>
            <h3 class="bt-card-title" :title="item.title">{{ item.parsed.title || item.title }}</h3>
          </div>
          <p class="bt-card-sub" :title="item.title">{{ item.title }}</p>
          <div class="bt-card-meta">
            <span v-if="item.parsed.episode != null" class="bt-meta-chip bt-meta-ep">第 {{ item.parsed.episode }} 集</span>
            <span v-if="item.parsed.season != null" class="bt-meta-chip">第 {{ item.parsed.season }} 季</span>
            <span v-if="item.parsed.resolution" class="bt-meta-chip bt-meta-res">{{ item.parsed.resolution }}</span>
            <span v-if="item.parsed.videoCodec" class="bt-meta-chip">{{ item.parsed.videoCodec }}</span>
            <span v-if="item.parsed.audioCodec" class="bt-meta-chip">{{ item.parsed.audioCodec }}</span>
            <span v-if="item.parsed.bitDepth" class="bt-meta-chip">{{ item.parsed.bitDepth }}bit</span>
            <span v-if="item.parsed.subtitleLang" class="bt-meta-chip">{{ item.parsed.subtitleLang }}</span>
            <span v-if="item.parsed.special" class="bt-meta-chip bt-meta-special">{{ item.parsed.special }}</span>
            <span v-if="item.parsed.isComplete" class="bt-meta-chip bt-meta-complete">全集</span>
            <span v-if="item.parsed.isUncensored" class="bt-meta-chip bt-meta-uncensored">无修正</span>
          </div>
          <div class="bt-card-info">
            <span class="bt-info-item bt-info-provider">{{ item.providerName }}</span>
            <span v-if="item.size" class="bt-info-item">{{ item.size }}</span>
            <span v-if="item.seedCount != null" class="bt-info-item">{{ item.seedCount }} 种子</span>
            <span v-if="item.publishDate" class="bt-info-item">{{ item.publishDate }}</span>
          </div>
        </div>
        <div class="bt-card-actions">
          <button class="bt-open-btn" @click="onStreamTorrent(item)">边播边下</button>
          <button class="bt-copy-btn" @click="onOpenMagnet(item)">用 BT 客户端打开</button>
          <button class="bt-copy-btn" @click="onCopyMagnet(item)">复制磁力链</button>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="searched" class="bt-empty">
      <div class="bt-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      </div>
      <p class="bt-empty-title">没有找到相关资源</p>
      <p class="bt-empty-tip">试试日文原名或英文名，或换个关键词再搜一次</p>
    </div>

    <!-- 初始引导 -->
    <div v-else class="bt-intro">
      <div class="bt-intro-hero" aria-hidden="true">
        <div class="bt-intro-magnet">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
            <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
          </svg>
        </div>
      </div>
      <h3 class="bt-intro-title">这里能找到什么？</h3>
      <p class="bt-intro-desc">
        聚合蜜柑计划、动漫花园两大 BT 索引站，检索 BDRip / WEB-DL 等高清压制资源，
        自动解析字幕组、集数、分辨率与编码信息。点击「边播边下」无需外部下载工具，
        应用会自动连接做种节点、按播放进度优先下载，直接在播放窗口观看；
        也可以用 BT 客户端完整下载后，把下载目录「添加本地媒体库」，视频会自动匹配到对应番剧详情页。
      </p>
      <div class="bt-intro-samples">
        <button
          v-for="sample in sampleKeywords"
          :key="sample"
          class="bt-sample-chip"
          @click="onTrySample(sample)"
        >{{ sample }}</button>
      </div>
    </div>

    <!-- 边播边下弹窗 -->
    <div v-if="stream.visible" class="bt-stream-mask" @click.self="onStreamClose">
      <div class="bt-stream-modal">
        <div class="bt-stream-head">
          <h3>边播边下</h3>
          <button class="bt-stream-close" title="关闭" @click="onStreamClose">×</button>
        </div>

        <!-- 阶段一：连接做种节点获取文件列表 -->
        <div v-if="stream.phase === 'preparing'" class="bt-stream-body">
          <div class="bt-stream-spinner" aria-hidden="true"></div>
          <p class="bt-stream-note">正在连接做种节点并读取文件列表…</p>
          <p class="bt-stream-sub">通常需要 10~45 秒，取决于资源做种数量；冷门资源可能失败，可改用「用 BT 客户端打开」完整下载</p>
        </div>

        <!-- 阶段二：选择要播放的文件 -->
        <div v-else-if="stream.phase === 'files'" class="bt-stream-body">
          <p class="bt-stream-note" :title="stream.name">{{ stream.name }}</p>
          <div class="bt-stream-files">
            <button
              v-for="file in streamVideoFiles"
              :key="file.path"
              class="bt-stream-file"
              @click="onStreamPlay(file)"
            >
              <span class="bt-stream-file-name" :title="file.path">{{ file.name }}</span>
              <span class="bt-stream-file-size">{{ formatBytes(file.length) }}</span>
            </button>
          </div>
          <p v-if="streamVideoFiles.length === 0" class="bt-stream-sub">该种子内没有可直接播放的视频文件</p>
          <p class="bt-stream-sub">兼容性：H.264 + AAC / FLAC 音轨可直接播放；HEVC 视频或 AC3 音轨的版本可能无法解码，请换其他压制版本</p>
          <div v-if="streamCache" class="bt-stream-cache-row">
            <span class="bt-stream-cache-text">
              缓存占用 {{ formatBytes(streamCache.totalBytes) }} · 下完整保留 {{ streamCache.retainDays }} 天，未下完的下次启动自动清理
            </span>
            <button class="bt-stream-cache-clear" :disabled="streamCacheClearing" @click="onClearStreamCache">
              {{ streamCacheClearing ? '清理中…' : '清空缓存' }}
            </button>
          </div>
        </div>

        <!-- 阶段三：边播边下中 -->
        <div v-else-if="stream.phase === 'playing'" class="bt-stream-body">
          <p class="bt-stream-note" :title="stream.fileName">{{ stream.fileName }}</p>
          <div class="bt-stream-progress">
            <div
              class="bt-stream-progress-bar"
              :style="{ transform: `scaleX(${streamProgressPercent / 100})` }"
            ></div>
          </div>
          <div class="bt-stream-stats">
            <span>{{ streamProgressPercent }}%</span>
            <span>{{ formatBytes(stream.status?.downloadSpeed || 0) }}/s</span>
            <span>{{ stream.status?.numPeers || 0 }} 节点</span>
            <span>{{ formatBytes(stream.status?.downloaded || 0) }} / {{ formatBytes(stream.status?.length || 0) }}</span>
          </div>
          <div class="bt-stream-actions">
            <button class="bt-stream-stop-btn" @click="onStreamStop">停止下载</button>
          </div>
          <p class="bt-stream-sub">关闭此弹窗不会中断下载；下完整保留 {{ streamCache ? streamCache.retainDays : 7 }} 天自动清理，未下完的下次启动时清除</p>
        </div>

        <!-- 阶段四：失败 -->
        <div v-else-if="stream.phase === 'error'" class="bt-stream-body">
          <p class="bt-stream-note">边播边下准备失败</p>
          <p class="bt-stream-sub">{{ stream.error }}</p>
          <div class="bt-stream-actions">
            <button class="bt-stream-stop-btn" @click="onStreamRetry">重试</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import PageHeader from '../components/Common/PageHeader.vue';

export default {
  name: 'BtHub',
  components: { PageHeader },
  data() {
    return {
      keyword: '',
      provider: 'all',
      providerOptions: [
        { key: 'all', label: '全部源' },
        { key: 'mikan', label: '蜜柑计划' },
        { key: 'dmhy', label: '动漫花园' }
      ],
      items: [],
      errors: [],
      loading: false,
      searched: false,
      addingLibrary: false,
      stream: {
        visible: false,
        phase: 'preparing',
        magnet: '',
        name: '',
        files: [],
        fileName: '',
        error: '',
        status: null
      },
      streamCache: null,
      streamCacheClearing: false,
      sampleKeywords: ['孤独摇滚', 'Fate', 'VCB-Studio', '葬送的芙莉莲']
    };
  },
  computed: {
    streamVideoFiles() {
      return this.stream.files.filter(file => file.isVideo);
    },
    streamProgressPercent() {
      const progress = Number(this.stream.status?.progress) || 0;
      return Math.min(100, Math.round(progress * 100));
    }
  },
  beforeUnmount() {
    this.stopStreamPolling();
  },
  methods: {
    async onSearch() {
      const query = this.keyword.trim();
      if (!query || this.loading) return;
      this.loading = true;
      this.searched = true;
      this.errors = [];
      try {
        const options = this.provider === 'all' ? {} : { providers: [this.provider] };
        const result = await window.electronAPI?.btSearch?.(query, options) || { items: [], errors: [] };
        this.items = Array.isArray(result.items) ? result.items : [];
        this.errors = Array.isArray(result.errors) ? result.errors : [];
      } catch (error) {
        this.items = [];
        this.errors = [{ provider: 'all', providerName: '搜索', message: error?.message || '搜索失败，请稍后再试' }];
      } finally {
        this.loading = false;
      }
    },
    onSwitchProvider(key) {
      if (this.provider === key) return;
      this.provider = key;
      if (this.searched && this.keyword.trim()) this.onSearch();
    },
    onClear() {
      this.keyword = '';
      this.items = [];
      this.errors = [];
      this.searched = false;
      this.$refs.searchInput?.focus();
    },
    onTrySample(sample) {
      this.keyword = sample;
      this.onSearch();
    },
    async onOpenMagnet(item) {
      const magnet = item?.magnet || '';
      if (!magnet) return;
      try {
        await window.electronAPI?.openExternal?.(magnet);
        this.$notify.success('已唤起 BT 客户端', '若未自动弹出，请先安装 qBittorrent / 迅雷等下载工具');
      } catch (error) {
        this.$notify.error('打开失败', error?.message || '可复制磁力链到下载工具中手动添加');
      }
    },
    async onAddLocalLibrary() {
      if (this.addingLibrary) return;
      this.addingLibrary = true;
      try {
        const result = await window.electronAPI?.mediaLibraryAddLocal?.();
        if (result?.canceled) return;
        if (result?.success) {
          this.$notify.success(
            '本地媒体库已添加',
            '下载完成后，打开对应番剧的详情页即可在播放源中看到本地文件（弹幕、超分等功能均可使用）'
          );
        } else {
          this.$notify.error('添加失败', result?.error || '请稍后再试');
        }
      } catch (error) {
        this.$notify.error('添加失败', error?.message || '请稍后再试');
      } finally {
        this.addingLibrary = false;
      }
    },
    formatBytes(value) {
      const bytes = Number(value) || 0;
      if (bytes < 1024) return `${bytes} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let size = bytes / 1024;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unit]}`;
    },
    async onStreamTorrent(item) {
      const magnet = item?.magnet || '';
      if (!magnet || (this.stream.visible && this.stream.phase === 'preparing')) return;
      this.stream = {
        visible: true,
        phase: 'preparing',
        magnet,
        name: item?.parsed?.title || item?.title || '',
        files: [],
        fileName: '',
        error: '',
        status: null
      };
      this.startStreamPolling();
      this.refreshStreamCache();
      const result = await window.electronAPI?.btStreamPrepare?.(magnet);
      if (!this.stream.visible || this.stream.magnet !== magnet) return;
      if (!result?.success) {
        this.stream.phase = 'error';
        this.stream.error = result?.error || '准备边播边下失败，请稍后再试';
        return;
      }
      this.stream.phase = 'files';
      this.stream.name = result.name || this.stream.name;
      this.stream.files = Array.isArray(result.files) ? result.files : [];
    },
    onStreamRetry() {
      this.onStreamTorrent({ magnet: this.stream.magnet, title: this.stream.name, parsed: null });
    },
    async onStreamPlay(file) {
      if (!file?.path) return;
      const result = await window.electronAPI?.btStreamOpen?.(this.stream.magnet, file.path);
      if (!result?.success) {
        this.$notify.error('打开失败', result?.error || '请稍后再试');
        return;
      }
      this.stream.phase = 'playing';
      this.stream.fileName = result.fileName || file.name;
      this.$notify.success('已开始边播边下', '首次播放需要缓冲几十秒，取决于当前下载速度');
      try {
        await window.electronAPI?.openPlayerWindow?.({
          title: `${this.stream.name} - ${result.fileName || file.name}`,
          url: result.url,
          anime: { name: this.stream.name || result.fileName || 'BT 资源', episodes: {} },
          episode: { title: result.fileName || file.name, url: result.url, id: file.path },
          episodeId: file.path,
          lineId: 'bt-stream'
        });
      } catch (error) {
        this.$notify.error('播放器打开失败', error?.message || '请稍后再试');
      }
    },
    onStreamClose() {
      // 还没开始播放就关闭：顺手把种子从客户端移除，避免空转占用连接
      if (this.stream.phase === 'preparing' || this.stream.phase === 'files') {
        const magnet = this.stream.magnet;
        if (magnet) window.electronAPI?.btStreamStop?.(magnet).catch(() => null);
      }
      this.stream.visible = false;
      this.stopStreamPolling();
    },
    async onStreamStop() {
      const magnet = this.stream.magnet;
      this.onStreamClose();
      await window.electronAPI?.btStreamStop?.(magnet).catch(() => null);
      this.$notify.success('已停止下载', '已下载的部分保留在缓存目录，下次启动时自动清理');
    },
    async refreshStreamCache() {
      try {
        const result = await window.electronAPI?.btStreamCacheInfo?.();
        if (result?.success) this.streamCache = result.info;
      } catch (_) {
        // 缓存信息获取失败不阻塞弹窗
      }
    },
    async onClearStreamCache() {
      if (this.streamCacheClearing) return;
      const confirmed = await this.$confirm({
        title: '清空边播边下缓存',
        message: '确定删除全部已缓存的视频和下载中的数据吗？正在播放的会话会被中断。此操作不可撤销。',
        confirmText: '清空',
        danger: true
      });
      if (!confirmed) return;
      this.streamCacheClearing = true;
      try {
        const result = await window.electronAPI?.btStreamClearCache?.();
        if (!result?.success) {
          this.$notify.error('清空失败', result?.error || '请稍后再试');
          return;
        }
        this.$notify.success('缓存已清空', '缓存目录已恢复初始状态');
        this.refreshStreamCache();
      } catch (error) {
        this.$notify.error('清空失败', error?.message || '请稍后再试');
      } finally {
        this.streamCacheClearing = false;
      }
    },
    startStreamPolling() {
      this.stopStreamPolling();
      this._streamPollTimer = setInterval(async () => {
        if (!this.stream.visible || !this.stream.magnet) return;
        try {
          const result = await window.electronAPI?.btStreamStatus?.(this.stream.magnet);
          if (result?.success && this.stream.visible) this.stream.status = result.status;
        } catch (_) {
          // 轮询失败静默忽略，下一秒重试
        }
      }, 1000);
    },
    stopStreamPolling() {
      if (this._streamPollTimer) {
        clearInterval(this._streamPollTimer);
        this._streamPollTimer = null;
      }
    },
    async onCopyMagnet(item) {
      const magnet = item?.magnet || '';
      if (!magnet) return;
      try {
        await navigator.clipboard.writeText(magnet);
        this.$notify.success('已复制磁力链', item.title);
      } catch (_) {
        // clipboard API 失败时退化到 execCommand
        const textarea = document.createElement('textarea');
        textarea.value = magnet;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          this.$notify.success('已复制磁力链', item.title);
        } catch (e) {
          this.$notify.error('复制失败', '请手动复制磁力链接');
        } finally {
          textarea.remove();
        }
      }
    }
  }
};
</script>

<style scoped>
.bt-hub {
  padding: 0 22px 30px;
  max-width: 1200px;
  margin: 0 auto;
}

/* ===== 搜索区 ===== */
.bt-search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 0 6px;
  flex-wrap: wrap;
}

.bt-search-input-wrap {
  position: relative;
  flex: 1;
  min-width: 260px;
  max-width: 520px;
  display: flex;
  align-items: center;
}

.bt-search-icon {
  position: absolute;
  left: 12px;
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.bt-search-input {
  width: 100%;
  height: 38px;
  padding: 0 32px 0 36px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.bt-search-input:focus {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.12);
}

.bt-clear-btn {
  position: absolute;
  right: 6px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: var(--bg-page);
  color: var(--text-tertiary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.16s ease;
}

.bt-clear-btn:hover {
  color: var(--text-primary);
}

.bt-provider-filter {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--bg-page);
  border: 1px solid var(--border-color);
}

.bt-provider-btn {
  padding: 5px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.16s ease, background-color 0.16s ease;
  white-space: nowrap;
}

.bt-provider-btn:hover {
  color: var(--text-primary);
}

.bt-provider-btn.active {
  background: var(--bg-card);
  color: var(--primary-color);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.bt-search-btn {
  height: 38px;
  padding: 0 22px;
  border: none;
  border-radius: 8px;
  background: var(--primary-color);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.16s ease, transform 0.16s var(--ease-smooth);
  white-space: nowrap;
}

.bt-search-btn:hover:not(:disabled) {
  opacity: 0.92;
  transform: translateY(-1px);
}

.bt-search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== 源错误 ===== */
.bt-errors {
  margin-top: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.08);
  border: 1px solid rgba(255, 107, 107, 0.25);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bt-error-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.bt-error-source {
  color: #ff6b6b;
  font-weight: 600;
  flex-shrink: 0;
}

.bt-error-tip {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 2px;
}

/* ===== 加载中 ===== */
.bt-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 60px 0;
}

.bt-loading-bubble {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.bt-loading-bubble i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--primary-color);
  animation: bt-dot-bounce 1.2s infinite ease-in-out;
}

.bt-loading-bubble i:nth-child(2) { animation-delay: 0.15s; }
.bt-loading-bubble i:nth-child(3) { animation-delay: 0.3s; }
.bt-loading-bubble i:nth-child(4) { animation-delay: 0.45s; }

@keyframes bt-dot-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
  40% { transform: translateY(-5px); opacity: 1; }
}

/* ===== 结果列表 ===== */
.bt-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}

.bt-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  transition: border-color 0.2s ease, transform 0.2s var(--ease-smooth), box-shadow 0.2s ease;
}

.bt-card:hover {
  border-color: rgba(var(--primary-rgb), 0.35);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
}

.bt-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bt-card-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.bt-group-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--primary-color);
  font-size: 11px;
  font-weight: 700;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-card-sub {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.bt-meta-chip {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-page);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 11px;
  white-space: nowrap;
}

.bt-meta-ep {
  background: rgba(var(--primary-rgb), 0.1);
  border-color: rgba(var(--primary-rgb), 0.25);
  color: var(--primary-color);
  font-weight: 600;
}

.bt-meta-res {
  color: var(--text-primary);
  font-weight: 600;
}

.bt-meta-special {
  background: rgba(255, 170, 60, 0.1);
  border-color: rgba(255, 170, 60, 0.3);
  color: #e6a23c;
  font-weight: 600;
}

.bt-meta-complete {
  background: rgba(103, 194, 58, 0.1);
  border-color: rgba(103, 194, 58, 0.3);
  color: #67c23a;
  font-weight: 600;
}

.bt-meta-uncensored {
  background: rgba(245, 108, 108, 0.1);
  border-color: rgba(245, 108, 108, 0.3);
  color: #f56c6c;
  font-weight: 600;
}

.bt-card-info {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.bt-info-provider {
  color: var(--text-secondary);
}

.bt-workflow-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 9px 14px;
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  border-radius: 8px;
  background: color-mix(in srgb, var(--primary-color) 6%, transparent);
  color: var(--text-secondary, #666);
  font-size: 12px;
  line-height: 1.5;
}

.bt-workflow-tip svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--primary-color);
}

.bt-workflow-text {
  flex: 1;
  min-width: 0;
}

.bt-add-library-btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  border-radius: 6px;
  background: transparent;
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.bt-add-library-btn:hover:not(:disabled) {
  background: var(--primary-color);
  color: #fff;
}

.bt-add-library-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ===== 边播边下弹窗 ===== */
.bt-stream-mask {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  padding: 20px;
  backdrop-filter: blur(2px);
}

.bt-stream-modal {
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.bt-stream-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--divider-color);
}

.bt-stream-head h3 {
  margin: 0;
  font-size: 16px;
  color: var(--text-primary);
}

.bt-stream-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
}

.bt-stream-close:hover {
  background: var(--primary-light);
  color: var(--text-primary);
}

.bt-stream-body {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.bt-stream-spinner {
  width: 26px;
  height: 26px;
  margin: 6px auto 2px;
  border: 3px solid rgba(var(--primary-rgb), 0.2);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: bt-stream-rotate 0.9s linear infinite;
}

@keyframes bt-stream-rotate {
  to {
    transform: rotate(360deg);
  }
}

.bt-stream-note {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-stream-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.bt-stream-cache-row {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 8px);
  background: rgba(127, 127, 127, 0.08);
}

.bt-stream-cache-text {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.bt-stream-cache-clear {
  flex-shrink: 0;
  padding: 4px 12px;
  border: none;
  border-radius: var(--radius-pill, 999px);
  background: rgba(240, 100, 141, 0.12);
  color: var(--primary-color, #f0648d);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.bt-stream-cache-clear:hover:not(:disabled) {
  background: rgba(240, 100, 141, 0.22);
}

.bt-stream-cache-clear:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.bt-stream-files {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}

.bt-stream-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--divider-color);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}

.bt-stream-file:hover {
  border-color: rgba(var(--primary-rgb), 0.5);
  background: color-mix(in srgb, var(--primary-color) 5%, transparent);
}

.bt-stream-file-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bt-stream-file-size {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.bt-stream-progress {
  height: 8px;
  border-radius: 4px;
  background: rgba(var(--primary-rgb), 0.12);
  overflow: hidden;
}

.bt-stream-progress-bar {
  width: 100%;
  height: 100%;
  border-radius: 4px;
  background: var(--primary-color);
  transform-origin: left center;
  transition: transform 0.6s var(--ease-smooth);
}

.bt-stream-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: 12px;
  color: var(--text-secondary);
}

.bt-stream-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.bt-stream-stop-btn {
  height: 30px;
  padding: 0 14px;
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  border-radius: 6px;
  background: transparent;
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.bt-stream-stop-btn:hover {
  background: var(--primary-color);
  color: #fff;
}

.bt-card-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.bt-open-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--primary-color);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.16s ease, box-shadow 0.16s ease;
}

.bt-open-btn:hover {
  box-shadow: 0 2px 10px rgba(var(--primary-rgb), 0.35);
}

.bt-copy-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid rgba(var(--primary-rgb), 0.4);
  border-radius: 6px;
  background: transparent;
  color: var(--primary-color);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.16s ease, color 0.16s ease, transform 0.16s var(--ease-smooth);
}

.bt-copy-btn:hover {
  background: var(--primary-color);
  color: #fff;
  transform: translateY(-1px);
}

/* ===== 空状态 ===== */
.bt-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 70px 0;
}

.bt-empty-icon {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-page);
  color: var(--text-tertiary);
}

.bt-empty-icon svg {
  width: 24px;
  height: 24px;
}

.bt-empty-title {
  margin: 6px 0 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.bt-empty-tip {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

/* ===== 初始引导 ===== */
.bt-intro {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 56px 20px 30px;
}

.bt-intro-hero {
  margin-bottom: 18px;
}

.bt-intro-magnet {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.16), rgba(var(--primary-rgb), 0.06));
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  color: var(--primary-color);
}

.bt-intro-magnet svg {
  width: 30px;
  height: 30px;
}

.bt-intro-title {
  margin: 0 0 10px;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
}

.bt-intro-desc {
  margin: 0 0 22px;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-secondary);
}

.bt-intro-samples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.bt-sample-chip {
  padding: 6px 16px;
  border-radius: 16px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.16s ease, color 0.16s ease, transform 0.16s var(--ease-smooth);
}

.bt-sample-chip:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
  transform: translateY(-1px);
}

@media (max-width: 760px) {
  .bt-card {
    flex-direction: column;
    align-items: stretch;
  }

  .bt-card-actions {
    display: flex;
    justify-content: flex-end;
  }

  .bt-copy-btn {
    flex: 0 0 auto;
  }
}
</style>
