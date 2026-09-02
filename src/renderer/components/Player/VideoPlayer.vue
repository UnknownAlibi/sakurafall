<template>
  <div
    class="video-player-container"
    :class="{ 'controls-idle': !controlsVisible && (isPlaying || isFullscreen) && !loading && !error && !buffering }"
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

    <div v-if="danmakuMatchVisible" class="video-overlay danmaku-match-overlay" @click.self="closeDanmakuMatchPanel">
      <div class="danmaku-match-panel">
        <header>
          <div>
            <h3>校正弹幕匹配</h3>
            <p>{{ danmakuAnimeName }} · 第 {{ danmakuEpisodeNumber || '?' }} 集</p>
          </div>
          <button type="button" @click="closeDanmakuMatchPanel" title="关闭">×</button>
        </header>
        <div v-if="danmakuMatchLoading" class="danmaku-match-state">
          <div class="loading-spinner small"></div><span>正在搜索各平台番剧库...</span>
        </div>
        <div v-else-if="!danmakuMatchGroups.some(group => group.candidates?.length)" class="danmaku-match-state">
          暂未找到可校正的候选，仍可导入本地 XML 或配置自定义接口
        </div>
        <div v-else class="danmaku-match-groups">
          <section v-for="group in danmakuMatchGroups" :key="group.id" v-show="group.candidates?.length">
            <div class="danmaku-match-source">
              <strong>{{ group.name }}</strong><span>{{ group.candidates.length }} 个候选</span>
            </div>
            <button
              v-for="candidate in group.candidates"
              :key="`${group.id}-${candidate.id}`"
              type="button"
              class="danmaku-match-candidate"
              @click="applyDanmakuMatch(group.id, candidate)"
            >
              <span>{{ candidate.title }}</span>
              <small>匹配度 {{ Math.round((candidate.score || 0) * 100) }}%</small>
            </button>
          </section>
        </div>
      </div>
    </div>

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

    <button v-if="!loading && !error && currentVideo?.anime?.name && controlsVisible" class="source-switch-btn" title="SakuraRoute 智能线路" @click.stop="switchToSameEpisode">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/><path d="M18 7l-5 5"/><path d="M6 17l5-5"/>
      </svg>
      <span>线路</span>
    </button>

    <div v-show="!loading && !error && !autoRecovering && controlsVisible && (routeStatus.active || currentSourceLabel || playbackStatsLabel || anime4kRuntime.presenting)" class="source-status-pill">
      <span v-if="routeStatus.active" class="sakura-route-state" :class="`is-${routeStatus.phase}`" :title="routeStatus.detail">
        <i aria-hidden="true"></i>{{ routeStatus.label }}
      </span>
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
            <h3>SakuraRoute 智能线路</h3>
            <p>{{ currentVideo?.episode?.title || currentVideo?.anime?.name || '当前视频' }} · {{ routeStatus.detail }}</p>
          </div>
          <button class="source-panel-close" @click="closeSourcePanel" title="关闭">×</button>
        </div>

        <div v-if="sourcePanelLoading" class="source-panel-state">
          <div class="loading-spinner small"></div>
          <span>正在解析剧集并预检线路...</span>
        </div>
        <template v-else>
          <div v-if="sourcePanelResolving" class="source-panel-state resolving">
            <div class="loading-spinner small"></div>
            <span>正在解析 {{ sourcePanelResolving.sourceName || sourcePanelResolving.sourceId || '候选源' }}，请稍候...</span>
          </div>
          <div v-else-if="sourcePanelError" class="source-panel-state error">
            {{ sourcePanelError }}
          </div>
          <div v-else-if="sourceCandidates.length === 0" class="source-panel-state">
            未找到可用候选源
          </div>
          <div v-else class="source-candidate-list">
            <button v-for="(candidate, index) in sourceCandidates" :key="`${candidate.sourceId}-${candidate.lineId}-${candidate.url}`" class="source-candidate" :class="{ recommended: index === 0, resolving: sourcePanelResolving === candidate }" @click="playSourceCandidate(candidate)">
              <span class="candidate-main">
                <span class="candidate-source">
                  {{ candidate.sourceName || candidate.sourceId }}
                  <em v-if="index === 0">推荐</em>
                  <em v-if="sourceLineCounts[candidate.sourceId] > 1 && candidate.lineId" class="line-badge">{{ formatLineName(candidate.lineId) }}</em>
                </span>
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
        </template>

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
      :anime-metadata="danmakuAnimeMetadata"
      :provider-ids="enabledDanmakuProviderIds"
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
      :danmaku-sources="danmakuSourceStatuses"
      :subtitle-enabled="showSubtitle"
      :casting="casting"
      :watch-together-active="watchTogetherActive"
      :notebook-active="notebookVisible"
      :dna-active="dnaVisible"
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
      :note-markers="noteMarkers"
      :is-muted="videoMuted"
      @controls-hover="onControlsHover"
      @note-marker-click="handleSeek"
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
      @danmaku-refresh="refreshDanmaku"
      @danmaku-correct-match="openDanmakuMatchPanel"
      @open-settings="$emit('open-settings')"
      @toggle-subtitle="toggleSubtitle"
      @subtitle-load-file="loadSubtitleFile"
      @subtitle-search="onSubtitleSearch"
      @cast-toggle="onCastToggle"
      @notebook-toggle="notebookVisible = !notebookVisible"
      @dna-toggle="dnaVisible = !dnaVisible"
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

    <!-- 一起看 P1：主机切集确认横幅 -->
    <transition name="wt-switch-fade">
      <div v-if="wtEpisodeSwitchRequest" class="wt-episode-switch">
        <div class="wt-episode-switch-body">
          <span class="wt-episode-switch-icon">📡</span>
          <span class="wt-episode-switch-text">
            主机已切到第 {{ wtEpisodeSwitchRequest.episodeIndex }} 集
            <em v-if="wtEpisodeSwitchRequest.episodeTitle">{{ wtEpisodeSwitchRequest.episodeTitle }}</em>
          </span>
          <span v-if="wtEpisodeSwitching" class="wt-episode-switch-status">正在确认本地候选源...</span>
          <span v-else-if="wtEpisodeSwitchError" class="wt-episode-switch-status is-error">{{ wtEpisodeSwitchError }}</span>
          <template v-else>
            <button type="button" class="wt-switch-btn is-primary" :disabled="wtEpisodeSwitching" @click="followWtEpisode">跟随主机</button>
            <button type="button" class="wt-switch-btn" :disabled="wtEpisodeSwitching" @click="dismissWtEpisodeSwitch">留在本集</button>
          </template>
        </div>
      </div>
    </transition>

    <ViewingNotebookPanel
      v-if="notebookVisible"
      :identity="currentEpisodeIdentity"
      :current-time="currentTime"
      :duration="duration"
      :source-id="getCurrentSourceId()"
      @close="notebookVisible = false"
      @seek="handleSeek"
      @changed="loadNoteMarkers"
    />

    <!-- Episode DNA：片头/片尾/广告段标记与候选确认 -->
    <EpisodeDnaPanel
      v-if="dnaVisible"
      :identity="currentEpisodeIdentity"
      :current-time="currentTime"
      :duration="duration"
      :source-id="getCurrentSourceId()"
      :dna-candidates="dnaCandidates"
      @close="dnaVisible = false"
      @seek="handleSeek"
      @changed="loadDnaAutoSkipRule"
      @rule-updated="onDnaRuleUpdated"
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
import ViewingNotebookPanel from './ViewingNotebookPanel.vue';
import EpisodeDnaPanel from './EpisodeDnaPanel.vue';
import { EpisodeDnaCollector } from '../../player/episodeDnaCollector.js';
import { analyzeIntroFeatures, destroyIntroAnalyzer } from '../../player/episodeDnaClient.js';
import {
  classifyPlaybackFailure
} from '../../utils/playbackDiagnostics.js';
import {
  formatSourceFrameRate,
  normalizeDeclaredFrameRate
} from '../../utils/playbackFrameRate.js';
import { collectHlsAdRanges, findActiveAdRange } from '../../utils/hlsAdMarkers.js';
import { toIpcPlainObject } from '../../utils/ipcPayload.js';
import { extractEpisodeNumber, formatLineName } from '../../utils/episodeList.js';
import { createEpisodeIdentity } from '../../utils/episodeIdentity.js';
import {
  beginRouteProbe,
  beginRouteSwitch,
  completeRouteProbe,
  createSakuraRouteSession,
  describeSakuraRoute,
  failRouteAttempt,
  markRouteStable,
  updateSakuraRoute
} from '../../utils/sakuraRouteSession.js';
import { formatCandidateQuality, formatMatchType, candidateHealthClass, candidateStallClass,
  formatCandidateStartup, formatCandidateRatio, candidateHealthTitle } from '../../utils/sourceCandidatePresentation.js';
