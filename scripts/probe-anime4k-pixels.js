// S2-3 / S2-7 验收探针：在打包应用中证明"增强画面在真实变化"，并完成长时
// 间 + 高频交互的 CNN 连续运行验收。
//
// S2-3：主线程读不到已被 transferControlToOffscreen 的画布，无法用 toDataURL
//   做像素对比。这里改用 CDP Page.captureScreenshot 截取播放器窗口中央区域，
//   再借主窗口的 2D canvas 解码 PNG，计算亮度均值/方差/哈希。判据：
//     - 相邻采样哈希必须变化（画面在动，不是旧帧）
//     - 亮度均值不能长期接近 0（不是黑帧）
//     - 连续完全相同的哈希不能长时间出现（不是冻结帧）
//   CNN 自己上报的 renderedFrames 只说明"计数在涨"，不能证明画面在变，两者
//   一起看才能排除"只更新计数"的情况。
//
// S2-7：循环执行全屏切换、暂停/恢复、拖动、切集，统计稳态（最近一次交互
//   3s 以后且未暂停）的播放速率、停滞次数与 CNN 呈现率。
//
// 运行: SAKURAFALL_PIXEL_SECONDS=300 node scripts/probe-anime4k-pixels.js
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');

const execFileAsync = promisify(execFile);
const workspace = path.resolve(__dirname, '..');
const executable = process.env.SAKURAFALL_AUDIT_EXECUTABLE
  || path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const sampleVideo = path.join(workspace, 'splash-sample.mp4');
const outputPath = path.join(workspace, 'artifacts', 'anime4k-pixel-audit.json');
const debugPort = Number(process.env.SAKURAFALL_PROBE_PORT || 9251);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const seconds = Number(process.env.SAKURAFALL_PIXEL_SECONDS || 300);
const intervalMs = Number(process.env.SAKURAFALL_PIXEL_INTERVAL_MS || 1000);
const interactionMs = Number(process.env.SAKURAFALL_PIXEL_INTERACTION_MS || 6000);
const steadyAfterMs = Number(process.env.SAKURAFALL_PIXEL_STEADY_MS || 3000);
const episodeCount = Math.max(12, Number(process.env.SAKURAFALL_PIXEL_EPISODES || 12));
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-pixel-'));
const userData = path.join(runRoot, 'user-data');

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

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function fetchTargets() {
  const response = await fetch(`${debugUrl}/json/list`);
  if (!response.ok) throw new Error(`DevTools target request failed: HTTP ${response.status}`);
  return response.json();
}

async function stopApp() {
  const script = `
$targetPath = ${powershellLiteral(executable)}
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $targetPath } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }).catch(() => {});
}

async function setAnime4k(page, enabled) {
  const changed = await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.settings-toggle-row'));
    const row = rows.find(item => item.textContent.includes('Anime4K'));
    const input = row?.querySelector('input[type="checkbox"]');
    if (!input) return false;
    input.checked = ${Boolean(enabled)};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked === ${Boolean(enabled)};
  })()`, true);
  if (!changed) throw new Error('Anime4K control was not found');
}

// 在主窗口装一个 PNG -> 亮度统计的解码器（主窗口可以自由创建 2D canvas）。
async function installPngDecoder(mainPage) {
  return mainPage.evaluate(`(() => {
    if (window.__probeDecodePng) return true;
    window.__probeDecodePng = b64 => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          let sumSq = 0;
          let hash = 0;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const luma = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            sum += luma;
            sumSq += luma * luma;
            n += 1;
            hash = ((hash * 31 + Math.round(luma)) & 0x7fffffff) >>> 0;
          }
          const mean = sum / n;
          resolve({ w: c.width, h: c.height, mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), hash });
        } catch (error) { reject(error); }
      };
      img.onerror = () => reject(new Error('png decode failed'));
      img.src = 'data:image/png;base64,' + b64;
    });
    return true;
  })()`, true);
}

