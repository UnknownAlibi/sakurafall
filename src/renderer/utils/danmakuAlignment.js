/**
 * 弹幕时间轴对齐（纯函数，可单测）
 *
 * 背景：不同片源会删片头/片尾、在中间插广告，导致「弹幕所属的官方站版本时间轴」
 * 与「正在播放的源」对不上。这里用一份可解释的对齐配置把弹幕时间轴映射到视频时间轴：
 *
 *   alignment = {
 *     offset: 0,              // 全局微调（秒），正数=弹幕往后挪（延迟显示）
 *     cuts:    [{ start, end }],  // 标准（弹幕）时间轴里被本视频删掉的区间
 *     inserts: [{ start, end }],  // 本视频里插入的区间（如中段广告），单位是视频时间
 *   }
 *
 * 映射规则（按序）：
 *   1. 命中 cuts 区间的弹幕 → 丢弃（那段时间本视频里不存在）；
 *   2. 跨过 cuts 后整体前移被删掉的时长；
 *   3. 跨过 inserts（广告）后整体后移广告时长；落在广告区间内的弹幕 → 丢弃；
 *   4. 最后叠加 offset 微调。
 */

const MAX_SHIFT_SECONDS = 1800; // 单个区间上限 30 分钟，防止脏数据把弹幕搬到离谱的位置

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampRange(range) {
  const start = Math.max(0, toFiniteNumber(range?.start, 0));
  const end = Math.max(start, toFiniteNumber(range?.end, start));
  const length = Math.min(end - start, MAX_SHIFT_SECONDS);
  return { start, end: start + length };
}

function normalizeRanges(ranges) {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .map(clampRange)
    .filter(range => range.end - range.start >= 0.2)
    .sort((a, b) => a.start - b.start);
}

/** 归一化并排序一份对齐配置（脏数据在这里被收敛，供持久层与渲染层共用） */
export function normalizeAlignment(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const offset = Math.max(-MAX_SHIFT_SECONDS, Math.min(MAX_SHIFT_SECONDS, toFiniteNumber(source.offset, 0)));
  return {
    offset: Math.round(offset * 10) / 10,
    cuts: normalizeRanges(source.cuts),
    inserts: normalizeRanges(source.inserts)
  };
}

/** 空配置（未校准） */
export function createEmptyAlignment() {
  return { offset: 0, cuts: [], inserts: [] };
}

/** 是否等同于「未校准」 */
export function isAlignmentEmpty(alignment) {
  const normalized = normalizeAlignment(alignment);
  return normalized.offset === 0 && normalized.cuts.length === 0 && normalized.inserts.length === 0;
}

/**
 * 标准时间轴 → 视频时间轴
 * @returns {number|null} 视频时间（秒）；null 表示该时间点的弹幕不应显示（落在被删除/广告区间内）
 */
export function mapCanonicalToVideoTime(canonicalTime, alignment) {
  const time = toFiniteNumber(canonicalTime, 0);
  if (time < 0) return null;
  const { offset, cuts, inserts } = normalizeAlignment(alignment);

  let shift = 0;
  for (const cut of cuts) {
    if (time >= cut.start && time < cut.end) return null;
    if (time >= cut.end) shift -= (cut.end - cut.start);
  }

  let played = time + shift;
  for (const insert of inserts) {
    if (played >= insert.start && played < insert.end) return null;
    if (played >= insert.end) played += (insert.end - insert.start);
  }

  return played + offset;
}

/**
 * 批量重映射弹幕时间（生成新数组，不改原对象）
 * @param {Array} comments - { time(秒), ... }
 * @param {object} alignment
 * @param {{ videoDuration?: number, durationTolerance?: number }} options
 *        videoDuration：已知视频时长时，把映射后超出片尾太多的弹幕丢掉（默认不丢）
 */
export function remapDanmakuComments(comments, alignment, options = {}) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const normalized = normalizeAlignment(alignment);
  const videoDuration = toFiniteNumber(options.videoDuration, 0);
  const tolerance = toFiniteNumber(options.durationTolerance, 2);
  // 未校准且不需要按时长裁剪时直接返回副本（省掉一次全量遍历）
  if (isAlignmentEmpty(normalized) && !(videoDuration > 0)) return comments.slice();

  const result = [];
  for (const comment of comments) {
    if (!comment || typeof comment !== 'object') continue;
    const mapped = mapCanonicalToVideoTime(comment.time, normalized);
    if (mapped === null || mapped < 0) continue;
    if (videoDuration > 0 && mapped > videoDuration + tolerance) continue;
    result.push({ ...comment, time: Math.round(mapped * 100) / 100 });
  }
  result.sort((a, b) => a.time - b.time);
  return result;
}

