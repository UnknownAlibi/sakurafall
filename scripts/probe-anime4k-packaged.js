// S2 诊断探针：在打包应用中复刻 audit:playback 的 Anime4K 激活场景，
// 以 100ms 分辨率采样视频健康度与 CNN 运行时，捕捉看门狗触发的时间线。
// 运行: node scripts/probe-anime4k-packaged.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');
const { sampleProcessTree, stopProcessTree } = require('./audit-process-tree');

const workspace = path.resolve(__dirname, '..');
// SAKURAFALL_PROBE_DEV=1 时挂到开发态真实应用（electron . + Vite 渲染层），
// 用于区分"应用代码问题"与"打包环境问题"
const devMode = process.env.SAKURAFALL_PROBE_DEV === '1';
const executable = devMode
  ? path.join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe')
  : (process.env.SAKURAFALL_AUDIT_EXECUTABLE
    || path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe'));
const sampleVideo = path.join(workspace, 'splash-sample.mp4');
const outputPath = process.env.SAKURAFALL_PROBE_OUT
  || path.join(workspace, 'artifacts', 'anime4k-packaged-probe.json');
const debugPort = Number(process.env.SAKURAFALL_PROBE_PORT || 9242);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const probeSeconds = Number(process.env.SAKURAFALL_PROBE_SECONDS || 30);
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-anime4k-probe-'));
const userData = path.join(runRoot, 'user-data');
let _child;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function seedDatabase() {
  const source = path.join(workspace, 'anime.db');
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(userData, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${source}${suffix}`;
    if (fs.existsSync(candidate)) fs.copyFileSync(candidate, path.join(userData, `anime.db${suffix}`));
  }
}

async function fetchTargets() {
  const response = await fetch(`${debugUrl}/json/list`);
  if (!response.ok) throw new Error(`DevTools target request failed: HTTP ${response.status}`);
  return response.json();
}

async function sampleProcesses() {
  const snapshot = await sampleProcessTree({
    rootPid: _child?.pid,
    executable,
    marker: `--smoke-user-data=${userData}`
  });
  return snapshot.processes;
}

// 播放器窗口内的高频采样：视频健康度 + Anime4K 运行时 + 节流/GPU 诊断维度。
async function samplePlayer(page) {
  return page.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    const canvas = document.querySelector('.anime4k-canvas');
    const component = canvas?.__vueParentComponent?.proxy;
    const runtime = component?.buildStatus?.() || JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
    const quality = video?.getVideoPlaybackQuality?.() || {};
    const notices = Array.from(document.querySelectorAll('[class*="notification"], [class*="notice"]'))
      .map(item => item.textContent.trim()).filter(Boolean);
    // 停滞归因维度：页面被节流（visibility/rAF 冻结）还是解码器饿死（rAF 正常但帧不涨）
    let bufferedAhead = 0;
    try {
      const ranges = video ? video.buffered : null;
      for (let i = 0; ranges && i < ranges.length; i += 1) {
        if (video.currentTime >= ranges.start(i) && video.currentTime <= ranges.end(i)) {
          bufferedAhead = ranges.end(i) - video.currentTime;
          break;
        }
      }
    } catch (_) { /* ignore */ }
    return {
      t: Date.now(),
      currentTime: video ? video.currentTime : -1,
      paused: video ? video.paused : null,
      seeking: video ? video.seeking : null,
      readyState: video ? video.readyState : 0,
      ended: video ? video.ended : null,
      networkState: video ? video.networkState : null,
      duration: video ? video.duration : null,
      bufferedRanges: (() => {
        try {
          const ranges = video?.buffered;
          if (!ranges) return [];
          return Array.from({ length: ranges.length }, (_, i) => [+ranges.start(i).toFixed(3), +ranges.end(i).toFixed(3)]);
        } catch (_) { return []; }
      })(),
      mediaError: video && video.error ? (video.error.message || video.error.code) : null,
      watchdog: (() => {
        try {
          const proxy = component;
          if (!proxy) return null;
          return {
            nearLoopEnd: proxy._watchdogNearLoopEnd ?? null,
            lastCallbackAgeMs: proxy.lastCallbackAt ? Math.round(performance.now() - proxy.lastCallbackAt) : null,
            generation: proxy._lifecycleGeneration ?? null
          };
        } catch (_) { return null; }
      })(),
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      rafCount: window.__probeRafCount || 0,
      pageNow: performance.now(),
      srcProtocol: video ? (video.currentSrc || video.src || '').split(':')[0] : '',
      playbackRate: video ? video.playbackRate : 0,
      bufferedAhead,
      totalVideoFrames: quality.totalVideoFrames || 0,
      droppedVideoFrames: quality.droppedVideoFrames || 0,
      backend: runtime.backend || '',
      mode: runtime.mode || '',
      preset: runtime.preset || '',
      presenting: Boolean(runtime.presenting),
      active: Boolean(runtime.active),
      renderedFrames: runtime.renderedFrames || 0,
      droppedFrames: runtime.droppedFrames || 0,
      fps: runtime.fps || 0,
      renderMs: runtime.renderMs || 0,
      frameAgeMs: runtime.frameAgeMs || 0,
      stageMs: runtime.stageMs || null,
      initMs: runtime.initMs || null,
      notices: notices.slice(-3)
    };
  })()`);
}

async function installRafCounter(page) {
  await page.evaluate(`(() => {
    if (window.__probeRafCount != null) return;
    window.__probeRafCount = 0;
    const tick = () => { window.__probeRafCount += 1; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`, true);
}

async function setAnime4k(page, enabled) {
  const changed = await page.evaluate(`(() => {
    const labels = Array.from(document.querySelectorAll('.settings-toggle-row'));
    const row = labels.find(item => item.textContent.includes('Anime4K'));
    const input = row?.querySelector('input[type="checkbox"]');
    if (!input) return false;
    input.checked = ${Boolean(enabled)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked === ${Boolean(enabled)};
  })()`, true);
  if (!changed) throw new Error('Anime4K control was not found');
}

async function stopApp() {
  await stopProcessTree({
    rootPid: _child?.pid,
    executable,
    marker: `--smoke-user-data=${userData}`
  });
}

function summarizePhase(phase) {
  const samples = phase.samples.filter(sample => !sample.error);
  const withVideo = samples.filter(sample => typeof sample.currentTime === 'number');
  // 播放速率：媒体时间增量 / 墙钟增量（循环回绕段忽略）。
  let mediaTotal = 0;
  let wallTotal = 0;
  let previous = null;
  let stalls = 0;
  let maxStallMs = 0;
  let stallStart = null;
  for (const sample of withVideo) {
    if (previous) {
      const wall = sample.t - previous.t;
      wallTotal += wall;
      if (sample.currentTime >= previous.currentTime) mediaTotal += sample.currentTime - previous.currentTime;
      // 停顿探测：播放中、非 seek、currentTime 不变。
      const frozen = !sample.paused && !sample.seeking && sample.currentTime === previous.currentTime;
      if (frozen) {
        if (stallStart == null) stallStart = previous.t;
        const stallMs = sample.t - stallStart;
        if (stallMs > maxStallMs) maxStallMs = stallMs;
      } else {
        if (stallStart != null && sample.t - stallStart >= 250) stalls += 1;
        stallStart = null;
      }
    }
    previous = sample;
  }
  const last = samples[samples.length - 1] || {};
  const first = samples[0] || {};
  return {
    name: phase.name,
    samples: samples.length,
    playbackRate: wallTotal > 0 ? Math.round((mediaTotal / (wallTotal / 1000)) * 1000) / 1000 : 0,
    stallsOver250ms: stalls,
    maxStallMs: Math.round(maxStallMs),
    decodedFrames: (last.totalVideoFrames || 0) - (first.totalVideoFrames || 0),
    compositorDropped: (last.droppedVideoFrames || 0) - (first.droppedVideoFrames || 0),
    backendEnd: last.backend || '',
    presetEnd: last.preset || '',
    renderedFramesEnd: last.renderedFrames || 0,
    cnnDroppedEnd: last.droppedFrames || 0,
    renderMsEnd: last.renderMs || 0,
    frameAgeMsEnd: last.frameAgeMs || 0,
    notices: [...new Set(samples.flatMap(sample => sample.notices || []))]
  };
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  if (!fs.existsSync(sampleVideo)) throw new Error(`Local sample video not found: ${sampleVideo}`);
  seedDatabase();

  // 捕获主进程 stdout/stderr：GPU 崩溃（GpuGuard）、协议错误等停滞归因证据
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stdoutPath = outputPath.replace('.json', '-stdout.log');
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });
  // 宿主环境注入的 NODE_OPTIONS（IDE / CLI shim）会被子进程继承，打包版
  // Electron 无法加载这些 require 项，表现为 GPU 进程启动即崩溃循环，审计会
  // 卡在"GPU process isn't usable"。启动前必须剥离。
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  const launchArgs = devMode
    ? ['.', `--remote-debugging-port=${debugPort}`, `--smoke-user-data=${userData}`]
    : [`--remote-debugging-port=${debugPort}`, `--smoke-user-data=${userData}`];
  _child = spawn(executable, launchArgs, {
    cwd: devMode ? workspace : path.dirname(executable),
    env: childEnv,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  _child.stdout.on('data', chunk => stdoutStream.write(chunk));
  _child.stderr.on('data', chunk => stdoutStream.write(chunk));

  let mainPage;
  let playerPage;
  const report = {
    executable,
    stdoutLog: stdoutPath,
    phases: [],
    timeline: [],
    processes: []
  };
  try {
    await waitFor(async () => {
      try { return (await fetchTargets()).find(item => item.type === 'page'); } catch (_) { return null; }
    }, 'packaged app DevTools endpoint', 30000, 150);

    const mainTarget = (await fetchTargets()).find(item => item.type === 'page');
    mainPage = new CdpClient(mainTarget.webSocketDebuggerUrl);
    await mainPage.connect();
    await mainPage.send('Runtime.enable');
    await waitFor(() => mainPage.evaluate(`Boolean(window.electronAPI?.openPlayerWindow)`), 'main preload API', 20000, 100);
    await waitFor(() => mainPage.evaluate(`(() => {
      const cards = document.querySelectorAll('.anime-card:not(.skeleton)').length;
      const loading = Boolean(document.querySelector('.anime-card.skeleton, .anime-loading-stage'));
      return cards >= 6 && !loading;
    })()`), 'stable main catalog', 30000, 200).catch(() => false);
    await delay(2500);

    const videoUrl = pathToFileURL(sampleVideo).href;
    const episode = { id: 'probe-episode-1', title: 'Episode 1', index: 0, url: videoUrl, lineId: 'local' };
    const payload = {
      title: 'Anime4K packaged probe',
      url: videoUrl,
      anime: {
        id: 'probe-local-video',
        name: 'Anime4K packaged probe',
        source: 'local-probe',
        sourceName: 'Local probe',
        sourceType: 'local',
        episodes: { local: [episode] }
      },
      episode,
      episodeId: episode.id,
      lineId: 'local'
    };
    const openResult = await mainPage.evaluate(`window.electronAPI.openPlayerWindow(${JSON.stringify(payload)})`, true);
    if (!openResult?.success) throw new Error(`Player window failed to open: ${openResult?.error || 'unknown error'}`);

    const playerTarget = await waitFor(async () => {
      const list = await fetchTargets();
      return list.find(item => item.type === 'page' && item.id !== mainTarget.id && item.url.includes('player-window'));
    }, 'player window target', 30000, 100);
    playerPage = new CdpClient(playerTarget.webSocketDebuggerUrl);
    await playerPage.connect();
    await playerPage.send('Runtime.enable');
    await playerPage.send('Page.enable');
    await installRafCounter(playerPage);

    await waitFor(() => playerPage.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      if (!video || video.error || video.readyState < 2 || !video.videoWidth) return null;
      video.loop = true;
      video.muted = true;
      video.play().catch(() => {});
      return { width: video.videoWidth, height: video.videoHeight };
    })()`), 'decoded local video', 15000, 100);

    await playerPage.evaluate(`document.querySelector('.video-player-container')?.requestFullscreen()`, true);
    await waitFor(() => playerPage.evaluate(`Boolean(document.fullscreenElement)`), 'player fullscreen', 5000, 50);

    // 阶段 1：无增强基线（真实应用 + 全屏），6 秒。
    const phase1 = { name: 'baseline-no-anime4k', startAt: Date.now(), samples: [] };
    for (let index = 0; index < 60; index += 1) {
      const sample = await samplePlayer(playerPage).catch(error => ({ error: error.message }));
      phase1.samples.push(sample);
      if (index % 10 === 0) report.processes.push({ phase: 'baseline', at: Date.now(), rows: await sampleProcesses().catch(() => []) });
      await delay(100);
    }
    report.phases.push(summarizePhase(phase1));

    // 阶段 2：开启 Anime4K，高频采样 probeSeconds 秒。
    await setAnime4k(playerPage, true);
    const phase2 = { name: 'anime4k-enabled', startAt: Date.now(), samples: [] };
    const ticks = Math.round(probeSeconds * 10);
    for (let index = 0; index < ticks; index += 1) {
      const sample = await samplePlayer(playerPage).catch(error => ({ error: error.message }));
      phase2.samples.push(sample);
      if (index % 10 === 0) report.processes.push({ phase: 'anime4k', at: Date.now(), rows: await sampleProcesses().catch(() => []) });
      await delay(100);
    }
    report.phases.push(summarizePhase(phase2));
    report.timeline = phase2.samples.map(sample => ({
      t: sample.t,
      currentTime: sample.currentTime,
      paused: sample.paused,
      readyState: sample.readyState,
      seeking: sample.seeking,
      ended: sample.ended,
      duration: sample.duration,
      bufferedRanges: sample.bufferedRanges,
      mediaError: sample.mediaError,
      watchdog: sample.watchdog,
      visibility: sample.visibility,
      focused: sample.focused,
      rafCount: sample.rafCount,
      pageNow: sample.pageNow,
      srcProtocol: sample.srcProtocol,
      bufferedAhead: sample.bufferedAhead,
      totalVideoFrames: sample.totalVideoFrames,
      droppedVideoFrames: sample.droppedVideoFrames,
      backend: sample.backend,
      preset: sample.preset,
      presenting: sample.presenting,
      renderedFrames: sample.renderedFrames,
      droppedFrames: sample.droppedFrames,
      renderMs: sample.renderMs,
      frameAgeMs: sample.frameAgeMs,
      stageMs: sample.stageMs,
      notices: sample.notices
    }));

    // 阶段 3：关闭增强后的恢复期，6 秒。
    await setAnime4k(playerPage, false);
    const phase3 = { name: 'anime4k-disabled-recovery', startAt: Date.now(), samples: [] };
    for (let index = 0; index < 60; index += 1) {
      const sample = await samplePlayer(playerPage).catch(error => ({ error: error.message }));
      phase3.samples.push(sample);
      await delay(100);
    }
    report.phases.push(summarizePhase(phase3));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('[Anime4K Packaged Probe]', JSON.stringify(report.phases, null, 2));
    return report;
  } finally {
    playerPage?.close();
    mainPage?.close();
    await stopApp();
    await delay(800);
    try { stdoutStream.end(); } catch (_) { /* ignore */ }
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* Chromium may still release profile files */ }
  }
}

main().catch(async error => {
  console.error(error.stack || error.message);
  await stopApp();
  process.exit(1);
});
