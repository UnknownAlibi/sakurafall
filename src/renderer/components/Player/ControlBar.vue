<template>
  <div
    class="control-bar"
    :class="{ visible }"
    :style="{ opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }"
    @mouseenter="$emit('controls-hover', true)"
    @mouseleave="$emit('controls-hover', false)"
    @pointerup="releasePointerFocus"
    @click.stop
    @dblclick.stop
  >
    <!-- 进度条 -->
    <div class="progress-container">
      <div class="progress-track-wrap">
        <input
          ref="progressSlider"
          type="range"
          class="progress-slider"
          min="0"
          :max="duration || 0"
          :value="displayCurrentTime"
          step="0.1"
          :style="{ background: progressGradient }"
          @input.stop="handleSliderInput"
          @change.stop="commitSliderSeek"
          @pointerdown.stop="onProgressPointerDown"
          @pointercancel.stop="onProgressPointerCancel"
          @pointermove="onProgressPointerMove"
          @pointerleave="hoverTime = null"
          @click.stop
        />
        <!-- 广告区间标记：黄色条提示片源标记的广告段 -->
        <div v-if="adRanges.length && duration" class="ad-ranges" aria-hidden="true">
          <span
            v-for="(range, i) in adRanges"
            :key="i"
            class="ad-range"
            :style="adRangeStyle(range)"
          ></span>
        </div>
        <!-- 手帐时光签标记：按分类着色，点击跳到时间点 -->
        <div
          v-if="noteMarkers.length && duration"
          class="note-markers"
          :class="{ visible }"
          role="button"
          tabindex="-1"
        >
          <button
            v-for="marker in noteMarkers"
            :key="marker.id"
            type="button"
            class="note-marker"
            :class="`is-${marker.category || 'plain'}`"
            :style="noteMarkerStyle(marker)"
            :title="`${formatTime(marker.position)}${marker.note ? ' · ' + marker.note : ''}`"
            @click.stop="$emit('note-marker-click', marker.position)"
          ></button>
        </div>
        <!-- 悬停/拖动时间气泡：预览目标时间 -->
        <div
          v-if="hoverTime != null"
          class="progress-tooltip"
          :style="{ left: (tooltipPosRatio * 100) + '%' }"
        >
          {{ formatTime(hoverTime) }}
        </div>
      </div>
      <div class="time-display">
        <span class="current-time">{{ formatTime(currentTime) }}</span>
        <span class="separator">/</span>
        <span class="total-time">{{ formatTime(duration) }}</span>
      </div>
    </div>

    <!-- 控制按钮区域 -->
    <div class="controls-container">
      <!-- 左侧控制组 -->
      <div class="controls-left">
        <!-- 快退（旋转箭头，表示时间回退） -->
        <button class="control-btn" @click="$emit('seek-relative', -seekStepSeconds)" :title="`快退 ${seekStepSeconds}s (←)`">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
        </button>

        <!-- 播放/暂停按钮 -->
        <button class="control-btn play-btn" @click="togglePlay" :title="isPlaying ? '暂停 (空格)' : '播放 (空格)'">
          <svg v-if="isPlaying" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1"/>
            <rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>

        <!-- 快进（旋转箭头，表示时间前进） -->
        <button class="control-btn" @click="$emit('seek-relative', seekStepSeconds)" :title="`快进 ${seekStepSeconds}s (→)`">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>

        <!-- 下一集（有剧集时才显示） -->
        <button v-if="hasEpisodes" class="control-btn" @click="$emit('next-episode')" :disabled="!hasNext" title="下一集 (N)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 6h2v12h-2V6zm-1.5 6L6 6v12l8.5-6z"/>
          </svg>
        </button>

        <!-- 音量控制 -->
        <div class="volume-control">
          <button class="control-btn volume-btn" @click="toggleMute" :title="isMuted || volume === 0 ? '取消静音' : '静音'">
            <svg v-if="isMuted || volume === 0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <line x1="23" y1="9" x2="17" y2="15"/>
              <line x1="17" y1="9" x2="23" y2="15"/>
            </svg>
            <svg v-else-if="volume < 0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
            <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            </svg>
          </button>
          <!-- 常驻横向音量滑块 + 百分比 -->
          <div class="volume-slider-inline">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="isMuted ? 0 : volume"
              @input.stop="handleVolumeChange"
              @pointerdown.stop
              @click.stop
              class="volume-range"
              :style="{ background: volumeGradient }"
            />
            <span class="volume-percent">{{ volumePercent }}%</span>
          </div>
        </div>

        <!-- 倍速控制 -->
        <div class="playback-rate-control">
          <button class="control-btn rate-btn" @click="toggleRateMenu" :title="'播放速度: ' + playbackRate + 'x'">
            {{ playbackRate }}x
          </button>
          <transition name="fade-scale">
            <div v-show="showRateMenu" class="rate-menu" @mouseleave="showRateMenu = false">
              <button
                v-for="rate in playbackRates"
                :key="rate"
                :class="['rate-option', { active: rate === playbackRate }]"
                @click="selectPlaybackRate(rate)"
              >
                {{ rate }}x
              </button>
            </div>
          </transition>
        </div>

        <!-- 画质选择（仅多画质时显示） -->
        <div v-if="qualityLevels.length > 1" class="quality-control">
          <button class="control-btn quality-btn" @click="toggleQualityMenu" :title="'画质切换'">
            {{ currentQualityLabel }}
          </button>
          <transition name="fade-scale">
            <div v-show="showQualityMenu" class="quality-menu" @mouseleave="showQualityMenu = false">
              <button
                :class="['quality-option', { active: currentQuality === -1 }]"
                @click="selectQuality(-1)"
              >
                自动
              </button>
              <!-- 从高到低显示 -->
              <button
                v-for="lv in [...qualityLevels].reverse()"
                :key="lv.index"
                :class="['quality-option', { active: currentQuality === lv.index }]"
                @click="selectQuality(lv.index)"
              >
                {{ lv.label }}
              </button>
            </div>
          </transition>
        </div>
      </div>

      <!-- 右侧控制组 -->
      <div class="controls-right">
        <!-- 换源：原右上角悬浮按钮迁入控制栏，避免遮挡画面 -->
        <button
          v-if="canSwitchSource"
          type="button"
          class="control-btn source-switch-control"
          title="换源 · SakuraRoute 智能线路"
          aria-label="换源"
          @click="$emit('source-switch')"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 7h11l-3-3"/><path d="M17 17H6l3 3"/><path d="M18 7l-5 5"/><path d="M6 17l5-5"/>
          </svg>
          <span class="control-btn-label">换源</span>
        </button>

        <!-- 常用播放设置：播放时可直接调整，无需离开当前视频 -->
        <div class="player-settings-control">
          <button
            :class="['control-btn', 'settings-btn', { 'menu-open': showSettingsMenu }]"
            type="button"
            title="播放设置"
            aria-label="播放设置"
            :aria-expanded="showSettingsMenu"
            @click="toggleSettingsMenu"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05-2.83 2.83-.05-.05a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.05.05-2.83-2.83.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.53-1H3v-4h.07A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.05-.05 2.83-2.83.05.05A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.07V3h4v.07a1.7 1.7 0 0 0 1.03 1.53 1.7 1.7 0 0 0 1.88-.34l.05-.05 2.83 2.83-.05.05A1.7 1.7 0 0 0 19.4 9c.25.61.85 1 1.53 1H21v4h-.07c-.68 0-1.28.39-1.53 1z"/>
            </svg>
          </button>
          <transition name="settings-pop">
            <div v-show="showSettingsMenu" class="player-settings-menu" @click.stop>
              <div class="settings-menu-heading">
                <strong>播放设置</strong>
                <span>即时生效</span>
              </div>

              <div class="settings-menu-row settings-menu-row-stack">
                <span class="settings-menu-label">快进 / 快退</span>
                <div class="seek-step-options" role="group" aria-label="快进快退时长">
                  <button
                    v-for="seconds in seekStepOptions"
                    :key="seconds"
                    :class="['seek-step-option', { active: seconds === seekStepSeconds }]"
                    type="button"
                    @click="$emit('seek-step-change', seconds)"
                  >{{ seconds }}s</button>
                </div>
              </div>

              <button
                :class="['settings-menu-row', 'ad-skip-action', { reported: adReported }]"
                type="button"
                @click="$emit('skip-ad')"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m5 4 10 8-10 8V4z"/>
                  <path d="M19 5v14"/>
                </svg>
                <span>
                  <strong>{{ adReported ? '继续跳过 15 秒' : '跳过广告 15 秒' }}</strong>
                  <small>{{ adReported ? '已降低当前源优先级' : '同时记录当前源广告情况' }}</small>
                </span>
              </button>

              <button
                :class="['settings-menu-row', 'ad-skip-action', 'clean-source-action', { reported: adReported }]"
                type="button"
                @click="$emit('report-ad-and-switch')"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 7h11l-3-3"/>
                  <path d="M17 17H6l3 3"/>
                  <path d="M18 7l-5 5"/>
                  <path d="M6 17l5-5"/>
                </svg>
                <span>
                  <strong>标记广告并换源</strong>
                  <small>降低当前源优先级，查找同一集的其他线路</small>
                </span>
              </button>

              <label class="settings-menu-row settings-toggle-row">
                <span>
                  <strong>自动跳过明确标记广告</strong>
                  <small>仅在片源提供标准广告标记时跳过，默认关闭</small>
                </span>
                <input type="checkbox" :checked="autoSkipMarkedAds" @change="$emit('auto-skip-marked-ads-change', $event.target.checked)" />
                <i aria-hidden="true"></i>
              </label>

              <label class="settings-menu-row settings-toggle-row">
                <span>
                  <strong>流畅优先缓冲</strong>
                  <small>开始和卡顿恢复时多缓冲几秒，减少反复停顿</small>
                </span>
                <input type="checkbox" :checked="smoothStreaming" @change="$emit('smooth-streaming-change', $event.target.checked)" />
                <i aria-hidden="true"></i>
              </label>

              <label class="settings-menu-row settings-toggle-row">
                <span>
                  <strong>Anime4K 实时增强（实验）</strong>
                  <small v-if="anime4kEnabled && anime4kActive">运行中 · GPU 正在修复线条与细节</small>
                  <small v-else-if="anime4kEnabled && anime4kDegraded">兼容显示增强中 · CNN 当前未运行</small>
                  <small v-else-if="anime4kEnabled">正在初始化并验证 GPU 输出...</small>
                  <small v-else>GPU 实时修复线条与细节；1080P 源不提升分辨率，低清源才可能 2× 放大</small>
                </span>
                <input type="checkbox" :checked="anime4kEnabled" @change="$emit('anime4k-change', $event.target.checked)" />
                <i aria-hidden="true"></i>
              </label>

              <label v-if="anime4kEnabled" class="settings-menu-row settings-range-row">
                <span class="settings-menu-label">增强档位</span>
                <select
                  class="settings-menu-select"
                  :value="anime4kPreset"
                  @change="$emit('anime4k-preset-change', $event.target.value)"
                >
                  <option value="light">轻量（S）</option>
                  <option value="balanced">均衡（M）</option>
                  <option value="quality">画质（L）</option>
                </select>
              </label>

              <label class="settings-menu-row settings-toggle-row">
                <span>
                  <strong>自动连播</strong>
                  <small>本集结束后播放下一集</small>
                </span>
                <input type="checkbox" :checked="autoPlay" @change="$emit('auto-play-change', $event.target.checked)" />
                <i aria-hidden="true"></i>
              </label>

              <label class="settings-menu-row settings-toggle-row">
                <span>
                  <strong>记住倍速</strong>
                  <small>下次播放沿用当前速度</small>
                </span>
                <input type="checkbox" :checked="rememberPlaybackRate" @change="$emit('remember-rate-change', $event.target.checked)" />
                <i aria-hidden="true"></i>
              </label>

              <label class="settings-menu-row settings-range-row">
                <span class="settings-menu-label">弹幕字号</span>
                <input type="range" min="12" max="36" step="1" :value="danmakuFontSize" @input="$emit('danmaku-font-size-change', Number($event.target.value))" />
                <output>{{ danmakuFontSize }}px</output>
              </label>

              <label class="settings-menu-row settings-range-row">
                <span class="settings-menu-label">字幕字号</span>
                <input type="range" min="12" max="48" step="1" :value="subtitleFontSize" @input="$emit('subtitle-font-size-change', Number($event.target.value))" />
                <output>{{ subtitleFontSize }}px</output>
              </label>
            </div>
          </transition>
        </div>

        <!-- 弹幕控制（开关 + 导入菜单） -->
        <div class="danmaku-control">
          <button
            :class="['control-btn', 'danmaku-btn', { active: danmakuActive, pending: danmakuPending }]"
            @click="toggleDanmakuMenu"
            :title="danmakuActive ? '弹幕运行中' : (danmakuPending ? '弹幕加载中' : (danmakuEnabled ? '当前集暂无可用弹幕' : '弹幕关'))"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M3 12h12M3 18h6"/>
              <circle v-if="danmakuActive" cx="19" cy="18" r="3" fill="currentColor" opacity="0.6" stroke="none"/>
            </svg>
            <span class="control-btn-label">弹幕</span>
          </button>
          <transition name="fade-scale">
            <div v-show="showDanmakuMenu" class="danmaku-menu" @mouseleave="showDanmakuMenu = false">
              <div v-if="danmakuSources.length" class="danmaku-source-summary">
                <span v-for="source in danmakuSources" :key="source.id" :class="`is-${source.status}`">
                  <i></i>{{ source.name }}<b v-if="source.count">{{ source.count }}</b>
                </span>
              </div>
              <button
                :class="['danmaku-option', { active: danmakuEnabled }]"
                @click="$emit('toggle-danmaku'); showDanmakuMenu = false;"
              >
                {{ danmakuEnabled ? '关闭弹幕' : '开启弹幕' }}
              </button>
              <!-- 重新匹配/导入XML/校正匹配已聚合进弹幕设置悬浮框，此处不再重复入口 -->
              <button class="danmaku-option" @click="$emit('danmaku-open-settings'); showDanmakuMenu = false;">
                弹幕设置
              </button>
            </div>
          </transition>
        </div>

        <!-- 低频播放工具聚合：保留原功能，避免控制栏被同级图标挤满 -->
        <PlayerToolsMenu
          :show="showToolsMenu"
          :more-tools-active="moreToolsActive"
          :casting="casting"
          :notebook-active="notebookActive"
          :dna-active="dnaActive"
          :watch-together-active="watchTogetherActive"
          @toggle="toggleToolsMenu"
          @close="showToolsMenu = false"
          @cast-toggle="$emit('cast-toggle')"
          @picture-in-picture-toggle="$emit('picture-in-picture-toggle')"
          @notebook-toggle="$emit('notebook-toggle')"
          @dna-toggle="$emit('dna-toggle')"
          @watch-together-toggle="$emit('watch-together-toggle')"
        />

        <!-- 字幕控制（开关 + 加载文件 + 在线搜索） -->
        <div class="subtitle-control">
          <button
            :class="['control-btn', 'subtitle-btn', { active: subtitleEnabled }]"
            @click="toggleSubtitleMenu"
            :title="subtitleEnabled ? '字幕开' : '字幕关'"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2"/>
              <path d="M6 11h4M6 14h2"/>
              <path d="M14 11h4M12 14h6"/>
            </svg>
          </button>
          <transition name="fade-scale">
            <div v-show="showSubtitleMenu" class="subtitle-menu" @mouseleave="showSubtitleMenu = false">
              <button
                :class="['subtitle-option', { active: subtitleEnabled }]"
                @click="$emit('toggle-subtitle'); showSubtitleMenu = false;"
              >
                {{ subtitleEnabled ? '关闭字幕' : '开启字幕' }}
              </button>
              <button class="subtitle-option" @click="$emit('subtitle-load-file'); showSubtitleMenu = false;">
                加载本地字幕
              </button>
              <button class="subtitle-option" @click="$emit('subtitle-search'); showSubtitleMenu = false;">
                在线搜索字幕
              </button>
            </div>
          </transition>
        </div>

        <!-- 全屏按钮 -->
        <button class="control-btn" @click="$emit('fullscreen-toggle')" :title="isFullscreen ? '退出全屏 (F)' : '全屏 (F)'">
          <svg v-if="isFullscreen" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 14 4 20 10 20"/>
            <polyline points="20 10 20 4 14 4"/>
            <line x1="14" y1="10" x2="20" y2="4"/>
            <line x1="4" y1="20" x2="10" y2="14"/>
          </svg>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 3 21 3 21 9"/>
            <polyline points="9 21 3 21 3 15"/>
            <line x1="21" y1="3" x2="14" y2="10"/>
            <line x1="3" y1="21" x2="10" y2="14"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import PlayerToolsMenu from './PlayerToolsMenu.vue';