/**
 * 依据检测结果推导一份对齐配置
 *
 * @param {object} input
 *   - danmakuContentStart: number|null   弹幕侧推断的「正片起点」（秒），见 danmakuAnchors.js
 *   - videoIntro: { start, end } | null  当前播放源检测到的片头（秒）；null=未检测到片头
 *   - canonicalIntroLength: number       已知的标准片头长度（无弹幕侧锚点时的兜底）
 *   - adRanges: Array<{ start, end }>    当前视频里的插入区间（如 HLS 广告段），视频时间
 *   - base: object                       已有配置
 * @returns {{ alignment: object, notes: string[] }} notes 为给用户看的中文说明
 */
export function deriveAlignmentFromDetections(input = {}) {
  const base = normalizeAlignment(input.base);
  const notes = [];
  const cuts = [];
  const inserts = [];
  let offset = base.offset;

  const hasDanmakuAnchor = input.danmakuContentStart !== null && input.danmakuContentStart !== undefined;
  const danmakuContentStart = hasDanmakuAnchor ? Math.max(0, toFiniteNumber(input.danmakuContentStart, 0)) : 0;
  const intro = input.videoIntro ? clampRange(input.videoIntro) : null;
  const videoIntroLength = intro ? intro.end - intro.start : 0;
  const introStart = intro ? intro.start : 0;

  if (hasDanmakuAnchor) {
    // 有弹幕侧正片起点：与视频侧正片起点直接比较，整体偏移一次算准（用户不需要逐条判断）
    const videoContentStart = intro ? intro.end : 0;
    offset = Math.round((videoContentStart - danmakuContentStart) * 10) / 10;
    const direction = offset >= 0 ? '后移' : '前移';
    if (intro) {
      notes.push(`弹幕版正片起点 ${formatClock(danmakuContentStart)} ↔ 本视频片头结束 ${formatClock(videoContentStart)}：弹幕整体${direction} ${Math.abs(offset)} 秒`);
    } else {
      notes.push(`弹幕版正片起点 ${formatClock(danmakuContentStart)}，本视频未检测到片头：按正片从 00:00 开始计算，弹幕整体${direction} ${Math.abs(offset)} 秒`);
    }
  } else if (input.canonicalIntroLength) {
    const canonicalIntro = Math.max(0, toFiniteNumber(input.canonicalIntroLength, 0));
    const delta = Math.round((videoIntroLength - canonicalIntro) * 10) / 10;
    if (delta <= -1) {
      // 本视频片头更短（含被整段删掉的情况）：删掉标准时间轴上对应的前段
      cuts.push({ start: introStart, end: introStart + Math.abs(delta) });
      notes.push(`片头比标准版短 ${Math.abs(delta)} 秒，已把弹幕整体前移`);
    } else if (delta >= 1) {
      inserts.push({ start: introStart, end: introStart + delta });
      notes.push(`片头比标准版长 ${delta} 秒，已把弹幕整体后移`);
    } else {
      notes.push('片头与标准版一致，无需头部对齐');
    }
  } else {
    notes.push('未识别到弹幕侧的「正片开始」标记；可在正片开始时点「这里就是正片开始」，或用下方弹幕对照校准');
  }

  const ads = normalizeRanges(input.adRanges);
  for (const ad of ads) {
    const length = Math.round((ad.end - ad.start) * 10) / 10;
    if (length < 1) continue;
    inserts.push(ad);
    notes.push(`第 ${formatClock(ad.start)} 处有 ${length} 秒插入内容，已跳过该区间的弹幕`);
  }

  return {
    alignment: normalizeAlignment({ offset, cuts, inserts }),
    notes
  };
}

/**
 * 追加一段「本视频插入的区间」（如中段广告），手动标记时用。
 * 区间过短（<1 秒）或非法时原样返回既有配置。
 */
export function addInsertRange(alignment, start, end) {
  const base = normalizeAlignment(alignment);
  const from = Math.max(0, toFiniteNumber(start, 0));
  const to = Math.max(from, toFiniteNumber(end, from));
  if (to - from < 1) return base;
  return normalizeAlignment({ ...base, inserts: [...base.inserts, { start: from, end: to }] });
}

/** 人类可读摘要（弹幕设置面板里显示） */
export function describeAlignment(alignment) {
  const normalized = normalizeAlignment(alignment);
  const parts = [];
  if (normalized.offset !== 0) {
    parts.push(`手动偏移 ${normalized.offset > 0 ? '+' : ''}${normalized.offset} 秒`);
  }
  for (const cut of normalized.cuts) {
    parts.push(`删减段 ${formatClock(cut.start)}–${formatClock(cut.end)}（${Math.round(cut.end - cut.start)} 秒）`);
  }
  for (const insert of normalized.inserts) {
    parts.push(`插入段 ${formatClock(insert.start)}–${formatClock(insert.end)}（${Math.round(insert.end - insert.start)} 秒）`);
  }
  return parts.length ? parts.join('；') : '未校准';
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.round(toFiniteNumber(seconds, 0)));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}