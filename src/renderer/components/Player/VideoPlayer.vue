<template>
  <div
    class="video-player-container"
    :class="{ 'controls-idle': !controlsVisible && isPlaying && !loading && !error && !buffering }"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
    @click="onContainerClick"
  >
    <!-- 初始加载状态（全黑+spinner） -->
    <div v-if="loading" class="video-overlay video-loading">
      <div class="player-loading-mascot" aria-hidden="true"></div>
      <p class="loading-text">
        {{ startupBuffering ? `正在预缓冲 · ${bufferAheadSeconds.toFixed(1)} 秒` : '樱月正在准备播放' }}
      </p>
    </div>

    <!-- 缓冲中状态（保留最后一帧画面，叠加半透明spinner） -->
    <div v-if="buffering && !loading" class="video-overlay video-buffering">
      <div class="loading-spinner"></div>
      <p class="buffering-text">{{ smoothRebuffering ? `正在蓄满缓冲 · ${bufferAheadSeconds.toFixed(1)} 秒` : '缓冲中' }}</p>
    </div>

    <transition name="fade">
      <div v-if="adSkipNotice" class="ad-skip-notice">{{ adSkipNotice }}</div>
    </transition>

    <transition name="fade">
      <div v-if="danmakuNotice" class="danmaku-notice" :class="`is-${danmakuNoticeTone}`">
        {{ danmakuNotice }}
      </div>
    </transition>

    <!-- 自动恢复/换源中 -->
    <div v-if="autoRecovering && !loading" class="video-overlay video-recovering">
      <div class="player-loading-mascot" aria-hidden="true"></div>
      <p class="recovering-title">{{ recoveryMessage || '正在自动切换可用源...' }}</p>
      <p v-if="lastPlaybackFailure" class="recovering-detail">
        {{ formatFailureForDisplay(lastPlaybackFailure) }}
      </p>
    </div>

    <!-- 错误状态 -->
    <div v-if="error && !autoRecovering" class="video-overlay video-error">
      <div class="error-category-badge" :class="`badge-${classifiedFailure.category}`">
        <span class="badge-icon">{{ errorCategoryIcon }}</span>
        <span class="badge-label">{{ classifiedFailure.title || '播放失败' }}</span>
      </div>
      <p class="error-text">{{ error }}</p>
      <p v-if="classifiedFailure.description" class="error-description">
        {{ classifiedFailure.description }}
      </p>
      <p v-if="lastPlaybackFailure" class="error-diagnostic">
        诊断：{{ formatFailureForDisplay(lastPlaybackFailure) }}
      </p>
      <p v-if="classifiedFailure.suggestion" class="error-suggestion">
        💡 {{ classifiedFailure.suggestion }}
      </p>
      <div class="error-actions">
        <button v-if="classifiedFailure.primaryAction === 'retry'" @click="retry" class="retry-btn">{{ errorPrimaryActionLabel }}</button>
        <button v-if="classifiedFailure.primaryAction === 'switch-source' && currentVideo?.anime?.name" @click="switchToSameEpisode" class="retry-btn">{{ errorPrimaryActionLabel }}</button>
        <button v-if="classifiedFailure.primaryAction === 'enhanced-player' && currentVideo?.url" @click="$emit('open-enhanced-player', enhancedPlayerPayload)" class="retry-btn">{{ errorPrimaryActionLabel }}</button>
        <button v-if="classifiedFailure.primaryAction === 'open-settings'" @click="$emit('open-settings')" class="retry-btn">{{ errorPrimaryActionLabel }}</button>

        <button v-if="classifiedFailure.secondaryAction === 'retry'" @click="retry" class="fallback-btn">重试</button>
        <button v-if="classifiedFailure.secondaryAction === 'switch-source' && currentVideo?.anime?.name" @click="switchToSameEpisode" class="fallback-btn">换源同集</button>
        <button v-if="classifiedFailure.secondaryAction === 'enhanced-player' && currentVideo?.url" @click="$emit('open-enhanced-player', enhancedPlayerPayload)" class="fallback-btn">增强播放</button>
        <button v-if="classifiedFailure.secondaryAction === 'open-settings'" @click="$emit('open-settings')" class="fallback-btn">网络设置</button>
      </div>
    </div>

    <button v-if="!loading && !error && currentVideo?.anime?.name && controlsVisible" class="source-switch-btn" title="换源同集" @click.stop="switchToSameEpisode">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/><path d="M18 7l-5 5"/><path d="M6 17l5-5"/>
      </svg>
      <span>换源</span>
    </button>

    <div v-show="!loading && !error && !autoRecovering && controlsVisible && (currentSourceLabel || playbackStatsLabel || anime4kRuntime.presenting)" class="source-status-pill">
      <span v-if="currentSourceLabel">{{ currentSourceLabel }}</span>
      <span v-if="currentSourceQualityLabel && !playbackStatsLabel">{{ currentSourceQualityLabel }}</span>
      <span v-if="playbackStatsLabel" class="playback-stats" :title="playbackStatsTitle">{{ playbackStatsLabel }}</span>
      <span v-if="anime4kRuntime.presenting" :title="anime4kRuntimeTitle">
        {{ anime4kRuntime.degraded ? '显示增强' : `A4K · ${anime4kPresetLabel}` }}
      </span>
    </div>

    <div v-if="sourcePanelVisible" class="video-overlay source-panel-overlay" @click.self="closeSourcePanel">
      <div class="source-panel">
        <div class="source-panel-header">
          <div>
            <h3>换源播放</h3>
            <p>{{ currentVideo?.episode?.title || currentVideo?.anime?.name || '当前视频' }}</p>
          </div>
          <button class="source-panel-close" @click="closeSourcePanel" title="关闭">×</button>
        </div>

        <div v-if="sourcePanelLoading" class="source-panel-state">
          <div class="loading-spinner small"></div>
          <span>正在测速...</span>
        </div>
        <div v-else-if="sourcePanelError" class="source-panel-state error">
          {{ sourcePanelError }}
        </div>
        <div v-else-if="sourceCandidates.length === 0" class="source-panel-state">
          未找到可用候选源
        </div>
        <div v-else class="source-candidate-list">
          <button v-for="candidate in sourceCandidates" :key="`${candidate.sourceId}-${candidate.url}`" class="source-candidate" @click="playSourceCandidate(candidate)">
            <span class="candidate-main">
              <span class="candidate-source">{{ candidate.sourceName || candidate.sourceId }}</span>
              <span class="candidate-episode">{{ candidate.episodeTitle || candidate.episode?.title }}</span>
            </span>
            <span class="candidate-meta">
              <span class="candidate-chip quality">{{ formatCandidateQuality(candidate) }}</span>
              <span class="candidate-chip" :class="candidateHealthClass(candidate)">健康 {{ candidate.healthScore ?? '--' }}</span>
              <span v-if="candidate.health?.playbackSessionCount" class="candidate-chip" :title="candidateHealthTitle(candidate)">首帧 {{ formatCandidateStartup(candidate) }}</span>
              <span v-if="candidate.health?.playbackSessionCount" class="candidate-chip" :class="candidateStallClass(candidate)">卡顿 {{ formatCandidateRatio(candidate.health.averageStallRatio) }}</span>
              <span v-if="candidate.health?.advertisingReportCount" class="candidate-chip issue-ad">广告反馈 {{ candidate.health.advertisingReportCount }}</span>
              <span class="candidate-chip">{{ formatMatchType(candidate.matchType) }}</span>
            </span>
          </button>
        </div>

        <div v-if="sourceSkipped.length > 0" class="source-skipped">
          已跳过 {{ sourceSkipped.length }} 个冷却源
        </div>
      </div>
    </div>

    <!-- 中央播放/暂停大按钮 -->
    <transition name="fade">
      <div v-if="showCenterPlay && !isPlaying && !loading && !buffering && !error" class="center-play-btn" @click="togglePlay">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="white">
          <path d="M8 5v14l11-7z"/>
        </svg>
      </div>
    </transition>

    <!-- 字幕在线搜索面板 -->
    <div v-if="subtitleSearchVisible" class="video-overlay subtitle-search-overlay" @click.self="closeSubtitleSearchPanel">
      <div class="subtitle-search-panel">
        <div class="subtitle-search-header">
          <div>
            <h3>在线搜索字幕</h3>
            <p>{{ danmakuAnimeName || '当前视频' }}</p>
          </div>
          <button class="subtitle-search-close" @click="closeSubtitleSearchPanel" title="关闭">×</button>
        </div>

        <div v-if="subtitleSearchLoading" class="subtitle-search-state">
          <div class="loading-spinner small"></div>
          <span>正在搜索字幕...</span>
        </div>
        <div v-else-if="subtitleSearchError" class="subtitle-search-state error">
          {{ subtitleSearchError }}
        </div>
        <div v-else-if="subtitleSearchResults.length === 0" class="subtitle-search-state">
          未找到匹配的字幕
        </div>
        <div v-else class="subtitle-search-list">
          <button
            v-for="item in subtitleSearchResults"
            :key="item.id || item.fileId"
            class="subtitle-search-item"
            @click="applyOnlineSubtitle(item)"
          >
            <span class="subtitle-item-main">
              <span class="subtitle-item-title">{{ item.title || item.releaseName || '未命名' }}</span>
              <span class="subtitle-item-lang">{{ item.language || '' }}</span>
            </span>
            <span class="subtitle-item-meta">
              <span v-if="item.fromEpisode" class="subtitle-item-chip">第 {{ item.fromEpisode }} 集</span>
              <span v-if="item.rating" class="subtitle-item-chip">评分 {{ item.rating }}</span>
              <span v-if="item.downloadCount" class="subtitle-item-chip">{{ item.downloadCount }} 次下载</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 暂停/播放时的闪烁反馈 -->
    <transition name="fade">
      <div v-if="showPlayFeedback" class="play-feedback">
        <svg v-if="isPlaying" width="40" height="40" viewBox="0 0 24 24" fill="white" opacity="0.8">
          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
        </svg>
        <svg v-else width="40" height="40" viewBox="0 0 24 24" fill="white" opacity="0.8">
          <path d="M8 5v14l11-7z"/>
        </svg>
      </div>
    </transition>

    <!-- 快进/快退/音量/静音 OSD 反馈（控制栏隐藏时也有可见反馈） -->
    <div v-if="osdLabel" :key="osdKey" class="player-osd" aria-hidden="true">
      <svg v-if="osdIcon === 'forward'" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      <svg v-else-if="osdIcon === 'backward'" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 1 10 7 10"/>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
      </svg>
      <svg v-else-if="osdIcon === 'volume'" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path v-if="osdLevel === 2" d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
      <svg v-else-if="osdIcon === 'mute'" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <line x1="23" y1="9" x2="17" y2="15"/>
        <line x1="17" y1="9" x2="23" y2="15"/>
      </svg>
      <span class="osd-label">{{ osdLabel }}</span>
    </div>

    <!-- DLNA 投屏对话框 -->
    <CastDialog
      v-if="castDialogVisible"
      :video="currentVideo"
      :seek-step-seconds="seekStepSeconds"
      @close="castDialogVisible = false"
      @cast-start="onCastStart"
      @cast-stop="onCastStop"
    />

    <!-- 视频元素：不使用原生 controls -->
    <video ref="videoElement"
      class="video-element"
      :style="{ visibility: loading || error ? 'hidden' : 'visible' }"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @ended="onVideoEnded"
      @waiting="onWaiting"
      @canplay="onCanPlay"
      @error="onVideoError"
      @progress="onProgress"
      @play="onPlay"
      @pause="onPause"
      @seeked="onSeeked"
      preload="metadata">
      您的浏览器不支持视频播放
    </video>

    <Anime4KCanvas :enabled="anime4kEnabled" :preset="anime4kPreset" :source-key="currentVideo?.url || ''"
      @status-change="onAnime4kStatusChange" @auto-disabled="onAnime4kAutoDisabled" />

    <!-- 弹幕层 -->
    <DanmakuLayer
      v-if="showDanmakuLayer"
      ref="danmakuLayer"
      :enabled="danmakuEnabled"
      :current-time="currentTime"
      :is-playing="isPlaying"
      :anime-name="danmakuAnimeName"
      :episode-number="danmakuEpisodeNumber"
      :font-size="danmakuFontSize"
      :opacity="danmakuOpacity"
      :speed="danmakuSpeed"
      :display-area-ratio="danmakuDisplayAreaRatio"
      @loaded="onDanmakuLoaded"
      @error="onDanmakuError"
      @status="onDanmakuStatus"
    />

    <!-- 字幕层 -->
    <SubtitleLayer
      v-if="showSubtitleLayer"
      ref="subtitleLayer"
      :cues="subtitleCues"
      :current-time="currentTime"
      :font-size="subtitleFontSize"
      :opacity="subtitleOpacity"
      :bottom-offset="subtitleBottomOffset"
      :visible="showSubtitle"
    />

    <!-- 自定义控制栏 -->
    <ControlBar
      v-if="!loading && !error"
      ref="controlBar"
      :is-playing="isPlaying"
      :current-time="currentTime"
      :duration="duration"
      :volume="volume"
      :is-fullscreen="isFullscreen"
      :playback-rate="playbackRate"
      :seek-step-seconds="seekStepSeconds"
      :buffer-progress="bufferProgress"
      :visible="controlsVisible"
      :quality-levels="qualityLevels"
      :current-quality="currentQuality"
      :has-episodes="hasEpisodes"
      :has-next="hasNextEpisode"
      :danmaku-enabled="danmakuEnabled"
      :danmaku-active="danmakuActive"
      :danmaku-pending="danmakuPending"
      :subtitle-enabled="showSubtitle"
      :casting="casting"
      :watch-together-active="watchTogetherActive"
      :auto-play="autoPlay"
      :remember-playback-rate="rememberPlaybackRate"
      :danmaku-font-size="danmakuFontSize"
      :subtitle-font-size="subtitleFontSize"
      :ad-reported="currentSourceAdReported"
      :auto-skip-marked-ads="autoSkipMarkedAds"
      :smooth-streaming="smoothStreaming"
      :anime4k-enabled="anime4kEnabled"
      :anime4k-active="anime4kRuntime.presenting && !anime4kRuntime.degraded"
      :anime4k-degraded="anime4kRuntime.presenting && anime4kRuntime.degraded"
      :anime4k-preset="anime4kPreset"
      :ad-ranges="detectedAdRanges"
      :is-muted="videoMuted"
      @controls-hover="onControlsHover"
      @toggle-play="togglePlay"
      @seek="handleSeek"
      @seek-relative="seekRelative"
      @volume-change="handleVolumeChange"
      @toggle-mute="toggleMute"
      @fullscreen-toggle="toggleFullscreen"
      @playback-rate-change="handlePlaybackRateChange"
      @quality-change="handleQualityChange"
      @picture-in-picture-toggle="togglePictureInPicture"
      @next-episode="$emit('next-episode')"
      @toggle-danmaku="toggleDanmaku"
      @danmaku-import-xml="onDanmakuImportXml"
      @open-settings="$emit('open-settings')"
      @toggle-subtitle="toggleSubtitle"
      @subtitle-load-file="loadSubtitleFile"
      @subtitle-search="onSubtitleSearch"
      @cast-toggle="onCastToggle"
      @watch-together-toggle="onWatchTogetherToggle"
      @seek-step-change="updateSeekStepSeconds"
      @auto-play-change="updateAutoPlay"
      @remember-rate-change="updateRememberPlaybackRate"
      @danmaku-font-size-change="updateDanmakuFontSize"
      @subtitle-font-size-change="updateSubtitleFontSize"
      @skip-ad="skipSuspectedAd"
      @report-ad-and-switch="reportAdAndSwitchSource"
      @auto-skip-marked-ads-change="setAutoSkipMarkedAds"
      @anime4k-change="setAnime4kEnabled"
      @anime4k-preset-change="setAnime4kPreset"
      @smooth-streaming-change="setSmoothStreaming"
    />

    <!-- 一起看面板 -->
    <WatchTogetherPanel
      v-if="watchTogetherPanelVisible"
      :video-info="wtVideoInfoForRoom"
      @close="watchTogetherPanelVisible = false"
      @room-changed="onWtRoomChanged"
    />
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import ControlBar from './ControlBar.vue';
import DanmakuLayer from './DanmakuLayer.vue';
import SubtitleLayer from './SubtitleLayer.vue';
import Anime4KCanvas from './Anime4KCanvas.vue';
import WatchTogetherPanel from './WatchTogetherPanel.vue';
import CastDialog from './CastDialog.vue';
import {
  describeNativeVideoError,
  formatPlaybackFailureForDisplay,
  classifyPlaybackFailure,
  classifyHlsFailure
} from '../../utils/playbackDiagnostics.js';
import {
  estimateSourceFrameRate,
  formatSourceFrameRate,
  normalizeDeclaredFrameRate
} from '../../utils/playbackFrameRate.js';
import { collectHlsAdRanges, findActiveAdRange } from '../../utils/hlsAdMarkers.js';
import { toIpcPlainObject } from '../../utils/ipcPayload.js';
import { extractEpisodeNumber } from '../../utils/episodeList.js';
import { formatCandidateQuality, formatMatchType, candidateHealthClass, candidateStallClass,
  formatCandidateStartup, formatCandidateRatio, candidateHealthTitle } from '../../utils/sourceCandidatePresentation.js';
