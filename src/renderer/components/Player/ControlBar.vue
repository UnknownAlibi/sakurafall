<template>
  <div
    class="control-bar"
    :class="{ visible }"
    @mouseenter="$emit('controls-hover', true)"
    @mouseleave="$emit('controls-hover', false)"
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
                  <strong>Anime4K 实时增强</strong>
                  <small v-if="anime4kEnabled && anime4kActive">运行中 · 已验证增强帧输出</small>
                  <small v-else-if="anime4kEnabled && anime4kDegraded">兼容显示增强中 · CNN 当前未运行</small>
                  <small v-else-if="anime4kEnabled">正在初始化并验证 GPU 输出...</small>
                  <small v-else>GPU 实时修复线条并按显示尺寸放大，仅 1080P 级片源可用</small>
                </span>
                <input type="checkbox" :checked="anime4kEnabled" @change="$emit('anime4k-change', $event.target.checked)" />
                <i aria-hidden="true"></i>
              </label>

              <label v-if="anime4kEnabled" class="settings-menu-row settings-range-row">
                <span class="settings-menu-label">超分档位</span>
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

        <!-- 投屏按钮（DLNA） -->
        <button
          :class="['control-btn', 'cast-btn', { active: casting }]"
          @click="$emit('cast-toggle')"
          :title="casting ? '投屏中' : '投屏到电视'"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/>
            <line x1="2" y1="20" x2="2.01" y2="20"/>
          </svg>
        </button>

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
          </button>
          <transition name="fade-scale">
            <div v-show="showDanmakuMenu" class="danmaku-menu" @mouseleave="showDanmakuMenu = false">
              <button
                :class="['danmaku-option', { active: danmakuEnabled }]"
                @click="$emit('toggle-danmaku'); showDanmakuMenu = false;"
              >
                {{ danmakuEnabled ? '关闭弹幕' : '开启弹幕' }}
              </button>
              <button class="danmaku-option" @click="$emit('danmaku-import-xml'); showDanmakuMenu = false;">
                导入本地 XML
              </button>
              <button class="danmaku-option" @click="$emit('open-settings'); showDanmakuMenu = false;">
                弹幕设置
              </button>
            </div>
          </transition>
        </div>

        <!-- 画中画按钮 -->
        <button class="control-btn" @click="$emit('picture-in-picture-toggle')" title="画中画">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2"/>
            <rect x="12" y="9" width="8" height="6" rx="1" fill="currentColor" opacity="0.4"/>
          </svg>
        </button>

        <!-- 一起看按钮（多人同步播放） -->
        <button
          :class="['control-btn', 'watch-together-btn', { active: watchTogetherActive }]"
          @click="$emit('watch-together-toggle')"
          :title="watchTogetherActive ? '一起看（已开启）' : '一起看'"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        </button>

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
export default {
  name: 'ControlBar',
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
    // 静音状态（真源在父组件 video.muted，保证按钮/滑块/快捷键一致）
    isMuted: {
      type: Boolean,
      default: false
    }
  },
  emits: [
    'toggle-play',
    'seek',
    'seek-relative',
    'volume-change',
    'toggle-mute',
    'fullscreen-toggle',
    'playback-rate-change',
    'picture-in-picture-toggle',
    'quality-change',
    'next-episode',
    'toggle-danmaku',
    'danmaku-import-xml',
    'open-settings',
    'toggle-subtitle',
    'subtitle-load-file',
    'subtitle-search',
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
    /** 关闭全部菜单；返回是否有菜单被关闭（供 Escape 拦截判断） */
    closeAllMenus() {
      const hadOpen = this.showRateMenu || this.showQualityMenu ||
        this.showDanmakuMenu || this.showSubtitleMenu || this.showSettingsMenu;
      this.showRateMenu = false;
      this.showQualityMenu = false;
      this.showDanmakuMenu = false;
      this.showSubtitleMenu = false;
      this.showSettingsMenu = false;
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

    toggleRateMenu() {
      this.showRateMenu = !this.showRateMenu;
      if (this.showRateMenu) {
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSubtitleMenu = false;
        this.showSettingsMenu = false;
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
      }
    },

    toggleSubtitleMenu() {
      this.showSubtitleMenu = !this.showSubtitleMenu;
      if (this.showSubtitleMenu) {
        this.showRateMenu = false;
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSettingsMenu = false;
      }
    },

    toggleSettingsMenu() {
      this.showSettingsMenu = !this.showSettingsMenu;
      if (this.showSettingsMenu) {
        this.showRateMenu = false;
        this.showQualityMenu = false;
        this.showDanmakuMenu = false;
        this.showSubtitleMenu = false;
      }
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

<style scoped>
.control-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background:
    linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.42) 22%, rgba(9, 9, 19, 0.9) 100%),
    radial-gradient(circle at 18% 100%, rgba(var(--primary-rgb), 0.24), transparent 30%),
    radial-gradient(circle at 82% 100%, rgba(66, 199, 238, 0.14), transparent 28%);
  color: white;
  padding: 16px 18px 12px;
  transition: opacity 0.3s var(--ease-smooth);
  z-index: 100;
  min-height: 84px;
}