async function sampleRuntime(playerPage) {
  return playerPage.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    const canvas = document.querySelector('.anime4k-canvas');
    const runtime = JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
    const quality = video?.getVideoPlaybackQuality?.() || {};
    return {
      t: Date.now(),
      currentTime: video ? video.currentTime : -1,
      paused: video ? video.paused : null,
      seeking: video ? video.seeking : null,
      readyState: video ? video.readyState : 0,
      totalVideoFrames: quality.totalVideoFrames || 0,
      droppedVideoFrames: quality.droppedVideoFrames || 0,
      backend: runtime.backend || '',
      preset: runtime.preset || '',
      presenting: Boolean(runtime.presenting),
      renderedFrames: runtime.renderedFrames || 0,
      cnnDropped: runtime.droppedFrames || 0,
      renderMs: runtime.renderMs || 0,
      fps: runtime.fps || 0
    };
  })()`);
}

async function capturePixels(playerPage, mainPage, clip) {
  const shot = await playerPage.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
  });
  return mainPage.evaluate(`window.__probeDecodePng(${JSON.stringify(shot.data)})`);
}

// 交互动作都保证"做完后回到全屏 + 正在播放"的状态，便于后续采样归因。
async function interactionFullscreen(playerPage) {
  await playerPage.evaluate(`document.exitFullscreen?.()`, true);
  await delay(900);
  await playerPage.evaluate(`document.querySelector('.video-player-container')?.requestFullscreen()`, true);
  await delay(500);
  return { entered: true, exited: true };
}

async function interactionPauseResume(playerPage) {
  await playerPage.evaluate(`document.querySelector('video.video-element')?.pause()`, true);
  await delay(1200);
  const resumed = await playerPage.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    if (!video) return false;
    video.play().catch(() => {});
    return true;
  })()`, true);
  await delay(300);
  return { paused: true, resumed };
}