export default {
  name: 'ControlBar',
  components: {
    PlayerToolsMenu
  },
  props: {
    isPlaying: {
      type: Boolean,
      default: false
    },
    currentTime: {
      type: Number,
      default: 0
    },
    duration: {
      type: Number,
      default: 0
    },
    volume: {
      type: Number,
      default: 1
    },
    isFullscreen: {
      type: Boolean,
      default: false
    },
    playbackRate: {
      type: Number,
      default: 1
    },
    seekStepSeconds: {
      type: Number,
      default: 10
    },
    bufferProgress: {
      type: Number,
      default: 0
    },
    visible: {
      type: Boolean,
      default: true
    },
    qualityLevels: {
      type: Array,
      default: () => []
    },
    currentQuality: {
      type: Number,
      default: -1
    },
    // 是否有剧集（控制下一集按钮显隐）
    hasEpisodes: {
      type: Boolean,
      default: false
    },
    hasNext: {
      type: Boolean,
      default: false
    },
    // 弹幕是否启用（控制按钮高亮）
    danmakuEnabled: {
      type: Boolean,
      default: false
    },
    danmakuActive: {
      type: Boolean,
      default: false
    },
    danmakuPending: {
      type: Boolean,
      default: false
    },
    danmakuSources: {
      type: Array,
      default: () => []
    },
    // 字幕是否启用（控制按钮高亮）
    subtitleEnabled: {
      type: Boolean,
      default: false
    },
    // 一起看是否启用（控制按钮高亮）
    watchTogetherActive: {
      type: Boolean,
      default: false
    },
    notebookActive: {
      type: Boolean,
      default: false
    },
    // Episode DNA 面板是否打开（控制按钮高亮）
    dnaActive: {
      type: Boolean,
      default: false
    },
    casting: {
      type: Boolean,
      default: false
    },
    autoPlay: {
      type: Boolean,
      default: true
    },
    rememberPlaybackRate: {
      type: Boolean,
      default: true
    },
    danmakuFontSize: {
      type: Number,
      default: 20
    },
    subtitleFontSize: {
      type: Number,
      default: 24
    },
    adReported: {
      type: Boolean,
      default: false
    },
    autoSkipMarkedAds: {
      type: Boolean,
      default: false
    },
    smoothStreaming: {
      type: Boolean,
      default: true
    },
    anime4kEnabled: {
      type: Boolean,
      default: false
    },
    anime4kActive: {
      type: Boolean,
      default: false
    },
    anime4kDegraded: {
      type: Boolean,
      default: false
    },
    anime4kPreset: {
      type: String,
      default: 'balanced'
    },
    // 片源标记的广告区间（进度条上以黄色条展示）
    adRanges: {
      type: Array,
      default: () => []
    },
    // 手帐时光签标记（进度条上方小竖标，点击跳转）
    noteMarkers: {
      type: Array,
      default: () => []
    },
    // 静音状态（真源在父组件 video.muted，保证按钮/滑块/快捷键一致）
    isMuted: {
      type: Boolean,
      default: false
    },
    // 是否展示“换源”（当前有可解析的番剧信息时）
    canSwitchSource: {
      type: Boolean,
      default: false
    }
  },
  emits: [
    'toggle-play',
    'seek',
    'seek-relative',
    'note-marker-click',
    'source-switch',
    'volume-change',
    'toggle-mute',
    'fullscreen-toggle',
    'playback-rate-change',
    'picture-in-picture-toggle',
    'quality-change',
    'next-episode',
    'toggle-danmaku',
    'danmaku-open-settings',
    'open-settings',
    'toggle-subtitle',
    'subtitle-load-file',
    'subtitle-search',
    'notebook-toggle',
    'dna-toggle',
    'watch-together-toggle',
    'controls-hover',
    'seek-step-change',
    'auto-play-change',
    'remember-rate-change',
    'danmaku-font-size-change',
    'subtitle-font-size-change',
    'skip-ad',
    'report-ad-and-switch',
    'auto-skip-marked-ads-change',
    'smooth-streaming-change',
    'anime4k-change',
    'anime4k-preset-change'
  ],
  data() {
    return {
      showRateMenu: false,
      showQualityMenu: false,
      showDanmakuMenu: false,
      showSubtitleMenu: false,
      showSettingsMenu: false,
      showToolsMenu: false,
      isDragging: false,
      draftTime: 0,
      playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
      seekStepOptions: [5, 10, 15, 30],
      // 进度条悬停预览（null = 不显示气泡）
      hoverTime: null,
      hoverRatio: 0
    };
  },
  computed: {
    progressPercentage() {
      if (!this.duration || this.duration === 0) return 0;
      return (this.displayCurrentTime / this.duration) * 100;
    },

    displayCurrentTime() {
      return this.isDragging ? this.draftTime : this.currentTime;
    },

    // 用于 Webkit 引擎的进度条渐变背景：已播放(主题色) → 已缓冲(主题色提亮) → 未缓冲(暗色)
    progressGradient() {
      const pct = this.progressPercentage;
      const buf = Math.min(Math.max(this.bufferProgress || 0, pct), 100);
      // 缓冲段用「主题色 + 白」提亮：比纯半透明白更贴合主题，且与已播放(实色)/未缓冲(暗色)清晰区分
      return `linear-gradient(to right, var(--player-progress) 0%, var(--player-progress) ${pct}%, color-mix(in srgb, var(--player-progress) 50%, white) ${pct}%, color-mix(in srgb, var(--player-progress) 50%, white) ${buf}%, rgba(255,255,255,0.15) ${buf}%, rgba(255,255,255,0.15) 100%)`;
    },

    // 当前画质显示标签
    currentQualityLabel() {
      if (this.currentQuality === -1) return '自动';
      const lv = this.qualityLevels.find(l => l.index === this.currentQuality);
      return lv ? lv.label : '画质';
    },

    // 音量百分比（0-100）
    volumePercent() {
      return Math.round((this.isMuted ? 0 : this.volume) * 100);
    },

    moreToolsActive() {
      return this.casting || this.notebookActive || this.dnaActive || this.watchTogetherActive;
    },

    // 音量滑块渐变背景
    volumeGradient() {
      const pct = this.volumePercent;
      return `linear-gradient(to right, var(--player-progress) 0%, var(--player-progress) ${pct}%, rgba(255,255,255,0.15) ${pct}%, rgba(255,255,255,0.15) 100%)`;
    },

    // 气泡定位比例：贴边时钳制，避免气泡溢出进度条两端
    tooltipPosRatio() {
      return Math.min(0.96, Math.max(0.04, this.hoverRatio));
    }
  },
  mounted() {
    // 点击控制栏外部时关闭所有弹出的菜单（避免菜单卡住遮挡画面）
    this._onDocMouseDown = (event) => {
      if (this.$el && !this.$el.contains(event.target)) {
        this.closeAllMenus();
      }
    };
    document.addEventListener('mousedown', this._onDocMouseDown);
    // Escape 键关闭菜单（全屏退出由父组件处理，菜单优先拦截）
    this._onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (this.closeAllMenus()) event.stopPropagation();
    };
    document.addEventListener('keydown', this._onKeyDown, true);
  },
  beforeUnmount() {
    if (this._onDocMouseDown) {
      document.removeEventListener('mousedown', this._onDocMouseDown);
      this._onDocMouseDown = null;
    }
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown, true);
      this._onKeyDown = null;
    }
  },
  methods: {
    releasePointerFocus(event) {
      const target = event?.target;
      const interactive = target instanceof Element
        ? target.closest('button, input[type="range"]')
        : null;
      if (interactive && this.$el?.contains(interactive) && document.activeElement === interactive) {
        interactive.blur();
      }
    },

    hasOpenInteraction() {
      return this.isDragging || this.showRateMenu || this.showQualityMenu ||
        this.showDanmakuMenu || this.showSubtitleMenu || this.showSettingsMenu || this.showToolsMenu;
    },

    /** 关闭全部菜单；返回是否有菜单被关闭（供 Escape 拦截判断） */
    closeAllMenus() {
      const hadOpen = this.showRateMenu || this.showQualityMenu ||
        this.showDanmakuMenu || this.showSubtitleMenu || this.showSettingsMenu || this.showToolsMenu;
      this.showRateMenu = false;
      this.showQualityMenu = false;
      this.showDanmakuMenu = false;
      this.showSubtitleMenu = false;
      this.showSettingsMenu = false;
        this.showToolsMenu = false;
      this.showToolsMenu = false;
      return hadOpen;
    },

    togglePlay() {
      this.$emit('toggle-play');
    },

    handleSliderInput(event) {
      this.isDragging = true;
      this.draftTime = this.clampTime(parseFloat(event.target.value));
    },

    clampTime(time) {
      const max = Number(this.duration) || 0;
      const value = Number(time);
      if (!Number.isFinite(value)) return 0;
      if (!Number.isFinite(max) || max <= 0) return 0;
      return Math.max(0, Math.min(max, value));
    },

    getPointerTime(event) {
      const slider = this.$refs.progressSlider;
      const max = Number(this.duration) || 0;
      if (!slider || !Number.isFinite(max) || max <= 0) return this.clampTime(this.currentTime || 0);
      const rect = slider.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / width));
      return this.clampTime(ratio * max);
    },

    emitSeek(time) {
      const nextTime = this.clampTime(time);
      this.draftTime = nextTime;
      this.$emit('seek', nextTime);
    },

    commitSliderSeek(event) {
      const newTime = event?.target ? parseFloat(event.target.value) : this.draftTime;
      this.isDragging = false;
      this.emitSeek(newTime);
    },

    onProgressPointerDown(event) {
      if (!this.duration || this.duration <= 0) return;
      this.isDragging = true;
      this.draftTime = this.clampTime(parseFloat(event.currentTarget?.value));
    },

    onProgressPointerCancel() {
      this.isDragging = false;
    },

    handleVolumeChange(event) {
      const newVolume = parseFloat(event.target.value);
      this.$emit('volume-change', newVolume);
    },

    // 静音切换统一交给父组件（操作 video.muted 单一真源）
    toggleMute() {
      this.$emit('toggle-mute');
    },

    /** 进度条悬停/拖动时的目标时间预览 */
    onProgressPointerMove(event) {
      const slider = this.$refs.progressSlider;
      const max = Number(this.duration) || 0;
      if (!slider || !Number.isFinite(max) || max <= 0) {
        this.hoverTime = null;
        return;
      }
      const rect = slider.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      this.hoverRatio = ratio;
      this.hoverTime = ratio * max;
    },

    /** 广告区间在进度条上的定位（百分比） */
    adRangeStyle(range) {
      const max = Number(this.duration) || 0;
      if (!max || !range || !Number.isFinite(range.start)) return { display: 'none' };
      const start = Math.max(0, Math.min(max, range.start));
      const end = Math.max(start, Math.min(max, Number.isFinite(range.end) ? range.end : start));
      return {
        left: `${(start / max) * 100}%`,
        width: `${Math.max(0.4, ((end - start) / max) * 100)}%`
      };
    },

    /** 手帐时光签标记在进度条上的定位 */
    noteMarkerStyle(marker) {
      const max = Number(this.duration) || 0;
      if (!max || !marker || !Number.isFinite(marker.position)) return { display: 'none' };
      const position = Math.max(0, Math.min(max, marker.position));
      return { left: `${(position / max) * 100}%` };
    },

    toggleRateMenu() {
      this.showRateMenu = !this.showRateMenu;
      if (this.showRateMenu) {
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSubtitleMenu = false;
        this.showSettingsMenu = false;
        this.showToolsMenu = false;
      }
    },

    selectPlaybackRate(rate) {
      this.$emit('playback-rate-change', rate);
      this.showRateMenu = false;
    },

    toggleQualityMenu() {
      this.showQualityMenu = !this.showQualityMenu;
      if (this.showQualityMenu) {
        this.showRateMenu = false;
        this.showDanmakuMenu = false;
        this.showSubtitleMenu = false;
        this.showSettingsMenu = false;
        this.showToolsMenu = false;
      }
    },

    selectQuality(level) {
      this.$emit('quality-change', level);
      this.showQualityMenu = false;
    },

    toggleDanmakuMenu() {
      this.showDanmakuMenu = !this.showDanmakuMenu;
      if (this.showDanmakuMenu) {
        this.showRateMenu = false;
        this.showQualityMenu = false;
        this.showSubtitleMenu = false;
        this.showSettingsMenu = false;
        this.showToolsMenu = false;
      }
    },

    toggleSubtitleMenu() {
      this.showSubtitleMenu = !this.showSubtitleMenu;
      if (this.showSubtitleMenu) {
        this.showRateMenu = false;
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSettingsMenu = false;
        this.showToolsMenu = false;
      }
    },

    toggleSettingsMenu() {
      this.showSettingsMenu = !this.showSettingsMenu;
      if (this.showSettingsMenu) {
        this.showRateMenu = false;
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSubtitleMenu = false;
        this.showToolsMenu = false;
      }
    },

    toggleToolsMenu() {
      this.showToolsMenu = !this.showToolsMenu;
      if (this.showToolsMenu) {
        this.showRateMenu = false;
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSubtitleMenu = false;
        this.showSettingsMenu = false;
      }
    },

    runToolAction(eventName) {
      this.showToolsMenu = false;
      this.$emit(eventName);
    },

    formatTime(seconds) {
      if (isNaN(seconds) || !isFinite(seconds) || seconds === 0) return '00:00';
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
  },

  watch: {
    currentTime(val) {
      if (!this.isDragging) {
        this.draftTime = val || 0;
      }
    }
  }
};
</script>

<!-- 不能用 scoped：PlayerToolsMenu 等子组件是多根模板，拿不到本组件的
     作用域属性，导致 .control-btn-label / .tools-btn 的 gap、字号等规则失效，
     表现为图标与文字挤在一起、基线错位。这些类只用于播放器控制栏，全局安全。 -->
<style src="../../assets/styles/player-control-bar.css"></style>