.control-bar:not(.visible) {
  opacity: 0;
  pointer-events: none;
}

/* ===== 进度条 ===== */
.progress-container {
  order: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  margin-bottom: 0;
}

/* 包裹层：为广告标记和悬停气泡提供定位上下文 */
.progress-track-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

/* 广告区间标记：黄色条覆盖在进度条轨道上 */
.ad-ranges {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 5px;
  transform: translateY(-50%);
  pointer-events: none;
  border-radius: 999px;
}

.ad-range {
  position: absolute;
  top: 0;
  height: 100%;
  background: rgba(255, 176, 32, 0.85);
  border-radius: 999px;
  box-shadow: 0 0 4px rgba(255, 176, 32, 0.5);
}

/* 悬停/拖动时间气泡 */
.progress-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  padding: 3px 9px;
  border-radius: 7px;
  background: rgba(12, 10, 16, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #fff;
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}

/* 两端防溢出：定位比例在 JS 侧钳制（tooltipPosRatio） */

.progress-slider {
  width: 100%;
  margin: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  height: 5px;
  background: rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  outline: none;
  position: relative;
}

.progress-slider:focus-visible {
  outline: 2px solid rgba(255, 138, 176, 0.9);
  outline-offset: 4px;
}

.progress-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--player-progress), var(--accent-cyan));
  cursor: pointer;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.12);
  transition: transform 0.15s;
  position: relative;
  z-index: 2;
}

.progress-slider::-webkit-slider-thumb:hover {
  transform: scale(1.3);
}

.progress-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--player-progress);
  cursor: pointer;
  border: none;
}

.progress-slider::-moz-range-track {
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
}

.progress-slider::-moz-range-progress {
  height: 4px;
  background: var(--player-progress);
  border-radius: 2px;
}

.time-display {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-family: 'Consolas', 'Monaco', monospace;
  color: rgba(255, 255, 255, 0.82);
  opacity: 1;
  white-space: nowrap;
}

.separator {
  opacity: 0.5;
}

/* ===== 控制按钮 ===== */
.controls-container {
  order: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 36px;
  gap: 10px;
}

.controls-left,
.controls-right {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.control-btn {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.055);
  color: white;
  font-size: 14px;
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  transition: background 0.15s var(--ease-smooth), border-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth);
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 138, 176, 0.28);
}

/* 按下反馈 + 禁用态 + 键盘焦点可见 */
.control-btn:active:not(:disabled) {
  transform: scale(0.94);
  transition-duration: 0.1s;
}

.control-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

.control-btn:focus-visible {
  outline: 2px solid rgba(255, 138, 176, 0.9);
  outline-offset: 2px;
}

.play-btn {
  min-width: 36px;
  height: 36px;
  color: #fff;
  background: linear-gradient(135deg, rgba(var(--primary-rgb), 0.92), rgba(156, 123, 255, 0.88));
  border-color: transparent;
}

/* ===== 音量（常驻横向滑块） ===== */
.volume-control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}

.volume-slider-inline {
  display: flex;
  align-items: center;
  gap: 6px;
}

.volume-range {
  -webkit-appearance: none;
  appearance: none;
  width: 70px;
  height: 5px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}

.volume-range:focus-visible {
  outline: 2px solid rgba(255, 138, 176, 0.9);
  outline-offset: 4px;
}

.volume-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--player-progress), var(--accent-cyan));
  cursor: pointer;
  transition: transform 0.15s;
}

.volume-range::-webkit-slider-thumb:hover {
  transform: scale(1.3);
}

.volume-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--player-progress);
  cursor: pointer;
  border: none;
}

.volume-percent {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.76);
  font-family: 'Consolas', 'Monaco', monospace;
  min-width: 32px;
  text-align: center;
  user-select: none;
}