import { formatAnime4kPreset, formatAnime4kRuntimeTitle } from '../../utils/anime4kPresentation.js';
import { applyRuntimeHlsBufferPolicy, toHlsBufferConfig } from '../../utils/hlsBufferPolicy.js';

let hlsClassPromise = null;

function loadHlsClass() {
  if (!hlsClassPromise) {
    hlsClassPromise = import('hls.js')
      .then(module => module.default || module)
      .catch(error => {
        hlsClassPromise = null;
        throw error;
      });
  }
  return hlsClassPromise;
}

export default {
  name: 'VideoPlayer',
  components: { ControlBar, DanmakuLayer, SubtitleLayer, Anime4KCanvas, CastDialog, WatchTogetherPanel },
  emits: ['video-ended', 'next-episode', 'open-enhanced-player', 'open-settings'],
  props: {
    // 是否有剧集列表（控制下一集按钮显隐），由父视图传入
    hasEpisodes: {
      type: Boolean,
      default: false
    },
    hasNextEpisode: {
      type: Boolean,
      default: false
    }
  },
  data() {
    return {
      loading: false,
      buffering: false, // 缓冲中（保留最后一帧画面）
      startupBuffering: false,
      smoothRebuffering: false,
      bufferAheadSeconds: 0,
      smoothStreaming: localStorage.getItem('player-smooth-streaming') !== 'false',
      error: null,
      hls: null,
      hlsStreamLive: false,
      hlsCurrentBitrate: 0,
      hlsBufferPolicy: null,
      isUpdatingTime: false,
      isUpdatingDuration: false,
      bufferProgress: 0,
      showCenterPlay: true,
      showPlayFeedback: false,
      playFeedbackTimer: null,
      // 静音单一真源的响应式镜像（真实状态在 video.muted）
      videoMuted: false,
      // 快进/快退/音量 OSD 反馈
      osdIcon: null,
      osdLabel: '',
      osdLevel: 1,
      osdKey: 0,
      hideControlsTimer: null,
      controlsVisible: true,
      controlsHovered: false,
      playbackWidth: 0,
      playbackHeight: 0,
      sourceFrameRate: 0,
      sourceFrameRateOrigin: '',
      playbackDecodedFps: 0,
      playbackTotalFrames: 0,
      playbackDroppedFrames: 0,
      frameRateSamples: [],
      progressSaveTimer: null,
      hlsErrorCount: 0,
      hlsRecoveryWatchdog: null,
      maxHlsRecoveryAttempts: 3,
      maxFallbackSourceAttempts: 3,
      triedFallbackSourceIds: [],
      fallbackRequestToken: 0,
      autoRecovering: false,
      recoveryMessage: '',
      lastPlaybackFailure: null,
      lastAutoFallbackCandidate: null,
      preserveFallbackSourceIdsOnce: false,
      reportedPlaybackSuccessKey: '',
      reportedPlaybackFailureKey: '',
      reportedAdvertisingKeys: [],
      mediaLoadGeneration: 0,
      playbackIntent: false,
      suppressPauseEventsUntil: 0,
      unexpectedPauseRecoveryTimer: null,
      pendingResumeTime: 0,
      playbackSession: null,
      detectedAdRanges: [],
      autoSkippedAdRangeIds: [],
      autoSkipMarkedAds: localStorage.getItem('player-auto-skip-marked-ads') === 'true',
      anime4kEnabled: localStorage.getItem('player-anime4k') === 'true',
      anime4kPreset: localStorage.getItem('player-anime4k-preset') || 'balanced',
      anime4kRuntime: { active: false, presenting: false },
      adSkipNotice: '',
      danmakuNotice: '',
      danmakuNoticeTone: 'info',
      danmakuNoticeTimer: null,
      danmakuRuntimeState: 'idle',
      sourcePanelVisible: false,
      sourcePanelLoading: false,
      sourcePanelError: '',
      sourcePanelRequestToken: 0,
      sourceCandidates: [],
      sourceSkipped: [],
      qualityLevels: [], // hls.js 可用画质列表
      currentQuality: -1, // -1=自动, 0..n=指定画质索引
      _timeUpdateFrame: null,
      _lastCommittedTime: 0,
      _lastDurationCommit: 0,
      _lastBufferProgress: 0,
      _lastMouseMoveAt: 0,
      _volumeSaveTimer: null,
      // ===== Phase 5: 播放状态机 =====
      // 取值：idle | resolving | resolved | loading | playing | recovering | failed
      playbackState: 'idle',
      // 解析请求 token：每次切集/换源递增，旧 token 的返回结果被丢弃
      resolveRequestToken: 0,
      // 当前 ResolvedVideo（含 headers/referer/UA）
      resolvedVideo: null,
      // 当前正在播放视频的快照（anime/episode/url）
      // 用于切换集数时保存"旧视频"的进度，避免 Vuex state 已更新为新视频导致进度写错
      playedSnapshot: null,
      // 跟踪所有 setTimeout，组件卸载时统一清理，防止 Hls 在卸载后被创建导致泄漏
      pendingTimers: [],
      // ===== 字幕相关 =====
      // 字幕 cue 数组：[{ start, end, text }]
      subtitleCues: [],
      // 字幕开关（受设置和是否有字幕双重控制）
      showSubtitle: false,
      // 字幕搜索面板显示
      subtitleSearchVisible: false,
      subtitleSearchLoading: false,
      subtitleSearchResults: [],
      subtitleSearchError: '',
      // ===== 投屏相关 =====
      // 投屏对话框是否可见
      castDialogVisible: false,
      // 是否正在投屏（用于 ControlBar 按钮高亮）
      casting: false,
      // ===== 一起看（同步播放）相关 =====
      // 一起看面板是否可见
      watchTogetherPanelVisible: false,
      // 当前是否在房间中（用于 ControlBar 按钮高亮）
      watchTogetherActive: false,
      // 房间信息（含 isHost 字段，决定本机是主机还是成员）
      wtRoomInfo: { isHost: false, roomCode: null },
      // 主机周期广播状态的定时器
      wtHostBroadcastTimer: null,
      // 成员同步节流：上次 seek 时间，避免频繁 seek 卡顿
      wtLastSeekAt: 0,
      // 成员正在应用主机同步状态时，本地播放事件不应再触发广播
      wtApplyingRemoteState: false,
      // 主进程消息订阅取消函数
      wtUnsubscribe: null
    };
  },
  computed: {
    ...mapGetters('player', ['currentVideo', 'isPlaying', 'isFullscreen', 'currentTime', 'duration', 'volume', 'playbackRate']),
    ...mapGetters('settings', [
      'autoPlay', 'rememberPlaybackRate', 'videoQuality', 'seekStepSeconds',
      // 弹幕设置
      'enableDanmaku', 'danmakuFontSize', 'danmakuOpacity', 'danmakuSpeed', 'danmakuDisplayArea',
      // 字幕设置
      'enableSubtitle', 'subtitleFontSize', 'subtitleOpacity', 'subtitleBottomOffset', 'openSubtitlesApiKey'
    ]),
    // 弹幕开关：受设置和当前视频是否有番剧名双重控制
    danmakuEnabled() {
      return this.enableDanmaku && !!this.danmakuAnimeName;
    },
    danmakuActive() {
      return this.danmakuEnabled && this.danmakuRuntimeState === 'active';
    },
    danmakuPending() {
      return this.danmakuEnabled && ['idle', 'loading'].includes(this.danmakuRuntimeState);
    },
    // 是否渲染弹幕层组件（仅当启用弹幕时才挂载，节省资源）
    showDanmakuLayer() {
      return this.enableDanmaku && !this.loading && !this.error;
    },
    // 当前播放番剧名（用于 dandanplay 搜索）
    danmakuAnimeName() {
      return this.currentVideo?.anime?.name || '';
    },
    danmakuEpisodeNumber() {
      const episode = this.currentVideo?.episode;
      const parsed = extractEpisodeNumber(episode);
      if (parsed > 0) return parsed;
      const index = Number(episode?.index);
      return Number.isInteger(index) && index >= 0 ? index + 1 : 0;
    },
    // display-area-ratio prop 对应 store 的 danmakuDisplayArea
    danmakuDisplayAreaRatio() { return this.danmakuDisplayArea; },
    // 是否渲染字幕层组件（仅在已加载字幕且视频就绪时挂载）
    showSubtitleLayer() {
      return !this.loading && !this.error;
    },
    currentSourceLabel() {
      return this.currentVideo?.anime?.sourceName ||
        this.currentVideo?.sourceName ||
        this.currentVideo?.anime?.source ||
        this.currentVideo?.sourceId ||
        '';
    },
    currentSourceQualityLabel() {
      const snapshot = this.getCurrentQualitySnapshot();
      if (snapshot?.height) return `${snapshot.height}p`;
      if (snapshot?.bitrate) return `${Math.round(snapshot.bitrate / 1000)}kbps`;
      return '';
    },
    playbackStatsLabel() {
      if (!this.playbackWidth || !this.playbackHeight) return '';
      const resolution = `${this.playbackWidth}×${this.playbackHeight}`;
      const frameRate = formatSourceFrameRate(this.sourceFrameRate);
      return frameRate ? `${resolution} · ${frameRate} FPS` : resolution;
    },
    playbackStatsTitle() {
      const details = [];
      if (this.sourceFrameRate > 0) {
        const origin = this.sourceFrameRateOrigin === 'manifest' ? '清单声明' : '稳定估算';
        details.push(`片源帧率：${formatSourceFrameRate(this.sourceFrameRate)} FPS（${origin}）`);
      }
      if (this.playbackDecodedFps > 0) {
        details.push(`实时解码：${this.playbackDecodedFps.toFixed(1)} FPS`);
      }
      if (this.playbackTotalFrames > 0) {
        const droppedPercent = this.playbackDroppedFrames / this.playbackTotalFrames * 100;
        details.push(`丢帧：${this.playbackDroppedFrames}（${droppedPercent.toFixed(2)}%）`);
      }
      return details.join(' · ') || '实际解码尺寸';
    },
    anime4kPresetLabel() {
      return formatAnime4kPreset(this.anime4kRuntime.preset || this.anime4kPreset);
    },
    anime4kRuntimeTitle() {
      return formatAnime4kRuntimeTitle(this.anime4kRuntime, this.anime4kPreset);
    },
    currentAdvertisingKey() {
      const sourceId = this.getCurrentSourceId();
      const animeId = this.currentVideo?.anime?.id || this.currentVideo?.anime?.anime_id || '';
      const episodeId = this.currentVideo?.episode?.id || this.currentVideo?.episodeId || this.currentVideo?.url || '';
      return sourceId && episodeId ? `${sourceId}|${animeId}|${episodeId}` : '';
    },
    currentSourceAdReported() {
      return !!this.currentAdvertisingKey && this.reportedAdvertisingKeys.includes(this.currentAdvertisingKey);
    },
    // 创建房间时传递给 WatchTogetherPanel 的当前视频信息
    wtVideoInfoForRoom() {
      const v = this.currentVideo;
      if (!v) return null;
      return {
        title: v.title || '',
        url: v.url || '',
        animeName: v.anime?.name || '',
        episodeTitle: v.episode?.title || '',
        episodeIndex: v.episode?.index ?? -1
      };
    },
    // ===== Phase 5: 失败分类 =====
    classifiedFailure() {
      return classifyPlaybackFailure(this.lastPlaybackFailure);
    },
    errorCategoryIcon() {
      const icons = {
        'invalid-source': '⚠',
        'network-blocked': '📡',
        'cors-referer': '🔒',
        'hls-decode': '🎬',
        'format-unsupported': '🎞',
        'resolver-timeout': '⏱',
        'cancelled': '↻',
        'unknown': '❓'
      };
      return icons[this.classifiedFailure.category] || '❓';
    },
    errorPrimaryActionLabel() {
      const labels = {
        'switch-source': '一键换源同集',
        'enhanced-player': '增强播放（mpv）',
        'open-settings': '打开网络设置',
        'retry': '重试'
      };
      return labels[this.classifiedFailure.primaryAction] || '重试';
    },
    // Phase 6: 传递给 mpv 增强播放的 payload（url + 起始进度 + headers）
    enhancedPlayerPayload() {
      return {
        url: this.currentVideo?.url || '',
        startPosition: this.currentTime || 0,
        headers: this.resolvedVideo?.headers || null
      };
    }
  },
  methods: {
    formatCandidateQuality,
    formatMatchType,
    candidateHealthClass,
    candidateStallClass,
    formatCandidateStartup,
    formatCandidateRatio,
    candidateHealthTitle,
    ...mapActions('player', [
      'playVideo',
      'setPlaying',
      'setCurrentTime',
      'setDuration',
      'setVolume',
      'setFullscreen',
      'setPlaybackRate',
      'stopVideo'
    ]),
    ...mapActions('settings', [
      'updateAutoPlay',
      'updateRememberPlaybackRate',
      'updateSeekStepSeconds',
      'updateDanmakuFontSize',
      'updateSubtitleFontSize'
    ]),

    scheduleVideoInitialization(delay = 120) {
      this.clearTrackedTimers();
      const generation = ++this.mediaLoadGeneration;
      this.forceStopAndClean('source-change');
      this.playbackIntent = true;
      this.trackTimer(setTimeout(() => this.initializeVideo(generation), delay));
    },

    initializeVideo(generation = this.mediaLoadGeneration) {
      const video = this.$refs.videoElement;
      const videoData = this.currentVideo;

      if (generation !== this.mediaLoadGeneration) return;
      if (!video || !videoData || !videoData.url) {
        this.loading = false;
        this.setPlaybackState('idle');
        return;
      }

      // 记录当前正在播放的视频快照，供切换集数时保存旧进度使用
      this.playedSnapshot = {
        anime: videoData.anime,
        episode: videoData.episode,
        url: videoData.url
      };
      this.resolvedVideo = videoData.resolvedVideo || null;

      const url = videoData.url;
      this.beginPlaybackSession(generation, url);
      // 进入 loading 状态：URL 已就绪，开始加载视频
      this.setPlaybackState('loading');

      this.trackTimer(setTimeout(() => {
        if (generation !== this.mediaLoadGeneration || this.currentVideo?.url !== url) return;
        if (this.isHLSStream(url)) {
          this.initHLSPlayer(url, generation);
        } else {
          this.initNativePlayer(url, generation);
        }
      }, 80));
    },

    /**
     * Phase 5: 统一播放状态机入口
     * 状态：idle | resolving | resolved | loading | playing | recovering | failed
     * - idle: 无视频
     * - resolving: 正在调用 PlaybackResolverService 解析 URL（由 PlayerWindow 触发）
     * - resolved: URL 已解析完成，等待 initializeVideo 加载
     * - loading: 视频正在加载（hls.js / native 正在拉流）
     * - playing: 视频已就绪，可播放
     * - recovering: 自动换源中
     * - failed: 播放失败，需要用户介入
     */
    setPlaybackState(state) {
      this.playbackState = state;
      // 同步 legacy 标志位，保持向后兼容
      switch (state) {
        case 'idle':
          this.loading = false;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'resolving':
          this.loading = true;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'resolved':
          // resolved 状态极短，立即进入 loading
          this.loading = true;
          break;
        case 'loading':
          this.loading = true;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'playing':
          this.loading = false;
          this.error = null;
          this.autoRecovering = false;
          break;
        case 'recovering':
          this.autoRecovering = true;
          this.error = null;
          this.loading = false;
          break;
        case 'failed':
          this.loading = false;
          this.autoRecovering = false;
          break;
        default:
          break;
      }
    },

    forceStopAndClean(reason = 'cleanup') {
      this.finalizePlaybackSession(reason);
      this.stopPlaybackStats(true);
      this.clearHlsRecoveryWatchdog();
      if (this.unexpectedPauseRecoveryTimer) {
        clearTimeout(this.unexpectedPauseRecoveryTimer);
        this.unexpectedPauseRecoveryTimer = null;
      }
      if (this._timeUpdateFrame) {
        cancelAnimationFrame(this._timeUpdateFrame);
        this._timeUpdateFrame = null;
      }
      const video = this.$refs.videoElement;
      if (video) {
        this.playbackIntent = false;
        this.suppressPauseEventsUntil = performance.now() + 700;
        video.pause();
        video.currentTime = 0;
        video.removeAttribute('src');
        video.load();
        // 清理未触发的 canplay 监听器
        if (this._nativeCanPlayHandler) {
          video.removeEventListener('canplay', this._nativeCanPlayHandler);
          this._nativeCanPlayHandler = null;
        }
      }
      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      this.loading = true;
      this.buffering = false;
      this.startupBuffering = false;
      this.smoothRebuffering = false;
      this.bufferAheadSeconds = 0;
      this.error = null;
      this.autoRecovering = false;
      this.recoveryMessage = '';
      this.lastPlaybackFailure = null;
      this.lastAutoFallbackCandidate = null;
      this.hlsErrorCount = 0;
      if (this.preserveFallbackSourceIdsOnce) {
        this.preserveFallbackSourceIdsOnce = false;
      } else {
        this.triedFallbackSourceIds = [];
        this.fallbackRequestToken += 1;
      }
      this.reportedPlaybackSuccessKey = '';
      this.reportedPlaybackFailureKey = '';
      this.detectedAdRanges = [];
      this.autoSkippedAdRangeIds = [];
      this.qualityLevels = [];
      this.currentQuality = -1;
      this.hlsStreamLive = false;
      this.hlsCurrentBitrate = 0;
      this.hlsBufferPolicy = null;
      this._lastCommittedTime = 0;
      this._lastDurationCommit = 0;
      this._lastBufferProgress = 0;
      // 切换视频时重置缓冲进度，避免显示上一集的缓冲条
      this.bufferProgress = 0;
    },

    isHLSStream(url) {
      return url.includes('.m3u8') || url.toLowerCase().includes('hls');
    },

    applyHlsBufferPolicy(overrides = {}) {
      return applyRuntimeHlsBufferPolicy(this, overrides);
    },

    async initHLSPlayer(url, generation = this.mediaLoadGeneration) {
      const video = this.$refs.videoElement;

      if (video?.canPlayType('application/vnd.apple.mpegurl')) {
        if (generation !== this.mediaLoadGeneration) return;
        video.src = url;
        this.startBufferedPlayback(generation, 'native-hls');
        return;
      }

      let Hls;
      try {
        Hls = await loadHlsClass();
      } catch (error) {
        this.lastPlaybackFailure = {
          source: 'hls',
          reason: 'hls-loader-unavailable',
          message: error?.message || 'HLS 播放器加载失败',
          userMessage: 'HLS 播放器加载失败',
          hint: '播放器核心未加载成功，通常是本地资源加载异常。'
        };
        this.error = 'HLS 播放器加载失败，请重试';
        this.loading = false;
        return;
      }

      if (generation !== this.mediaLoadGeneration || this.currentVideo?.url !== url || !this.$refs.videoElement) {
        return;
      }

      if (Hls.isSupported()) {
        if (this.hls) {
          this.hls.destroy();
          this.hls = null;
        }

        const bufferPolicy = this.applyHlsBufferPolicy({ live: false, bitrate: 0 });
        this.hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          ...toHlsBufferConfig(bufferPolicy),
          startPosition: -1,
          capLevelToPlayerSize: false,
          enableInterstitialPlayback: false
        });

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (generation !== this.mediaLoadGeneration || !this.hls) return;
          this.error = null;

          // 画质优化：根据用户设置选择初始画质
          // hls.levels 按 bitrate 升序排列，索引越大画质越高
          const levels = this.hls.levels || [];
          this.qualityLevels = levels.map((lv, i) => ({
            index: i,
            label: this._formatQualityLabel(lv, i, levels.length),
            height: lv.height,
            bitrate: lv.bitrate,
            frameRate: lv.frameRate || 0
          }));

          if (levels.length > 1) {
            // 多画质：根据用户设置选择
            // videoQuality: 'high'=最高, 'auto'=自动, 'low'=最低（省流）
            if (this.videoQuality === 'low' && levels.length > 0) {
              this.hls.currentLevel = 0; // 最低画质
              this.currentQuality = 0;
            } else if (this.videoQuality === 'auto') {
              this.hls.currentLevel = -1; // 自动（由 hls.js 根据带宽决定）
              this.currentQuality = -1;
            } else {
              // 'high' 或默认：选最高画质
              this.hls.currentLevel = levels.length - 1;
              this.currentQuality = levels.length - 1;
            }
          } else {
            // 单画质：无需切换
            this.currentQuality = levels.length > 0 ? 0 : -1;
          }
          this.updateManifestFrameRate(this.currentQuality);
          const selectedLevel = this.currentQuality >= 0
            ? levels[this.currentQuality]
            : levels.reduce((best, level) => (Number(level?.bitrate) > Number(best?.bitrate) ? level : best), null);
          this.applyHlsBufferPolicy({ bitrate: Number(selectedLevel?.bitrate) || 0 });

          this.startBufferedPlayback(generation, 'manifest-parsed');
        });

        this.hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
          if (generation !== this.mediaLoadGeneration) return;
          this.updateMarkedAdRanges(data?.details);
          this.applyHlsBufferPolicy({ live: data?.details?.live === true });
        });

        // 监听画质切换，同步 currentQuality 给 ControlBar
        this.hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
          this.currentQuality = data.level;
          this.updateManifestFrameRate(data.level);
          const level = this.hls?.levels?.[data.level];
          this.applyHlsBufferPolicy({ bitrate: Number(level?.bitrate) || 0 });
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            this.handleHLSError(data, Hls);
          }
        });

        this.hls.attachMedia(video);
        this.hls.loadSource(url);

      } else {
        this.initNativePlayer(url, generation);
      }
    },

    initNativePlayer(url, generation = this.mediaLoadGeneration) {
      const video = this.$refs.videoElement;
      if (!video || generation !== this.mediaLoadGeneration) return;
      video.removeAttribute('src');
      video.load();
      video.src = url;
      this.error = null;

      // 移除上一次未触发的 canplay 监听器，避免快速切换视频时累积
      if (this._nativeCanPlayHandler) {
        video.removeEventListener('canplay', this._nativeCanPlayHandler);
        this._nativeCanPlayHandler = null;
      }
      const onCanPlay = () => {
        if (generation === this.mediaLoadGeneration) this.startBufferedPlayback(generation, 'native-canplay');
        video.removeEventListener('canplay', onCanPlay);
        this._nativeCanPlayHandler = null;
      };
      this._nativeCanPlayHandler = onCanPlay;
      video.addEventListener('canplay', onCanPlay);
    },

    handleHLSError(data, Hls) {
      this.hlsErrorCount++;
      if (this.hlsErrorCount > this.maxHlsRecoveryAttempts) {
        this.clearHlsRecoveryWatchdog();
        const failure = this.createHlsFailure(data, Hls);
        this.recordPlaybackFailure(failure);
        if (this.hls) {
          this.hls.destroy();
          this.hls = null;
        }
        this.setPlaybackState('recovering');
        this.autoFallbackToOtherSource(failure);
        return;
      }

      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          this.recoveryMessage = `视频网络异常，正在尝试恢复 (${this.hlsErrorCount}/${this.maxHlsRecoveryAttempts})`;
          this.setPlaybackState('recovering');
          this.trackTimer(setTimeout(() => this.hls?.startLoad(), 1000));
          this.scheduleHlsRecoveryWatchdog(data, Hls);
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          this.recoveryMessage = `视频解码异常，正在尝试恢复 (${this.hlsErrorCount}/${this.maxHlsRecoveryAttempts})`;
          this.setPlaybackState('recovering');
          this.trackTimer(setTimeout(() => this.hls?.recoverMediaError(), 1000));
          this.scheduleHlsRecoveryWatchdog(data, Hls);
          break;
        default:
          this.clearHlsRecoveryWatchdog();
          this.recordPlaybackFailure(this.createHlsFailure(data, Hls));
          if (this.hls) {
            this.hls.destroy();
            this.hls = null;
          }
          this.setPlaybackState('recovering');
          this.autoFallbackToOtherSource(this.lastPlaybackFailure);
          break;
      }
    },

    createHlsFailure(data, Hls) {
      // Phase 5: 使用 classifyHlsFailure 获得带分类的失败对象
      const failure = classifyHlsFailure(data, Hls);
      failure.attempts = this.hlsErrorCount;
      if (data?.type === Hls.ErrorTypes.NETWORK_ERROR) {
        failure.userMessage = '视频加载失败，正在尝试自动切换其他源';
      } else if (data?.type === Hls.ErrorTypes.MEDIA_ERROR) {
        failure.userMessage = '视频解码失败，正在尝试自动切换其他源';
      }
      return failure;
    },

    createNativeVideoFailure() {
      const video = this.$refs.videoElement;
      return describeNativeVideoError(video?.error);
    },

    recordPlaybackFailure(failure) {
      this.lastPlaybackFailure = failure;
      this.reportSourcePlaybackResult(false, failure?.reason || 'playback-failed', failure);
    },

    formatFailureForDisplay(failure) {
      return formatPlaybackFailureForDisplay(failure);
    },

    finalPlaybackErrorMessage(failure) {
      const base = failure?.message || '视频播放失败';
      return `自动换源未成功：${base}`;
    },

    /**
     * 格式化画质标签：优先用高度（如 1080p），无高度时用序号
     */
    _formatQualityLabel(level, index, _total) {
      if (level.height) {
        return `${level.height}p`;
      }
      if (level.bitrate) {
        // 无高度时用码率估算
        const kbps = Math.round(level.bitrate / 1000);
        return `${kbps}kbps`;
      }
      return `画质${index + 1}`;
    },

    /**
     * 用户手动切换画质
     * @param {number} level -1=自动, 0..n=指定索引
     */
    handleQualityChange(level) {
      if (!this.hls) return;
      this.hls.currentLevel = level;
      this.currentQuality = level;
    },

    getCurrentSourceId() {
      return this.currentVideo?.anime?.source || this.currentVideo?.sourceId || '';
    },

    getCurrentProviderId() {
      return this.currentVideo?.anime?.providerId
        || this.currentVideo?.providerId
        || (this.getCurrentSourceId() ? `cms:${this.getCurrentSourceId()}` : '');
    },

    getCurrentQualitySnapshot() {
      if (!this.hls) return null;
      const levels = this.hls.levels || [];
      const levelIndex = this.currentQuality >= 0 ? this.currentQuality : this.hls.currentLevel;
      const level = levels[levelIndex] || levels[levels.length - 1];
      if (!level) return null;
      return {
        height: level.height || 0,
        bitrate: level.bitrate || 0,
        frameRate: level.frameRate || 0
      };
    },

    updateManifestFrameRate(levelIndex = -1) {
      if (!this.hls) return;
      const levels = this.hls.levels || [];
      const selectedLevel = levels[levelIndex] || levels[this.hls.currentLevel];
      const declaredRate = selectedLevel?.frameRate
        || levels.find(level => Number(level?.frameRate) > 0)?.frameRate;
      const normalizedRate = normalizeDeclaredFrameRate(declaredRate);
      if (!normalizedRate) return;
      this.sourceFrameRate = normalizedRate;
      this.sourceFrameRateOrigin = 'manifest';
      this.frameRateSamples = [];
    },

    reportSourcePlaybackResult(success, reason = '', diagnostics = null) {
      const sourceId = this.getCurrentSourceId();
      const url = this.currentVideo?.url || '';
      const providerId = this.getCurrentProviderId();
      if (!sourceId || !url) return;

      const key = `${sourceId}|${url}|${success ? 'ok' : 'fail'}|${reason}`;
      if (success) {
        if (this.reportedPlaybackSuccessKey === key) return;
        this.reportedPlaybackSuccessKey = key;
      } else {
        if (this.reportedPlaybackFailureKey === key) return;
        this.reportedPlaybackFailureKey = key;
      }

      const payload = {
        success,
        reason,
        error: diagnostics?.message || reason,
        diagnostics: diagnostics ? {
          category: String(diagnostics.category || ''),
          reason: String(diagnostics.reason || reason || ''),
          message: String(diagnostics.message || ''),
          hint: String(diagnostics.hint || ''),
          type: String(diagnostics.type || ''),
          details: String(diagnostics.details || ''),
          status: Number(diagnostics.status) || 0,
          attempts: Number(diagnostics.attempts) || 0
        } : null,
        quality: success ? this.getCurrentQualitySnapshot() : null
      };
      if (providerId && window.electronAPI?.sourceProviderReportPlayback) {
        window.electronAPI.sourceProviderReportPlayback(providerId, payload).catch(() => {});
      } else {
        window.electronAPI?.cmsReportSourcePlayback?.(sourceId, payload).catch(() => {});
      }
    },

    beginPlaybackSession(generation, url) {
      const now = Date.now();
      this.playbackSession = {
        generation,
        url,
        sourceId: this.getCurrentSourceId(),
        providerId: this.currentVideo?.anime?.providerId || this.currentVideo?.providerId || '',
        loadStartedAt: now,
        firstFrameAt: 0,
        lastPlayStartedAt: 0,
        playedMs: 0,
        stallStartedAt: 0,
        stallCount: 0,
        stallMs: 0,
        intentionalSeekUntil: 0,
        unexpectedPauseCount: 0,
        startTotalFrames: 0,
        startDroppedFrames: 0,
        checkpointTimer: null,
        checkpointReported: false,
        reported: false
      };
    },

    markPlaybackSessionPlaying(firstFrame = true) {
      const session = this.playbackSession;
      if (!session || session.generation !== this.mediaLoadGeneration) return;
      const now = Date.now();
      if (firstFrame && !session.firstFrameAt) {
        session.firstFrameAt = now;
        session.startTotalFrames = this.playbackTotalFrames || 0;
        session.startDroppedFrames = this.playbackDroppedFrames || 0;
      }
      if (session.stallStartedAt) {
        session.stallMs += Math.max(0, now - session.stallStartedAt);
        session.stallStartedAt = 0;
      }
      if (session.firstFrameAt && this.playbackIntent && !session.lastPlayStartedAt) {
        session.lastPlayStartedAt = now;
      }
      this.schedulePlaybackSessionCheckpoint();
    },

    pausePlaybackSession() {
      const session = this.playbackSession;
      if (!session) return;
      const now = Date.now();
      if (session.lastPlayStartedAt) {
        session.playedMs += Math.max(0, now - session.lastPlayStartedAt);
        session.lastPlayStartedAt = 0;
      }
    },

    markPlaybackSessionStall() {
      const session = this.playbackSession;
      if (!session?.firstFrameAt || session.stallStartedAt || !this.playbackIntent) return;
      if (Date.now() < session.intentionalSeekUntil || this.$refs.videoElement?.seeking) return;
      this.pausePlaybackSession();
      session.stallCount += 1;
      session.stallStartedAt = Date.now();
    },

    markIntentionalSeek() {
      const session = this.playbackSession;
      if (!session?.firstFrameAt) return;
      this.pausePlaybackSession();
      session.intentionalSeekUntil = Date.now() + 3000;
    },

    currentPlaybackSessionPlayedMs(session = this.playbackSession, now = Date.now()) {
      if (!session) return 0;
      return session.playedMs + (session.lastPlayStartedAt
        ? Math.max(0, now - session.lastPlayStartedAt)
        : 0);
    },

    buildPlaybackSessionMetrics(session, now = Date.now()) {
      const totalFrames = Math.max(0, (this.playbackTotalFrames || 0) - session.startTotalFrames);
      const droppedFrames = Math.max(0, (this.playbackDroppedFrames || 0) - session.startDroppedFrames);
      const quality = this.getCurrentQualitySnapshot() || {};
      const playedMs = this.currentPlaybackSessionPlayedMs(session, now);
      const stallMs = session.stallMs + (session.stallStartedAt
        ? Math.max(0, now - session.stallStartedAt)
        : 0);
      return {
        metrics: {
          startupMs: Math.max(0, session.firstFrameAt - session.loadStartedAt),
          playedMs: Math.round(playedMs),
          stallCount: session.stallCount,
          stallMs: Math.round(stallMs),
          unexpectedPauseCount: session.unexpectedPauseCount,
          totalFrames,
          droppedFrames,
          width: this.playbackWidth || 0,
          height: this.playbackHeight || quality.height || 0,
          bitrate: quality.bitrate || 0,
          frameRate: this.sourceFrameRate || quality.frameRate || 0,
          sustained: playedMs >= 15000
        },
        quality
      };
    },

    reportPlaybackSessionSample(session, reason) {
      if (!session?.firstFrameAt) return;
      const { metrics, quality } = this.buildPlaybackSessionMetrics(session);
      const payload = { sample: 'session', success: true, reason, metrics, quality };
      const providerId = session.providerId || (session.sourceId ? `cms:${session.sourceId}` : '');
      if (providerId && window.electronAPI?.sourceProviderReportPlayback) {
        window.electronAPI.sourceProviderReportPlayback(providerId, payload).catch(() => {});
      } else if (session.sourceId && window.electronAPI?.cmsReportSourcePlayback) {
        window.electronAPI.cmsReportSourcePlayback(session.sourceId, payload).catch(() => {});
      }
    },

    schedulePlaybackSessionCheckpoint() {
      const session = this.playbackSession;
      if (!session?.firstFrameAt || session.checkpointReported || session.checkpointTimer) return;
      const playedMs = this.currentPlaybackSessionPlayedMs(session);
      const delay = Math.max(500, 15000 - playedMs);
      session.checkpointTimer = this.trackTimer(setTimeout(() => {
        if (this.playbackSession !== session || session.reported) return;
        session.checkpointTimer = null;
        if (this.currentPlaybackSessionPlayedMs(session) >= 15000) {
          this.reportPlaybackSessionSample(session, 'sustained-checkpoint');
          session.checkpointReported = true;
        } else if (this.playbackIntent) {
          this.schedulePlaybackSessionCheckpoint();
        }
      }, delay));
    },

    finalizePlaybackSession(reason = 'closed') {
      const session = this.playbackSession;
      if (!session || session.reported) return;
      if (session.checkpointTimer) {
        clearTimeout(session.checkpointTimer);
        session.checkpointTimer = null;
      }
      this.pausePlaybackSession();
      const now = Date.now();
      if (session.stallStartedAt) {
        session.stallMs += Math.max(0, now - session.stallStartedAt);
        session.stallStartedAt = 0;
      }
      session.reported = true;
      this.playbackSession = null;
      if (!session.checkpointReported) this.reportPlaybackSessionSample(session, reason);
    },

    getBufferedAhead(video = this.$refs.videoElement) {
      if (!video?.buffered?.length) return 0;
      const current = Number(video.currentTime) || 0;
      try {
        for (let index = 0; index < video.buffered.length; index += 1) {
          const start = video.buffered.start(index);
          const end = video.buffered.end(index);
          if (current >= start - 0.15 && current <= end + 0.15) {
            return Math.max(0, end - current);
          }
        }
      } catch (_) {
        return 0;
      }
      return 0;
    },

    updateBufferAhead() {
      const next = this.getBufferedAhead();
      if (Math.abs(next - this.bufferAheadSeconds) >= 0.1 || next === 0) {
        this.bufferAheadSeconds = next;
      }
      return next;
    },

    startBufferedPlayback(generation, trigger = 'buffer-ready') {
      if (generation !== this.mediaLoadGeneration) return;
      if (!this.smoothStreaming) {
        this.startupBuffering = false;
        this.loading = false;
        this.requestPlayback(trigger);
        return;
      }

      this.startupBuffering = true;
      this.loading = true;
      const startedAt = performance.now();
      const targetSeconds = this.hls ? 3 : 1.5;
      const maxWaitMs = this.hls ? 7000 : 3500;
      const poll = () => {
        if (generation !== this.mediaLoadGeneration || !this.$refs.videoElement) return;
        const ahead = this.updateBufferAhead();
        if (ahead >= targetSeconds || performance.now() - startedAt >= maxWaitMs) {
          this.startupBuffering = false;
          this.loading = false;
          this.requestPlayback(trigger);
          return;
        }
        this.trackTimer(setTimeout(poll, 120));
      };
      poll();
    },

    startSmoothRebuffer() {
      const video = this.$refs.videoElement;
      if (!this.smoothStreaming || !this.hls || !video || this.smoothRebuffering || !this.playbackIntent) return;
      const generation = this.mediaLoadGeneration;
      const startedAt = performance.now();
      this.smoothRebuffering = true;
      this.suppressPauseEventsUntil = performance.now() + 9000;
      if (!video.paused) video.pause();

      const poll = () => {
        if (generation !== this.mediaLoadGeneration || !this.$refs.videoElement) return;
        const ahead = this.updateBufferAhead();
        if (ahead >= 3 || performance.now() - startedAt >= 8000) {
          this.smoothRebuffering = false;
          this.buffering = false;
          this.requestPlayback('smooth-rebuffer');
          return;
        }
        this.trackTimer(setTimeout(poll, 140));
      };
      poll();
    },

    async requestPlayback(trigger = 'auto') {
      const video = this.$refs.videoElement;
      if (!video || this.casting) return false;
      this.playbackIntent = true;
      try {
        await video.play();
        return true;
      } catch (error) {
        if (error?.name !== 'AbortError') {
          this.playbackIntent = false;
          this.setPlaying(false);
          this.showCenterPlay = true;
          this.revealControls(false);
          console.warn(`[VideoPlayer] play rejected (${trigger}):`, error?.message || error);
        }
        return false;
      }
    },

    pausePlayback(reason = 'user') {
      const video = this.$refs.videoElement;
      if (!video) return;
      this.playbackIntent = false;
      if (reason !== 'user') this.suppressPauseEventsUntil = performance.now() + 500;
      video.pause();
    },

    closeSourcePanel() {
      this.sourcePanelRequestToken += 1;
      this.sourcePanelVisible = false;
      this.sourcePanelLoading = false;
      this.sourcePanelError = '';
    },

    async loadSourceCandidates() {
      const animeName = this.currentVideo?.anime?.name;
      if (!animeName) {
        this.sourcePanelError = '当前视频没有番剧信息';
        return;
      }

      const currentSourceId = this.getCurrentSourceId();
      const excludeSourceIds = currentSourceId ? [currentSourceId] : [];
      const requestToken = ++this.sourcePanelRequestToken;
      this.sourcePanelVisible = true;
      this.sourcePanelLoading = true;
      this.sourcePanelError = '';
      this.sourceCandidates = [];
      this.sourceSkipped = [];

      try {
        const result = await window.electronAPI.cmsMultiSelectBestEpisodeSource(animeName, {
          episodeTitle: this.currentVideo?.episode?.title || '',
          episodeIndex: this.currentVideo?.episode?.index ?? -1,
          excludeSourceIds,
          allowFirstFallback: true
        });
        if (requestToken !== this.sourcePanelRequestToken || result?.cancelled) return;

        const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        this.sourceCandidates = candidates.filter(candidate => candidate?.url);
        this.sourceSkipped = result?.skipped || [];
        if (result?.error && this.sourceCandidates.length === 0) {
          this.sourcePanelError = result.error;
        }
      } catch (error) {
        if (requestToken !== this.sourcePanelRequestToken) return;
        this.sourcePanelError = error.message || '加载候选源失败';
      } finally {
        if (requestToken === this.sourcePanelRequestToken) {
          this.sourcePanelLoading = false;
        }
      }
    },

    async playSourceCandidate(candidate) {
      const plainCandidate = toIpcPlainObject(candidate, null);
      if (!plainCandidate?.url || !plainCandidate?.anime || !plainCandidate?.episode) {
        this.sourcePanelError = '候选源数据不完整';
        return false;
      }

      try {
        const resumeAt = Number(this.$refs.videoElement?.currentTime) || Number(this.currentTime) || 0;
        if (plainCandidate.sourceId && !this.triedFallbackSourceIds.includes(plainCandidate.sourceId)) {
          this.triedFallbackSourceIds.push(plainCandidate.sourceId);
        }
        const anime = {
          ...plainCandidate.anime,
          source: plainCandidate.anime.source || plainCandidate.sourceId,
          sourceId: plainCandidate.sourceId || plainCandidate.anime.sourceId,
          providerId: plainCandidate.providerId || plainCandidate.anime.providerId || `cms:${plainCandidate.sourceId}`,
          sourceType: plainCandidate.anime.sourceType || 'cms',
          sourceName: plainCandidate.sourceName || plainCandidate.anime.sourceName
        };
        const episode = plainCandidate.episode;
        let resolvedVideo = null;
        let videoUrl = plainCandidate.url;
        if (window.electronAPI?.playbackResolve) {
          resolvedVideo = await window.electronAPI.playbackResolve({
            providerId: anime.providerId,
            sourceId: anime.sourceId,
            sourceName: anime.sourceName,
            sourceType: anime.sourceType,
            sourceAnimeId: String(anime.id || ''),
            episode
          });
          if (!resolvedVideo?.success || !resolvedVideo.url) {
            const reason = resolvedVideo?.error || '候选源视频地址不可用';
            this.sourcePanelVisible = true;
            this.sourcePanelError = `${plainCandidate.sourceName || plainCandidate.sourceId || '候选源'}：${reason}`;
            return false;
          }
          videoUrl = resolvedVideo.url;
        }

        this.preserveFallbackSourceIdsOnce = true;
        this.sourcePanelVisible = false;
        this.sourcePanelError = '';
        this.error = null;
        this.lastAutoFallbackCandidate = plainCandidate;
        this.pendingResumeTime = resumeAt > 1 ? resumeAt : 0;

        await this.playVideo({
          title: `${anime.name} - ${episode.title}`,
          url: videoUrl,
          anime,
          episode: { ...episode, index: episode.index ?? 0 },
          episodeId: episode.id || videoUrl,
          sourceId: plainCandidate.sourceId,
          sourceName: plainCandidate.sourceName,
          resolvedVideo
        });
        return true;
      } catch (error) {
        this.sourcePanelVisible = true;
        this.sourcePanelError = error.message || '切换候选源失败';
        return false;
      }
    },

    togglePlay() {
      const video = this.$refs.videoElement;
      if (video) {
        if (video.paused) {
          this.requestPlayback('user');
        } else {
          this.pausePlayback('user');
        }
        this.showCenterPlay = false;
        this.flashPlayFeedback();
        // 主机模式：立即广播播放/暂停状态（不等下一个周期）
        if (this.wtRoomInfo.isHost && this.watchTogetherActive) {
          this.broadcastWtState();
        }
      }
    },

    flashPlayFeedback() {
      this.showPlayFeedback = true;
      if (this.playFeedbackTimer) clearTimeout(this.playFeedbackTimer);
      this.playFeedbackTimer = setTimeout(() => {
        this.showPlayFeedback = false;
      }, 600);
    },

    handleSeek(time) {
      const video = this.$refs.videoElement;
      if (video && isFinite(time)) {
        this.markIntentionalSeek();
        this.buffering = true; // seek 时标记缓冲中，保留当前帧画面
        const duration = Number(video.duration);
        const nextTime = Number.isFinite(duration) && duration > 0
          ? Math.max(0, Math.min(time, duration))
          : Math.max(0, Number(time) || 0);
        video.currentTime = nextTime;
        this._lastCommittedTime = nextTime;
        this.setCurrentTime(nextTime);
        // 通知弹幕层重置时间轴
        if (this.$refs.danmakuLayer) {
          this.$refs.danmakuLayer.onSeek(nextTime);
        }
        // 通知字幕层重置查找状态
        if (this.$refs.subtitleLayer) {
          this.$refs.subtitleLayer.onSeek(nextTime);
        }
        // 主机模式：seek 后立即广播，让成员跟上
        if (this.wtRoomInfo.isHost && this.watchTogetherActive) {
          this.broadcastWtState();
        }
      }
    },

    handleVolumeChange(vol) {
      const video = this.$refs.videoElement;
      if (video) {
        video.volume = vol;
        if (vol > 0 && video.muted) {
          video.muted = false;
          this.videoMuted = false;
        }
        this.setVolume(vol);
        this.scheduleVolumeSave(vol);
        this.showOsd(vol === 0 ? 'mute' : 'volume', `${Math.round(vol * 100)}%`, vol >= 0.5 ? 2 : 1);
      }
    },

    scheduleVolumeSave(vol) {
      if (this._volumeSaveTimer) {
        clearTimeout(this._volumeSaveTimer);
      }
      this._volumeSaveTimer = setTimeout(() => {
        this._volumeSaveTimer = null;
        localStorage.setItem('player-volume', String(vol));
      }, 160);
    },

    handlePlaybackRateChange(rate) {
      const video = this.$refs.videoElement;
      if (video) {
        video.playbackRate = rate;
        this.setPlaybackRate(rate);
        if (this.rememberPlaybackRate) {
          localStorage.setItem('player-playback-rate', String(rate));
        }
      }
    },

    toggleFullscreen() {
      const container = this.$el;
      if (container) {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          container.requestFullscreen();
        }
      }
    },

    async togglePictureInPicture() {
      const video = this.$refs.videoElement;
      if (!video || !document.pictureInPictureEnabled) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (error) {
        this.$notify?.warning('画中画不可用', error.message || '当前视频暂不支持画中画');
      }
    },

    onTimeUpdate() {
      const video = this.$refs.videoElement;
      this.updateBufferAhead();
      if (!video || this._timeUpdateFrame) return;
      this._timeUpdateFrame = requestAnimationFrame(() => {
        this._timeUpdateFrame = null;
        const current = this.$refs.videoElement?.currentTime || 0;
        if (current > 0 && !this.$refs.videoElement?.paused) this.markPlaybackSessionPlaying();
        this.maybeAutoSkipMarkedAd(current);
        if (Math.abs(current - this._lastCommittedTime) < 0.22 && this.isPlaying) return;
        this._lastCommittedTime = current;
        this.setCurrentTime(current);
      });
    },

    onLoadedMetadata() {
      this.samplePlaybackStats(true);
      if (this.$refs.videoElement && !this.isUpdatingDuration) {
        this.isUpdatingDuration = true;
        this.$nextTick(() => {
          if (this.$refs.videoElement) {
            const nextDuration = this.$refs.videoElement.duration;
            if (Math.abs(nextDuration - this._lastDurationCommit) > 0.1) {
              this._lastDurationCommit = nextDuration;
              this.setDuration(nextDuration);
            }
          }
          this.isUpdatingDuration = false;
        });
      }

      // 恢复上次播放位置
      const savedPosition = Number(this.currentVideo?.playPosition) || 0;
      const resumePosition = Math.max(savedPosition > 5 ? savedPosition : 0, this.pendingResumeTime || 0);
      if (resumePosition > 0 && this.$refs.videoElement) {
        this.$refs.videoElement.currentTime = Math.min(resumePosition, this.$refs.videoElement.duration || resumePosition);
      }
      this.pendingResumeTime = 0;

      // 恢复音量
      const savedVolume = parseFloat(localStorage.getItem('player-volume') || '1');
      if (this.$refs.videoElement && isFinite(savedVolume)) {
        this.$refs.videoElement.volume = savedVolume;
        this.setVolume(savedVolume);
      }

      // 恢复播放速率
      if (this.rememberPlaybackRate) {
        const savedRate = parseFloat(localStorage.getItem('player-playback-rate') || '1');
        if (this.$refs.videoElement && isFinite(savedRate) && savedRate !== 1) {
          this.$refs.videoElement.playbackRate = savedRate;
          this.setPlaybackRate(savedRate);
        }
      }

      // 启动定期保存播放进度
      this.startProgressSave();
    },

    onVideoEnded() {
      this.finalizePlaybackSession('ended');
      this.playbackIntent = false;
      this.setPlaying(false);
      this.showCenterPlay = true;
      this.stopProgressSave();
      // 自动连播由父视图监听 video-ended 后统一处理（含完整 URL 解析），
      // 这里只负责通知，避免父子各触发一次导致双换集竞态
      this.$emit('video-ended');
    },

    onWaiting() {
      // 如果已有视频画面（非初始加载），只标记缓冲中，保留最后一帧
      if (this.loading) return; // 初始加载中，不用管
      this.buffering = true;
      this.markPlaybackSessionStall();
      this.startSmoothRebuffer();
    },

    onCanPlay() {
      this.updateBufferAhead();
      if (this.startupBuffering || this.smoothRebuffering) return;
      this.markPlaybackSessionPlaying(false);
      this.clearHlsRecoveryWatchdog();
      this.loading = false;
      this.buffering = false;
      this.autoRecovering = false;
      this.recoveryMessage = '';
      this.lastPlaybackFailure = null;
      this.setPlaybackState('playing');
      this.reportSourcePlaybackResult(true, 'canplay');
    },

    onSeeked() {
      const video = this.$refs.videoElement;
      if (!video) return;
      const current = Number(video.currentTime) || 0;
      this._lastCommittedTime = current;
      this.setCurrentTime(current);
      // 已有当前帧即可先撤掉遮罩；若后续数据不足，waiting 会重新进入缓冲态。
      if (video.readyState >= 2 && !this.startupBuffering && !this.smoothRebuffering) {
        this.buffering = false;
      }
      if (this.playbackIntent && video.paused && !video.ended && !this.casting) {
        this.requestPlayback('seeked');
      }
    },

    onVideoError() {
      this.loading = false;
      this.buffering = false;
      if (this.hls && this.currentVideo?.url?.includes('.m3u8')) {
        return;
      }
      const failure = this.createNativeVideoFailure();
      this.recordPlaybackFailure(failure);
      this.setPlaybackState('recovering');
      this.autoFallbackToOtherSource(failure);
    },

    onProgress() {
      const video = this.$refs.videoElement;
      this.updateBufferAhead();
      if (!video || !video.buffered || !video.duration) return;
      try {
        const buffered = video.buffered;
        if (buffered.length > 0) {
          // seek 后可能存在多个缓冲区间：取包含当前播放头的那个区间的末尾，
          // 避免缓冲条虚标到另一个不相邻区间的末尾误导用户
          const current = video.currentTime;
          let end = buffered.end(buffered.length - 1);
          for (let i = 0; i < buffered.length; i++) {
            if (current >= buffered.start(i) && current < buffered.end(i)) {
              end = buffered.end(i);
              break;
            }
          }
          const nextProgress = (end / video.duration) * 100;
          if (Math.abs(nextProgress - this._lastBufferProgress) >= 1 || nextProgress >= 99.5) {
            this._lastBufferProgress = nextProgress;
            this.bufferProgress = nextProgress;
          }
        }
      } catch (e) {
        // ignore
      }
    },

    onPlay() {
      this.playbackIntent = true;
      this.startupBuffering = false;
      this.smoothRebuffering = false;
      this.loading = false;
      this.buffering = false;
      this.markPlaybackSessionPlaying();
      this.setPlaybackState('playing');
      this.setPlaying(true);
      this.showCenterPlay = false;
      this.startPlaybackStats();
      this.scheduleControlsHide();
    },

    onPause() {
      this.pausePlaybackSession();
      const video = this.$refs.videoElement;
      const unexpected = this.playbackIntent
        && performance.now() > this.suppressPauseEventsUntil
        && !video?.ended
        && !this.casting
        && !this.wtApplyingRemoteState
        && ['loading', 'playing', 'recovering'].includes(this.playbackState);
      if (unexpected && this.playbackSession) {
        this.playbackSession.unexpectedPauseCount += 1;
        if (this.unexpectedPauseRecoveryTimer) clearTimeout(this.unexpectedPauseRecoveryTimer);
        const generation = this.mediaLoadGeneration;
        this.unexpectedPauseRecoveryTimer = setTimeout(() => {
          this.unexpectedPauseRecoveryTimer = null;
          if (generation === this.mediaLoadGeneration && this.playbackIntent && this.$refs.videoElement?.paused) {
            this.requestPlayback('unexpected-pause-recovery');
          }
        }, 120);
      }
      this.setPlaying(false);
      this.stopPlaybackStats();
      this.revealControls(false);
      // 暂停时立即保存一次进度，避免切换或关闭时丢失最后几秒
      this.savePlayProgress();
    },

    retry() {
      this.triedFallbackSourceIds = [];
      this.fallbackRequestToken += 1;
      this.error = null;
      this.autoRecovering = false;
      this.recoveryMessage = '';
      this.lastPlaybackFailure = null;
      this.loading = true;
      this.setPlaybackState('loading');
      this.scheduleVideoInitialization(180);
    },

    async searchOtherSources() {
      await this.loadSourceCandidates();
    },

    /**
     * Phase 5: 一键换源同集
     * 显式触发跨源搜索，匹配与当前集同序号/同标题的剧集
     */
    async switchToSameEpisode() {
      await this.loadSourceCandidates();
    },

    async autoFallbackToOtherSource(failure = this.lastPlaybackFailure) {
      if (this.triedFallbackSourceIds.length >= this.maxFallbackSourceAttempts) {
        this.autoRecovering = false;
        this.error = this.finalPlaybackErrorMessage(failure);
        this.setPlaybackState('failed');
        return false;
      }

      this.setPlaybackState('recovering');
      this.error = null;
      this.recoveryMessage = '正在自动选择可用播放源...';
      const switched = await this.tryFallbackToOtherSource();
      if (!switched) {
        this.autoRecovering = false;
        this.error = this.finalPlaybackErrorMessage(failure);
        this.setPlaybackState('failed');
      }
      return switched;
    },

    async tryFallbackToOtherSource() {
      const animeName = this.currentVideo?.anime?.name;
      if (!animeName) return false;

      const fallbackToken = ++this.fallbackRequestToken;
      const isLatestFallback = () => fallbackToken === this.fallbackRequestToken;
      const currentEpTitle = this.currentVideo?.episode?.title || '';
      const currentEpIndex = this.currentVideo?.episode?.index ?? -1;
      const currentSourceId = this.getCurrentSourceId();
      if (currentSourceId && !this.triedFallbackSourceIds.includes(currentSourceId)) {
        this.triedFallbackSourceIds.push(currentSourceId);
      }
      const excludeSourceIds = [...new Set(this.triedFallbackSourceIds.filter(Boolean))];

      try {
        this.autoRecovering = true;
        this.error = null;
        this.recoveryMessage = '正在探测其他播放源...';
        const result = await window.electronAPI.cmsMultiSelectBestEpisodeSource(animeName, {
          episodeTitle: currentEpTitle,
          episodeIndex: currentEpIndex,
          excludeSourceIds,
          allowFirstFallback: true
        });
        if (!isLatestFallback() || result?.cancelled) return false;

        this.sourceCandidates = Array.isArray(result?.candidates) ? result.candidates.filter(candidate => candidate?.url) : [];
        this.sourceSkipped = result?.skipped || [];

        const candidates = [result?.best, ...this.sourceCandidates]
          .filter(candidate => candidate?.url && candidate?.anime && candidate?.episode)
          .filter((candidate, index, items) => items.findIndex(item => (
            item.sourceId === candidate.sourceId && item.url === candidate.url
          )) === index)
          .slice(0, this.maxFallbackSourceAttempts);
        for (const candidate of candidates) {
          if (!isLatestFallback()) return false;
          this.recoveryMessage = `正在验证 ${candidate.sourceName || candidate.sourceId || '候选源'}...`;
          if (await this.playSourceCandidate(candidate)) return true;
        }

        if (!isLatestFallback()) return false;
        this.recoveryMessage = '其他源未找到可播放的链接';
        return false;
      } catch (err) {
        if (!isLatestFallback()) return false;
        this.recoveryMessage = '换源失败：' + (err.message || '未知错误');
        return false;
      }
    },

    readDecodedFrameCount(video) {
      const quality = video?.getVideoPlaybackQuality?.();
      if (Number.isFinite(quality?.totalVideoFrames)) {
        this.playbackTotalFrames = Number(quality.totalVideoFrames) || 0;
        this.playbackDroppedFrames = Number(quality.droppedVideoFrames) || 0;
        return quality.totalVideoFrames;
      }
      return Number.isFinite(video?.webkitDecodedFrameCount) ? video.webkitDecodedFrameCount : null;
    },

    samplePlaybackStats(resetBaseline = false) {
      const video = this.$refs.videoElement;
      if (!video) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        this.playbackWidth = video.videoWidth;
        this.playbackHeight = video.videoHeight;
      }

      const totalFrames = this.readDecodedFrameCount(video);
      const sampledAt = performance.now();
      if (resetBaseline || !Number.isFinite(totalFrames) || !Number.isFinite(this._statsLastFrames)) {
        this._statsLastFrames = totalFrames;
        this._statsLastSampleAt = sampledAt;
        return;
      }

      const frameDelta = totalFrames - this._statsLastFrames;
      const elapsedSeconds = (sampledAt - this._statsLastSampleAt) / 1000;
      if (elapsedSeconds < 1.8) return;
      this._statsLastFrames = totalFrames;
      this._statsLastSampleAt = sampledAt;
      if (video.paused || frameDelta <= 0 || elapsedSeconds > 5) return;

      const measuredFps = frameDelta / elapsedSeconds / Math.max(0.1, Number(video.playbackRate) || 1);
      if (measuredFps < 1 || measuredFps > 240) return;
      const smoothedFps = this.playbackDecodedFps > 0
        ? this.playbackDecodedFps * 0.7 + measuredFps * 0.3
        : measuredFps;
      this.playbackDecodedFps = Math.round(smoothedFps * 10) / 10;

      if (this.sourceFrameRateOrigin !== 'manifest' && !this.sourceFrameRate) {
        this.frameRateSamples = [...this.frameRateSamples.slice(-7), measuredFps];
        const estimatedRate = estimateSourceFrameRate(this.frameRateSamples);
        if (estimatedRate) {
          this.sourceFrameRate = estimatedRate;
          this.sourceFrameRateOrigin = 'estimated';
        }
      }
    },

    startPlaybackStats() {
      this.stopPlaybackStats();
      this.samplePlaybackStats(true);
      this._playbackStatsTimer = setInterval(() => this.samplePlaybackStats(), 1000);
    },

    stopPlaybackStats(reset = false) {
      if (this._playbackStatsTimer) {
        clearInterval(this._playbackStatsTimer);
        this._playbackStatsTimer = null;
      }
      this._statsLastFrames = null;
      this._statsLastSampleAt = 0;
      if (reset) {
        this.playbackWidth = 0;
        this.playbackHeight = 0;
        this.sourceFrameRate = 0;
        this.sourceFrameRateOrigin = '';
        this.playbackDecodedFps = 0;
        this.playbackTotalFrames = 0;
        this.playbackDroppedFrames = 0;
        this.frameRateSamples = [];
      }
    },

    clearHlsRecoveryWatchdog() {
      if (!this.hlsRecoveryWatchdog) return;
      clearTimeout(this.hlsRecoveryWatchdog);
      this.hlsRecoveryWatchdog = null;
    },

    scheduleHlsRecoveryWatchdog(data, Hls) {
      this.clearHlsRecoveryWatchdog();
      const recoveringInstance = this.hls;
      this.hlsRecoveryWatchdog = setTimeout(() => {
        this.hlsRecoveryWatchdog = null;
        if (this.hls !== recoveringInstance || this.playbackState === 'playing') return;

        const failure = this.createHlsFailure(data, Hls);
        failure.reason = `${failure.reason || 'hls-error'}-recovery-timeout`;
        failure.message = '当前视频线路恢复超时';
        failure.userMessage = '当前线路持续无响应，正在自动切换其他源';
        failure.hint = '播放器已跳过无响应线路。';
        this.recordPlaybackFailure(failure);
        if (this.hls) {
          this.hls.destroy();
          this.hls = null;
        }
        this.setPlaybackState('recovering');
        this.autoFallbackToOtherSource(failure);
      }, 7000);
    },

    revealControls(autoHide = true) {
      this.controlsVisible = true;
      if (this.hideControlsTimer) {
        clearTimeout(this.hideControlsTimer);
        this.hideControlsTimer = null;
      }
      if (autoHide) this.scheduleControlsHide();
    },

    scheduleControlsHide() {
      if (!this.isPlaying || this.controlsHovered) return;
      if (this.hideControlsTimer) clearTimeout(this.hideControlsTimer);
      this.hideControlsTimer = setTimeout(() => {
        if (this.isPlaying && !this.controlsHovered) this.controlsVisible = false;
        this.hideControlsTimer = null;
      }, 3000);
    },

    onControlsHover(hovered) {
      this.controlsHovered = hovered;
      this.revealControls(!hovered);
    },

    onMouseMove() {
      const now = performance.now();
      if (this.controlsVisible && now - this._lastMouseMoveAt < 120) return;
      this._lastMouseMoveAt = now;
      this.revealControls(true);
      // 播放中时，鼠标停留 3 秒后自动隐藏控制栏
    },

    onMouseLeave() {
      if (this.hideControlsTimer) {
        clearTimeout(this.hideControlsTimer);
        this.hideControlsTimer = null;
      }
      if (this.isPlaying) {
        this.controlsVisible = false;
      }
    },

    onContainerClick(event) {
      // 只响应直接点击视频画面本身，避免控制栏、按钮、覆盖层误触发播放/暂停
      if (!event.target.classList.contains('video-element')) return;
      // 延迟执行单击暂停：双击全屏时第二次 click 与 dblclick 会取消本次待执行的切换，
      // 避免"双击全屏导致画面暂停又播放"的闪烁
      clearTimeout(this._clickToggleTimer);
      this._clickToggleTimer = this.trackTimer(setTimeout(() => {
        this._clickToggleTimer = null;
        this.togglePlay();
      }, 220));
    },

    seekRelative(delta) {
      const video = this.$refs.videoElement;
      if (video) {
        this.handleSeek((Number(video.currentTime) || 0) + delta);
        this.showOsd(delta > 0 ? 'forward' : 'backward', `${delta > 0 ? '+' : ''}${delta}s`);
      }
    },

    updateMarkedAdRanges(details) {
      const nextRanges = collectHlsAdRanges(details);
      if (nextRanges.length === 0) return;
      const merged = [...this.detectedAdRanges, ...nextRanges]
        .sort((a, b) => a.start - b.start)
        .filter((range, index, items) => items.findIndex(item => (
          item.id === range.id || (Math.abs(item.start - range.start) < 0.1 && Math.abs(item.end - range.end) < 0.1)
        )) === index);
      this.detectedAdRanges = merged;
    },

    setAutoSkipMarkedAds(enabled) {
      this.autoSkipMarkedAds = !!enabled;
      localStorage.setItem('player-auto-skip-marked-ads', String(this.autoSkipMarkedAds));
    },

    setAnime4kEnabled(enabled) {
      this.anime4kEnabled = !!enabled;
      this.anime4kRuntime = this.anime4kEnabled
        ? { active: false, presenting: false, state: 'initializing' }
        : { active: false, presenting: false };
      localStorage.setItem('player-anime4k', String(this.anime4kEnabled));
    },

    setAnime4kPreset(preset) {
      const next = ['light', 'balanced', 'quality'].includes(preset) ? preset : 'balanced';
      this.anime4kPreset = next;
      localStorage.setItem('player-anime4k-preset', next);
    },

    onAnime4kStatusChange(status) {
      this.anime4kRuntime = status?.active
        ? { ...status, active: true, presenting: !!status.presenting }
        : { active: false, presenting: false };
    },

    onAnime4kAutoDisabled() {
      this.anime4kRuntime = { active: false, presenting: false };
      this.setAnime4kEnabled(false);
    },

    setSmoothStreaming(enabled) {
      this.smoothStreaming = !!enabled;
      localStorage.setItem('player-smooth-streaming', String(this.smoothStreaming));
      this.applyHlsBufferPolicy();
    },

    async reportAdAndSwitchSource() {
      await this.reportAdvertisingIssue('manual-source-switch');
      await this.loadSourceCandidates();
    },

    maybeAutoSkipMarkedAd(currentTime) {
      if (!this.autoSkipMarkedAds || this.detectedAdRanges.length === 0) return;
      const range = findActiveAdRange(this.detectedAdRanges, currentTime, this.autoSkippedAdRangeIds);
      if (!range) return;
      const video = this.$refs.videoElement;
      if (!video || !Number.isFinite(range.end) || range.end <= currentTime) return;
      this.autoSkippedAdRangeIds = [...this.autoSkippedAdRangeIds.slice(-49), range.id];
      this.markIntentionalSeek();
      video.currentTime = Math.min(range.end + 0.05, video.duration || range.end + 0.05);
      const label = '标记广告';
      this.adSkipNotice = `已跳过${label} ${Math.max(1, Math.round(range.end - currentTime))} 秒`;
      if (this._adSkipNoticeTimer) clearTimeout(this._adSkipNoticeTimer);
      this._adSkipNoticeTimer = setTimeout(() => {
        this._adSkipNoticeTimer = null;
        this.adSkipNotice = '';
      }, 2200);
      this.reportAdvertisingIssue('hls-marker');
    },

    async skipSuspectedAd() {
      this.seekRelative(15);
      await this.reportAdvertisingIssue('manual-skip');
    },

    async reportAdvertisingIssue(detection = 'manual') {
      const sourceId = this.getCurrentSourceId();
      const reportKey = this.currentAdvertisingKey;
      if (!sourceId || !reportKey || this.reportedAdvertisingKeys.includes(reportKey)) return;

      this.reportedAdvertisingKeys = [...this.reportedAdvertisingKeys.slice(-99), reportKey];
      const providerId = this.getCurrentProviderId();
      try {
        const payload = {
          issue: 'advertising',
          detection,
          episodeTitle: this.currentVideo?.episode?.title || '',
          url: this.currentVideo?.url || ''
        };
        const result = providerId && window.electronAPI?.sourceProviderReportPlayback
          ? await window.electronAPI.sourceProviderReportPlayback(providerId, payload)
          : await window.electronAPI?.cmsReportSourcePlayback?.(sourceId, payload);
        if (result?.success === false) throw new Error(result.error || '广告反馈记录失败');
      } catch (error) {
        this.reportedAdvertisingKeys = this.reportedAdvertisingKeys.filter(key => key !== reportKey);
      }
    },

    changeVolume(delta) {
      const video = this.$refs.videoElement;
      if (video) {
        const newVol = Math.max(0, Math.min(1, video.volume + delta));
        video.volume = newVol;
        if (newVol > 0 && video.muted) {
          video.muted = false;
          this.videoMuted = false;
        }
        this.setVolume(newVol);
        localStorage.setItem('player-volume', String(newVol));
        this.showOsd(newVol === 0 ? 'mute' : 'volume', `${Math.round(newVol * 100)}%`, newVol >= 0.5 ? 2 : 1);
      }
    },

    /** 静音切换（m 快捷键 / 控制栏静音按钮共用）：video.muted 为单一真源 */
    toggleMute() {
      const video = this.$refs.videoElement;
      if (!video) return;
      video.muted = !video.muted;
      this.videoMuted = video.muted;
      this.showOsd(video.muted ? 'mute' : 'volume', video.muted ? '已静音' : `${Math.round(video.volume * 100)}%`, video.volume >= 0.5 ? 2 : 1);
    },

    /** 快进/快退/音量调节的中央 OSD 反馈（key 递增以重启动画） */
    showOsd(icon, label, level = 1) {
      this.osdIcon = icon;
      this.osdLabel = label;
      this.osdLevel = level;
      this.osdKey += 1;
      clearTimeout(this._osdTimer);
      this._osdTimer = this.trackTimer(setTimeout(() => {
        this.osdLabel = '';
        this.osdIcon = null;
      }, 650));
    },

    /**
     * 定期保存播放进度到数据库
     */
    startProgressSave() {
      this.stopProgressSave();
      this.progressSaveTimer = setInterval(() => {
        this.savePlayProgress();
      }, 10000); // 每10秒保存一次
    },

    stopProgressSave() {
      if (this.progressSaveTimer) {
        clearInterval(this.progressSaveTimer);
        this.progressSaveTimer = null;
      }
    },

    savePlayProgress(snapshot) {
      const video = this.$refs.videoElement;
      // 优先使用传入快照（切换集数时保存旧视频进度），否则用当前 currentVideo
      const ctx = snapshot || this.currentVideo;
      const anime = ctx?.anime;
      if (!video || !anime || !video.currentTime) return;

      const source = anime.source || 'legacy';
      const animeId = String(anime.id || anime.anime_id || '');
      if (!animeId) return;

      // 守卫：位置未显著变化（<3s）且非快照保存时跳过，减少高频 IPC + SQLite 写入
      const pos = video.currentTime || 0;
      if (!snapshot && this._lastSavedPosition != null) {
        if (Math.abs(pos - this._lastSavedPosition) < 3) return;
      }
      this._lastSavedPosition = pos;

      window.electronAPI?.historyUpdate({
        anime_id: animeId,
        source,
        name: anime.name || '',
        cover: anime.cover || '',
        episode_title: ctx?.episode?.title || '',
        episode_index: ctx?.episode?.index ?? -1,
        play_url: ctx?.url || '',
        anime_data: '',
        play_position: pos,
        bgm_id: anime.bgm_id || null
      }).catch(() => {});
    },

    // 跟踪 setTimeout 返回的 id，组件卸载时统一清理
    trackTimer(timerId) {
      if (timerId == null) return;
      this.pendingTimers.push(timerId);
      return timerId;
    },

    clearTrackedTimers() {
      while (this.pendingTimers.length) {
        clearTimeout(this.pendingTimers.pop());
      }
    },

    handleKeyPress(event) {
      // 输入框内不触发快捷键
      if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'SELECT') return;

      switch (event.key) {
        case ' ':
          // 按钮聚焦时交给浏览器默认行为（Space 触发 click），避免双重切换播放状态
          if (event.target.tagName === 'BUTTON') return;
          event.preventDefault();
          this.togglePlay();
          break;
        case 'f':
        case 'F':
          this.toggleFullscreen();
          break;
        case 'm':
        case 'M':
          this.toggleMute();
          break;
        case 'ArrowLeft':
          this.seekRelative(-this.seekStepSeconds);
          break;
        case 'ArrowRight':
          this.seekRelative(this.seekStepSeconds);
          break;
        case 'ArrowUp':
          event.preventDefault();
          this.changeVolume(0.1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          this.changeVolume(-0.1);
          break;
        case 'n':
        case 'N':
          if (this.hasEpisodes && this.hasNextEpisode) {
            event.preventDefault();
            this.$emit('next-episode');
          }
          break;
        case 'Escape':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          }
          break;
      }
    },

    // ===== 弹幕相关方法 =====

    async toggleDanmaku() {
      const nextEnabled = !this.enableDanmaku;
      await this.$store.dispatch('settings/updateEnableDanmaku', nextEnabled);
      if (nextEnabled) {
        this.danmakuRuntimeState = 'loading';
        this.showDanmakuNotice(
          this.danmakuEpisodeNumber > 0
            ? `正在匹配第 ${this.danmakuEpisodeNumber} 集弹幕…`
            : '正在匹配弹幕…',
          'loading',
          0
        );
      } else {
        this.danmakuRuntimeState = 'idle';
        this.showDanmakuNotice('弹幕已关闭', 'info');
      }
    },

    /**
     * 导入本地 XML 弹幕文件（由 ControlBar 按钮触发）
     */
    async onDanmakuImportXml() {
      try {
        const result = await window.electronAPI.selectFile([
          { name: 'XML 弹幕', extensions: ['xml'] }
        ]);
        if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
          const filePath = result.filePaths[0];
          if (this.$refs.danmakuLayer) {
            await this.$refs.danmakuLayer.importLocalXml(filePath);
          }
        }
      } catch (e) {
        console.error('[VideoPlayer] 导入弹幕失败:', e);
      }
    },

    onDanmakuLoaded(info) {
      const count = Number(info?.count) || 0;
      this.danmakuRuntimeState = count > 0 ? 'active' : 'empty';
      if (count > 0) {
        const episodeLabel = info?.match?.episodeNumber
          ? `第 ${info.match.episodeNumber} 集 · `
          : '';
        this.showDanmakuNotice(`${episodeLabel}已加载 ${count} 条弹幕`, 'success', 3600);
        return;
      }
      this.showDanmakuNotice(
        this.danmakuEpisodeNumber > 0
          ? `没有匹配到第 ${this.danmakuEpisodeNumber} 集的弹幕`
          : '当前视频暂无可用弹幕',
        'warning',
        5000
      );
    },

    onDanmakuError(msg) {
      this.danmakuRuntimeState = 'error';
      console.warn('[VideoPlayer] 弹幕加载失败:', msg);
      this.showDanmakuNotice(msg || '弹幕加载失败', 'error', 6500);
    },

    onDanmakuStatus(status) {
      if (status?.state === 'loading') {
        this.danmakuRuntimeState = 'loading';
        this.showDanmakuNotice(status.message || '正在匹配弹幕…', 'loading', 0);
      }
    },

    showDanmakuNotice(message, tone = 'info', duration = 2800) {
      if (this.danmakuNoticeTimer) {
        clearTimeout(this.danmakuNoticeTimer);
        this.danmakuNoticeTimer = null;
      }
      this.danmakuNotice = String(message || '');
      this.danmakuNoticeTone = tone;
      if (this.danmakuNotice && duration > 0) {
        this.danmakuNoticeTimer = setTimeout(() => {
          this.danmakuNotice = '';
          this.danmakuNoticeTimer = null;
        }, duration);
      }
    },

    // ===== 字幕相关方法 =====

    toggleSubtitle() {
      if (!this.showSubtitle && this.subtitleCues.length === 0) {
        // 还没有字幕数据，提示用户加载
        this.$notify?.warning('字幕', '请先加载本地字幕或在线搜索字幕');
        return;
      }
      this.showSubtitle = !this.showSubtitle;
      // 同步到 settings store，记录用户偏好
      this.$store.dispatch('settings/updateEnableSubtitle', this.showSubtitle);
    },

    /**
     * 加载本地字幕文件（由 ControlBar 按钮触发）
     * 调用主进程弹出文件选择对话框，解析后填充字幕 cue 数组
     */
    async loadSubtitleFile() {
      try {
        const result = await window.electronAPI.subtitleParseFile();
        if (!result || result.canceled) return;
        if (!result.success) {
          this.$notify?.error('字幕加载失败', result.error || '未知错误');
          return;
        }
        this.onSubtitleLoaded(result.cues, result.format);
      } catch (e) {
        console.error('[VideoPlayer] 加载字幕失败:', e);
        this.$notify?.error('字幕加载失败', e.message || '未知错误');
      }
    },

    /**
     * 字幕加载完成后的统一处理
     * @param {Array} cues - 字幕 cue 数组
     * @param {string} [format] - 字幕格式（srt/vtt/ass）
     */
    onSubtitleLoaded(cues, format) {
      const count = Array.isArray(cues) ? cues.length : 0;
      if (count === 0) {
        this.$notify?.warning('字幕', '字幕文件无有效内容');
        return;
      }
      this.subtitleCues = cues;
      this.showSubtitle = true;
      // 同步到 settings store
      this.$store.dispatch('settings/updateEnableSubtitle', true);
      // 通知字幕层重置查找状态
      this.$nextTick(() => {
        if (this.$refs.subtitleLayer) {
          this.$refs.subtitleLayer.onSeek(this.currentTime || 0);
        }
      });
      this.$notify?.success('字幕已加载', `共 ${count} 条（${format || 'srt'}）`);
    },

    /**
     * 在线搜索字幕（由 ControlBar 按钮触发）
     * 使用当前番剧名作为关键词，调用 OpenSubtitles API
     * 需要用户在设置中配置 API Key
     */
    async onSubtitleSearch() {
      const keyword = this.danmakuAnimeName;
      if (!keyword) {
        this.$notify?.warning('字幕搜索', '当前视频没有番剧信息，无法搜索');
        return;
      }
      if (!this.openSubtitlesApiKey) {
        this.$notify?.warning('字幕搜索', '请先在设置中配置 OpenSubtitles API Key');
        return;
      }

      this.subtitleSearchVisible = true;
      this.subtitleSearchLoading = true;
      this.subtitleSearchError = '';
      this.subtitleSearchResults = [];

      try {
        const result = await window.electronAPI.subtitleSearch(keyword, 'zh');
        if (!result || !result.success) {
          this.subtitleSearchError = result?.error || '搜索失败';
          this.$notify?.error('字幕搜索失败', this.subtitleSearchError);
          return;
        }
        this.subtitleSearchResults = result.results || [];
        if (this.subtitleSearchResults.length === 0) {
          this.$notify?.info('字幕搜索', '未找到匹配的字幕');
        }
      } catch (e) {
        console.error('[VideoPlayer] 在线搜索字幕失败:', e);
        this.subtitleSearchError = e.message || '未知错误';
        this.$notify?.error('字幕搜索失败', e.message || '未知错误');
      } finally {
        this.subtitleSearchLoading = false;
      }
    },

    /**
     * 下载并应用在线搜索到的字幕
     * @param {Object} item - 搜索结果项 { fileId, title, ... }
     */
    async applyOnlineSubtitle(item) {
      if (!item?.fileId) {
        this.$notify?.warning('字幕下载', '字幕条目缺少 fileId');
        return;
      }
      try {
        this.$notify?.info('字幕下载', '正在下载字幕文件...');
        const downloadResult = await window.electronAPI.subtitleDownload(item.fileId);
        if (!downloadResult || !downloadResult.success) {
          this.$notify?.error('字幕下载失败', downloadResult?.error || '未知错误');
          return;
        }
        // 解析下载的字幕内容
        const parseResult = await window.electronAPI.subtitleParseContent(downloadResult.content);
        if (!parseResult || !parseResult.success) {
          this.$notify?.error('字幕解析失败', parseResult?.error || '未知错误');
          return;
        }
        this.subtitleSearchVisible = false;
        this.onSubtitleLoaded(parseResult.cues, parseResult.format);
      } catch (e) {
        console.error('[VideoPlayer] 下载在线字幕失败:', e);
        this.$notify?.error('字幕下载失败', e.message || '未知错误');
      }
    },

    /**
     * 关闭字幕搜索面板
     */
    closeSubtitleSearchPanel() {
      this.subtitleSearchVisible = false;
    },

    // ===== 投屏相关方法 =====

    /**
     * 切换投屏对话框显隐（由 ControlBar 投屏按钮触发）
     */
    onCastToggle() {
      this.castDialogVisible = !this.castDialogVisible;
    },

    /**
     * 投屏开始：暂停本地播放器（避免双端同时播放）
     */
    onCastStart() {
      this.casting = true;
      const video = this.$refs.videoElement;
      if (video && !video.paused) {
        this.pausePlayback('cast');
      }
      this.setPlaying(false);
    },

    /**
     * 投屏停止：恢复本地播放器状态
     */
    onCastStop() {
      this.casting = false;
    },

    // ===== 一起看（同步播放）相关方法 =====

    /**
     * 切换"一起看"面板显隐（由 ControlBar 按钮触发）
     */
    onWatchTogetherToggle() {
      this.watchTogetherPanelVisible = !this.watchTogetherPanelVisible;
    },

    /**
     * 房间状态变化回调（由 WatchTogetherPanel 触发）
     * 同步本组件状态、启动/停止主机广播定时器
     */
    onWtRoomChanged(roomInfo) {
      const prevActive = this.watchTogetherActive;
      this.wtRoomInfo = {
        isHost: !!roomInfo?.isHost,
        roomCode: roomInfo?.roomCode || null
      };
      this.watchTogetherActive = !!roomInfo?.roomCode;

      // 进入/退出房间时同步状态
      if (this.watchTogetherActive && !prevActive) {
        // 刚进入房间：主机则启动周期广播，成员则等待同步
        if (this.wtRoomInfo.isHost) {
          this.startWtHostBroadcast();
        }
      } else if (!this.watchTogetherActive && prevActive) {
        // 离开房间：清理定时器
        this.stopWtHostBroadcast();
      }

      // 角色切换时调整定时器
      if (this.watchTogetherActive && !this.wtRoomInfo.isHost) {
        this.stopWtHostBroadcast();
      }
    },

    /**
     * 主机：启动周期性广播播放状态（每 2 秒一次）
     */
    startWtHostBroadcast() {
      this.stopWtHostBroadcast();
      this.wtHostBroadcastTimer = setInterval(() => {
        this.broadcastWtState();
      }, 2000);
      // 立即广播一次，让新成员尽快同步
      this.broadcastWtState();
    },

    stopWtHostBroadcast() {
      if (this.wtHostBroadcastTimer) {
        clearInterval(this.wtHostBroadcastTimer);
        this.wtHostBroadcastTimer = null;
      }
    },

    /**
     * 主机：广播当前播放状态给所有成员
     */
    broadcastWtState() {
      if (!this.wtRoomInfo.isHost || !this.watchTogetherActive) return;
      if (!window.electronAPI?.wtBroadcastState) return;
      const video = this.$refs.videoElement;
      const state = {
        isPlaying: this.isPlaying,
        currentTime: video?.currentTime || this.currentTime || 0,
        duration: video?.duration || this.duration || 0,
        playbackRate: this.playbackRate || 1,
        episodeIndex: this.currentVideo?.episode?.index ?? -1,
        episodeTitle: this.currentVideo?.episode?.title || '',
        videoUrl: this.currentVideo?.url || ''
      };
      try {
        window.electronAPI.wtBroadcastState(state);
      } catch (_) { /* ignore */ }
    },

    /**
     * 成员：处理主机发来的同步消息，对齐本地播放器
     */
    applyWtSyncState(state) {
      if (this.wtRoomInfo.isHost) return; // 主机不需要同步自己
      const video = this.$refs.videoElement;
      if (!video) return;

      this.wtApplyingRemoteState = true;
      try {
        // 1. 对齐播放/暂停状态
        if (state.isPlaying && video.paused) {
          this.requestPlayback('watch-together');
        } else if (!state.isPlaying && !video.paused) {
          this.pausePlayback('watch-together');
        }

        // 2. 对齐播放进度（时间差 > 1.5s 才 seek，避免频繁跳动）
        const targetTime = Number(state.currentTime) || 0;
        const localTime = video.currentTime || 0;
        const diff = Math.abs(targetTime - localTime);
        const now = Date.now();
        if (diff > 1.5 && now - this.wtLastSeekAt > 800) {
          this.wtLastSeekAt = now;
          if (isFinite(targetTime)) {
            this.markIntentionalSeek();
            video.currentTime = Math.max(0, Math.min(targetTime, video.duration || targetTime));
            // 通知弹幕/字幕层重置
            if (this.$refs.danmakuLayer) {
              this.$refs.danmakuLayer.onSeek(video.currentTime);
            }
            if (this.$refs.subtitleLayer) {
              this.$refs.subtitleLayer.onSeek(video.currentTime);
            }
          }
        }

        // 3. 对齐倍速
        if (state.playbackRate && Math.abs(state.playbackRate - (video.playbackRate || 1)) > 0.01) {
          video.playbackRate = state.playbackRate;
          this.setPlaybackRate(state.playbackRate);
        }
      } finally {
        // 异步释放标志位，让本轮事件回调跳过广播；纳入 pendingTimers 跟踪避免卸载后执行
        this.trackTimer(setTimeout(() => { this.wtApplyingRemoteState = false; }, 0));
      }
    },

    /**
     * 收到主进程推送的"一起看"消息
     */
    onWtMessage(msg) {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'sync':
          this.applyWtSyncState(msg.state || {});
          break;
        case 'joined':
          // 成员加入房间成功
          this.wtRoomInfo = { isHost: false, roomCode: msg.roomCode };
          this.watchTogetherActive = !!msg.roomCode;
          break;
        case 'member-joined':
          // 有新成员加入，主机立即广播一次状态让其同步
          if (this.wtRoomInfo.isHost) {
            this.broadcastWtState();
          }
          break;
        case 'room-closed':
        case 'left':
          this.stopWtHostBroadcast();
          this.wtRoomInfo = { isHost: false, roomCode: null };
          this.watchTogetherActive = false;
          break;
        default:
          break;
      }
    }
  },

  watch: {
    'currentVideo.url': {
      handler(newUrl, oldUrl) {
        // 切换视频前先保存"旧视频"的进度
        // 注意：此时 currentVideo 已是新视频，必须用 playedSnapshot（旧视频快照）
        // 否则会把旧视频的 currentTime 写到新视频的记录里，造成进度错乱
        if (oldUrl && this.playedSnapshot) {
          this.savePlayProgress(this.playedSnapshot);
        }
        if (newUrl && newUrl !== oldUrl) {
          this.anime4kRuntime = this.anime4kEnabled
            ? { active: false, presenting: false, state: 'initializing' }
            : { active: false, presenting: false };
          this.danmakuRuntimeState = this.danmakuEnabled ? 'loading' : 'idle';
          this.scheduleVideoInitialization(120);
          // 切换视频时清空旧字幕（新视频需要重新加载字幕）
          this.subtitleCues = [];
          this.showSubtitle = false;
        } else if (!newUrl && oldUrl) {
          this.clearTrackedTimers();
          this.mediaLoadGeneration += 1;
          this.forceStopAndClean('source-cleared');
        }
      },
      immediate: true
    },
    // OpenSubtitles API Key 变化时同步到主进程
    openSubtitlesApiKey(val) {
      if (window.electronAPI?.subtitleSetApiKey) {
        window.electronAPI.subtitleSetApiKey(val || '').catch(() => {});
      }
    }
  },

  mounted() {
    document.addEventListener('keydown', this.handleKeyPress);

    // 监听全屏变化
    this._fullscreenHandler = () => {
      this.setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', this._fullscreenHandler);

    // 双击全屏（具名 handler：先取消待执行的单击暂停，再切全屏）
    this._onDblClick = () => {
      clearTimeout(this._clickToggleTimer);
      this._clickToggleTimer = null;
      this.toggleFullscreen();
    };
    this.$el?.addEventListener('dblclick', this._onDblClick);

    // 同步字幕设置到主进程（OpenSubtitles API Key）
    // 主进程的 SubtitleService 需要此 Key 才能调用在线搜索
    if (this.openSubtitlesApiKey && window.electronAPI?.subtitleSetApiKey) {
      window.electronAPI.subtitleSetApiKey(this.openSubtitlesApiKey).catch(() => {});
    }
    // 应用设置中的字幕开关偏好
    this.showSubtitle = !!this.enableSubtitle && this.subtitleCues.length > 0;

    // 订阅"一起看"主进程消息
    if (window.electronAPI?.onWtMessage) {
      this.wtUnsubscribe = window.electronAPI.onWtMessage((msg) => {
        this.onWtMessage(msg);
      });
    }
  },

  beforeUnmount() {
    document.removeEventListener('keydown', this.handleKeyPress);
    document.removeEventListener('fullscreenchange', this._fullscreenHandler);
    this.$el?.removeEventListener('dblclick', this._onDblClick);
    clearTimeout(this._clickToggleTimer);
    this._clickToggleTimer = null;
    clearTimeout(this._osdTimer);
    this._osdTimer = null;

    // 保存最终播放进度
    this.savePlayProgress();
    this.stopProgressSave();
    // Cancel deferred source work before releasing the media element. Reuse the
    // source-switch teardown so decoders, connections and frame callbacks exit.
    this.clearTrackedTimers();
    this.forceStopAndClean('window-closed');

    // 如果正在投屏，通知主进程停止
    if (this.casting && window.electronAPI?.dlnaStop) {
      window.electronAPI.dlnaStop().catch(() => {});
    }
    this.casting = false;

    // 清理"一起看"相关资源：定时器与消息订阅
    this.stopWtHostBroadcast();
    if (this.wtUnsubscribe) {
      this.wtUnsubscribe();
      this.wtUnsubscribe = null;
    }

    // 清理所有跟踪的 setTimeout，防止组件卸载后仍触发 initializeVideo 创建 Hls 导致泄漏
    if (this.playFeedbackTimer) {
      clearTimeout(this.playFeedbackTimer);
    }
    if (this._adSkipNoticeTimer) {
      clearTimeout(this._adSkipNoticeTimer);
      this._adSkipNoticeTimer = null;
    }
    if (this.danmakuNoticeTimer) {
      clearTimeout(this.danmakuNoticeTimer);
      this.danmakuNoticeTimer = null;
    }
    if (this.hideControlsTimer) {
      clearTimeout(this.hideControlsTimer);
    }
    if (this._volumeSaveTimer) {
      clearTimeout(this._volumeSaveTimer);
      this._volumeSaveTimer = null;
      if (this.$refs.videoElement) {
        localStorage.setItem('player-volume', String(this.$refs.videoElement.volume));
      }
    }
  }
};
</script>