import { formatAnime4kPreset, formatAnime4kRuntimeTitle } from '../../utils/anime4kPresentation.js';
import { applyRuntimeHlsBufferPolicy, toHlsBufferConfig } from '../../utils/hlsBufferPolicy.js';
import playerPlatformIntegration from '../../mixins/playerPlatformIntegration.js';
import watchTogetherMixin from '../../mixins/watchTogether.js';
import playerPlaybackLifecycle from '../../mixins/playerPlaybackLifecycle.js';
import playerPlaybackStats from '../../mixins/playerPlaybackStats.js';
import { isSuspiciousSniffedMediaEnd } from '../../utils/episodePlaybackPolicy.js';

// Automatic fallback is allowed only after serialized recovery attempts for
// the current media generation have been exhausted.
const AUTO_FALLBACK_ENABLED = true;

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
  components: { ControlBar, DanmakuLayer, SubtitleLayer, Anime4KCanvas, CastDialog, WatchTogetherPanel, ViewingNotebookPanel, EpisodeDnaPanel },
  mixins: [playerPlatformIntegration, watchTogetherMixin, playerPlaybackLifecycle, playerPlaybackStats],
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
      hlsRecoveryAttemptPending: false,
      hlsRecoveryWatchdog: null,
      playbackStartupWatchdog: null,
      nativeFallbackConfirmationPending: false,
      maxHlsRecoveryAttempts: 3,
      maxFallbackSourceAttempts: 3,
      triedFallbackSourceIds: [],
      fallbackRequestToken: 0,
      fallbackCyclePromise: null,
      fallbackCycleGeneration: -1,
      autoRecovering: false,
      recoveryMessage: '',
      lastPlaybackFailure: null,
      lastAutoFallbackCandidate: null,
      preserveFallbackSourceIdsOnce: false,
      reportedPlaybackSuccessKey: '',
      reportedPlaybackFailureKey: '',
      reportedAdvertisingKeys: [],
      mediaLoadGeneration: 0,
      activeMediaGeneration: -1,
      activeMediaMode: '',
      activeMediaUrl: '',
      playbackTransitionToken: 0,
      playbackIntent: false,
      playRetryCount: 0,
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
      danmakuSourceStatuses: [],
      danmakuMatchVisible: false,
      danmakuMatchLoading: false,
      danmakuMatchGroups: [],
      sourcePanelVisible: false,
      sourcePanelLoading: false,
      sourcePanelError: '',
      // 正在解析的候选（点击换源后到 playVideo 前的反馈状态）
      sourcePanelResolving: null,
      sourcePanelRequestToken: 0,
      sourceCandidates: [],
      sourceSkipped: [],
      sakuraRoute: createSakuraRouteSession(),
      notebookVisible: false,
      // 当前进集的手帐时光签（进度条标记数据源）
      noteMarkers: [],
      _noteMarkersToken: 0,
      // ===== Episode DNA P1 =====
      // DNA 面板是否可见
      dnaVisible: false,
      // Worker 产出的片头候选（仅建议，用户在面板中确认后生效）
      dnaCandidates: [],
      // 作品级自动跳过规则（三集稳定确认后由数据库升级）
      dnaAutoSkipRule: null,
      // 本集已应用过自动跳过的标记（identity.key），避免重复 seek
      dnaAutoSkippedKey: '',
      _dnaRuleToken: 0,
      qualityLevels: [], // hls.js 可用画质列表
      currentQuality: -1, // -1=自动, 0..n=指定画质索引
      _timeUpdateFrame: null,
      _lastCommittedTime: 0,
      _lastDurationCommit: 0,
      _lastBufferProgress: 0,
      lastPlaybackProgressAt: 0,
      lastPlaybackProgressTime: 0,
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
      casting: false
      // "一起看"相关状态与方法见 mixins/watchTogether.js
    };
  },
  computed: {
    ...mapGetters('player', ['currentVideo', 'isPlaying', 'isFullscreen', 'currentTime', 'duration', 'volume', 'playbackRate']),
    // 各源在候选面板中出现的线路数：同源多线路时在候选上标注线路名
    sourceLineCounts() {
      const counts = {};
      for (const candidate of this.sourceCandidates || []) {
        if (!candidate?.sourceId) continue;
        counts[candidate.sourceId] = (counts[candidate.sourceId] || 0) + 1;
      }
      return counts;
    },
    ...mapGetters('settings', [
      'autoPlay', 'rememberPlaybackRate', 'videoQuality', 'seekStepSeconds',
      // 弹幕设置
      'enableDanmaku', 'danmakuFontSize', 'danmakuOpacity', 'danmakuSpeed', 'danmakuDisplayArea', 'danmakuProviders',
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
    currentEpisodeIdentity() {
      return createEpisodeIdentity(this.currentVideo || {});
    },
    playbackMediaKey() {
      const video = this.currentVideo;
      if (!video?.url) return '';
      return [
        video.url,
        video.sourceId || video.anime?.sourceId || video.anime?.source || '',
        video.lineId || video.episode?.lineId || '',
        video.episodeId || video.episode?.id || video.episode?.index || ''
      ].join('|');
    },
    routeStatus() {
      return describeSakuraRoute(this.sakuraRoute);
    },
    danmakuAnimeMetadata() {
      return this.currentVideo?.anime || {};
    },
    enabledDanmakuProviderIds() {
      const configured = this.danmakuProviders || {};
      return ['bilibili', 'acfun', 'dandanplay', 'custom'].filter(id => configured[id] !== false);
    },
    // wtVideoInfoForRoom 见 mixins/watchTogether.js
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
    formatLineName,
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

    ensureSakuraRouteSession() {
      const identity = this.currentEpisodeIdentity;
      const sourceId = this.getCurrentSourceId();
      const sourceName = this.currentSourceLabel;
      if (!this.sakuraRoute?.id || this.sakuraRoute.episodeKey !== identity.key) {
        this.sakuraRoute = createSakuraRouteSession({
          episodeKey: identity.key,
          sourceId,
          sourceName
        });
      } else if (sourceId && this.sakuraRoute.phase === 'idle') {
        this.sakuraRoute = updateSakuraRoute(this.sakuraRoute, {
          currentSourceId: sourceId,
          currentSourceName: sourceName
        });
      }
      return this.sakuraRoute;
    },

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
      this.schedulePlaybackStartupWatchdog(generation, url);

      this.trackTimer(setTimeout(() => {
        if (generation !== this.mediaLoadGeneration || this.currentVideo?.url !== url) return;
        if (this.isHLSStream(url)) {
          this.initHLSPlayer(url, generation);
        } else {
          this.initNativePlayer(url, generation);
        }
      }, 80));
    },

    forceStopAndClean(reason = 'cleanup') {
      // Clear ownership before touching <video>; Chromium may synchronously emit
      // error/pause while src is removed and those events belong to the old URL.
      this.activeMediaGeneration = -1;
      this.activeMediaMode = '';
      this.activeMediaUrl = '';
      this.finalizePlaybackSession(reason);
      this.stopPlaybackStats(true);
      this.clearHlsRecoveryWatchdog();
      this.clearPlaybackStartupWatchdog();
      // Episode DNA：切源/清理时静默销毁采集器（不触发分析）
      this.stopDnaCollection(true);
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
      this.hlsRecoveryAttemptPending = false;
      this.nativeFallbackConfirmationPending = false;
      this.playRetryCount = 0;
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
      this.lastPlaybackProgressAt = 0;
      this.lastPlaybackProgressTime = 0;
      // 切换视频时重置缓冲进度，避免显示上一集的缓冲条
      this.bufferProgress = 0;
    },

    isHLSStream(url) {
      const value = String(url || '');
      return /\.m3u8(?:[?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$)/i.test(value)
        || /[?&]media=hls(?:&|$)/i.test(value);
    },

    applyHlsBufferPolicy(overrides = {}) {
      return applyRuntimeHlsBufferPolicy(this, overrides);
    },

    async initHLSPlayer(url, generation = this.mediaLoadGeneration) {
      const video = this.$refs.videoElement;

      let Hls;
      try {
        Hls = await loadHlsClass();
      } catch (error) {
        if (generation !== this.mediaLoadGeneration || this.currentVideo?.url !== url) return;
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
        const hlsInstance = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          ...toHlsBufferConfig(bufferPolicy),
          startPosition: -1,
          capLevelToPlayerSize: false,
          enableInterstitialPlayback: false
        });
        this.hls = hlsInstance;
        this.activeMediaGeneration = generation;
        this.activeMediaMode = 'hls';
        this.activeMediaUrl = url;

        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (generation !== this.mediaLoadGeneration || this.hls !== hlsInstance) return;
          this.error = null;

          // 画质优化：根据用户设置选择初始画质
          // hls.levels 按 bitrate 升序排列，索引越大画质越高
          const levels = hlsInstance.levels || [];
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
              hlsInstance.currentLevel = 0; // 最低画质
              this.currentQuality = 0;
            } else if (this.videoQuality === 'auto') {
              hlsInstance.currentLevel = -1; // 自动（由 hls.js 根据带宽决定）
              this.currentQuality = -1;
            } else {
              // 'high' 或默认：选最高画质
              hlsInstance.currentLevel = levels.length - 1;
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

        hlsInstance.on(Hls.Events.LEVEL_LOADED, (_, data) => {
          if (generation !== this.mediaLoadGeneration || this.hls !== hlsInstance) return;
          this.updateMarkedAdRanges(data?.details);
          this.applyHlsBufferPolicy({ live: data?.details?.live === true });
        });

        // 监听画质切换，同步 currentQuality 给 ControlBar
        hlsInstance.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
          if (generation !== this.mediaLoadGeneration || this.hls !== hlsInstance) return;
          this.currentQuality = data.level;
          this.updateManifestFrameRate(data.level);
          const level = hlsInstance.levels?.[data.level];
          this.applyHlsBufferPolicy({ bitrate: Number(level?.bitrate) || 0 });
        });

        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
          if (generation !== this.mediaLoadGeneration || this.hls !== hlsInstance) return;
          if (data.fatal) {
            this.handleHLSError(data, Hls, hlsInstance, generation);
          }
        });

        hlsInstance.attachMedia(video);
        hlsInstance.loadSource(url);

      } else if (video?.canPlayType('application/vnd.apple.mpegurl')) {
        this.initNativePlayer(url, generation);
      } else {
        const failure = {
          source: 'hls',
          reason: 'hls-unsupported',
          message: '当前运行环境不支持 HLS 播放',
          userMessage: '当前运行环境不支持该视频格式',
          hint: '请尝试增强播放或切换其他线路。'
        };
        this.recordPlaybackFailure(failure);
        this.setPlaybackState('recovering');
        this.autoFallbackToOtherSource(failure);
      }
    },

    initNativePlayer(url, generation = this.mediaLoadGeneration) {
      const video = this.$refs.videoElement;
      if (!video || generation !== this.mediaLoadGeneration) return;
      this.activeMediaGeneration = -1;
      this.activeMediaMode = '';
      this.activeMediaUrl = '';
      video.removeAttribute('src');
      video.load();
      video.src = url;
      this.activeMediaGeneration = generation;
      this.activeMediaMode = 'native';
      this.activeMediaUrl = url;
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

    /** 加载当前剧集的手帐时光签 → 进度条标记（带 token 防止切集后旧结果覆盖） */
    async loadNoteMarkers() {
      const identity = this.currentEpisodeIdentity;
      const episodeKey = identity?.key;
      if (!episodeKey) { this.noteMarkers = []; return; }
      const token = ++this._noteMarkersToken;
      try {
        const notes = await window.electronAPI?.viewingNoteList?.(episodeKey, 300) || [];
        if (token !== this._noteMarkersToken) return; // 已切到其他集，丢弃
        this.noteMarkers = (Array.isArray(notes) ? notes : [])
          .map(note => ({
            id: note.id,
            position: Number(note.position) || 0,
            category: note.category || '',
            note: note.note || ''
          }))
          .sort((a, b) => a.position - b.position);
      } catch (error) {
        if (token === this._noteMarkersToken) this.noteMarkers = [];
      }
    },

    // ===== Episode DNA P1：特征采集 → Worker 分析 → 候选确认 =====

    /** 播放开始后启动低频被动采集（每集仅一次，采集 4 分钟窗口） */
    startDnaCollection() {
      const video = this.$refs.videoElement;
      if (this._dnaCollector || !video || !this.currentEpisodeIdentity?.key) return;
      if (this.casting || this.watchTogetherActive) return; // 投屏/同步播放时不采集
      try {
        this._dnaCollector = new EpisodeDnaCollector(video, {
          windowMs: 500,
          maxSeconds: 240,
          onDone: (features) => this.onDnaCollectionDone(features)
        });
        this._dnaCollector.start();
      } catch (_) {
        this._dnaCollector = null;
      }
    },

    /** 采集完成（或超窗）后交给 Worker 分析片头候选 */
    stopDnaCollection(silent = false) {
      if (!this._dnaCollector) return;
      const collector = this._dnaCollector;
      this._dnaCollector = null;
      if (silent) collector.destroy();
      else collector.stop();
    },

    async onDnaCollectionDone(features) {
      if (this._dnaCollector) {
        this._dnaCollector = null;
      }
      if (!features) return; // 数据不足或全降级，静默放弃
      const episodeKey = this.currentEpisodeIdentity?.key;
      try {
        const candidates = await analyzeIntroFeatures(features);
        if (!episodeKey || episodeKey !== this.currentEpisodeIdentity?.key) return; // 已切集，丢弃
        this.dnaCandidates = Array.isArray(candidates) ? candidates : [];
      } catch (_) {
        // Worker 异常不影响播放，候选保持为空
      }
    },

    /** 加载作品级自动跳过规则（三集稳定确认后生效） */
    async loadDnaAutoSkipRule() {
      const identity = this.currentEpisodeIdentity;
      if (!identity?.workKey) {
        this.dnaAutoSkipRule = null;
        return;
      }
      const token = ++this._dnaRuleToken;
      try {
        const rule = await window.electronAPI?.episodeSegmentAutoSkipRule?.(identity.bgmId, identity.workKey);
        if (token !== this._dnaRuleToken) return;
        this.dnaAutoSkipRule = rule || null;
      } catch (_) {
        if (token === this._dnaRuleToken) this.dnaAutoSkipRule = null;
      }
    },

    /** 面板保存后规则升级（达到 3 集稳定）时立即生效 */
    onDnaRuleUpdated(rule) {
      this.dnaAutoSkipRule = rule || null;
      this.dnaAutoSkippedKey = '';
    },

    /** 三集稳定确认后的片头自动跳过（timeupdate 驱动） */
    maybeAutoSkipDnaIntro(currentTime) {
      const rule = this.dnaAutoSkipRule;
      const episodeKey = this.currentEpisodeIdentity?.key;
      if (!rule || !episodeKey || this.dnaAutoSkippedKey === episodeKey) return;
      // 一起看同步中不自动跳，避免破坏房间时钟
      if (this.watchTogetherActive || this.casting) return;
      const start = Number(rule.start) || 0;
      const end = Number(rule.end) || 0;
      if (end <= start || currentTime < start || currentTime >= end - 0.5) return;
      const video = this.$refs.videoElement;
      if (!video) return;
      this.dnaAutoSkippedKey = episodeKey;
      this.markIntentionalSeek?.();
      video.currentTime = Math.min(end + 0.05, video.duration || end + 0.05);
      this.adSkipNotice = `已自动跳过片头 ${Math.max(1, Math.round(end - currentTime))} 秒`;
      if (this._adSkipNoticeTimer) clearTimeout(this._adSkipNoticeTimer);
      this._adSkipNoticeTimer = setTimeout(() => {
        this._adSkipNoticeTimer = null;
        this.adSkipNotice = '';
      }, 2200);
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
      this.ensureSakuraRouteSession();
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

    closeSourcePanel() {
      this.sourcePanelRequestToken += 1;
      this.sourcePanelVisible = false;
      this.sourcePanelLoading = false;
      this.sourcePanelResolving = null;
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
      this.sakuraRoute = beginRouteProbe(this.ensureSakuraRouteSession());

      try {
        const result = await window.electronAPI.cmsMultiSelectBestEpisodeSource(animeName, {
          episodeTitle: this.currentVideo?.episode?.title || '',
          episodeIndex: this.currentVideo?.episode?.index ?? -1,
          excludeSourceIds,
          allowFirstFallback: true,
          routePreference: this.$store.state.settings.routePreference || 'stability'
        });
        if (requestToken !== this.sourcePanelRequestToken || result?.cancelled) return;

        const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        this.sourceCandidates = candidates.filter(candidate => candidate?.url);
        this.sourceSkipped = result?.skipped || [];
        this.sakuraRoute = completeRouteProbe(this.sakuraRoute, this.sourceCandidates, this.sourceSkipped);
        // SakuraRoute P1：候选面板打开后并行预热前两条候选线路（清单+极小分片），用户点击播放时即可命中缓存
        this.preheatTopCandidates(this.sourceCandidates);
        if (result?.error && this.sourceCandidates.length === 0) {
          this.sourcePanelError = result.error;
        }
      } catch (error) {
        if (requestToken !== this.sourcePanelRequestToken) return;
        this.sourcePanelError = error.message || '加载候选源失败';
        this.sakuraRoute = failRouteAttempt(this.sakuraRoute, error);
      } finally {
        if (requestToken === this.sourcePanelRequestToken) {
          this.sourcePanelLoading = false;
        }
      }
    },

    // SakuraRoute P1：并行预热前两条候选线路，fire-and-forget，失败不影响选线流程
    preheatTopCandidates(candidates = []) {
      if (!window.electronAPI?.cmsPreheatCandidates) return;
      const top = (Array.isArray(candidates) ? candidates : [])
        .slice(0, 2)
        .map(candidate => ({ sourceId: candidate?.sourceId || '', url: candidate?.url || '' }))
        .filter(item => item.url && /^https?:\/\//i.test(item.url));
      if (top.length === 0) return;
      window.electronAPI.cmsPreheatCandidates(top)
        .then(result => {
          if (result?.preheated > 0) {
            this.sakuraRoute = { ...this.sakuraRoute, preheatedLines: result.preheated };
          }
        })
        .catch(() => { /* 预热失败静默忽略 */ });
    },

    async playSourceCandidate(candidate, options = {}) {
      const plainCandidate = toIpcPlainObject(candidate, null);
      if (!plainCandidate?.url || !plainCandidate?.anime || !plainCandidate?.episode) {
        this.sourcePanelError = '候选源数据不完整';
        return false;
      }

      const manualRequestToken = typeof options.isCurrent === 'function'
        ? 0
        : ++this.sourcePanelRequestToken;
      const isCandidateCurrent = () => (
        (manualRequestToken === 0 || manualRequestToken === this.sourcePanelRequestToken)
        && (typeof options.isCurrent !== 'function' || options.isCurrent())
      );

      try {
        const resumeAt = Number(this.$refs.videoElement?.currentTime) || Number(this.currentTime) || 0;
        this.sakuraRoute = beginRouteSwitch(this.ensureSakuraRouteSession(), plainCandidate, resumeAt);
        this.rememberFallbackAttempt(plainCandidate.sourceId, plainCandidate.providerId, plainCandidate.lineId);
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
          // 解析中反馈：慢源（分享页解析/webview 嗅探）需要数秒，无反馈会被误以为
          // 没点上而重复点击，第二次点击的解析会把本次全局取消。
          // 存原始引用（而非 plainCandidate 拷贝），保证模板 :class 高亮比对生效
          this.sourcePanelResolving = candidate;
          this.sourcePanelError = '';
          resolvedVideo = await window.electronAPI.playbackResolve({
            providerId: anime.providerId,
            sourceId: anime.sourceId,
            sourceName: anime.sourceName,
            sourceType: anime.sourceType,
            sourceAnimeId: String(anime.id || ''),
            episode
          });
          if (!isCandidateCurrent()) return false;
          if (!resolvedVideo?.success || !resolvedVideo.url) {
            // cancelled = 被更新的解析请求取代（如用户再次点击了其他候选），
            // 不是该源的错误：静默丢弃，由更新的请求接管 UI
            if (resolvedVideo?.category === 'cancelled') {
              if (this.sourcePanelResolving === candidate) {
                this.sourcePanelResolving = null;
              }
              return false;
            }
            const reason = resolvedVideo?.error || '候选源视频地址不可用';
            this.sourcePanelVisible = true;
            this.sourcePanelResolving = null;
            this.sourcePanelError = `${plainCandidate.sourceName || plainCandidate.sourceId || '候选源'}：${reason}`;
            this.sakuraRoute = failRouteAttempt(this.sakuraRoute, reason);
            return false;
          }
          videoUrl = resolvedVideo.url;
        }

        if (!isCandidateCurrent()) {
          if (this.sourcePanelResolving === candidate) {
            this.sourcePanelResolving = null;
          }
          return false;
        }

        this.preserveFallbackSourceIdsOnce = true;
        this.sourcePanelVisible = false;
        this.sourcePanelResolving = null;
        this.sourcePanelError = '';
        this.error = null;
        this.pendingResumeTime = resumeAt > 1 ? resumeAt : 0;

        // Resolve first so a bad manual candidate does not interrupt the
        // currently playing route. Once verified, atomically retire old media.
        if (manualRequestToken !== 0) this.beginPlaybackTransition('source-candidate');
        this.lastAutoFallbackCandidate = plainCandidate;

        await this.playVideo({
          title: `${anime.name} - ${episode.title}`,
          url: videoUrl,
          anime,
          episode: {
            ...episode,
            index: episode.index ?? 0,
            lineId: plainCandidate.lineId || episode.lineId || ''
          },
          episodeIdentity: this.currentEpisodeIdentity,
          episodeId: episode.id || videoUrl,
          sourceId: plainCandidate.sourceId,
          sourceName: plainCandidate.sourceName,
          lineId: plainCandidate.lineId || '',
          resolvedVideo
        });
        return true;
      } catch (error) {
        if (!isCandidateCurrent()) return false;
        this.sourcePanelVisible = true;
        this.sourcePanelResolving = null;
        this.sourcePanelError = error.message || '切换候选源失败';
        this.sakuraRoute = failRouteAttempt(this.sakuraRoute, error);
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
      if (!this.isCurrentMediaSession()) return;
      const video = this.$refs.videoElement;
      this.updateBufferAhead();
      if (!video || this._timeUpdateFrame) return;
      this._timeUpdateFrame = requestAnimationFrame(() => {
        this._timeUpdateFrame = null;
        const current = this.$refs.videoElement?.currentTime || 0;
        if (current >= this.lastPlaybackProgressTime + 0.05) {
          this.lastPlaybackProgressTime = current;
          this.lastPlaybackProgressAt = performance.now();
          this.clearPlaybackStartupWatchdog();
        }
        if (current > 0 && !this.$refs.videoElement?.paused) this.markPlaybackSessionPlaying();
        this.maybeAutoSkipMarkedAd(current);
        this.maybeAutoSkipDnaIntro(current);
        if (Math.abs(current - this._lastCommittedTime) < 0.22 && this.isPlaying) return;
        this._lastCommittedTime = current;
        this.setCurrentTime(current);
      });
    },

    onLoadedMetadata() {
      if (!this.isCurrentMediaSession()) return;
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
      if (!this.isCurrentMediaSession()) return;
      this.clearPlaybackStartupWatchdog();
      const video = this.$refs.videoElement;
      if (isSuspiciousSniffedMediaEnd({
        duration: video?.duration,
        resolvedBy: this.currentVideo?.resolvedVideo?.resolvedBy
      })) {
        const failure = {
          source: 'media-sniffer',
          category: 'invalid-source',
          reason: 'sniffed-short-media',
          message: '\u7f51\u9875\u7ebf\u8def\u8fd4\u56de\u4e86\u8fc7\u77ed\u7684\u5a92\u4f53\u7247\u6bb5\uff0c\u53ef\u80fd\u662f\u5e7f\u544a\u6216\u9884\u544a\u7247',
          userMessage: '\u68c0\u6d4b\u5230\u77ed\u7247\u6bb5\uff0c\u6b63\u5728\u5c1d\u8bd5\u5176\u4ed6\u7ebf\u8def',
          hint: '\u64ad\u653e\u5668\u5df2\u963b\u6b62\u5c06\u77ed\u7247\u6bb5\u8bef\u5224\u4e3a\u6b63\u7247\u7ed3\u675f\u3002'
        };
        this.playbackIntent = false;
        this.setPlaying(false);
        this.showCenterPlay = true;
        this.stopProgressSave();
        this.recordPlaybackFailure(failure);
        this.setPlaybackState('recovering');
        this.autoFallbackToOtherSource(failure);
        return;
      }
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
      if (!this.isCurrentMediaSession()) return;
      // 如果已有视频画面（非初始加载），只标记缓冲中，保留最后一帧
      if (this.loading) return; // 初始加载中，不用管
      this.buffering = true;
      this.markPlaybackSessionStall();
      this.startSmoothRebuffer();
    },

    onCanPlay() {
      if (!this.isCurrentMediaSession()) return;
      this.updateBufferAhead();
      if (this.startupBuffering || this.smoothRebuffering) return;
      this.markPlaybackSessionPlaying(false);
      this.clearHlsRecoveryWatchdog();
      this.loading = false;
      this.buffering = false;
      this.autoRecovering = false;
      this.recoveryMessage = '';
      this.lastPlaybackFailure = null;
      this.hlsErrorCount = 0;
      this.hlsRecoveryAttemptPending = false;
      this.setPlaybackState('playing');
      this.sakuraRoute = markRouteStable(this.ensureSakuraRouteSession(), {
        sourceId: this.getCurrentSourceId(),
        sourceName: this.currentSourceLabel
      });
      this.reportSourcePlaybackResult(true, 'canplay');
      const video = this.$refs.videoElement;
      if (this.playbackIntent && video?.paused) this.requestPlayback('canplay-ready');
    },

    onSeeked() {
      if (!this.isCurrentMediaSession()) return;
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
      if (!this.isCurrentMediaSession('native')) return;
      const video = this.$refs.videoElement;
      if (!video?.error) return;
      this.clearPlaybackStartupWatchdog();
      this.loading = false;
      this.buffering = false;
      const failure = this.createNativeVideoFailure();
      this.scheduleNativeFallbackConfirmation(failure);
    },

    onProgress() {
      if (!this.isCurrentMediaSession()) return;
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
      if (!this.isCurrentMediaSession()) return;
      this.playbackIntent = true;
      this.playRetryCount = 0;
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
      // Episode DNA：播放开始后启动被动特征采集（每集一次）
      this.startDnaCollection();
    },

    onPause() {
      if (!this.isCurrentMediaSession()) return;
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
      // 开关关闭：直接进入失败态展示错误，不做任何自动切换
      if (!AUTO_FALLBACK_ENABLED) {
        this.autoRecovering = false;
        this.recoveryMessage = '';
        // userMessage 尾部带"正在尝试切换其他源"，开关关闭时未发生切换，
        // 用 message（去掉该尾缀的前半句）避免误导
        this.error = failure?.message || failure?.userMessage || '视频播放失败';
        this.setPlaybackState('failed');
        return false;
      }
      const generation = this.mediaLoadGeneration;
      if (this.fallbackCyclePromise && this.fallbackCycleGeneration === generation) {
        return this.fallbackCyclePromise;
      }

      const cycle = this.runAutoFallbackCycle(failure, generation);
      this.fallbackCyclePromise = cycle;
      this.fallbackCycleGeneration = generation;
      try {
        return await cycle;
      } finally {
        if (this.fallbackCyclePromise === cycle) {
          this.fallbackCyclePromise = null;
          this.fallbackCycleGeneration = -1;
        }
      }
    },

    async runAutoFallbackCycle(failure = this.lastPlaybackFailure, generation = this.mediaLoadGeneration) {
      if (generation !== this.mediaLoadGeneration) return false;
      if (this.triedFallbackSourceIds.length >= this.maxFallbackSourceAttempts) {
        this.autoRecovering = false;
        this.error = this.finalPlaybackErrorMessage(failure);
        this.sakuraRoute = failRouteAttempt(this.ensureSakuraRouteSession(), failure?.message || this.error, true);
        this.setPlaybackState('failed');
        return false;
      }

      this.setPlaybackState('recovering');
      this.error = null;
      this.recoveryMessage = '正在自动选择可用播放源...';
      const switched = await this.tryFallbackToOtherSource(generation);
      if (generation !== this.mediaLoadGeneration) return false;
      if (!switched) {
        this.autoRecovering = false;
        this.error = this.finalPlaybackErrorMessage(failure);
        this.sakuraRoute = failRouteAttempt(this.ensureSakuraRouteSession(), failure?.message || this.error, true);
        this.setPlaybackState('failed');
      }
      return switched;
    },

    async tryFallbackToOtherSource(generation = this.mediaLoadGeneration) {
      const animeName = this.currentVideo?.anime?.name;
      if (!animeName) return false;

      const fallbackToken = ++this.fallbackRequestToken;
      const isLatestFallback = () => fallbackToken === this.fallbackRequestToken
        && generation === this.mediaLoadGeneration;
      const currentEpTitle = this.currentVideo?.episode?.title || '';
      const currentEpIndex = this.currentVideo?.episode?.index ?? -1;
      const currentSourceId = this.getCurrentSourceId();
      // 已知当前线路时按线路排除（当前源的其他线路仍可参与回退），否则整源排除
      this.rememberFallbackAttempt(
        currentSourceId,
        this.currentVideo?.providerId || this.currentVideo?.anime?.providerId,
        this.currentVideo?.lineId || this.currentVideo?.episode?.lineId || ''
      );
      const excludeSourceIds = [...new Set(this.triedFallbackSourceIds.filter(Boolean))];

      try {
        this.autoRecovering = true;
        this.error = null;
        this.recoveryMessage = '正在探测其他播放源...';
        this.sakuraRoute = beginRouteProbe(this.ensureSakuraRouteSession());
        const result = await window.electronAPI.cmsMultiSelectBestEpisodeSource(animeName, {
          episodeTitle: currentEpTitle,
          episodeIndex: currentEpIndex,
          excludeSourceIds,
          allowFirstFallback: true
        });
        if (!isLatestFallback() || result?.cancelled) return false;

        this.sourceCandidates = Array.isArray(result?.candidates) ? result.candidates.filter(candidate => candidate?.url) : [];
        this.sourceSkipped = result?.skipped || [];
        this.sakuraRoute = completeRouteProbe(this.sakuraRoute, this.sourceCandidates, this.sourceSkipped);
        // 主进程已按线路过滤 `sourceId|lineId` 排除 key，这里再按本地 tried 列表
        // 过滤一遍（面板手动点过的线路同样不再出现在自动回退候选里）

        const candidates = [result?.best, ...this.sourceCandidates]
          .filter(candidate => candidate?.url && candidate?.anime && candidate?.episode)
          .filter(candidate => {
            const candidateIds = [candidate.sourceId, candidate.providerId]
              .map(id => this.normalizeFallbackSourceId(id))
              .filter(Boolean);
            if (candidateIds.some(id => excludeSourceIds.includes(id))) return false;
            // 线路级 key（`sourceId|lineId`）：只排除该线路，同源其他线路保留
            if (candidate.lineId) {
              const lineKey = `${this.normalizeFallbackSourceId(candidate.sourceId)}|${candidate.lineId}`;
              if (excludeSourceIds.includes(lineKey)) return false;
            }
            return true;
          })
          .filter((candidate, index, items) => items.findIndex(item => (
            item.sourceId === candidate.sourceId && item.lineId === candidate.lineId && item.url === candidate.url
          )) === index)
          .slice(0, this.maxFallbackSourceAttempts);
        for (const candidate of candidates) {
          if (!isLatestFallback()) return false;
          const lineLabel = candidate.lineId && candidates.filter(c => c.sourceId === candidate.sourceId).length > 1
            ? ` · ${candidate.lineId}`
            : '';
          this.recoveryMessage = `正在验证 ${candidate.sourceName || candidate.sourceId || '候选源'}${lineLabel}...`;
          if (await this.playSourceCandidate(candidate, { isCurrent: isLatestFallback })) return true;
        }

        if (!isLatestFallback()) return false;
        this.recoveryMessage = '其他源未找到可播放的链接';
        this.sakuraRoute = failRouteAttempt(this.sakuraRoute, this.recoveryMessage, true);
        return false;
      } catch (err) {
        if (!isLatestFallback()) return false;
        this.recoveryMessage = '换源失败：' + (err.message || '未知错误');
        this.sakuraRoute = failRouteAttempt(this.sakuraRoute, err, true);
        return false;
      }
    },

    revealControls(autoHide = true) {
      this.controlsVisible = true;
      this.syncFullscreenCursorState();
      if (this.hideControlsTimer) {
        clearTimeout(this.hideControlsTimer);
        this.hideControlsTimer = null;
      }
      if (autoHide) this.scheduleControlsHide();
    },

    scheduleControlsHide() {
      const canAutoHide = this.isPlaying || this.isFullscreen;
      if (!canAutoHide || this.notebookVisible || this.dnaVisible || (this.controlsHovered && !this.isFullscreen)) return;
      if (this.hideControlsTimer) clearTimeout(this.hideControlsTimer);
      this.hideControlsTimer = setTimeout(() => {
        this.hideControlsTimer = null;
        if (this.$refs.controlBar?.hasOpenInteraction?.()) {
          this.scheduleControlsHide();
          return;
        }
        if ((this.isPlaying || this.isFullscreen) && (!this.controlsHovered || this.isFullscreen)) {
          this.controlsVisible = false;
          this.syncFullscreenCursorState();
        }
      }, 3000);
    },

    onControlsHover(hovered) {
      this.controlsHovered = hovered;
      this.revealControls(this.isFullscreen || !hovered);
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
      if (this.isPlaying || this.isFullscreen) {
        this.controlsVisible = false;
        this.syncFullscreenCursorState();
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

      const focusedButton = event.target.tagName === 'BUTTON' ? event.target : null;
      if (focusedButton && event.key !== ' ' && [
        'f', 'F', 'm', 'M', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'n', 'N', 'Escape'
      ].includes(event.key)) {
        focusedButton.blur();
      }

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
          event.preventDefault();
          this.seekRelative(-this.seekStepSeconds);
          break;
        case 'ArrowRight':
          event.preventDefault();
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

    buildDanmakuSearchContext() {
      const anime = this.danmakuAnimeMetadata || {};
      return {
        animeName: this.danmakuAnimeName,
        aliases: [
          anime.name_cn,
          anime.nameCn,
          anime.original_name,
          anime.originalName,
          anime.rawName,
          ...(Array.isArray(anime.aliases) ? anime.aliases : []),
          ...(Array.isArray(anime.alias) ? anime.alias : [])
        ].filter(Boolean),
        bgmId: anime.bgmId || anime.bgm_id || anime.subjectId || anime.id || '',
        episodeNumber: this.danmakuEpisodeNumber,
        providerIds: ['bilibili', 'acfun']
      };
    },

    async refreshDanmaku() {
      if (!this.$refs.danmakuLayer) return;
      this.danmakuRuntimeState = 'loading';
      this.showDanmakuNotice('正在重新匹配全部弹幕源…', 'loading', 0);
      await this.$refs.danmakuLayer.loadDanmaku(true);
    },

    async openDanmakuMatchPanel() {
      this.danmakuMatchVisible = true;
      this.danmakuMatchLoading = true;
      this.danmakuMatchGroups = [];
      try {
        this.danmakuMatchGroups = await window.electronAPI?.danmakuSearchProviders?.(
          this.buildDanmakuSearchContext()
        ) || [];
      } catch (error) {
        this.showDanmakuNotice(error.message || '弹幕候选搜索失败', 'error', 5000);
      } finally {
        this.danmakuMatchLoading = false;
      }
    },

    closeDanmakuMatchPanel() {
      this.danmakuMatchVisible = false;
    },

    async applyDanmakuMatch(providerId, candidate) {
      this.closeDanmakuMatchPanel();
      this.danmakuRuntimeState = 'loading';
      this.showDanmakuNotice(`正在使用 ${candidate.title} 重新加载…`, 'loading', 0);
      await this.$refs.danmakuLayer?.loadWithOverride?.(providerId, candidate);
    },

    onDanmakuLoaded(info) {
      const count = Number(info?.count) || 0;
      this.danmakuSourceStatuses = Array.isArray(info?.sources) ? info.sources : [];
      this.danmakuRuntimeState = count > 0 ? 'active' : 'empty';
      if (count > 0) {
        const episodeLabel = info?.match?.episodeNumber
          ? `第 ${info.match.episodeNumber} 集 · `
          : '';
        const sourceNames = this.danmakuSourceStatuses
          .filter(source => source.status === 'ok')
          .map(source => source.name)
          .filter(Boolean);
        const sourceLabel = sourceNames.length ? ` · ${sourceNames.join(' + ')}` : '';
        this.showDanmakuNotice(`${episodeLabel}已加载 ${count} 条弹幕${sourceLabel}`, 'success', 4200);
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
    // 一起看相关方法已抽离至 mixins/watchTogether.js
  },

  watch: {
    playbackMediaKey: {
      handler(newKey, oldKey) {
        const newUrl = this.currentVideo?.url || '';
        // 切换视频前先保存"旧视频"的进度
        // 注意：此时 currentVideo 已是新视频，必须用 playedSnapshot（旧视频快照）
        // 否则会把旧视频的 currentTime 写到新视频的记录里，造成进度错乱
        if (oldKey && this.playedSnapshot) {
          this.savePlayProgress(this.playedSnapshot);
        }
        if (newUrl && newKey !== oldKey) {
          this.notebookVisible = false;
          this.dnaVisible = false;
          this.anime4kRuntime = this.anime4kEnabled
            ? { active: false, presenting: false, state: 'initializing' }
            : { active: false, presenting: false };
          this.danmakuRuntimeState = this.danmakuEnabled ? 'loading' : 'idle';
          this.scheduleVideoInitialization(120);
          // 切换视频时清空旧字幕（新视频需要重新加载字幕）
          this.subtitleCues = [];
          this.showSubtitle = false;
        } else if (!newUrl && oldKey) {
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
    },
    // 剧集身份变化时加载该集的手帐时光签（供进度条标记）
    'currentEpisodeIdentity.key': {
      handler(key) {
        if (key) this.loadNoteMarkers();
        else this.noteMarkers = [];
        // Episode DNA：切集后重置候选并加载作品级自动跳过规则
        this.dnaCandidates = [];
        this.dnaAutoSkippedKey = '';
        this.loadDnaAutoSkipRule();
      },
      immediate: true
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
    // "一起看"消息订阅见 mixins/watchTogether.js（mounted 钩子）
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

    // "一起看"定时器/订阅清理见 mixins/watchTogether.js（beforeUnmount 钩子）
    // 清理 Episode DNA 采集器与分析 Worker
    this.stopDnaCollection(true);
    destroyIntroAnalyzer();

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

<style scoped src="../../assets/styles/video-player.css"></style>
