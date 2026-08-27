/**
 * 弹幕渲染引擎（Canvas 实现）
 *
 * 支持：
 *   - 滚动弹幕（从右到左）：多轨道碰撞检测，自动避让
 *   - 顶部弹幕：固定在顶部，按时长消失
 *   - 底部弹幕：固定在底部，按时长消失
 *   - 字号 / 透明度 / 速度 / 显示区域比例 可调
 *   - 暂停时停止动画，seek 时重置时间轴
 *   - 密度自适应：高密度时按 hash 降采样，避免掉帧
 *   - 文本宽度缓存 + 批量渲染优化
 *
 * 使用：
 *   const engine = new DanmakuEngine(canvas);
 *   engine.setComments([...]);
 *   engine.start();
 *   engine.setTime(currentTime);  // 由视频 timeupdate 驱动
 *   engine.destroy();
 */

const SCROLL_LIFE_MS = 8000;        // 滚动弹幕单条生命期（ms），实际按速度倍率缩放
const FIXED_LIFE_MS = 4000;         // 顶/底弹幕持续时长（ms）
const COLLISION_PADDING = 10;       // 轨道碰撞额外间距
const MAX_ACTIVE_DANMAKU = 150;     // 同屏最大弹幕数，超过触发降采样
const DENSITY_SAMPLE_INTERVAL = 500; // 密度统计窗口（ms）

