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
 *   - 文本预光栅化位图缓存：每帧仅 drawImage，滚动高帧率下依然流畅
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
const DEFAULT_MAX_ACTIVE_DANMAKU = 80; // 默认同屏最大弹幕数（用户可在设置中调整 danmakuDensity）
const SPAWN_TOKEN_BURST = 3;        // 令牌桶容量（允许的瞬时爆发量）

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

    // 密度控制：令牌桶限速。稳态同屏数 ≈ maxActive（按生命期换算放行速率），
    // 且放行在时间上均匀分布，避免"一批全进→空白几秒→再一批"的批次效应
    this._spawnTokens = SPAWN_TOKEN_BURST; // 当前令牌数
    this._lastTokenTime = 0;        // 上次补充令牌的视频时间（秒）
    this.maxActive = DEFAULT_MAX_ACTIVE_DANMAKU; // 同屏弹幕上限（用户可调）

    // 文本宽度缓存（key = text+fontSize）
    this._widthCache = new Map();
    this._widthCacheSize = 0;

    // 文本位图缓存（key = fontSize+color+text）：每条弹幕只光栅化一次，滚动帧里 drawImage 复用
    this._spriteCache = new Map();

    // 渲染循环
    this._rafId = null;
    this._devicePixelRatio = window.devicePixelRatio || 1;

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
    // 重置换弹幕的时间轴与放行令牌
    this._spawnTokens = SPAWN_TOKEN_BURST;
    this._lastTokenTime = 0;
    // 清空宽度/位图缓存（字号可能变化）
    this._widthCache.clear();
    this._widthCacheSize = 0;
    this._spriteCache.clear();
  }

  setFontSize(size) {
    this.fontSize = Math.max(12, Math.min(36, parseInt(size, 10) || 20));
    // 字号变化后需要重置轨道和宽度/位图缓存
    this.scrollTracks = [];
    this.topTracks = [];
    this.bottomTracks = [];
    this._widthCache.clear();
    this._widthCacheSize = 0;
    this._spriteCache.clear();
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

  // 同屏弹幕上限（用户可调，20-150）
  setMaxActive(count) {
    this.maxActive = Math.max(10, Math.min(200, parseInt(count, 10) || DEFAULT_MAX_ACTIVE_DANMAKU));
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
    // dpr 变化（跨屏拖动）时位图需要重光栅化
    if (dpr !== (window.devicePixelRatio || 1)) this._spriteCache.clear();
    this._devicePixelRatio = window.devicePixelRatio || 1;
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
    this._widthCache.clear();
    this._spriteCache.clear();
    this.canvas = null;
    this.ctx = null;
  }

  // ── 核心逻辑 ──
  _tick(_timestamp) {
    if (!this.ctx || !this._cssWidth) return;
    if (!this.visible) {
      this.clear();
      return;
    }

    // 不做帧率门控：rAF 本身跟随显示器刷新率；
    // 以固定 fps 为目标做跳帧会在 60Hz 屏上产生周期性丢帧（节拍抖动），滚动弹幕对此非常敏感

    if (this.playing) {
      this._refillSpawnTokens();
      this._spawnNew();
      this._updateScroll();
      this._updateFixed();
    }

    // 渲染
    this._render();
  }

  /**
   * 分发当前时间点应出现的弹幕
   * 密度控制：令牌桶限速，消耗 1 个令牌放行 1 条；无令牌则丢弃
   */
  _spawnNew() {
    const t = this.currentTime;
    while (this.cursor < this.comments.length && this.comments[this.cursor].time <= t) {
      const c = this.comments[this.cursor];
      this.cursor++;
      if (this._spawnTokens < 1) {
        continue; // 令牌耗尽，丢弃（后续弹幕按补充节奏持续放行，不会攒批）
      }
      this._spawnTokens -= 1;
      this._spawnOne(c);
    }
  }

  /**
   * 按视频时间补充放行令牌：速率 = maxActive / 平均生命期
   * 稳态下 同屏数 ≈ 放行速率 × 生命期 ≈ maxActive
   */
  _refillSpawnTokens() {
    const t = this.currentTime;
    const delta = Math.max(0, t - this._lastTokenTime);
    this._lastTokenTime = t;
    if (delta === 0) return;
    // 速度越快生命期越短，放行速率相应提高，保证同屏数仍收敛到 maxActive
    const lifeSec = (SCROLL_LIFE_MS / 1000) / Math.max(0.25, this.speed);
    const refillPerSec = this.maxActive / lifeSec;
    this._spawnTokens = Math.min(SPAWN_TOKEN_BURST, this._spawnTokens + delta * refillPerSec);
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
   * 优化：文本预光栅化成位图（_getSprite），每帧只做 drawImage，
   * 避免对上百条文本逐帧重复 strokeText/fillText（滚动卡顿的主要来源）
   */
  _render() {
    this.clear();
    this.ctx.globalAlpha = this.opacity;
    const dpr = this._devicePixelRatio;

    // 滚动弹幕
    for (const item of this.activeScroll) {
      const s = this._getSprite(item.comment);
      this.ctx.drawImage(s.canvas, item.x - s.pad, item.y - s.pad, s.canvas.width / dpr, s.canvas.height / dpr);
    }
    // 顶/底弹幕：居中
    for (const item of this.activeFixed) {
      const s = this._getSprite(item.comment);
      const x = (this._cssWidth - s.width) / 2;
      this.ctx.drawImage(s.canvas, x - s.pad, item.y - s.pad, s.canvas.width / dpr, s.canvas.height / dpr);
    }

    this.ctx.globalAlpha = 1;
  }

  /**
   * 获取弹幕文本的位图缓存：描边+填充只做一次，之后逐帧 drawImage
   */
  _getSprite(comment) {
    const key = this.fontSize + '|' + (comment.color || 0) + '|' + comment.text;
    let sprite = this._spriteCache.get(key);
    if (!sprite) {
      // 限制缓存条数，避免长视频内存膨胀
      if (this._spriteCache.size > 1500) this._spriteCache.clear();
      const font = `${this.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      const pad = 3; // 描边余量
      this.ctx.font = font;
      const textWidth = Math.ceil(this.ctx.measureText(comment.text).width);
      const w = textWidth + pad * 2;
      const h = this.fontSize + pad * 2;
      const dpr = this._devicePixelRatio;
      const cv = document.createElement('canvas');
      cv.width = Math.ceil(w * dpr);
      cv.height = Math.ceil(h * dpr);
      const c = cv.getContext('2d');
      c.scale(dpr, dpr);
      c.font = font;
      c.textBaseline = 'top';
      c.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      c.lineWidth = 2;
      c.strokeText(comment.text, pad, pad);
      c.fillStyle = this._formatColor(comment.color);
      c.fillText(comment.text, pad, pad);
      sprite = { canvas: cv, width: textWidth, pad };
      this._spriteCache.set(key, sprite);
    }
    return sprite;
  }

  _formatColor(intColor) {
    const c = Number(intColor) || 0xFFFFFF;
    const r = (c >> 16) & 0xFF;
    const g = (c >> 8) & 0xFF;
    const b = c & 0xFF;
    return `rgb(${r}, ${g}, ${b})`;
  }
}