/* ===== 倍速 ===== */
.playback-rate-control {
  position: relative;
}

.rate-btn {
  font-size: 12px;
  font-weight: 600;
  min-width: 42px;
  letter-spacing: 0.5px;
}

.rate-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(19, 18, 31, 0.94);
  border: 1px solid rgba(255, 138, 176, 0.14);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 64px;
}

.rate-option {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 12px;
  text-align: center;
  transition: background-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth);
}

.rate-option:hover {
  background: rgba(var(--primary-rgb), 0.12);
  color: white;
}

.rate-option.active {
  color: var(--player-progress);
  font-weight: 600;
}

/* ===== 画质 ===== */
.quality-control {
  position: relative;
}

.quality-btn {
  font-size: 12px;
  font-weight: 600;
  min-width: 48px;
  letter-spacing: 0.3px;
}

.quality-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(19, 18, 31, 0.94);
  border: 1px solid rgba(255, 138, 176, 0.14);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 72px;
}

.quality-option {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 12px;
  text-align: center;
  transition: background-color 0.15s var(--ease-smooth), color 0.15s var(--ease-smooth);
}

.quality-option:hover {
  background: rgba(var(--primary-rgb), 0.12);
  color: white;
}

.quality-option.active {
  color: var(--player-progress);
  font-weight: 600;
}

/* ===== 弹幕按钮 + 菜单 ===== */
.danmaku-control {
  position: relative;
}

.danmaku-btn {
  /* 继承 .control-btn 基础样式 */
}

.danmaku-btn.active {
  color: var(--player-progress);
  border-color: rgba(var(--primary-rgb), 0.36);
  background: rgba(var(--primary-rgb), 0.12);
}

.danmaku-btn.pending {
  color: rgba(255, 255, 255, 0.76);
  border-color: rgba(255, 255, 255, 0.2);
}

/* ===== 投屏按钮 ===== */
.cast-btn.active {
  color: var(--player-progress);
  border-color: rgba(var(--primary-rgb), 0.36);
  background: rgba(var(--primary-rgb), 0.12);
  animation: cast-pulse 2s ease-in-out infinite;
}

@keyframes cast-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--primary-rgb), 0); }
  50% { box-shadow: 0 0 0 4px rgba(var(--primary-rgb), 0.18); }
}

.danmaku-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  background: rgba(19, 18, 31, 0.94);
  border: 1px solid rgba(255, 138, 176, 0.14);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 120px;
}

.danmaku-option {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  padding: 8px 14px;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.danmaku-option:hover {
  background: rgba(var(--primary-rgb), 0.12);
  color: white;
}

.danmaku-option.active {
  color: var(--player-progress);
  font-weight: 600;
}

/* ===== 字幕按钮 + 菜单 ===== */
.subtitle-control {
  position: relative;
}

.subtitle-btn {
  /* 继承 .control-btn 基础样式 */
}

.subtitle-btn.active {
  color: var(--player-progress);
  border-color: rgba(var(--primary-rgb), 0.36);
  background: rgba(var(--primary-rgb), 0.12);
}

/* ===== 一起看按钮 ===== */
.watch-together-btn.active {
  color: var(--player-progress);
  border-color: rgba(var(--primary-rgb), 0.36);
  background: rgba(var(--primary-rgb), 0.12);
}

.subtitle-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  background: rgba(19, 18, 31, 0.94);
  border: 1px solid rgba(255, 138, 176, 0.14);
  border-radius: 8px;
  padding: 4px 0;
  min-width: 132px;
}

.subtitle-option {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  padding: 8px 14px;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.subtitle-option:hover {
  background: rgba(var(--primary-rgb), 0.12);
  color: white;
}

.subtitle-option.active {
  color: var(--player-progress);
  font-weight: 600;
}

/* ===== 常用播放设置 ===== */
.player-settings-control {
  position: relative;
}

.settings-btn.menu-open {
  color: var(--player-progress);
  border-color: rgba(var(--primary-rgb), 0.38);
  background: rgba(var(--primary-rgb), 0.08);
}

.player-settings-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  width: 286px;
  max-height: min(72vh, 560px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(19, 18, 31, 0.97);
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.36);
  color: #fff;
}

.player-settings-menu::-webkit-scrollbar {
  width: 6px;
}

.player-settings-menu::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
}

.settings-menu-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 2px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}

.settings-menu-heading strong {
  font-size: 13px;
}