export default class DanmakuEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;

    // 弹幕数据
    this.comments = [];              // 排序后的弹幕数组 [{ time, color, text, type }]
    this.cursor = 0;                 // 已分发的弹幕指针（按 time 排序后）

    // 运行时状态
    this.activeScroll = [];          // 活跃的滚动弹幕 [{ comment, x, y, width, track, bornAt }]
    this.activeFixed = [];           // 活跃的顶/底弹幕 [{ comment, y, bornAt, lifeMs }]
    this.scrollTracks = [];          // 滚动轨道：每项是该轨道最后一条弹幕的 right 边缘时间戳信息
    this.topTracks = [];             // 顶部轨道占用情况
    this.bottomTracks = [];          // 底部轨道占用情况

    // 时间同步
    this.currentTime = 0;            // 视频当前时间（秒）
    this.lastFrameTime = 0;          // 上一帧时间戳（用于计算 delta）
    this.playing = false;

    // 设置
    this.fontSize = 20;
    this.opacity = 1.0;
    this.speed = 1.0;                // 速度倍率，1=标准
    this.displayAreaRatio = 0.75;    // 显示区域占 canvas 高度的比例（0.25~1）
    this.visible = true;             // 弹幕开关

    // 密度自适应
    this._densityWindow = [];        // 密度统计窗口 [{ time, count }]
    this._dropRate = 0;              // 当前丢弃率（0=不丢，1=全丢）

    // 文本宽度缓存（key = text+fontSize）
    this._widthCache = new Map();
    this._widthCacheSize = 0;

    // 渲染循环
    this._rafId = null;
    this._devicePixelRatio = window.devicePixelRatio || 1;
    // 帧率控制：弹幕不需要 60fps，30fps 足够流畅且省 CPU/GPU
    this._targetFps = 30;
    this._frameInterval = 1000 / this._targetFps;
    this._lastRenderTime = 0;

    if (this.canvas) {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.canvas.parentElement || this.canvas);
      this.resize();
    }
  }

  // ── 设置 ──
  setComments(comments) {
    this.comments = Array.isArray(comments)
      ? comments.slice().sort((a, b) => a.time - b.time)
      : [];
    this.cursor = 0;
    this.activeScroll = [];
    this.activeFixed = [];
    this.scrollTracks = [];
    this.topTracks = [];
    this.bottomTracks = [];
    this._densityWindow = [];
    this._dropRate = 0;
    // 清空宽度缓存（字号可能变化）
    this._widthCache.clear();
    this._widthCacheSize = 0;
  }

  setFontSize(size) {
    this.fontSize = Math.max(12, Math.min(36, parseInt(size, 10) || 20));
    // 字号变化后需要重置轨道和宽度缓存
    this.scrollTracks = [];
    this.topTracks = [];
    this.bottomTracks = [];
    this._widthCache.clear();
    this._widthCacheSize = 0;
  }

  setOpacity(opacity) {
    this.opacity = Math.max(0.1, Math.min(1, parseFloat(opacity) || 1));
  }

  setSpeed(speed) {
    this.speed = Math.max(0.25, Math.min(3, parseFloat(speed) || 1));
  }

  setDisplayAreaRatio(ratio) {
    this.displayAreaRatio = Math.max(0.25, Math.min(1, parseFloat(ratio) || 0.75));
  }

  setVisible(visible) {
    this.visible = !!visible;
    if (!this.visible) {
      this.clear();
    }
  }

  /**
   * 调整 canvas 尺寸（处理 devicePixelRatio）
   */
  resize() {
    if (!this.canvas || !this.ctx) return;
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = this._devicePixelRatio;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssWidth = rect.width;
    this._cssHeight = rect.height;
    // 尺寸变化后重置轨道
    this.scrollTracks = [];
    this.topTracks = [];
    this.bottomTracks = [];
  }

  // ── 时间控制 ──
  setTime(timeSec) {
    this.currentTime = timeSec;
    // 时间回退（seek 倒退）：清空活跃弹幕，重置 cursor 到当前时间之前
    // 仅在显著回退时重置，避免抖动
    if (this.activeScroll.length > 0 || this.activeFixed.length > 0) {
      // 检测是否回退
      const minActiveTime = this._minActiveTime();
      if (timeSec + 0.5 < minActiveTime) {
        this.activeScroll = [];
        this.activeFixed = [];
        this.scrollTracks = [];
        this.topTracks = [];
        this.bottomTracks = [];
        this.cursor = this._findCursorIndex(timeSec);
      }
    } else {
      // 无活跃弹幕时也确保 cursor 对齐
      if (this.cursor === 0 || (this.cursor < this.comments.length && this.comments[this.cursor].time > timeSec + 1)) {
        this.cursor = this._findCursorIndex(timeSec);
      }
    }
  }

  _findCursorIndex(timeSec) {
    // 二分查找第一个 time >= timeSec 的位置
    let lo = 0, hi = this.comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.comments[mid].time < timeSec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _minActiveTime() {
    let min = Infinity;
    for (const item of this.activeScroll) {
      if (item.comment.time < min) min = item.comment.time;
    }
    for (const item of this.activeFixed) {
      if (item.comment.time < min) min = item.comment.time;
    }
    return min === Infinity ? this.currentTime : min;
  }

  setPlaying(playing) {
    this.playing = !!playing;
    if (this.playing) {
      this.lastFrameTime = 0; // 重置，避免 delta 过大
    }
  }

  // ── 渲染循环 ──
  start() {
    if (this._rafId) return;
    this.lastFrameTime = 0;
    this._lastRenderTime = 0;
    const loop = (ts) => {
      this._rafId = requestAnimationFrame(loop);
      this._tick(ts);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  clear() {
    if (this.ctx && this._cssWidth) {
      this.ctx.clearRect(0, 0, this._cssWidth, this._cssHeight);
    }
  }

  destroy() {
    this.stop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this.clear();
    this.comments = [];
    this.activeScroll = [];
    this.activeFixed = [];
    this._densityWindow = [];
    this._widthCache.clear();
    this.canvas = null;
    this.ctx = null;
  }

  // ── 核心逻辑 ──
  _tick(timestamp) {
    if (!this.ctx || !this._cssWidth) return;
    if (!this.visible) {
      this.clear();
      return;
    }

    // 帧率控制：30fps 足够弹幕流畅，降低 GPU/CPU 占用
    const elapsed = timestamp - this._lastRenderTime;
    if (elapsed < this._frameInterval) {
      return;
    }
    this._lastRenderTime = timestamp - (elapsed % this._frameInterval);

    const delta = this.lastFrameTime === 0 ? this._frameInterval : (timestamp - this.lastFrameTime);
    this.lastFrameTime = timestamp;

    // 推进活跃弹幕
    if (this.playing) {
      this._spawnNew();
      this._updateScroll(delta);
      this._updateFixed();
      this._updateDensity();
    }

    // 渲染
    this._render();
  }

  /**
   * 分发当前时间点应出现的弹幕
   * 含密度自适应：同屏弹幕过多时按 hash 降采样
   */
  _spawnNew() {
    const t = this.currentTime;
    while (this.cursor < this.comments.length && this.comments[this.cursor].time <= t) {
      const c = this.comments[this.cursor];
      this.cursor++;
      // 密度自适应：根据当前活跃弹幕数计算丢弃率
      const activeCount = this.activeScroll.length + this.activeFixed.length;
      if (activeCount > MAX_ACTIVE_DANMAKU) {
        // 超过上限，按弹幕文本 hash 决定是否丢弃（同一弹幕稳定丢弃/保留）
        const hash = this._quickHash(c.text);
        const threshold = (activeCount - MAX_ACTIVE_DANMAKU) / activeCount;
        if (hash < threshold) {
          continue; // 丢弃该弹幕
        }
      }
      this._spawnOne(c);
    }
  }

  /**
   * 快速字符串哈希（0~1 浮点数），用于稳定的降采样
   */
  _quickHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return ((h >>> 0) % 1000) / 1000;
  }

  /**
   * 更新密度统计窗口，动态调整丢弃率
   */
  _updateDensity() {
    const now = performance.now();
    // 清理过期统计（超过 DENSITY_SAMPLE_INTERVAL）
    this._densityWindow = this._densityWindow.filter(t => now - t < DENSITY_SAMPLE_INTERVAL);
    // 记录当前帧
    this._densityWindow.push(now);
  }

  _spawnOne(comment) {
    if (comment.type === 'scroll') {
      this._spawnScroll(comment);
    } else if (comment.type === 'top') {
      this._spawnFixed(comment, 'top');
    } else if (comment.type === 'bottom') {
      this._spawnFixed(comment, 'bottom');
    }
  }

  /**
   * 测量文本宽度（带缓存）
   */
  _measureWidth(text) {
    const key = this.fontSize + '|' + text;
    let w = this._widthCache.get(key);
    if (w === undefined) {
      this.ctx.font = `${this.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      w = this.ctx.measureText(text).width;
      // 限制缓存大小，避免内存膨胀
      if (this._widthCacheSize > 2000) {
        this._widthCache.clear();
        this._widthCacheSize = 0;
      }
      this._widthCache.set(key, w);
      this._widthCacheSize++;
    }
    return w;
  }

  /**
   * 计算可用轨道数量
   */
  _trackCount() {
    const trackHeight = this.fontSize + 8;
    const availHeight = this._cssHeight * this.displayAreaRatio;
    return Math.max(1, Math.floor(availHeight / trackHeight));
  }

  _trackY(trackIdx) {
    const trackHeight = this.fontSize + 8;
    return trackIdx * trackHeight + 4;
  }

  /**
   * 滚动弹幕：找到可用的轨道
   * 碰撞规则：该轨道最后一条弹幕的右边缘 + padding < canvas 宽度，才可放入
   */
  _spawnScroll(comment) {
    const trackCount = this._trackCount();
    const width = this._measureWidth(comment.text);
    const canvasWidth = this._cssWidth;

    // 扩展轨道数组
    while (this.scrollTracks.length < trackCount) this.scrollTracks.push(null);

    for (let i = 0; i < trackCount; i++) {
      const last = this.scrollTracks[i];
      // last: { rightEdge, bornAt } —— 该轨道最后一条弹幕当前右边缘的 x 坐标
      if (!last) {
        this._addToScroll(comment, i, width, canvasWidth);
        return;
      }
      // 计算最后一条弹幕当前的右边缘位置
      const elapsed = performance.now() - last.bornAt;
      const lifeMs = SCROLL_LIFE_MS / this.speed;
      const progress = elapsed / lifeMs;
      // 弹幕从 x=canvasWidth 移动到 x=-width，总位移 = canvasWidth + width
      const totalDistance = canvasWidth + last.width;
      const currentX = canvasWidth - progress * totalDistance;
      const currentRight = currentX + last.width;
      // 需要当前右边缘 + padding < canvas 宽度（即弹幕已完全进入画面）
      if (currentRight + COLLISION_PADDING < canvasWidth) {
        this._addToScroll(comment, i, width, canvasWidth);
        return;
      }
    }
    // 所有轨道都满，丢弃该弹幕（避免堆叠）
  }

  _addToScroll(comment, track, width, canvasWidth) {
    const item = {
      comment,
      width,
      track,
      x: canvasWidth,           // 起始 x（右边缘外）
      y: this._trackY(track),
      bornAt: performance.now()
    };
    this.activeScroll.push(item);
    this.scrollTracks[track] = {
      rightEdge: canvasWidth + width,
      width,
      bornAt: item.bornAt
    };
  }

  /**
   * 顶/底弹幕：找到可用轨道
   */
  _spawnFixed(comment, position) {
    const trackCount = this._trackCount();
    const tracks = position === 'top' ? this.topTracks : this.bottomTracks;
    while (tracks.length < trackCount) tracks.push(null);

    for (let i = 0; i < trackCount; i++) {
      const slot = tracks[i];
      const now = performance.now();
      if (!slot || now - slot.bornAt > FIXED_LIFE_MS) {
        const y = position === 'top'
          ? this._trackY(i)
          : this._cssHeight - this._trackY(i) - this.fontSize - 8;
        const item = {
          comment,
          y,
          bornAt: now,
          lifeMs: FIXED_LIFE_MS
        };
        this.activeFixed.push(item);
        tracks[i] = { bornAt: now };
        return;
      }
    }
    // 满了就丢弃
  }

  /**
   * 更新滚动弹幕位置，移除已离开画面的
   */
  _updateScroll(_delta) {
    const canvasWidth = this._cssWidth;
    const lifeMs = SCROLL_LIFE_MS / this.speed;
    const now = performance.now();
    const remaining = [];

    for (const item of this.activeScroll) {
      const elapsed = now - item.bornAt;
      const progress = elapsed / lifeMs;
      const totalDistance = canvasWidth + item.width;
      item.x = canvasWidth - progress * totalDistance;
      // 右边缘 < 0 表示已完全离开画面左侧
      if (item.x + item.width >= 0) {
        remaining.push(item);
      }
    }
    this.activeScroll = remaining;
  }

  /**
   * 更新顶/底弹幕，移除已过期的
   */
  _updateFixed() {
    const now = performance.now();
    this.activeFixed = this.activeFixed.filter(item => (now - item.bornAt) < item.lifeMs);
  }

  /**
   * 渲染所有活跃弹幕
   * 优化：一次性设置 font/globalAlpha，减少 Canvas state 切换
   */
  _render() {
    this.clear();
    this.ctx.globalAlpha = this.opacity;
    this.ctx.font = `${this.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    this.ctx.textBaseline = 'top';

    // 滚动弹幕
    for (const item of this.activeScroll) {
      this._drawText(item.comment, item.x, item.y);
    }
    // 顶/底弹幕：居中
    for (const item of this.activeFixed) {
      const width = this._measureWidth(item.comment.text);
      const x = (this._cssWidth - width) / 2;
      this._drawText(item.comment, x, item.y);
    }

    this.ctx.globalAlpha = 1;
  }

  /**
   * 绘制单条弹幕文本（带描边）
   */
  _drawText(comment, x, y) {
    const color = this._formatColor(comment.color);
    this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    this.ctx.lineWidth = 2;
    this.ctx.strokeText(comment.text, x, y);
    this.ctx.fillStyle = color;
    this.ctx.fillText(comment.text, x, y);
  }

  _formatColor(intColor) {
    const c = Number(intColor) || 0xFFFFFF;
    const r = (c >> 16) & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = c & 0xFF;
    return `rgb(${r}, ${g}, ${b})`;
  }
}