<style scoped>
.video-player-container {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--player-bg);
  cursor: pointer;
  user-select: none;
}

.video-element {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

/* ===== 覆盖层（加载/错误） ===== */
.video-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
}

.video-loading {
  background: rgba(0, 0, 0, 0.88);
}

.video-buffering {
  background: rgba(0, 0, 0, 0.3);
}

.buffering-text {
  margin: 0;
  color: rgba(255, 255, 255, 0.78);
  font-size: 12px;
  text-shadow: 0 1px 5px rgba(0, 0, 0, 0.7);
}

.ad-skip-notice {
  position: absolute;
  left: 50%;
  bottom: 96px;
  z-index: 48;
  transform: translateX(-50%);
  padding: 7px 12px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(20, 19, 29, 0.9);
  color: rgba(255, 255, 255, 0.92);
  font-size: 12px;
  pointer-events: none;
}

.danmaku-notice {
  position: absolute;
  top: 54px;
  left: 50%;
  z-index: 52;
  max-width: min(560px, calc(100% - 32px));
  transform: translateX(-50%);
  padding: 8px 13px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(20, 19, 29, 0.9);
  color: rgba(255, 255, 255, 0.94);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
  backdrop-filter: blur(8px);
}

.danmaku-notice.is-loading {
  color: #8fe9ff;
  border-color: rgba(99, 210, 240, 0.38);
}

