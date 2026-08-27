<template>
  <div class="subtitle-layer" :style="layerStyle">
    <transition name="subtitle-fade">
      <div v-if="currentText" class="subtitle-text" :style="textStyle">
        <span v-for="(line, i) in currentLines" :key="i" class="subtitle-line">{{ line }}</span>
      </div>
    </transition>
  </div>
</template>

<script>
/**
 * 字幕显示层
 * 根据当前播放时间在 cue 数组中查找对应字幕并显示
 * 字幕层与弹幕层独立，不互相干扰（z-index 低于弹幕层，但都在视频之上）
 */
export default {
  name: 'SubtitleLayer',
  props: {
    // 字幕 cue 数组：[{ start, end, text }]
    cues: {
      type: Array,
      default: () => []
    },
    // 当前播放时间（秒）
    currentTime: {
      type: Number,
      default: 0
    },
    // 字体大小（px）
    fontSize: {
      type: Number,
      default: 24
    },
    // 不透明度 0-1
    opacity: {
      type: Number,
      default: 1.0
    },
    // 距离底部偏移（px）
    bottomOffset: {
      type: Number,
      default: 80
    },
    // 是否显示字幕（开关）
    visible: {
      type: Boolean,
      default: true
    }
  },
  data() {
    return {
      // 缓存当前查找到的 cue 索引，避免每次 timeupdate 都从头查找
      _lastCueIndex: -1,
      // 当前显示的字幕文本
      currentText: ''
    };
  },
  computed: {
    // 将当前字幕文本按换行符拆分为多行
    currentLines() {
      if (!this.currentText) return [];
      return this.currentText.split('\n');
    },
    // 容器层样式：定位 + 不透明度
    layerStyle() {
      return {
        opacity: this.visible ? this.opacity : 0,
        bottom: `${this.bottomOffset}px`
      };
    },
    // 文本样式：字号 + 描边
    textStyle() {
      return {
        fontSize: `${this.fontSize}px`
      };
    }
  },
  watch: {
    // 时间变化时查找对应字幕
    currentTime(val) {
      this.findCurrentCue(val);
    },
    // cues 数组变化时重置缓存
    cues() {
      this._lastCueIndex = -1;
      this.currentText = '';
      this.findCurrentCue(this.currentTime);
    },
    // 关闭字幕时清空显示
    visible(val) {
      if (!val) {
        this.currentText = '';
      } else {
        this.findCurrentCue(this.currentTime);
      }
    }
  },
  methods: {
    /**
     * 在 cue 数组中查找当前时间对应的字幕
     * 使用二分查找优化性能（cue 数组通常按时间排序）
     * @param {number} time - 当前播放时间（秒）
     */
    findCurrentCue(time) {
      if (!this.visible) {
        this.currentText = '';
        return;
      }
      const cues = this.cues;
      if (!cues || cues.length === 0) {
        this.currentText = '';
        return;
      }

      // 先检查上次索引附近的 cue（局部性优化）
      const lastIdx = this._lastCueIndex;
      if (lastIdx >= 0 && lastIdx < cues.length) {
        const cue = cues[lastIdx];
        if (time >= cue.start && time <= cue.end) {
          // 仍在当前字幕范围内，无需更新
          if (this.currentText !== cue.text) {
            this.currentText = cue.text;
          }
          return;
        }
      }

      // 二分查找
      const idx = this.binarySearchCue(cues, time);
      if (idx !== -1) {
        this._lastCueIndex = idx;
        const cue = cues[idx];
        if (this.currentText !== cue.text) {
            this.currentText = cue.text;
        }
      } else {
        this._lastCueIndex = -1;
        if (this.currentText !== '') {
            this.currentText = '';
        }
      }
    },

    /**
     * 二分查找当前时间所在的 cue 索引
     * @param {Array} cues - 字幕数组（按 start 升序）
     * @param {number} time - 当前时间
     * @returns {number} 找到的索引，未找到返回 -1
     */
    binarySearchCue(cues, time) {
      let low = 0;
      let high = cues.length - 1;
      let result = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const cue = cues[mid];
        if (time < cue.start) {
          high = mid - 1;
        } else if (time > cue.end) {
          low = mid + 1;
        } else {
          // time >= cue.start && time <= cue.end
          result = mid;
          break;
        }
      }
      return result;
    },

    /**
     * seek 时重置字幕查找状态
     * 由父组件调用
     */
    onSeek(time) {
      this._lastCueIndex = -1;
      this.findCurrentCue(time);
    }
  }
};
</script>

<style scoped>
.subtitle-layer {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 40;
  transition: opacity 0.2s ease;
}

.subtitle-text {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 80%;
  padding: 6px 16px;
  border-radius: 6px;
  /* 黑色半透明背景，提升可读性 */
  background: rgba(0, 0, 0, 0.55);
  color: #ffffff;
  font-family: 'Microsoft YaHei', 'PingFang SC', 'Helvetica Neue', sans-serif;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  /* 黑色描边，进一步增强可读性 */
  text-shadow:
    -1px -1px 0 #000,
    1px -1px 0 #000,
    -1px 1px 0 #000,
    1px 1px 0 #000,
    0 0 4px rgba(0, 0, 0, 0.8);
  word-wrap: break-word;
  word-break: break-word;
  white-space: pre-wrap;
}

.subtitle-line {
  display: block;
}

/* 字幕淡入淡出过渡 */
.subtitle-fade-enter-active {
  transition: opacity 0.15s ease;
}
.subtitle-fade-leave-active {
  transition: opacity 0.1s ease;
}
.subtitle-fade-enter-from,
.subtitle-fade-leave-to {
  opacity: 0;
}

@media (max-width: 768px) {
  .subtitle-text {
    max-width: 92%;
    padding: 4px 10px;
  }
}
</style>
