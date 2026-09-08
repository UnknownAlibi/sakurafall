// Only adjacent runtime samples describe an uninterrupted interval. Filtering
// before pairing would join samples across seeks, pauses and episode switches.
module.exports = function summarizePlaybackSamples(samples) {
  let previous = null;
  let wallMs = 0;
  let mediaSeconds = 0;
  let frameWallMs = 0;
  let renderedFrames = 0;
  let measuredPairs = 0;
  let excludedWraps = 0;
  let resets = 0;
  let maxSampleGapMs = 0;
  for (const sample of samples) {
    const valid = !sample.error && !sample.interaction && !sample.interactionError &&
      Number.isFinite(sample.currentTime) && Number.isFinite(sample.t);
    if (!valid) { previous = null; continue; }
    if (previous) {
      const wall = sample.t - previous.t;
      maxSampleGapMs = Math.max(maxSampleGapMs, wall);
      if (sample.steady && previous.steady && sample.paused === false && previous.paused === false &&
          !sample.seeking && !previous.seeking && wall > 0) {
        const media = sample.currentTime - previous.currentTime;
        if (media >= 0) {
          wallMs += wall;
          mediaSeconds += media;
          measuredPairs++;
        } else excludedWraps++;
        const frames = sample.renderedFrames - previous.renderedFrames;
        if (sample.presenting && previous.presenting && sample.backend === 'webgpu-worker' &&
            previous.backend === sample.backend && sample.preset === previous.preset && Number.isFinite(frames)) {
          if (frames >= 0) { frameWallMs += wall; renderedFrames += frames; }
          else resets++;
        }
      }
    }
    previous = sample;
  }
  return {
    steadyPlaybackRate: wallMs ? mediaSeconds / (wallMs / 1000) : null,
    measuredSteadySeconds: wallMs / 1000, measuredPairs, excludedWraps,
    steadyCnnFps: frameWallMs ? renderedFrames / (frameWallMs / 1000) : null,
    measuredCnnSeconds: frameWallMs / 1000, counterResets: resets, maxSampleGapMs,
    scope: 'Adjacent steady samples only; negative media deltas are excluded, not treated as stalls. Sampling gaps do not prove sub-second freeze absence.'
  };
};
