const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');

const execFileAsync = promisify(execFile);
const workspace = path.resolve(__dirname, '..');
const executable = path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const sampleVideo = path.join(workspace, 'splash-sample.mp4');
const outputPath = path.join(workspace, 'artifacts', 'production-playback-performance-audit.json');
const debugPort = Number(process.env.SAKURAFALL_PLAYBACK_AUDIT_PORT || 9241);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-playback-audit-'));
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

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function fetchTargets() {
  const response = await fetch(`${debugUrl}/json/list`);
  if (!response.ok) throw new Error(`DevTools target request failed: HTTP ${response.status}`);
  return response.json();
}

async function sampleProcesses() {
  const script = `
$targetPath = ${powershellLiteral(executable)}
$matches = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $targetPath })
$rows = @()
foreach ($item in $matches) {
  $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    $rows += [pscustomobject]@{
      pid = $process.Id
      role = if ($item.CommandLine -match '--type=gpu-process') { 'gpu' } elseif ($item.CommandLine -match '--type=renderer') { 'renderer' } elseif ($item.CommandLine -match '--utility-sub-type=audio') { 'audio' } elseif ($item.CommandLine -match '--type=utility') { 'utility' } else { 'main' }
      workingSetMB = [math]::Round($process.WorkingSet64 / 1MB, 2)
      privateMB = [math]::Round($process.PrivateMemorySize64 / 1MB, 2)
      cpuSeconds = [math]::Round($process.CPU, 3)
    }
  }
}
[pscustomobject]@{
  processCount = $rows.Count
  workingSetMB = [math]::Round(($rows | Measure-Object workingSetMB -Sum).Sum, 2)
  privateMB = [math]::Round(($rows | Measure-Object privateMB -Sum).Sum, 2)
  cpuSeconds = [math]::Round(($rows | Measure-Object cpuSeconds -Sum).Sum, 3)
  processes = $rows
} | ConvertTo-Json -Depth 4 -Compress
`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout.trim());
}

async function rendererMetrics(page) {
  const [heap, dom] = await Promise.all([
    page.send('Runtime.getHeapUsage'),
    page.send('Memory.getDOMCounters')
  ]);
  return {
    jsHeapUsedMB: Number((heap.usedSize / 1024 / 1024).toFixed(2)),
    jsHeapTotalMB: Number((heap.totalSize / 1024 / 1024).toFixed(2)),
    documents: dom.documents,
    domNodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners
  };
}

async function checkpoint(page, name) {
  return {
    name,
    system: await sampleProcesses(),
    renderer: page ? await rendererMetrics(page) : null
  };
}