async function interactionSeek(playerPage) {
  return playerPage.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    if (!video) return { ok: false };
    const duration = Number(video.duration) || 0;
    const target = duration > 0 ? (video.currentTime + 1.5) % duration : 0;
    video.currentTime = target;
    return { ok: true, target };
  })()`, true);
}

async function interactionNextEpisode(playerPage) {
  const clicked = await playerPage.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button.control-btn'))
      .find(item => (item.getAttribute('title') || '').includes('下一集'));
    if (!button || button.disabled) return { clicked: false, reason: 'unavailable' };
    button.click();
    return { clicked: true };
  })()`, true);
  if (!clicked.clicked) return clicked;
  const ready = await waitFor(() => playerPage.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    return video && video.readyState >= 2 && !video.seeking ? video.currentTime : null;
  })()`), 'next episode decoded', 10000, 100).catch(() => null);
  return { ...clicked, ready };
}

function summarize(samples) {
  const valid = samples.filter(item => !item.error);
  let mediaTotal = 0;
  let wallTotal = 0;
  let stalls = 0;
  let maxStallMs = 0;
  let stallStart = null;
  let previous = null;
  const frozenRuns = [];
  let currentFrozen = null;
  for (const sample of valid) {
    if (previous) {
      const wall = sample.t - previous.t;
      // 只在两端都在播放时计入速率：交互里有 1.2s 的暂停段，若把暂停期
      // 的墙钟也算进去，playbackRate 会被系统性拉低（实测 0.50），失去意义。
      const playing = sample.paused === false && previous.paused === false && !sample.seeking && !previous.seeking;
      if (playing) {
        wallTotal += wall;
        if (sample.currentTime >= previous.currentTime) mediaTotal += sample.currentTime - previous.currentTime;
      }
      const frozen = !sample.paused && !sample.seeking && sample.currentTime === previous.currentTime;
      if (frozen) {
        if (stallStart == null) stallStart = previous.t;
        maxStallMs = Math.max(maxStallMs, sample.t - stallStart);
      } else if (stallStart != null) {
        if (sample.t - stallStart >= 250) stalls += 1;
        stallStart = null;
      }
    }
    // 冻结帧连续段：像素哈希与上一帧完全一致
    if (sample.pixel?.hash != null) {
      if (currentFrozen && currentFrozen.hash === sample.pixel.hash) {
        currentFrozen.count += 1;
        currentFrozen.until = sample.t;
      } else {
        if (currentFrozen && currentFrozen.count > 1) frozenRuns.push(currentFrozen);
        currentFrozen = sample.paused ? null : { hash: sample.pixel.hash, count: 1, from: sample.t, until: sample.t };
      }
    }
    previous = sample;
  }
  if (currentFrozen && currentFrozen.count > 1) frozenRuns.push(currentFrozen);

  const withPixels = valid.filter(item => item.pixel);
  const blackFrames = withPixels.filter(item => item.pixel.mean < 2).length;
  const changed = withPixels.filter((item, index) => index > 0 && item.pixel.hash !== withPixels[index - 1].pixel.hash).length;
  const steady = valid.filter(item => item.steady);
  let steadyRate = 0;
  let steadyWall = 0;
  let steadyMedia = 0;
  let steadyStalls = 0;
  let steadyStallStart = null;
  let steadyPrev = null;
  for (const sample of steady) {
    if (steadyPrev) {
      const wall = sample.t - steadyPrev.t;
      // 同上：只统计两端都在播放的相邻采样对。
      const playing = sample.paused === false && steadyPrev.paused === false && !sample.seeking && !steadyPrev.seeking;
      if (playing) {
        steadyWall += wall;
        if (sample.currentTime >= steadyPrev.currentTime) steadyMedia += sample.currentTime - steadyPrev.currentTime;
      }
      const frozen = !sample.paused && !sample.seeking && sample.currentTime === steadyPrev.currentTime;
      if (frozen) {
        if (steadyStallStart == null) steadyStallStart = steadyPrev.t;
      } else {
        if (steadyStallStart != null && sample.t - steadyStallStart >= 500) steadyStalls += 1;
        steadyStallStart = null;
      }
    }
    steadyPrev = sample;
  }
  steadyRate = steadyWall > 0 ? Math.round((steadyMedia / (steadyWall / 1000)) * 1000) / 1000 : 0;

  const first = valid[0] || {};
  const last = valid[valid.length - 1] || {};
  return {
    samples: valid.length,
    playbackRate: wallTotal > 0 ? Math.round((mediaTotal / (wallTotal / 1000)) * 1000) / 1000 : 0,
    stallsOver250ms: stalls,
    maxStallMs: Math.round(maxStallMs),
    steadySamples: steady.length,
    steadyPlaybackRate: steadyRate,
    steadyStallsOver500ms: steadyStalls,
    steadyCnnPresentRate: steadyWall > 0 && last.renderedFrames
      ? Math.round(((last.renderedFrames - first.renderedFrames) / (steadyWall / 1000)) * 100) / 100
      : 0,
    pixelSamples: withPixels.length,
    pixelChangedRatio: withPixels.length > 1
      ? Math.round((changed / (withPixels.length - 1)) * 1000) / 1000
      : 0,
    blackFrames,
    maxConsecutiveIdenticalFrames: frozenRuns.reduce((acc, run) => Math.max(acc, run.count), 0),
    frozenRuns: frozenRuns.slice(0, 10).map(run => ({ count: run.count, from: run.from, until: run.until })),
    decodedFrames: (last.totalVideoFrames || 0) - (first.totalVideoFrames || 0),
    cnnRenderedFrames: (last.renderedFrames || 0) - (first.renderedFrames || 0),
    cnnDroppedEnd: last.cnnDropped || 0,
    renderMsEnd: Math.round((last.renderMs || 0) * 100) / 100,
    backendEnd: last.backend || '',
    presetEnd: last.preset || ''
  };
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  if (!fs.existsSync(sampleVideo)) throw new Error(`Local sample video not found: ${sampleVideo}`);
  seedDatabase();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stdoutPath = outputPath.replace('.json', '-stdout.log');
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  const launchArgs = [`--remote-debugging-port=${debugPort}`, `--smoke-user-data=${userData}`];
  const noSandbox = process.env.SAKURAFALL_PROBE_NO_SANDBOX === '1';
  if (noSandbox) launchArgs.push('--no-sandbox');
  const child = spawn(executable, launchArgs, {
    cwd: path.dirname(executable),
    env: childEnv,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => stdoutStream.write(chunk));
  child.stderr.on('data', chunk => stdoutStream.write(chunk));

  let mainPage;
  let playerPage;
  const report = {
    executable,
    stdoutLog: stdoutPath,
    noSandbox,
    gpuSandboxWorkaround: noSandbox ? 'SAKURAFALL_PROBE_NO_SANDBOX=1（宿主 GPU 沙箱不可用）' : '',
    seconds,
    intervalMs,
    interactionMs,
    steadyAfterMs,
    interactionCounts: {},
    samples: [],
    summary: null
  };
  const interactionHandlers = [
    { id: 'fullscreen', run: interactionFullscreen },
    { id: 'seek', run: interactionSeek },
    { id: 'episode-next', run: interactionNextEpisode },
    { id: 'pause-resume', run: interactionPauseResume }
  ];

  try {
    await waitFor(async () => {
      try { return (await fetchTargets()).find(item => item.type === 'page'); } catch (_) { return null; }
    }, 'packaged app DevTools endpoint', 30000, 150);

    const mainTarget = (await fetchTargets()).find(item => item.type === 'page');
    mainPage = new CdpClient(mainTarget.webSocketDebuggerUrl);
    await mainPage.connect();
    await mainPage.send('Runtime.enable');
    await mainPage.send('Page.enable');
    await waitFor(() => mainPage.evaluate(`Boolean(window.electronAPI?.openPlayerWindow)`), 'main preload API', 20000, 100);
    await installPngDecoder(mainPage);
    await delay(2000);

    const videoUrl = pathToFileURL(sampleVideo).href;
    const episodes = Array.from({ length: episodeCount }, (_, index) => ({
      id: `probe-episode-${index + 1}`,
      title: `Episode ${index + 1}`,
      index,
      url: videoUrl,
      lineId: 'local'
    }));
    const payload = {
      title: 'Anime4K pixel audit',
      url: videoUrl,
      anime: {
        id: 'probe-local-video',
        name: 'Anime4K pixel audit',
        source: 'local-probe',
        sourceName: 'Local probe',
        sourceType: 'local',
        episodes: { local: episodes }
      },
      episode: episodes[0],
      episodeId: episodes[0].id,
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

    const metrics = await playerPage.send('Page.getLayoutMetrics');
    const viewport = metrics.cssContentSize || metrics.contentSize;
    const clipWidth = Math.max(120, Math.round((viewport.width || 640) * 0.25));
    const clipHeight = Math.max(68, Math.round((viewport.height || 360) * 0.25));
    const clip = {
      x: Math.round(((viewport.width || 640) - clipWidth) / 2),
      y: Math.round(((viewport.height || 360) - clipHeight) / 2),
      width: clipWidth,
      height: clipHeight
    };
    report.clip = clip;

    await setAnime4k(playerPage, true);
    await waitFor(() => playerPage.evaluate(`(() => {
      const canvas = document.querySelector('.anime4k-canvas');
      return JSON.parse(canvas?.dataset.anime4kRuntime || '{}').presenting || null;
    })()`), 'anime4k presenting', 15000, 100);

    const startedAt = Date.now();
    let lastInteractionAt = startedAt;
    let interactionIndex = 0;
    let nextInteractionAt = startedAt + interactionMs;

    while (Date.now() - startedAt < seconds * 1000) {
      await delay(intervalMs);
      const runtime = await sampleRuntime(playerPage).catch(error => ({ error: error.message }));
      let pixel = null;
      try {
        pixel = await capturePixels(playerPage, mainPage, clip);
      } catch (error) {
        pixel = { error: error.message };
      }
      const now = Date.now();
      const sample = {
        ...runtime,
        pixel,
        // 稳态：距上次交互超过 steadyAfterMs 且此刻在播放
        steady: runtime.paused === false && now - lastInteractionAt >= steadyAfterMs
      };
      report.samples.push(sample);

      if (now >= nextInteractionAt) {
        const handler = interactionHandlers[interactionIndex % interactionHandlers.length];
        interactionIndex += 1;
        nextInteractionAt = now + interactionMs;
        report.interactionCounts[handler.id] = (report.interactionCounts[handler.id] || 0) + 1;
        report.samples.push({ t: now, interaction: handler.id });
        lastInteractionAt = now;
        try {
          await handler.run(playerPage);
        } catch (error) {
          report.samples.push({ t: Date.now(), interactionError: `${handler.id}: ${error.message}` });
        }
        lastInteractionAt = Date.now();
      }
    }

    report.summary = summarize(report.samples);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('[pixel audit] interactions', JSON.stringify(report.interactionCounts));
    console.log('[pixel audit] summary', JSON.stringify(report.summary, null, 2));
    return report;
  } finally {
    playerPage?.close();
    mainPage?.close();
    await stopApp();
    await delay(800);
    try { stdoutStream.end(); } catch (_) { /* ignore */ }
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

main().catch(async error => {
  console.error(error.stack || error.message);
  await stopApp();
  process.exit(1);
});