.danmaku-notice.is-success {
  color: #a8f0cd;
  border-color: rgba(98, 220, 159, 0.38);
}

.danmaku-notice.is-warning,
.danmaku-notice.is-error {
  color: #ffb2ca;
  border-color: rgba(var(--primary-rgb), 0.42);
}

.video-recovering {
  background: rgba(0, 0, 0, 0.76);
  z-index: 42;
}

.video-error {
  background:
    radial-gradient(circle at center, rgba(var(--primary-rgb), 0.12), transparent 36%),
    rgba(0, 0, 0, 0.9);
  pointer-events: auto;
}

/* ===== 加载动画 ===== */
.player-loading-mascot {
  width: 85px;
  height: 120px;
  margin-bottom: 8px;
  background: var(--sakura-mascot-image) center bottom / contain no-repeat;
  filter: drop-shadow(0 18px 24px rgba(var(--primary-rgb), 0.35));
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 0;
  background: var(--sakurafall-mark-image) center / contain no-repeat;
  filter: drop-shadow(0 5px 8px rgba(var(--primary-rgb), 0.32));
  animation: brand-buffer 0.72s ease-in-out infinite;
  margin-bottom: 16px;
}

.loading-text {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
  margin: 0;
  letter-spacing: 0;
}

/* ===== 错误状态 ===== */
.error-icon {
  margin-bottom: 12px;
}

