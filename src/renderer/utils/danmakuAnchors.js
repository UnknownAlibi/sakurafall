/**
 * 弹幕侧时间轴锚点推断（纯函数）
 *
 * 目的：让「对齐」这件事不再依赖用户逐条比对「哪条弹幕对应哪个画面」。
 * 弹幕自身带有大量结构性标记（「空降」「正片开始」「片头结束」「OP/ED」……），
 * 这些标记在弹幕时间轴上聚成一簇，其位置就是该弹幕版本的「正片起点」。
 * 拿到这个锚点后，与视频侧检测（Episode DNA 的片头区间）一比较即可自动算出整体偏移。
 */

// 正片起点类标记：出现位置通常在片头结束处（空降=跳过片头后落地）
const CONTENT_START_PATTERNS = [
  /空降/, /正片开始/, /正片开始啦/, /^正片$/, /片头结束/, /跳过片头/, /开始正片/,
  /^op\s*(结束|完)?$/i, /^op\b/i, /内容开始/, /进入正片/
];
// 用于「弹幕对照校准」列表高亮：明显与画面强相关、便于用户识别的弹幕
const HIGHLIGHT_PATTERNS = [
  /前方高能/, /高能/, /名场面/, /泪目/, /泪崩/, /笑死/, /第一次看/, /这里.*(神|绝了)/, /空降/
];

export function isStructuralDanmaku(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return CONTENT_START_PATTERNS.some(pattern => pattern.test(value));
}

export function isHighlightDanmaku(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return HIGHLIGHT_PATTERNS.some(pattern => pattern.test(value));
}

/**
 * 推断弹幕版本的「正片起点」
 * @param {Array<{time:number,text:string}>} comments - 原始（未对齐）弹幕
 * @param {{ searchWindow?: number, clusterSeconds?: number, minSamples?: number }} options
 *   searchWindow：只在片头附近搜索（默认前 10 分钟）
 *   clusterSeconds：同一簇的时间跨度（默认 30 秒）
 *   minSamples：成簇所需的最少条数（默认 2）
 * @returns {{ contentStart: number|null, confidence: number, samples: number }}
 *   contentStart 为弹幕时间轴上的正片起点（秒）；识别不出时返回 null
 */
export function inferDanmakuContentStart(comments = [], options = {}) {
  const searchWindow = Number(options.searchWindow) || 600;
  const clusterSeconds = Number(options.clusterSeconds) || 30;
  const minSamples = Number(options.minSamples) || 2;

  const hits = [];
  for (const comment of comments) {
    const time = Number(comment?.time);
    if (!Number.isFinite(time) || time < 0 || time > searchWindow) continue;
    if (isStructuralDanmaku(comment.text)) hits.push(Math.round(time * 10) / 10);
  }
  if (hits.length === 0) return { contentStart: null, confidence: 0, samples: 0 };

  hits.sort((a, b) => a - b);
  for (const anchor of hits) {
    const cluster = hits.filter(time => time >= anchor && time <= anchor + clusterSeconds);
    if (cluster.length >= minSamples) {
      // 一簇标记里取中位数，比最早一条更稳（有人会在片头中间就发「空降」）
      const median = cluster[Math.floor(cluster.length / 2)];
      return {
        contentStart: median,
        confidence: Math.min(1, cluster.length / 5),
        samples: cluster.length
      };
    }
  }

  // 只有孤立一条：给低置信度结果，交由 UI 提示核实
  return { contentStart: hits[0], confidence: 0.25, samples: 1 };
}

/**
 * 取「当前画面附近」的候选弹幕，供用户点选做对照校准。
 * 以当前校准推算出画面时刻在弹幕时间轴上的期望位置，取邻近弹幕按接近程度排序。
 * @returns {Array<{ time:number, text:string, structural:boolean, highlight:boolean }>}
 */
export function pickReferenceComments(comments = [], targetTime = 0, options = {}) {
  const radius = Number(options.radius) || 150;
  const limit = Number(options.limit) || 40;
  const target = Number(targetTime) || 0;
  const picked = [];
  for (const comment of comments) {
    const time = Number(comment?.time);
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - target);
    if (distance > radius) continue;
    const text = String(comment.text || '').slice(0, 80);
    if (!text) continue;
    picked.push({
      time: Math.round(time * 10) / 10,
      text,
      distance,
      structural: isStructuralDanmaku(text),
      highlight: isHighlightDanmaku(text)
    });
  }
  picked.sort((a, b) => a.distance - b.distance);
  return picked.slice(0, limit).map(({ distance: _distance, ...item }) => item);
}