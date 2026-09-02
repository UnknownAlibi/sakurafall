// Episode DNA P1：片头候选分析 Worker
//
// 输入（analyze 消息）：
//   windowMs  每个采样窗口的毫秒数
//   times     Float32Array 各窗口起点（秒）
//   rms       Float32Array | null  各窗口音频 RMS 能量（0-1 归一化）
//   luma      Float32Array | null  各窗口画面平均亮度（0-255）
//
// 输出：
//   { type: 'result', candidates: [{ start, end, confidence, reason }] }
//
// 策略（只做建议，不自动跳过）：
//   1. 音频能量：片头(OP)通常是开头一段持续高能量音乐，正片开始时能量骤降。
//      找到片头范围内最大的能量下坠点作为片头结束候选。
//   2. 场景切换：OP→正片的转场通常伴随画面亮度突变，用相邻窗口亮度差检测
//      场景切换峰，并把能量边界吸附到最近的场景切换峰上。
//   3. 边界必须相隔至少 20 秒，最多输出 3 个候选。

function movingAverage(values, span) {
  const out = new Float32Array(values.length);
  const half = Math.max(1, Math.floor(span / 2));
  let sum = 0;
  const queue = [];
  for (let i = 0; i < values.length; i++) {
    queue.push(values[i]);
    sum += values[i];
    if (queue.length > half * 2 + 1) sum -= queue.shift();
    out[i] = sum / queue.length;
  }
  return out;
}

function scenePeaks(luma) {
  // 相邻窗口亮度差作为场景切换得分
  const scores = new Float32Array(Math.max(0, luma.length - 1));
  for (let i = 0; i < scores.length; i++) {
    scores[i] = Math.abs(luma[i + 1] - luma[i]);
  }
  // 只保留局部极大值
  const peaks = [];
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] >= scores[i - 1] && scores[i] > scores[i + 1]) {
      peaks.push({ index: i, score: scores[i] });
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  return { scores, peaks: peaks.slice(0, 24) };
}

function snapToScenePeak(index, peaks, toleranceWindows) {
  let best = index;
  let bestDistance = Infinity;
  for (const peak of peaks) {
    const distance = Math.abs(peak.index - index);
    if (distance <= toleranceWindows && distance < bestDistance) {
      best = peak.index;
      bestDistance = distance;
    }
  }
  return best;
}

function analyzeIntroCandidates({ windowMs, times, rms, luma }) {
  const windowCount = times.length;
  if (windowCount < 20) return []; // 数据不足 10 秒，不产出候选
  const tolerance = Math.max(2, Math.round(3000 / windowMs)); // 边界吸附容差 3s

  const hasAudio = rms && rms.length === windowCount;
  const hasScene = luma && luma.length === windowCount;
  const { peaks } = hasScene ? scenePeaks(luma) : { peaks: [] };
  const maxPeakScore = peaks.length > 0 ? peaks[0].score : 0;

  const candidates = [];

  if (hasAudio) {
    const energy = movingAverage(rms, 5);
    const maxEnergy = Math.max(...energy);
    if (maxEnergy > 0.001) {
      const startThreshold = maxEnergy * 0.18;
      const minWindows = Math.max(4, Math.round(6000 / windowMs)); // 6s 持续
      // 1. 找音乐开始：前 60s 内首次持续高于阈值
      let musicStart = 0;
      const searchLimit = Math.min(windowCount, Math.ceil(60000 / windowMs));
      for (let i = 0; i < searchLimit; i++) {
        let sustained = true;
        for (let j = i; j < Math.min(i + minWindows, windowCount); j++) {
          if (energy[j] < startThreshold) { sustained = false; break; }
        }
        if (sustained) { musicStart = i; break; }
      }
      // 2. 找能量骤降：音乐开始 20s 后，到 200s 内，找最大相对下坠
      const dropFrom = musicStart + Math.round(20000 / windowMs);
      const dropTo = Math.min(windowCount - 2, Math.ceil(200000 / windowMs));
      let bestDropIndex = -1;
      let bestDropMagnitude = 0;
      const compareSpan = Math.max(2, Math.round(4000 / windowMs)); // 4s 对比跨度
      for (let i = dropFrom; i < dropTo; i++) {
        const before = Math.max(...energy.slice(Math.max(0, i - compareSpan), i + 1));
        const after = Math.min(...energy.slice(i, Math.min(i + compareSpan + 1, windowCount)));
        if (before <= 0) continue;
        const magnitude = (before - after) / before;
        if (magnitude > bestDropMagnitude) {
          bestDropMagnitude = magnitude;
          bestDropIndex = i;
        }
      }
      if (bestDropIndex > 0 && bestDropMagnitude > 0.35) {
        const snappedStart = snapToScenePeak(musicStart, peaks, tolerance);
        const snappedEnd = snapToScenePeak(bestDropIndex, peaks, tolerance);
        const start = times[Math.max(0, Math.min(windowCount - 1, snappedStart))];
        const end = times[Math.max(0, Math.min(windowCount - 1, snappedEnd))];
        if (end - start >= 20) {
          const confidence = Math.max(0.3, Math.min(0.95, bestDropMagnitude));
          candidates.push({
            start: Math.round(start * 10) / 10,
            end: Math.round(end * 10) / 10,
            confidence: Math.round(confidence * 100) / 100,
            reason: 'audio-energy'
          });
        }
      }
    }
  }

  if (hasScene && maxPeakScore > 12) {
    // 纯场景切换候选：前 150s 内最强的切换峰作为片头结束
    const limit = Math.min(windowCount - 1, Math.ceil(150000 / windowMs));
    const top = peaks.find(peak => peak.index < limit);
    if (top) {
      const end = times[Math.min(windowCount - 1, top.index)];
      const start = times[0];
      if (end - start >= 20 && !candidates.some(c => Math.abs(c.end - end) < 4)) {
        candidates.push({
          start: Math.round(start * 10) / 10,
          end: Math.round(end * 10) / 10,
          confidence: Math.round(Math.min(0.6, top.score / 60) * 100) / 100,
          reason: 'scene-change'
        });
      }
    }
  }

  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
}

self.onmessage = (event) => {
  const { type, payload } = event.data || {};
  if (type !== 'analyze') return;
  try {
    const candidates = analyzeIntroCandidates(payload || {});
    self.postMessage({ type: 'result', candidates });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || '分析失败' });
  }
};