.error-text {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
  margin: 0 0 16px 0;
  text-align: center;
  max-width: 280px;
  line-height: 1.5;
}

.error-diagnostic,
.recovering-detail {
  max-width: min(520px, calc(100% - 48px));
  margin: -6px 0 14px;
  color: rgba(255, 255, 255, 0.48);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
}

/* ===== Phase 5: 失败分类徽章与说明 ===== */
.error-category-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  margin-bottom: 14px;
  font-size: 13px;
  font-weight: 700;
  background: rgba(255, 107, 107, 0.18);
  color: #ffb3b3;
  border: 1px solid rgba(255, 107, 107, 0.35);
}

.error-category-badge .badge-icon {
  font-size: 16px;
  line-height: 1;
}

.error-category-badge.badge-network-blocked {
  background: rgba(255, 193, 7, 0.18);
  color: #f1c85b;
  border-color: rgba(255, 193, 7, 0.4);
}

.error-category-badge.badge-cors-referer {
  background: rgba(255, 152, 0, 0.18);
  color: #ffb74d;
  border-color: rgba(255, 152, 0, 0.4);
}

.error-category-badge.badge-hls-decode {
  background: rgba(156, 123, 255, 0.18);
  color: #b39ddb;
  border-color: rgba(156, 123, 255, 0.4);
}

