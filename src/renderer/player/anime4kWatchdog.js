// Anime4K 解码看门狗的归因判定。
//
// 播放停滞有两种截然不同的成因，必须分开，否则要么把网络卡顿算到 CNN 头上
// （误伤降级），要么在真正需要兜底时失声：
//
//   1. 数据源饥饿：暂停、seek、播放结束、缓冲耗尽 —— 与增强无关，重置看门狗。
//   2. 解码管线被卡住：有缓冲数据、未在 seek、currentTime 却不前进 —— 需要降级。
//
// 关键点：解码停摆时 video.readyState 会掉到 2（HAVE_CURRENT_DATA：有当前帧，
// 拿不到下一帧），而不是保持不变。早先的写法要求 readyState >= 3 才计停滞，
// 结果看门狗对唯一需要它兜底的场景完全瞎掉。判定条件因此只看"有没有数据可用"，
// 不看 readyState 的具体档位。

// 当前播放位置之后还剩多少已缓冲数据（秒）。
export function bufferedAheadSeconds(video) {
  if (!video) return 0;
  try {
    const ranges = video.buffered;
    if (!ranges) return 0;
    const currentTime = Number(video.currentTime) || 0;
    for (let index = 0; index < ranges.length; index += 1) {
      if (currentTime >= ranges.start(index) && currentTime <= ranges.end(index)) {
        return ranges.end(index) - currentTime;
      }
    }
  } catch (_) { /* readyState 过低或元素已销毁时 buffered 不可用 */ }
  return 0;
}

// true = 停滞应由数据源负责，不该让 CNN 背锅。
export function isSourceStarved(video, { minBufferedAhead = 0.05 } = {}) {
  if (!video) return true;
  if (video.paused || video.seeking || video.ended) return true;
  if ((video.readyState || 0) < 2) return true;
  return bufferedAheadSeconds(video) <= minBufferedAhead;
}

// 是否已经播放到尾部（loop 会在此处重启解码，短暂停顿属正常）。
export function isNearLoopEnd(video, { thresholdSeconds = 0.25 } = {}) {
  if (!video) return false;
  const duration = Number(video.duration) || 0;
  const mediaTime = Number(video.currentTime) || 0;
  return duration > 0 && Number.isFinite(duration) && duration - mediaTime < thresholdSeconds;
}
