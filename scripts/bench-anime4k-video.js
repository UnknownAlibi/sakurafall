const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const rendererUrl = process.env.SAKURAFALL_RENDERER_URL || 'http://127.0.0.1:5173/index.html';
const workspace = path.resolve(__dirname, '..');
const sampleVideo = process.env.SAKURAFALL_BENCH_VIDEO || path.join(workspace, 'splash-sample.mp4');
const outputPath = path.join(workspace, 'artifacts', 'anime4k-video-bench.json');
// 每场景稳态采样时长（毫秒）。首帧/编译期单独记录，不计入稳态统计。
const scenarioMs = Number(process.env.SAKURAFALL_BENCH_SCENARIO_MS || 6000);
const settleFrames = 6; // 丢弃前 N 帧的瞬态（首帧拷贝/呈现同步等）

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

async function run() {
  if (!fs.existsSync(sampleVideo)) throw new Error(`sample video missing: ${sampleVideo}`);
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 780,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });
  await win.loadURL(rendererUrl);
  const report = await win.webContents.executeJavaScript(`(async () => {
    const api = await import('/player/anime4kWebgpuClient.js');
    const scenarioMs = ${scenarioMs};
    const settleFrames = ${settleFrames};
    const videoUrl = new URL('/@fs/' + ${JSON.stringify(sampleVideo.replace(/\\\\/g, '/'))}, ${JSON.stringify(rendererUrl)}).href;

    document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;height:100vh';
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;inset:0;background:#000';
    document.body.appendChild(stage);

    const video = document.createElement('video');
    // 与 Anime4KCanvas 相同的层叠：画布盖住 video（z 更高），
    // 这样 Chromium 对 rvfc 的节流与解码行为和真实应用一致。
    video.className = 'video-element';
    video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:1';
    video.muted = true; video.loop = true; video.playsInline = true;
    video.src = videoUrl;
    stage.appendChild(video);
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('sample video failed to load'));
    });
    await video.play();

    const canvasHost = document.createElement('div');
    canvasHost.style.cssText = 'position:absolute;inset:0;z-index:2';
    stage.appendChild(canvasHost);

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const percentile = (sorted, value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] || 0;

    async function runScenario({ name, preset, inputFormat, play, fullscreen }) {
      // 全屏切换与组件行为一致：对舞台元素 requestFullscreen。
      if (Boolean(document.fullscreenElement) !== Boolean(fullscreen)) {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await stage.requestFullscreen().catch(() => {});
        await delay(400);
      }

      video.currentTime = 0;
      if (play) { if (video.paused) await video.play(); }
      else video.pause();
      await delay(200);

      // transferControlToOffscreen 只能执行一次：每场景新建 canvas 元素。
      const output = document.createElement('canvas');
      output.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      canvasHost.replaceChildren(output);

      const frames = [];
      let fatal = null;
      let rafId = 0; let rvfcId = 0; let timerId = null;
      const rafIntervals = []; let previousRaf = 0;
      const onRaf = now => {
        if (previousRaf) rafIntervals.push(now - previousRaf);
        previousRaf = now;
        rafId = requestAnimationFrame(onRaf);
      };
      rafId = requestAnimationFrame(onRaf);

      // 启动期冻结探测：100ms 采样 currentTime，记录播放中且未 seek 的停顿。
      const stalls = [];
      const probe = { last: video.currentTime, since: performance.now() };
      const probeId = setInterval(() => {
        const now = performance.now();
        const current = video.currentTime;
        if (!video.paused && !video.seeking && current === probe.last) {
          if (now - probe.since >= 250) {
            stalls.push({ atMs: Math.round(now), durationMs: Math.round(now - probe.since) });
            probe.since = now; // 记录一次后重置，避免同一段重复计数
          }
        } else {
          probe.last = current;
          probe.since = now;
        }
      }, 100);

      const qualityBefore = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      const wallBefore = performance.now();
      const mediaClock = { total: 0, last: video.currentTime };

      const client = await api.createAnime4kWebgpuPipeline(output, {
        preset,
        inputFormat,
        inputWidth: video.videoWidth,
        inputHeight: video.videoHeight,
        displayWidth: 1920,
        displayHeight: 1080,
        pixelRatio: 1,
        maxOutputEdge: 1920,
        onStats(stats) { frames.push(stats); },
        onFatal(error) { fatal = error.message; }
      });

      // 播放态用 rvfc 驱动（与组件一致，含画布遮挡节流口径）；
      // 暂停态 rvfc 不触发，按 24Hz 定时器驱动（重渲染同一帧）。
      let driveCount = 0;
      const drive = (now, metadata) => {
        driveCount += 1;
        const t = metadata && Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : video.currentTime;
        // 循环回绕感知：mediaTime 回跳按 (duration - last + t) 累计。
        if (t >= mediaClock.last) mediaClock.total += t - mediaClock.last;
        else if (video.duration > 0) mediaClock.total += video.duration - mediaClock.last + t;
        mediaClock.last = t;
        client.renderFrame(video, metadata);
        if (play) rvfcId = video.requestVideoFrameCallback(drive);
      };
      if (play) rvfcId = video.requestVideoFrameCallback(drive);
      else timerId = setInterval(() => drive(performance.now(), { mediaTime: video.currentTime }), 1000 / 24);

      await delay(scenarioMs);

      if (rafId) cancelAnimationFrame(rafId);
      if (rvfcId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfcId);
      if (timerId) clearInterval(timerId);
      clearInterval(probeId);
      const qualityAfter = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : {};
      const wallAfter = performance.now();
      const profile = { ...client.profile };
      client.dispose();
      await delay(300);

      const steady = frames.slice(settleFrames);
      const stat = key => steady.map(frame => frame[key]).filter(value => Number.isFinite(value));
      const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const gpuValues = steady.map(frame => frame.stageMs ? frame.stageMs.gpuMs : NaN).filter(Number.isFinite);
      const uploadValues = steady.map(frame => frame.stageMs ? frame.stageMs.uploadMs : NaN).filter(Number.isFinite);
      const sortedGpu = gpuValues.slice().sort((a, b) => a - b);
      const wallSeconds = (wallAfter - wallBefore) / 1000;
      const maxStall = stalls.reduce((max, item) => Math.max(max, item.durationMs), 0);
      return {
        name,
        preset,
        inputFormat,
        play,
        fullscreen: Boolean(document.fullscreenElement),
        input: { width: video.videoWidth, height: video.videoHeight },
        pipeline: profile.pipeline || '',
        frameBudgetMs: profile.frameBudgetMs || 0,
        benchmarkMs: profile.benchmarkMs || 0,
        initTimes: profile.initTimes || null,
        driveCount,
        renderedFrames: frames.length ? frames[frames.length - 1].renderedFrames : 0,
        droppedFrames: frames.length ? frames[frames.length - 1].droppedFrames : 0,
        steadyFrames: steady.length,
        steady: {
          renderMsAvg: Math.round(avg(stat('renderMs')) * 100) / 100,
          renderMsP95: Math.round(percentile(stat('renderMs').slice().sort((a, b) => a - b), 0.95) * 100) / 100,
          gpuMsAvg: Math.round(avg(gpuValues) * 100) / 100,
          gpuMsP95: Math.round(percentile(sortedGpu, 0.95) * 100) / 100,
          gpuMsMax: Math.round((sortedGpu[sortedGpu.length - 1] || 0) * 100) / 100,
          uploadMsAvg: Math.round(avg(uploadValues) * 100) / 100,
          fpsAvg: Math.round(avg(stat('fps')) * 100) / 100,
          frameAgeMsAvg: Math.round(avg(stat('frameAgeMs')) * 100) / 100
        },
        video: {
          playbackRate: Math.round((mediaClock.total / Math.max(0.001, wallSeconds)) * 1000) / 1000,
          decoded: (qualityAfter.totalVideoFrames || 0) - (qualityBefore.totalVideoFrames || 0),
          dropped: (qualityAfter.droppedVideoFrames || 0) - (qualityBefore.droppedVideoFrames || 0),
          stallsOver250ms: stalls.length,
          maxStallMs: maxStall
        },
        ui: {
          rafAverageMs: Math.round(avg(rafIntervals) * 100) / 100,
          rafP95Ms: Math.round(percentile(rafIntervals.slice().sort((a, b) => a - b), 0.95) * 100) / 100,
          longFrameRatio: Math.round(rafIntervals.filter(value => value > 32).length / Math.max(1, rafIntervals.length) * 1000) / 1000
        },
        fatal
      };
    }

    const scenarios = [
      // 窗口基线（新默认格式与旧格式对照）
      { name: 'balanced-playing-windowed-rgba8unorm', preset: 'balanced', inputFormat: 'rgba8unorm', play: true, fullscreen: false },
      { name: 'balanced-playing-windowed-rgba16float', preset: 'balanced', inputFormat: 'rgba16float', play: true, fullscreen: false },
      // 全屏（复现审计环境）
      { name: 'balanced-playing-fullscreen-rgba8unorm', preset: 'balanced', inputFormat: 'rgba8unorm', play: true, fullscreen: true },
      { name: 'balanced-playing-fullscreen-rgba16float', preset: 'balanced', inputFormat: 'rgba16float', play: true, fullscreen: true },
      { name: 'light-playing-fullscreen-rgba8unorm', preset: 'light', inputFormat: 'rgba8unorm', play: true, fullscreen: true },
      { name: 'light-playing-fullscreen-rgba16float', preset: 'light', inputFormat: 'rgba16float', play: true, fullscreen: true },
      // 全屏 + 暂停：隔离解码争用（重渲染同一帧）
      { name: 'balanced-paused-fullscreen-rgba8unorm', preset: 'balanced', inputFormat: 'rgba8unorm', play: false, fullscreen: true }
    ];

    const results = [];
    for (const scenario of scenarios) {
      try { results.push(await runScenario(scenario)); }
      catch (error) { results.push({ name: scenario.name, fatal: error.message }); }
      await delay(700);
    }
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    video.pause();
    return { capabilities: api.getWebgpuAnime4kCapabilities(), sample: videoUrl, scenarioMs, settleFrames, results };
  })()`, true);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
  const summary = report.results.map(item => ({
    name: item.name,
    pipeline: item.pipeline,
    benchmark: item.benchmarkMs,
    steady: item.steady,
    video: item.video,
    drive: item.driveCount,
    drops: item.droppedFrames,
    fatal: item.fatal || ''
  }));
  console.log('[Anime4K Video Bench]', JSON.stringify(summary, null, 2));
  app.exit(0);
}

app.whenReady().then(run).catch((error) => {
  console.error('[Anime4K Video Bench]', error);
  app.exit(1);
});