.error-category-badge.badge-format-unsupported {
  background: rgba(66, 199, 238, 0.18);
  color: #7ef3e8;
  border-color: rgba(66, 199, 238, 0.4);
}

.error-category-badge.badge-resolver-timeout {
  background: rgba(255, 138, 176, 0.18);
  color: #ff8ab0;
  border-color: rgba(255, 138, 176, 0.4);
}

.error-category-badge.badge-invalid-source {
  background: rgba(255, 107, 107, 0.18);
  color: #ff8a8a;
  border-color: rgba(255, 107, 107, 0.4);
}

.error-category-badge.badge-cancelled,
.error-category-badge.badge-unknown {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  border-color: rgba(255, 255, 255, 0.18);
}

.error-description {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.56);
  margin: 0 0 8px;
  max-width: min(440px, calc(100% - 48px));
  line-height: 1.55;
  text-align: center;
}

.error-suggestion {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.68);
  margin: 0 0 18px;
  max-width: min(440px, calc(100% - 48px));
  line-height: 1.55;
  text-align: center;
}

.recovering-title {
  margin: 0 0 10px;
  color: rgba(255, 255, 255, 0.82);
  font-size: 14px;
  font-weight: 700;
}

.recovering-detail {
  margin: 0;
}

.retry-btn {
  padding: 7px 22px;
  background: linear-gradient(135deg, var(--player-progress), var(--accent-lavender));
  color: var(--text-inverse);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.2s;
}