async function collectPlaybackWindow(page, durationMs = 3000) {
  return page.evaluate(`(() => new Promise(resolve => {
    const video = document.querySelector('video.video-element');
    if (!video) return resolve({ error: 'video element missing' });
    const container = document.querySelector('.video-player-container');
    container?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 120 }));
    video.loop = true;
    video.muted = true;
    video.play().catch(() => {});
    const qualityBefore = video.getVideoPlaybackQuality?.() || {};
    const rafIntervals = [];
    const mediaIntervals = [];
    let rafId = 0;
    let videoFrameId = 0;
    let previousRaf = 0;
    let previousMediaTime = null;
    let presentedFrames = 0;
    const startedAt = performance.now();

    const onRaf = now => {
      if (previousRaf) rafIntervals.push(now - previousRaf);
      previousRaf = now;
      rafId = requestAnimationFrame(onRaf);
    };
    rafId = requestAnimationFrame(onRaf);

    const onVideoFrame = (_now, metadata) => {
      presentedFrames += 1;
      if (previousMediaTime != null && metadata.mediaTime >= previousMediaTime) {
        const delta = metadata.mediaTime - previousMediaTime;
        if (delta > 0 && delta < 0.5) mediaIntervals.push(delta);
      }
      previousMediaTime = metadata.mediaTime;
      videoFrameId = video.requestVideoFrameCallback(onVideoFrame);
    };
    if (video.requestVideoFrameCallback) {
      videoFrameId = video.requestVideoFrameCallback(onVideoFrame);
    }

    setTimeout(() => {
      cancelAnimationFrame(rafId);
      if (video.cancelVideoFrameCallback && videoFrameId) video.cancelVideoFrameCallback(videoFrameId);
      const elapsedMs = performance.now() - startedAt;
      const qualityAfter = video.getVideoPlaybackQuality?.() || {};
      const sorted = rafIntervals.slice().sort((a, b) => a - b);
      const percentile = value => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] || 0;
      const averageMediaDelta = mediaIntervals.reduce((sum, value) => sum + value, 0) / Math.max(1, mediaIntervals.length);
      const animeCanvas = document.querySelector('.anime4k-canvas');
      const animeComponent = animeCanvas?.__vueParentComponent?.proxy || null;
      container?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 140, clientY: 140 }));
      const animeStatus = Array.from(document.querySelectorAll('.source-status-pill span'))
        .find(item => item.textContent.includes('A4K'));
      resolve({
        elapsedMs,
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        presentedFrames,
        measuredVideoFps: presentedFrames * 1000 / elapsedMs,
        mediaCadenceFps: averageMediaDelta > 0 ? 1 / averageMediaDelta : 0,
        decodedFrames: (qualityAfter.totalVideoFrames || 0) - (qualityBefore.totalVideoFrames || 0),
        droppedFrames: (qualityAfter.droppedVideoFrames || 0) - (qualityBefore.droppedVideoFrames || 0),
        // Anime4K canvas 盖住 video 元素时，Chromium 会把"无需上屏的视频帧"计入 droppedVideoFrames，
        // 属于合成层口径差异而非真实掉帧；真实流畅度看 longFrameRatio 与 mediaCadence。
        droppedFramesNote: (() => {
          const canvas = document.querySelector('.anime4k-canvas');
          const covered = Boolean(canvas && getComputedStyle(canvas).display !== 'none' && getComputedStyle(canvas).visibility !== 'hidden');
          return covered ? 'canvas covering video: droppedVideoFrames includes non-composited frames (benign)' : '';
        })(),
        rafFrames: rafIntervals.length,
        rafAverageMs: rafIntervals.reduce((sum, value) => sum + value, 0) / Math.max(1, rafIntervals.length),
        rafP95Ms: percentile(0.95),
        rafMaximumMs: Math.max(0, ...rafIntervals),
        longFrameRatio: rafIntervals.filter(value => value > 32).length / Math.max(1, rafIntervals.length),
        fullscreen: Boolean(document.fullscreenElement),
        anime4k: animeComponent?.buildStatus ? animeComponent.buildStatus() : { active: false },
        anime4kStatusText: animeStatus?.textContent.trim() || '',
        anime4kStatusTitle: animeStatus?.title || '',
        canvasVisible: (() => {
          const canvas = document.querySelector('.anime4k-canvas');
          return Boolean(canvas && getComputedStyle(canvas).display !== 'none' && getComputedStyle(canvas).visibility !== 'hidden');
        })()
      });
    }, ${Math.max(1000, Number(durationMs) || 3000)});
  }))()`);
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
  const script = `
$targetPath = ${powershellLiteral(executable)}
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $targetPath } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }).catch(() => {});
}

function delta(after, before) {
  return {
    processCount: after.processCount - before.processCount,
    workingSetMB: Number((after.workingSetMB - before.workingSetMB).toFixed(2)),
    privateMB: Number((after.privateMB - before.privateMB).toFixed(2)),
    cpuSeconds: Number((after.cpuSeconds - before.cpuSeconds).toFixed(3))
  };
}

function roleCount(snapshot, role) {
  return snapshot.processes.filter(item => item.role === role).length;
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  if (!fs.existsSync(sampleVideo)) throw new Error(`Local sample video not found: ${sampleVideo}`);
  seedDatabase();

  _child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--smoke-user-data=${userData}`
  ], {
    cwd: path.dirname(executable),
    windowsHide: false,
    stdio: 'ignore'
  });

  let mainPage;
  let playerPage;
  try {
    await waitFor(async () => {
      try { return (await fetchTargets()).find(item => item.type === 'page'); } catch (_) { return null; }
    }, 'packaged app DevTools endpoint', 30000, 150);

    const mainTarget = (await fetchTargets()).find(item => item.type === 'page');
    mainPage = new CdpClient(mainTarget.webSocketDebuggerUrl);
    await mainPage.connect();
    await mainPage.send('Runtime.enable');
    await mainPage.send('Performance.enable');
    await waitFor(() => mainPage.evaluate(`Boolean(window.electronAPI?.openPlayerWindow)`), 'main preload API', 20000, 100);
    await waitFor(() => mainPage.evaluate(`(() => {
      const cards = document.querySelectorAll('.anime-card:not(.skeleton)').length;
      const loading = Boolean(document.querySelector('.anime-card.skeleton, .anime-loading-stage'));
      return cards >= 6 && !loading;
    })()`), 'stable main catalog', 30000, 200).catch(() => false);
    await delay(2500);

    const report = {
      executable,
      sampleVideo,
      source: { width: 1112, height: 834, fps: 24, durationSeconds: 5.088 },
      checkpoints: [],
      playback: {},
      deltas: {},
      verdict: {}
    };
    report.checkpoints.push(await checkpoint(mainPage, 'main-idle'));

    const videoUrl = pathToFileURL(sampleVideo).href;
    const episode = { id: 'audit-episode-1', title: 'Episode 1', index: 0, url: videoUrl, lineId: 'local' };
    const payload = {
      title: 'SakuraFall playback performance audit',
      url: videoUrl,
      anime: {
        id: 'audit-local-video',
        name: 'SakuraFall playback performance audit',
        source: 'local-audit',
        sourceName: 'Local audit',
        sourceType: 'local',
        episodes: { local: [episode] }
      },
      episode,
      episodeId: episode.id,
      lineId: 'local'
    };
    const openedAt = Date.now();
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
    await playerPage.send('Performance.enable');

    const ready = await waitFor(() => playerPage.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      if (!video || video.error || video.readyState < 2 || !video.videoWidth) return null;
      video.loop = true;
      video.muted = true;
      video.play().catch(() => {});
      return { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState };
    })()`), 'decoded local video', 15000, 100);
    report.playback.startupMs = Date.now() - openedAt;
    report.playback.ready = ready;
    report.checkpoints.push(await checkpoint(playerPage, 'player-ready'));

    const normalCpuBefore = await sampleProcesses();
    report.playback.normal = await collectPlaybackWindow(playerPage, 3200);
    const normalCpuAfter = await sampleProcesses();
    report.playback.normal.systemDelta = delta(normalCpuAfter, normalCpuBefore);

    await playerPage.evaluate(`document.querySelector('.video-player-container')?.requestFullscreen()`, true);
    await waitFor(() => playerPage.evaluate(`Boolean(document.fullscreenElement)`), 'player fullscreen', 5000, 50);
    report.playback.fullscreen = await collectPlaybackWindow(playerPage, 2600);

    await playerPage.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      if (!video) return false;
      video.pause();
      video.currentTime = 0;
      video.loop = true;
      return true;
    })()`);
    await waitFor(() => playerPage.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      return Boolean(video && !video.seeking && video.readyState >= 2 && video.currentTime < 0.25);
    })()`), 'sample seek reset', 5000, 50);
    await playerPage.evaluate(`document.querySelector('video.video-element')?.play().catch(() => {})`);
    await setAnime4k(playerPage, true);
    const anime4kActivated = await waitFor(() => playerPage.evaluate(`(() => {
      const canvas = document.querySelector('.anime4k-canvas');
      const component = canvas?.__vueParentComponent?.proxy;
      return Boolean(component?.buildStatus?.().active ||
        (canvas && getComputedStyle(canvas).display !== 'none' && canvas.width > 0 && canvas.height > 0));
    })()`), 'Anime4K runtime', 12000, 150).catch(() => false);
    report.playback.anime4kActivation = await playerPage.evaluate(`(() => {
      const canvas = document.querySelector('.anime4k-canvas');
      const canvasNode = canvas?.__vueParentComponent;
      const input = Array.from(document.querySelectorAll('.settings-toggle-row'))
        .find(item => item.textContent.includes('Anime4K'))?.querySelector('input[type="checkbox"]');
      return {
        activated: ${JSON.stringify(anime4kActivated)},
        enabled: Boolean(input?.checked),
        componentName: canvasNode?.type?.name || '',
        canvasEnabled: Boolean(canvasNode?.proxy?.enabled),
        runtime: canvasNode?.proxy?.buildStatus ? canvasNode.proxy.buildStatus() : null,
        canvasActive: Boolean(canvasNode?.proxy?.active),
        canvasBackend: canvasNode?.proxy?.backend || '',
        fullscreenSafeMode: Boolean(canvasNode?.proxy?.fullscreenSafeMode),
        canvasDisplay: canvas ? getComputedStyle(canvas).display : 'missing',
        canvasSize: canvas ? { width: canvas.width, height: canvas.height } : null,
        hasWebgpu: Boolean(navigator.gpu),
        hasVideoFrame: typeof VideoFrame === 'function',
        hasOffscreenCanvas: typeof OffscreenCanvas === 'function',
        notices: Array.from(document.querySelectorAll('[class*="notification"], [class*="notice"]')).map(item => item.textContent.trim()).filter(Boolean).slice(-4)
      };
    })()`);
    const animeCpuBefore = await sampleProcesses();
    report.playback.fullscreenAnime4k = await collectPlaybackWindow(playerPage, 3600);
    const animeCpuAfter = await sampleProcesses();
    report.playback.fullscreenAnime4k.systemDelta = delta(animeCpuAfter, animeCpuBefore);
    report.checkpoints.push(await checkpoint(playerPage, 'fullscreen-anime4k'));

    await setAnime4k(playerPage, false);
    await playerPage.evaluate(`document.fullscreenElement ? document.exitFullscreen() : Promise.resolve()`, true);
    await delay(500);
    await playerPage.evaluate(`window.electronAPI.closeWindow()`, true);
    await waitFor(async () => !(await fetchTargets()).some(item => item.id === playerTarget.id), 'player target cleanup', 10000, 150);
    playerPage.close();
    playerPage = null;

    await delay(12000);
    await mainPage.send('HeapProfiler.enable');
    await mainPage.send('HeapProfiler.collectGarbage');
    await delay(1200);
    report.checkpoints.push(await checkpoint(mainPage, 'after-player-close'));

    const baseline = report.checkpoints[0];
    const playerReady = report.checkpoints.find(item => item.name === 'player-ready');
    const closed = report.checkpoints.find(item => item.name === 'after-player-close');
    report.deltas.playerOpen = delta(playerReady.system, baseline.system);
    report.deltas.afterClose = delta(closed.system, baseline.system);
    report.deltas.rendererAfterClose = {
      jsHeapUsedMB: Number((closed.renderer.jsHeapUsedMB - baseline.renderer.jsHeapUsedMB).toFixed(2)),
      domNodes: closed.renderer.domNodes - baseline.renderer.domNodes,
      jsEventListeners: closed.renderer.jsEventListeners - baseline.renderer.jsEventListeners
    };
    report.verdict = {
      startupUnderThreeSeconds: report.playback.startupMs < 3000,
      normalPlaybackAdvances: report.playback.normal.presentedFrames >= 50,
      normalLongFrameRatioUnderFivePercent: report.playback.normal.longFrameRatio < 0.05,
      fullscreenPlaybackAdvances: report.playback.fullscreen.presentedFrames >= 40,
      anime4kActivated: Boolean(report.playback.anime4kActivation.activated &&
        (report.playback.fullscreenAnime4k.canvasVisible ||
          report.playback.anime4kActivation.runtime?.active ||
          report.playback.fullscreenAnime4k.anime4kStatusText.includes('A4K'))),
      anime4kPlaybackAdvances: report.playback.fullscreenAnime4k.presentedFrames >= 50,
      playerRendererReleased: roleCount(closed.system, 'renderer') <= roleCount(baseline.system, 'renderer'),
      closeWorkingSetWithinBudget: report.deltas.afterClose.workingSetMB < 280
    };
    report.passed = Object.values(report.verdict).every(Boolean);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ success: true, outputPath, ...report }, null, 2));
  } finally {
    playerPage?.close();
    mainPage?.close();
    await stopApp();
    await delay(800);
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* Chromium may still release profile files */ }
  }
}

main().catch(async error => {
  console.error(error.stack || error.message);
  await stopApp();
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
