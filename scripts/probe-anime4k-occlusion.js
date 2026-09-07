// S2 归因探针：在打包应用中逐个变量验证"开启 CNN 后视频解码停摆"的根因。
//
// 停滞签名（artifacts/anime4k-packaged-probe.json）：currentTime 冻结时
// renderedFrames 同样冻结、readyState 掉到 2 且 buffered 仍有余量 —— 说明
// CNN 是受害者而非加害者，根因在视频解码/呈现链路。
//
// 本探针在同一会话内依次施加不同 CSS 变量，排除"画布遮挡导致 video 层不再
// 被合成 -> 解码器收不到释放信号"这一类假设：
//   cover-default     画布完全遮挡 video（当前行为，预期复现停滞）
//   canvas-opacity-099 画布 99% 不透明，破坏 cc 的完全遮挡判定
//   canvas-corner     画布缩到角落，video 完全可见
//   canvas-hidden     画布不参与合成（CNN 仍照常跑，作为"GPU 工作量"对照组）
//
// 运行: node scripts/probe-anime4k-occlusion.js
// 环境: SAKURAFALL_AUDIT_EXECUTABLE / SAKURAFALL_PROBE_PORT / SAKURAFALL_PROBE_VARIANT_SECONDS
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');
const { stopProcessTree } = require('./audit-process-tree');

const workspace = path.resolve(__dirname, '..');
const executable = process.env.SAKURAFALL_AUDIT_EXECUTABLE
  || path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const sampleVideo = path.join(workspace, 'splash-sample.mp4');
const outputPath = path.join(workspace, 'artifacts', 'anime4k-occlusion-probe.json');
const debugPort = Number(process.env.SAKURAFALL_PROBE_PORT || 9245);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const variantSeconds = Number(process.env.SAKURAFALL_PROBE_VARIANT_SECONDS || 20);
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-occlusion-'));
const userData = path.join(runRoot, 'user-data');
let child;

const VARIANTS = [
  { id: 'cover-default', css: '', note: '画布完全遮挡 video（当前线上行为）' },
  { id: 'canvas-opacity-099', css: '.anime4k-canvas{opacity:0.99 !important;}', note: '破坏完全遮挡判定' },
  {
    id: 'canvas-corner',
    css: '.anime4k-canvas{inset:auto !important;top:auto !important;left:auto !important;right:8px !important;bottom:8px !important;width:96px !important;height:54px !important;}',
    note: '画布移到角落，video 完全可见'
  },
  { id: 'canvas-hidden', css: '.anime4k-canvas{display:none !important;}', note: '画布不参与合成，CNN 照常执行（GPU 工作量对照）' }
];

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