.retry-btn:hover {
  filter: brightness(1.08);
}

.error-actions {
  display: flex;
  gap: 10px;
  margin-top: 4px;
}

.fallback-btn {
  padding: 7px 22px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.fallback-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  border-color: rgba(255, 255, 255, 0.5);
}

.source-switch-btn {
  position: absolute;
  right: 18px;
  top: 18px;
  z-index: 18;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 8px;
  background: rgba(13, 12, 25, 0.68);
  color: rgba(255, 255, 255, 0.88);
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
}

.source-switch-btn:hover {
  background: rgba(var(--primary-rgb), 0.25);
  border-color: rgba(var(--primary-rgb), 0.55);
}

.source-status-pill {
  position: absolute;
  right: 18px;
  top: 58px;
  z-index: 18;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(360px, calc(100% - 36px));
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background: rgba(13, 12, 25, 0.58);
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  font-weight: 700;
  cursor: default;
}

.source-status-pill span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-status-pill .playback-stats {
  flex-shrink: 0;
  overflow: visible;
  color: rgba(144, 231, 255, 0.94);
  font-variant-numeric: tabular-nums;
}

.source-panel-overlay {
  z-index: 45;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.58);
}

.source-panel {
  width: min(560px, calc(100% - 32px));
  max-height: min(78vh, 540px);
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid rgba(255, 138, 176, 0.16);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(31, 27, 48, 0.96), rgba(18, 17, 31, 0.96)),
    var(--app-ambient-bg) right top / 480px auto no-repeat;
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.28);
}

