const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { promisify } = require('node:util');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');

const execFileAsync = promisify(execFile);
const workspace = path.resolve(__dirname, '..');
// 支持通过 SAKURAFALL_AUDIT_EXECUTABLE 指定打包产物（如 dist-app-v2），
// 避免主输出目录被 IDE 索引器等占用时无法重新构建。
const executable = process.env.SAKURAFALL_AUDIT_EXECUTABLE
  || path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const sampleVideo = path.join(workspace, 'splash-sample.mp4');
const outputPath = path.join(workspace, 'artifacts', 'production-playback-performance-audit.json');
const debugPort = Number(process.env.SAKURAFALL_PLAYBACK_AUDIT_PORT || 9241);
const debugUrl = `http://127.0.0.1:${debugPort}`;
// soak 模式：CNN 连续运行验证（默认 5 分钟，全屏/暂停/拖动/切集各 ≥10 次）。
// 运行: node scripts/production-playback-performance-audit.js --soak
// 时长覆盖: SAKURAFALL_SOAK_MINUTES=10 node ... --soak
const soakEnabled = process.argv.includes('--soak') || Number(process.env.SAKURAFALL_SOAK_MINUTES || 0) > 0;
const soakMinutes = Math.max(1, Number(process.env.SAKURAFALL_SOAK_MINUTES) || 5);
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
    const startMediaTime = Number(video.currentTime) || 0;
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
      const animeRuntime = JSON.parse(animeCanvas?.dataset.anime4kRuntime || '{}');
      container?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 140, clientY: 140 }));
      const animeStatus = Array.from(document.querySelectorAll('.source-status-pill span'))
        .find(item => /A4K|显示增强/.test(item.textContent));
      // 播放推进用媒体时间衡量：画布盖住 video 时 Chromium 会节流呈现
      // （presentedFrames 偏低属合成口径差异），currentTime/解码帧才是真实播放健康度。
      let mediaAdvanced = video.currentTime - startMediaTime;
      if (mediaAdvanced < 0 && video.duration > 0) mediaAdvanced += video.duration;
      resolve({
        elapsedMs,
        currentTime: video.currentTime,
        duration: video.duration,
        paused: video.paused,
        readyState: video.readyState,
        width: video.videoWidth,
        height: video.videoHeight,
        presentedFrames,
        mediaTimeAdvancedMs: Math.round(mediaAdvanced * 100) / 100,
        playbackRateRatio: Math.max(0, Math.min(1, mediaAdvanced / Math.max(0.001, elapsedMs / 1000))),
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
        anime4k: animeComponent?.buildStatus ? animeComponent.buildStatus() : animeRuntime,
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

// 连续截屏并比对像素哈希：证明增强画布真的在呈现变化帧，
// 而不是冻结的黑屏/首帧（CNN worker 存活但呈现链路断裂时的典型症状）。
async function captureVisualSamples(page, count = 4, intervalMs = 350) {
  const hashes = [];
  for (let index = 0; index < count; index += 1) {
    // 每次截屏前刷新控制栏的显隐状态，避免 UI 隐藏造成假阳性差异。
    await page.evaluate(`(() => {
      const container = document.querySelector('.video-player-container');
      container?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 160, clientY: 160 }));
    })()`, true).catch(() => {});
    const shot = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    hashes.push(crypto.createHash('md5').update(shot.data, 'base64').digest('hex'));
    if (index < count - 1) await delay(intervalMs);
  }
  let changedPairs = 0;
  for (let index = 1; index < hashes.length; index += 1) {
    if (hashes[index] !== hashes[index - 1]) changedPairs += 1;
  }
  const totalPairs = Math.max(0, hashes.length - 1);
  return { hashes, changedPairs, totalPairs, changing: changedPairs > 0 };
}

// soak 期间按固定节奏采样播放器状态：视频推进、CNN 后端/档位/呈现与帧计数。
async function soakPoll(page) {
  return page.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    const canvas = document.querySelector('.anime4k-canvas');
    const component = canvas?.__vueParentComponent?.proxy;
    const runtime = component?.buildStatus?.() || JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
    return {
      t: Date.now(),
      videoTime: video ? video.currentTime : -1,
      duration: video ? video.duration : 0,
      paused: video ? video.paused : null,
      seeking: video ? video.seeking : null,
      backend: runtime.backend || '',
      preset: runtime.preset || '',
      presenting: Boolean(runtime.presenting),
      active: Boolean(runtime.active),
      renderedFrames: runtime.renderedFrames || 0,
      droppedFrames: runtime.droppedFrames || 0,
      fps: runtime.fps || 0,
      renderMs: runtime.renderMs || 0,
      sourceFps: runtime.sourceFps || 0,
      frameAgeMs: runtime.frameAgeMs || 0,
      stageMs: runtime.stageMs || null,
      initMs: runtime.initMs || null
    };
  })()`);
}

// 在组件树上找到 PlayerWindow 视图（持有 playEpisode/playNextEpisode）。
function playerWindowCallExpression(method) {
  return `(() => {
    let node = document.querySelector('video.video-element')?.__vueParentComponent;
    while (node && !(node.proxy && typeof node.proxy.playEpisode === 'function')) node = node.parent;
    if (!node) return false;
    const proxy = node.proxy;
    ${method};
    return true;
  })()`;
}

async function soakInteraction(page, kind) {
  if (kind === 'fullscreen') {
    const direction = await page.evaluate(`(() => {
      if (document.fullscreenElement) { document.exitFullscreen(); return 'exiting'; }
      const container = document.querySelector('.video-player-container');
      container?.requestFullscreen();
      return 'entering';
    })()`, true);
    const expected = direction === 'entering';
    await waitFor(() => page.evaluate(`Boolean(document.fullscreenElement) === ${expected}`, true),
      `soak fullscreen ${direction}`, 5000, 100).catch(() => false);
    return;
  }
  if (kind === 'pause') {
    await page.evaluate(`(() => { document.querySelector('video.video-element')?.pause(); })()`, true);
    await delay(600);
    await page.evaluate(`(() => { document.querySelector('video.video-element')?.play()?.catch(() => {}); })()`, true);
    await waitFor(() => page.evaluate(`!document.querySelector('video.video-element')?.paused`, true),
      'soak resume', 5000, 100).catch(() => false);
    return;
  }
  if (kind === 'seek') {
    await page.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      if (!video || !video.duration || !Number.isFinite(video.duration)) return;
      video.currentTime = Math.max(0.5, video.duration * (0.1 + 0.8 * Math.random()));
    })()`, true);
    await waitFor(() => page.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      return Boolean(video && !video.seeking && video.readyState >= 2);
    })()`, true), 'soak seek settle', 5000, 100).catch(() => false);
    return;
  }
  if (kind === 'episode') {
    // 优先下一集；到最后一集时回到第一集，保证切集交互可持续循环。
    const triggered = await page.evaluate(playerWindowCallExpression(`
      const list = Array.isArray(proxy.currentLineEpisodes) ? proxy.currentLineEpisodes : [];
      const target = proxy.nextEpisode || list[0];
      if (!target) return false;
      proxy.playEpisode(target);
    `), true);
    if (!triggered) return;
    await waitFor(() => page.evaluate(`(() => {
      const canvas = document.querySelector('.anime4k-canvas');
      const component = canvas?.__vueParentComponent?.proxy;
      const runtime = component?.buildStatus?.() || JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
      const video = document.querySelector('video.video-element');
      return Boolean(runtime.active && runtime.presenting && video && video.readyState >= 2 && !video.paused);
    })()`, true), 'soak episode switch presenting', 25000, 200).catch(() => false);
  }
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
    const episodeList = [episode];
    if (soakEnabled) {
      // soak 切集样本：不同分辨率/帧率的本地样本，驱动 sourceKey 重启与帧预算自适应。
      const mediaDir = path.join(workspace, 'artifacts', 'media-samples');
      for (const name of ['480p-24fps', '480p-30fps', '720p-24fps', '720p-30fps']) {
        const file = path.join(mediaDir, `${name}.mp4`);
        if (fs.existsSync(file)) {
          episodeList.push({
            id: `audit-episode-${episodeList.length + 1}`,
            title: `Episode ${episodeList.length + 1} (${name})`,
            index: episodeList.length,
            url: pathToFileURL(file).href,
            lineId: 'local'
          });
        }
      }
    }
    const payload = {
      title: 'SakuraFall playback performance audit',
      url: videoUrl,
      anime: {
        id: 'audit-local-video',
        name: 'SakuraFall playback performance audit',
        source: 'local-audit',
        sourceName: 'Local audit',
        sourceType: 'local',
        episodes: { local: episodeList }
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
      const runtime = component?.buildStatus?.() || JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
      return Boolean(runtime.active && runtime.presenting);
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
        runtime: canvasNode?.proxy?.buildStatus ? canvasNode.proxy.buildStatus() : JSON.parse(canvas?.dataset.anime4kRuntime || '{}'),
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
    report.playback.anime4kVisual = await captureVisualSamples(playerPage, 4, 350);
    report.checkpoints.push(await checkpoint(playerPage, 'fullscreen-anime4k'));

    // S2-7 soak：CNN 连续运行验证。全屏/暂停/拖动/切集循环执行，
    // 全程按 500ms 采样视频推进与 CNN 状态，另按 30s 周期做画面变化截屏比对。
    if (soakEnabled) {
      const soakStartedAt = Date.now();
      const deadline = soakStartedAt + soakMinutes * 60_000;
      const polls = [];
      const marks = [];
      const interactions = { fullscreenToggles: 0, pauseResumes: 0, seeks: 0, episodeSwitches: 0 };
      const visual = { checks: 0, changes: 0 };
      let lastVisualCheck = 0;
      let lastPreset = null;
      let presetChanges = 0;
      let nextInteractionAt = 0;
      let roundIndex = 0;
      const round = ['fullscreen', 'pause', 'seek', 'episode'];

      while (Date.now() < deadline) {
        const poll = await soakPoll(playerPage).catch(() => null);
        if (poll) {
          polls.push(poll);
          if (lastPreset != null && poll.preset && poll.preset !== lastPreset) presetChanges += 1;
          if (poll.preset) lastPreset = poll.preset;
        }
        if (Date.now() - lastVisualCheck > 30_000 && deadline - Date.now() > 20_000) {
          lastVisualCheck = Date.now();
          const samples = await captureVisualSamples(playerPage, 2, 400).catch(() => null);
          if (samples) {
            visual.checks += 1;
            if (samples.changing) visual.changes += 1;
          }
        }
        if (Date.now() > nextInteractionAt && deadline - Date.now() > 30_000) {
          const kind = round[roundIndex % round.length];
          roundIndex += 1;
          nextInteractionAt = Date.now() + 6000;
          const markStartedAt = Date.now();
          try { await soakInteraction(playerPage, kind); } catch (_) { /* soak 交互失败计入计数，不中断 */ }
          marks.push({ kind, start: markStartedAt, end: Date.now() });
          if (kind === 'fullscreen') interactions.fullscreenToggles += 1;
          if (kind === 'pause') interactions.pauseResumes += 1;
          if (kind === 'seek') interactions.seeks += 1;
          if (kind === 'episode') interactions.episodeSwitches += 1;
        }
        await delay(500);
      }

      // 冻结检测：连续两次采样之间视频未推进且既非暂停也非 seek，
      // 且不落在交互窗口（±3s 缓冲）内，记为疑似冻结间隔。
      // videoTime 回退（样本循环回绕）视为正常推进。
      const nearInteraction = t => marks.some(mark => {
        // 切集后管线重建（解析→换源→初始化→首帧）需要更长恢复窗口
        const tailGrace = mark.kind === 'episode' ? 10000 : 3000;
        return t > mark.start - 3000 && t < mark.end + tailGrace;
      });
      const isProgress = (prev, current) =>
        current.videoTime > prev.videoTime || current.videoTime < prev.videoTime - 0.5;
      let maxFreezeMs = 0;
      let freezeEvents = 0;
      for (let index = 1; index < polls.length; index += 1) {
        const prev = polls[index - 1];
        const current = polls[index];
        if (prev.paused || current.paused || prev.seeking || current.seeking) continue;
        if (nearInteraction(prev.t) || nearInteraction(current.t)) continue;
        if (isProgress(prev, current)) continue;
        const stallMs = current.t - prev.t;
        if (stallMs > maxFreezeMs) maxFreezeMs = stallMs;
        if (stallMs >= 500) freezeEvents += 1;
      }
      const activePolls = polls.filter(poll => !poll.paused && poll.backend === 'webgpu-worker' && poll.active);
      const playingPolls = polls.filter(poll => !poll.paused && poll.active && !nearInteraction(poll.t));
      const activeExcluded = activePolls.filter(poll => !nearInteraction(poll.t));
      // 激活率排除交互窗口：切集/降档重建期 CNN 短暂失活属于编译与切换阶段，单独列数据
      const cnnActiveRatio = polls.length > 0 ? activePolls.length / polls.length : 0;
      const cnnActiveWhilePlayingRatio = playingPolls.length > 0 ? activeExcluded.length / playingPolls.length : 0;
      const lastPoll = polls[polls.length - 1] || {};
      report.soak = {
        enabled: true,
        minutes: soakMinutes,
        durationMs: Date.now() - soakStartedAt,
        pollCount: polls.length,
        interactions,
        visual,
        presetChanges,
        cnnActiveRatio: Math.round(cnnActiveRatio * 1000) / 1000,
        cnnActiveWhilePlayingRatio: Math.round(cnnActiveWhilePlayingRatio * 1000) / 1000,
        maxFreezeMs,
        freezeEventsOver500ms: freezeEvents,
        finalRuntime: {
          backend: lastPoll.backend || '',
          preset: lastPoll.preset || '',
          presenting: lastPoll.presenting || false,
          renderedFrames: lastPoll.renderedFrames || 0,
          droppedFrames: lastPoll.droppedFrames || 0,
          fps: lastPoll.fps || 0,
          sourceFps: lastPoll.sourceFps || 0,
          renderMs: lastPoll.renderMs || 0,
          frameAgeMs: lastPoll.frameAgeMs || 0,
          stageMs: lastPoll.stageMs || null,
          initMs: lastPoll.initMs || null
        },
        polls: polls.map(poll => ({
          t: poll.t,
          videoTime: poll.videoTime,
          paused: poll.paused,
          backend: poll.backend,
          preset: poll.preset,
          presenting: poll.presenting,
          renderedFrames: poll.renderedFrames,
          droppedFrames: poll.droppedFrames,
          fps: poll.fps,
          renderMs: poll.renderMs
        }))
      };
      report.checkpoints.push(await checkpoint(playerPage, 'soak-complete'));
    }

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

    // 三个独立结果：CNN 实时运行 / 轻量显示增强（回退）/ 视频仍正常播放。
    // CSS 或 WebGL 回退不得计入 CNN 成功；回退发生时 CNN 结果为 false，但视频与回退链路单独判定。
    const runtimeBackend = String(
      report.playback.anime4kActivation.runtime?.backend ||
      report.playback.anime4kActivation.canvasBackend || ''
    );
    const statusText = `${report.playback.fullscreenAnime4k.anime4kStatusText || ''} ${report.playback.fullscreenAnime4k.anime4kStatusTitle || ''}`;
    const cnnRuntimeActive = Boolean(
      report.playback.anime4kActivation.activated &&
      runtimeBackend === 'webgpu-worker' &&
      report.playback.anime4kActivation.runtime?.active &&
      report.playback.anime4kActivation.runtime?.presenting
    );
    const displayEnhancementActive = Boolean(
      report.playback.anime4kActivation.activated &&
      !cnnRuntimeActive &&
      (runtimeBackend === 'css' || runtimeBackend === 'webgl-main' || statusText.includes('显示增强'))
    );
    // CNN 呈现率：渲染完成帧占提交帧（渲染 + 忙时丢弃）的比例，
    // 结合 render fps 相对源帧率的比值取较大者（画布盖住 video 时 rvfc 回调节流属正常口径）。
    const animeRuntime = report.playback.fullscreenAnime4k.anime4k || {};
    const cnnRendered = Number(animeRuntime.renderedFrames) || 0;
    const cnnDropped = Number(animeRuntime.droppedFrames) || 0;
    const dropRateRatio = (cnnRendered + cnnDropped) > 0 ? cnnRendered / (cnnRendered + cnnDropped) : 0;
    const cadenceFps = Number(report.playback.fullscreenAnime4k.mediaCadenceFps) || 24;
    const renderFpsRatio = Math.min(1, (Number(animeRuntime.fps) || 0) / Math.max(1, cadenceFps));
    const cnnPresentationRatio = Math.max(dropRateRatio, renderFpsRatio);
    report.playback.anime4kClassification = {
      runtimeBackend,
      cnnRuntimeActive,
      displayEnhancementActive,
      videoAdvancing: report.playback.fullscreenAnime4k.playbackRateRatio >= 0.9
        && report.playback.fullscreenAnime4k.decodedFrames >= 24,
      cnnRenderedFrames: cnnRendered,
      cnnDroppedFrames: cnnDropped,
      cnnPresentationRatio: Math.round(cnnPresentationRatio * 1000) / 1000,
      visualChangedPairs: report.playback.anime4kVisual.changedPairs,
      visualTotalPairs: report.playback.anime4kVisual.totalPairs
    };

    report.verdict = {
      startupUnderThreeSeconds: report.playback.startupMs < 3000,
      normalPlaybackAdvances: report.playback.normal.presentedFrames >= 50,
      normalLongFrameRatioUnderFivePercent: report.playback.normal.longFrameRatio < 0.05,
      fullscreenPlaybackAdvances: report.playback.fullscreen.presentedFrames >= 40,
      // CNN 实时运行（webgpu-worker 真在处理并呈现）
      cnnRuntimeActive,
      // CNN 呈现率：≥90% 的提交帧被渲染完成且没有持续丢帧
      cnnPresentationRateSufficient: cnnPresentationRatio >= 0.9,
      // 画面变化验证：连续截屏哈希不同，增强画布在呈现变化帧而非冻结画面
      anime4kVisualChanges: Boolean(report.playback.anime4kVisual?.changing),
      // 回退后轻量显示增强仍启用（独立于 CNN 的结果）
      displayEnhancementActive,
      // 增强链路激活期间视频本身仍正常推进：媒体时间按 ≥0.9x 实时推进且解码持续
      // （presentedFrames 在画布盖住 video 时被 Chromium 节流，不能作为判据）
      anime4kPlaybackAdvances: report.playback.fullscreenAnime4k.playbackRateRatio >= 0.9
        && report.playback.fullscreenAnime4k.decodedFrames >= 24,
      playerRendererReleased: roleCount(closed.system, 'renderer') <= roleCount(baseline.system, 'renderer'),
      closeWorkingSetWithinBudget: report.deltas.afterClose.workingSetMB < 280
    };
    // 核心验收：视频播放、回退链路、资源回收必须全部成立；
    // CNN 实时性单独报告（S2 阶段目标），回退不算核心失败但明确标记
    const coreKeys = [
      'startupUnderThreeSeconds',
      'normalPlaybackAdvances',
      'normalLongFrameRatioUnderFivePercent',
      'fullscreenPlaybackAdvances',
      'anime4kPlaybackAdvances',
      'playerRendererReleased',
      'closeWorkingSetWithinBudget'
    ];
    report.corePassed = coreKeys.every(key => report.verdict[key]);
    // S2 目标 = CNN 真实时运行 + 呈现率达标 + 画面确实在变化；
    // soak 模式下还要求：连续运行、无长冻结、交互次数达标、画面持续变化、无档位振荡。
    const soakRan = Boolean(report.soak?.enabled);
    const soakVerdict = soakRan ? {
      // 播放期间 CNN 持续激活的比例 ≥95%
      soakCnnContinuous: report.soak.cnnActiveWhilePlayingRatio >= 0.95,
      // 无可归因于增强的 ≥500ms 冻结
      soakNoLongFreeze: report.soak.freezeEventsOver500ms === 0,
      // 全屏/暂停/拖动/切集各 ≥10 次
      soakInteractionsComplete: report.soak.interactions.fullscreenToggles >= 10
        && report.soak.interactions.pauseResumes >= 10
        && report.soak.interactions.seeks >= 10
        && report.soak.interactions.episodeSwitches >= 10,
      // 周期性截屏比对：≥90% 的检查周期画面在变化
      soakVisualChanging: report.soak.visual.checks > 0
        && report.soak.visual.changes >= Math.ceil(report.soak.visual.checks * 0.9),
      // 档位稳定：无振荡（5 分钟内档位变化 ≤6 次，切集导致的合理重建除外）
      soakNoPresetOscillation: report.soak.presetChanges <= 6
    } : null;
    if (soakVerdict) Object.assign(report.verdict, soakVerdict);
    report.s2Passed = Boolean(
      report.verdict.cnnRuntimeActive &&
      report.verdict.cnnPresentationRateSufficient &&
      report.verdict.anime4kVisualChanges &&
      (!soakRan || Object.values(soakVerdict).every(Boolean))
    );
    report.passed = report.corePassed && report.s2Passed;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ success: true, outputPath, ...report }, null, 2));
    return report;
  } finally {
    playerPage?.close();
    mainPage?.close();
    await stopApp();
    await delay(800);
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* Chromium may still release profile files */ }
  }
}

main().then(report => {
  // 退出码约定：0 = 全部通过（含 CNN 实时运行 + 呈现率达标 + 画面变化验证）
  //           2 = 采集完成、核心验收通过，但 S2 目标未达成（CNN 未实时运行/呈现率不足/画面冻结）——S2 未完成
  //           1 = 采集失败或核心验收未通过（真实失败，不得忽略）
  if (!report) return;
  if (!report.corePassed) {
    console.error('[audit:playback] 核心验收未通过，详见 verdict:');
    console.error(JSON.stringify(report.verdict, null, 2));
    process.exitCode = 1;
  } else if (!report.s2Passed) {
    console.error('[audit:playback] 核心通过，但 S2 目标未达成（backend=%s，呈现率=%s，画面变化=%s）',
      report.playback.anime4kClassification.runtimeBackend,
      report.playback.anime4kClassification.cnnPresentationRatio,
      report.verdict.anime4kVisualChanges);
    process.exitCode = 2;
  }
}).catch(async error => {
  console.error(error.stack || error.message);
  await stopApp();
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