async function samplePlayer(page) {
  return page.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    const canvas = document.querySelector('.anime4k-canvas');
    const runtime = JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
    const quality = video?.getVideoPlaybackQuality?.() || {};
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
      bufferedAhead,
      totalVideoFrames: quality.totalVideoFrames || 0,
      droppedVideoFrames: quality.droppedVideoFrames || 0,
      backend: runtime.backend || '',
      preset: runtime.preset || '',
      presenting: Boolean(runtime.presenting),
      renderedFrames: runtime.renderedFrames || 0,
      cnnDropped: runtime.droppedFrames || 0,
      renderMs: runtime.renderMs || 0
    };
  })()`);
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

async function setVariantCss(page, css) {
  await page.evaluate(`(() => {
    let style = document.getElementById('probe-occlusion-css');
    if (!style) {
      style = document.createElement('style');
      style.id = 'probe-occlusion-css';
      document.head.appendChild(style);
    }
    style.textContent = ${JSON.stringify(css || '')};
  })()`, true);
}

async function stopApp() {
  await stopProcessTree({
    rootPid: child?.pid,
    executable,
    marker: `--smoke-user-data=${userData}`
  });
}

// 只看"解码是否健康"：媒体时间推进速率 + 停滞次数 + 解码帧增量。
function summarizeVariant(variant, samples) {
  const valid = samples.filter(sample => !sample.error && typeof sample.currentTime === 'number');
  let mediaTotal = 0;
  let wallTotal = 0;
  let stalls = 0;
  let maxStallMs = 0;
  let stallStart = null;
  let previous = null;
  const readyStateCounts = {};
  for (const sample of valid) {
    readyStateCounts[sample.readyState] = (readyStateCounts[sample.readyState] || 0) + 1;
    if (previous) {
      const wall = sample.t - previous.t;
      wallTotal += wall;
      if (sample.currentTime >= previous.currentTime) mediaTotal += sample.currentTime - previous.currentTime;
      const frozen = !sample.paused && !sample.seeking && sample.currentTime === previous.currentTime;
      if (frozen) {
        if (stallStart == null) stallStart = previous.t;
        maxStallMs = Math.max(maxStallMs, sample.t - stallStart);
      } else {
        if (stallStart != null && sample.t - stallStart >= 250) stalls += 1;
        stallStart = null;
      }
    }
    previous = sample;
  }
  const first = valid[0] || {};
  const last = valid[valid.length - 1] || {};
  return {
    id: variant.id,
    note: variant.note,
    css: variant.css,
    samples: valid.length,
    playbackRate: wallTotal > 0 ? Math.round((mediaTotal / (wallTotal / 1000)) * 1000) / 1000 : 0,
    stallsOver250ms: stalls,
    maxStallMs: Math.round(maxStallMs),
    decodedFrames: (last.totalVideoFrames || 0) - (first.totalVideoFrames || 0),
    cnnRenderedFrames: (last.renderedFrames || 0) - (first.renderedFrames || 0),
    cnnRenderMsEnd: Math.round((last.renderMs || 0) * 100) / 100,
    backendEnd: last.backend || '',
    presetEnd: last.preset || '',
    readyStateHistogram: readyStateCounts
  };
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  if (!fs.existsSync(sampleVideo)) throw new Error(`Local sample video not found: ${sampleVideo}`);
  seedDatabase();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const stdoutPath = outputPath.replace('.json', '-stdout.log');
  const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'w' });
  // 宿主环境注入的 NODE_OPTIONS（IDE / CLI shim）会被子进程继承，打包版 Electron
  // 无法加载这些 require 项，表现为 GPU 进程启动即崩溃循环。启动前必须剥离。
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  const args = [`--remote-debugging-port=${debugPort}`, `--smoke-user-data=${userData}`];
  // 个别机器上 Chromium 的 GPU 沙箱无法初始化（GPU 进程启动即 exit_code=1 并
  // 被判定为不可用）。此时只有 --no-sandbox 能起来，属于宿主环境问题，必须
  // 显式开启并在报告里记录，不能作为默认行为。
  const noSandbox = process.env.SAKURAFALL_PROBE_NO_SANDBOX === '1';
  if (noSandbox) args.push('--no-sandbox');
  child = spawn(executable, args, {
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
    variantSeconds,
    noSandbox,
    gpuSandboxWorkaround: noSandbox ? 'SAKURAFALL_PROBE_NO_SANDBOX=1（宿主 GPU 沙箱不可用）' : '',
    results: []
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
    await delay(2500);

    const videoUrl = pathToFileURL(sampleVideo).href;
    const episode = { id: 'probe-episode-1', title: 'Episode 1', index: 0, url: videoUrl, lineId: 'local' };
    const payload = {
      title: 'Anime4K occlusion probe',
      url: videoUrl,
      anime: {
        id: 'probe-local-video',
        name: 'Anime4K occlusion probe',
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

    for (const variant of VARIANTS) {
      // 每个变量前先回到"无增强"的干净状态，避免上一变量的降级影响下一变量。
      await setVariantCss(playerPage, '');
      await setAnime4k(playerPage, false);
      await delay(2500);
      await setVariantCss(playerPage, variant.css);
      await setAnime4k(playerPage, true);
      // 等 CNN 真正开始呈现；若 10 秒内没有呈现，按失败记录（不抛错，继续下一变量）。
      const presented = await waitFor(
        () => playerPage.evaluate(`(() => {
          const canvas = document.querySelector('.anime4k-canvas');
          const runtime = JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
          return Boolean(runtime.presenting) || null;
        })()`),
        `anime4k presenting (${variant.id})`,
        10000,
        100
      ).catch(() => null);

      const ticks = Math.round(variantSeconds * (1000 / 150));
      const samples = [];
      for (let index = 0; index < ticks; index += 1) {
        samples.push(await samplePlayer(playerPage).catch(error => ({ error: error.message })));
        await delay(150);
      }
      const summary = summarizeVariant(variant, samples);
      summary.presenting = Boolean(presented);
      report.results.push(summary);
      console.log('[occlusion]', JSON.stringify(summary));
      await setAnime4k(playerPage, false);
      await setVariantCss(playerPage, '');
    }

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n[occlusion] summary');
    for (const item of report.results) {
      console.log(`${item.id.padEnd(20)} rate=${String(item.playbackRate).padEnd(6)} stalls=${String(item.stallsOver250ms).padEnd(3)} maxStall=${String(item.maxStallMs).padEnd(6)} decoded=${String(item.decodedFrames).padEnd(5)} cnnFrames=${String(item.cnnRenderedFrames).padEnd(5)} ${item.backendEnd}/${item.presetEnd}`);
    }
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