.source-panel-header,
.subtitle-search-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.source-panel-header h3,
.subtitle-search-header h3 {
  margin: 0;
  color: rgba(255, 255, 255, 0.94);
  font-size: 17px;
}

.source-panel-header p,
.subtitle-search-header p {
  margin: 5px 0 0;
  color: rgba(255, 255, 255, 0.56);
  font-size: 12px;
}

.source-panel-close,
.subtitle-search-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.74);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
}

.source-panel-close:hover,
.subtitle-search-close:hover {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
}

.source-panel-state,
.subtitle-search-state {
  min-height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.68);
  font-size: 13px;
}

.source-panel-state.error,
.subtitle-search-state.error {
  color: #ff8a8a;
}

.loading-spinner.small {
  width: 22px;
  height: 22px;
  margin: 0;
}

.source-candidate-list,
.subtitle-search-list {
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.source-candidate,
.subtitle-search-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 58px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.055);
  color: #fff;
  cursor: pointer;
  text-align: left;
  transition: background 0.2s, border-color 0.2s;
}

.source-candidate:hover,
.subtitle-search-item:hover {
  background: rgba(var(--primary-rgb), 0.13);
  border-color: rgba(var(--primary-rgb), 0.35);
}

.candidate-main,
.subtitle-item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.candidate-source {
  font-size: 14px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.94);
}

.candidate-episode {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.54);
}

.candidate-meta,
.subtitle-item-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.candidate-chip,
.subtitle-item-chip {
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.candidate-chip.quality {
  color: #8ee6dc;
  background: rgba(78, 205, 196, 0.16);
}

.candidate-chip.health-good {
  color: #6ee68f;
  background: rgba(45, 211, 111, 0.16);
}

.candidate-chip.health-warn {
  color: #f1c85b;
  background: rgba(255, 193, 7, 0.16);
}

.candidate-chip.health-bad {
  color: #ff8a8a;
  background: rgba(255, 107, 107, 0.16);
}

.candidate-chip.issue-ad {
  color: #ffb36b;
  background: rgba(255, 157, 72, 0.15);
}

.source-skipped {
  margin-top: 10px;
  color: rgba(255, 255, 255, 0.46);
  font-size: 12px;
}

@media (max-width: 600px) {
  .source-switch-btn {
    right: 12px;
    top: 12px;
  }

  .source-status-pill {
    right: 12px;
    top: 52px;
  }

  .source-panel,
  .subtitle-search-panel {
    max-height: min(82vh, 560px);
    padding: 14px;
  }

  .source-candidate,
  .subtitle-search-item {
    align-items: flex-start;
    flex-direction: column;
  }

  .candidate-meta,
  .subtitle-item-meta {
    justify-content: flex-start;
  }

  .candidate-episode,
  .subtitle-item-title {
    max-width: 100%;
  }
}

/* ===== 中央播放按钮 ===== */
.center-play-btn {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 72px;
  height: 72px;
  background: radial-gradient(circle, rgba(var(--primary-rgb), 0.82), rgba(101, 65, 126, 0.78));
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  cursor: pointer;
  transition: background 0.2s;
}

.center-play-btn:hover {
  background: radial-gradient(circle, rgba(var(--primary-rgb), 0.94), rgba(101, 65, 126, 0.88));
}

.center-play-btn svg {
  margin-left: 4px;
}

/* ===== 播放/暂停闪烁反馈 ===== */
.play-feedback {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 60px;
  height: 60px;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 25;
  pointer-events: none;
}

/* ===== 快进/快退/音量 OSD：中央图标 + 文本，一次性弹出后淡出 ===== */
.player-osd {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 26px;
  border-radius: 18px;
  background: rgba(10, 8, 14, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 26;
  pointer-events: none;
  animation: osd-pop 0.65s var(--ease-smooth) forwards;
}

.osd-label {
  color: rgba(255, 255, 255, 0.92);
  font-size: 15px;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}

@keyframes osd-pop {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.82); }
  18% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  72% { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1.02); }
}

/* ===== 播放中控制栏隐藏时，鼠标光标一并隐藏（沉浸观影） ===== */
.video-player-container.controls-idle {
  cursor: none;
}

/* ===== 闪烁反馈过渡 ===== */
.fade-enter-active {
  transition: opacity 0.15s ease;
}
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@keyframes brand-buffer {
  0%, 100% { transform: scale(0.9); opacity: 0.58; }
  50% { transform: scale(1); opacity: 1; }
}

/* ===== 字幕在线搜索面板 ===== */
.subtitle-search-overlay {
  z-index: 46;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.58);
}

.subtitle-search-panel {
  width: min(520px, calc(100% - 32px));
  max-height: min(78vh, 540px);
  display: flex;
  flex-direction: column;
  padding: 16px;
  border: 1px solid rgba(255, 138, 176, 0.16);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(31, 27, 48, 0.96), rgba(18, 17, 31, 0.96));
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.28);
}

/* 其余面板样式与 source-panel 系列共享，见上方组合选择器 */
.subtitle-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
  font-size: 13px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.94);
}

.subtitle-item-lang {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.54);
}
</style>