.settings-menu-heading span {
  color: rgba(110, 216, 255, 0.9);
  font-size: 10px;
}

.settings-menu-row {
  min-height: 42px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.settings-menu-row:last-child {
  border-bottom: 0;
}

.settings-menu-row-stack {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 10px 2px;
}

.settings-menu-label,
.settings-toggle-row strong {
  color: rgba(255, 255, 255, 0.88);
  font-size: 12px;
  font-weight: 600;
}

.seek-step-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
}

.seek-step-option {
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 0.14s var(--ease-smooth), border-color 0.14s var(--ease-smooth), color 0.14s var(--ease-smooth);
}

.seek-step-option:hover {
  border-color: rgba(110, 216, 255, 0.38);
  color: #fff;
}

.seek-step-option.active {
  border-color: var(--player-progress);
  background: rgba(var(--primary-rgb), 0.18);
  color: #fff;
}

.settings-toggle-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 2px;
  cursor: pointer;
}

.ad-skip-action {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 2px;
  border-top: 0;
  border-right: 0;
  border-left: 0;
  background: transparent;
  color: rgba(255, 255, 255, 0.82);
  text-align: left;
  cursor: pointer;
  transition: color 0.14s var(--ease-smooth), background-color 0.14s var(--ease-smooth);
}

.ad-skip-action:hover,
.ad-skip-action.reported {
  color: #fff;
  background: rgba(var(--primary-rgb), 0.1);
}

.clean-source-action svg {
  color: rgba(110, 216, 255, 0.92);
}

.ad-skip-action > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.ad-skip-action strong {
  font-size: 12px;
  font-weight: 600;
}

.ad-skip-action small {
  color: rgba(255, 255, 255, 0.48);
  font-size: 10px;
}

.settings-toggle-row > span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-toggle-row small {
  color: rgba(255, 255, 255, 0.48);
  font-size: 10px;
}

.settings-toggle-row input {
  position: absolute;
  opacity: 0;
}

.settings-toggle-row i {
  position: relative;
  width: 34px;
  height: 19px;
  flex: 0 0 34px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.16);
  transition: background-color 0.16s var(--ease-smooth);
}

.settings-toggle-row i::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.16s var(--ease-smooth);
}

.settings-toggle-row input:checked + i {
  background: var(--player-progress);
}

.settings-toggle-row input:checked + i::after {
  transform: translateX(15px);
}

.settings-range-row {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr) 38px;
  align-items: center;
  gap: 8px;
  padding: 9px 2px;
}

.settings-range-row input {
  width: 100%;
  accent-color: var(--player-progress);
}

.settings-range-row output {
  color: rgba(255, 255, 255, 0.62);
  font-family: Consolas, monospace;
  font-size: 10px;
  text-align: right;
}

/* 超分档位下拉（沿用 range-row 两端布局） */
.settings-range-row .settings-menu-select {
  grid-column: 2 / 4;
  width: 100%;
  height: 24px;
  padding: 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 11px;
  outline: none;
  cursor: pointer;
}

.settings-range-row .settings-menu-select option {
  color: #222;
}

.settings-pop-enter-active,
.settings-pop-leave-active {
  transition: opacity 0.14s var(--ease-smooth), transform 0.14s var(--ease-smooth);
  transform-origin: right bottom;
}

.settings-pop-enter-from,
.settings-pop-leave-to {
  opacity: 0;
  transform: translateY(5px) scale(0.97);
}

/* ===== 过渡动画 ===== */
.fade-scale-enter-active {
  transition: opacity 0.15s, transform 0.15s;
}
.fade-scale-leave-active {
  transition: opacity 0.1s, transform 0.1s;
}
.fade-scale-enter-from {
  opacity: 0;
  transform: translateX(-50%) scale(0.9);
}
.fade-scale-leave-to {
  opacity: 0;
  transform: translateX(-50%) scale(0.9);
}

@media (max-width: 768px) {
  .control-bar {
    padding: 12px 10px 8px;
    min-height: 78px;
  }

  .controls-left,
  .controls-right {
    gap: 2px;
  }

  .control-btn {
    min-width: 28px;
    height: 28px;
    padding: 4px;
  }

  .progress-container {
    gap: 8px;
  }

  .rate-btn {
    font-size: 11px;
    min-width: 36px;
  }

  /* 移动端音量滑块缩短，隐藏百分比 */
  .volume-range {
    width: 50px;
  }
  .volume-percent {
    display: none;
  }
}
</style>
