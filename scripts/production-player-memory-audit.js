const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');
const { linearSlope, sampleProcessTree, stopProcessTree } = require('./audit-process-tree');

const workspace = path.resolve(__dirname, '..');
const executable = process.env.SAKURAFALL_AUDIT_EXECUTABLE
  || path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const outputPath = process.env.SAKURAFALL_MEMORY_AUDIT_OUTPUT
  || path.join(workspace, 'artifacts', 'production-player-memory-audit.json');
const debugPort = Number(process.env.SAKURAFALL_MEMORY_AUDIT_PORT || 9257);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const rounds = Math.max(10, Number(process.env.SAKURAFALL_MEMORY_AUDIT_ROUNDS) || 10);
const settleMs = Math.max(1200, Number(process.env.SAKURAFALL_MEMORY_AUDIT_SETTLE_MS) || 2500);
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-player-memory-'));
const userData = path.join(runRoot, 'user-data');
const logPath = path.join(runRoot, 'app.log');
const marker = `--smoke-user-data=${userData}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;

function seedDatabase() {
  const source = path.join(workspace, 'anime.db');
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(userData, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${source}${suffix}`;
    if (fs.existsSync(candidate)) fs.copyFileSync(candidate, path.join(userData, `anime.db${suffix}`));
  }
  return true;
}

function sanitizedEnvironment() {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}

async function fetchTargets() {
  const response = await fetch(`${debugUrl}/json/list`);
  if (!response.ok) throw new Error(`DevTools target request failed: HTTP ${response.status}`);
  return response.json();
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

async function collectGarbage(page) {
  await page.send('HeapProfiler.enable');
  await page.send('HeapProfiler.collectGarbage');
  await delay(500);
}

async function checkpoint(page, name) {
  return {
    name,
    at: new Date().toISOString(),
    system: await sampleProcessTree({ rootPid: child?.pid, executable, marker }),
    renderer: page ? await rendererMetrics(page) : null
  };
}

function delta(after, before) {
  const afterSystem = after.system || after;
  const beforeSystem = before.system || before;
  return {
    processCount: afterSystem.processCount - beforeSystem.processCount,
    workingSetMB: Number((afterSystem.workingSetMB - beforeSystem.workingSetMB).toFixed(2)),
    privateMB: Number((afterSystem.privateMB - beforeSystem.privateMB).toFixed(2)),
    rendererHeapMB: after.renderer && before.renderer
      ? Number((after.renderer.jsHeapUsedMB - before.renderer.jsHeapUsedMB).toFixed(2))
      : null
  };
}

async function setAnime4k(page, enabled) {
  return page.evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('.settings-toggle-row'))
      .find(item => item.textContent.includes('Anime4K'));
    const input = row?.querySelector('input[type="checkbox"]');
    if (!input) return false;
    if (input.checked !== ${Boolean(enabled)}) {
      input.checked = ${Boolean(enabled)};
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return input.checked === ${Boolean(enabled)};
  })()`, true);
}

function playerWindowCallExpression(body) {
  return `(() => {
    let node = document.querySelector('video.video-element')?.__vueParentComponent;
    while (node && !(node.proxy && typeof node.proxy.playEpisode === 'function')) node = node.parent;
    if (!node) return false;
    const proxy = node.proxy;
    ${body}
    return true;
  })()`;
}

async function openPlayer(mainPage, mainTarget, payload, round) {
  const existingIds = new Set((await fetchTargets()).map(item => item.id));
  const result = await mainPage.evaluate(`window.electronAPI.openPlayerWindow(${JSON.stringify(payload)})`, true);
  if (!result?.success) throw new Error(`Round ${round}: player open failed: ${result?.error || 'unknown'}`);
  const target = await waitFor(async () => {
    const list = await fetchTargets();
    return list.find(item => item.type === 'page' && item.id !== mainTarget.id
      && !existingIds.has(item.id) && item.url.includes('player-window'));
  }, `round ${round} player target`, 20000, 100);
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await waitFor(() => page.evaluate(`(() => {
    const video = document.querySelector('video.video-element');
    if (!video || video.error || video.readyState < 2 || !video.videoWidth) return false;
    video.loop = true;
    video.muted = true;
    video.play().catch(() => {});
    return true;
  })()`), `round ${round} decoded video`, 15000, 100);
  return { page, target };
}

async function runRound({ mainPage, mainTarget, payload, round, mode }) {
  const before = await checkpoint(mainPage, `round-${round}-before`);
  const { page, target } = await openPlayer(mainPage, mainTarget, payload, round);
  let runtime = { mode, anime4kRequested: false, anime4kActive: false };
  try {
    await setAnime4k(page, false).catch(() => false);
    if (mode !== 'normal') {
      runtime.anime4kRequested = await setAnime4k(page, true).catch(() => false);
      if (mode === 'initializing-close') {
        await delay(75);
      } else {
        runtime.anime4kActive = await waitFor(() => page.evaluate(`(() => {
          const canvas = document.querySelector('.anime4k-canvas');
          const state = JSON.parse(canvas?.dataset.anime4kRuntime || '{}');
          return Boolean(state.active || state.presenting);
        })()`, true), `round ${round} Anime4K active`, 12000, 150).catch(() => false);
        if (mode === 'source-switch') {
          await page.evaluate(playerWindowCallExpression(`
            const list = Array.isArray(proxy.currentLineEpisodes) ? proxy.currentLineEpisodes : [];
            if (list[1]) proxy.playEpisode(list[1]);
          `), true).catch(() => false);
          await delay(1200);
        } else {
          await delay(1800);
        }
      }
    } else {
      await delay(1400);
    }
    runtime.beforeClose = await page.evaluate(`(() => {
      const video = document.querySelector('video.video-element');
      const canvas = document.querySelector('.anime4k-canvas');
      return {
        currentTime: Number(video?.currentTime) || 0,
        readyState: Number(video?.readyState) || 0,
        anime4k: JSON.parse(canvas?.dataset.anime4kRuntime || '{}')
      };
    })()`, true).catch(() => null);
  } finally {
    await page.evaluate(`window.electronAPI.closeWindow()`, true).catch(() => {});
    await waitFor(async () => !(await fetchTargets()).some(item => item.id === target.id),
      `round ${round} player cleanup`, 10000, 120);
    page.close();
  }
  await delay(settleMs);
  await collectGarbage(mainPage);
  const after = await checkpoint(mainPage, `round-${round}-after`);
  const remainingPlayerTargets = (await fetchTargets())
    .filter(item => item.type === 'page' && item.url.includes('player-window')).length;
  return { round, mode, runtime, before, after, remainingPlayerTargets };
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  const sampleVideo = path.join(workspace, 'splash-sample.mp4');
  if (!fs.existsSync(sampleVideo)) throw new Error(`Local sample video not found: ${sampleVideo}`);
  const secondVideo = path.join(workspace, 'artifacts', 'media-samples', '720p-24fps.mp4');
  const urls = [sampleVideo, fs.existsSync(secondVideo) ? secondVideo : sampleVideo]
    .map(file => pathToFileURL(file).href);
  const episodes = urls.map((url, index) => ({
    id: `memory-audit-${index + 1}`,
    title: `Memory audit episode ${index + 1}`,
    index,
    lineId: 'local',
    url
  }));
  const payload = {
    title: 'SakuraFall player memory audit',
    url: episodes[0].url,
    anime: {
      id: 'memory-audit',
      name: 'SakuraFall player memory audit',
      source: 'local-audit',
      sourceName: 'Local audit',
      sourceType: 'local',
      episodes: { local: episodes }
    },
    episode: episodes[0],
    episodeId: episodes[0].id,
    lineId: 'local'
  };

  const seededDatabase = seedDatabase();
  const args = [`--remote-debugging-port=${debugPort}`, marker];
  if (process.env.SAKURAFALL_AUDIT_NO_SANDBOX === '1') args.push('--no-sandbox');
  child = spawn(executable, args, {
    cwd: path.dirname(executable),
    windowsHide: true,
    env: sanitizedEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  let mainPage;
  try {
    await waitFor(async () => {
      try { return (await fetchTargets()).find(item => item.type === 'page'); } catch (_) { return null; }
    }, 'packaged app DevTools endpoint', 30000, 150);
    const mainTarget = (await fetchTargets()).find(item => item.type === 'page');
    mainPage = new CdpClient(mainTarget.webSocketDebuggerUrl);
    await mainPage.connect();
    await mainPage.send('Runtime.enable');
    await waitFor(() => mainPage.evaluate(`Boolean(window.electronAPI?.openPlayerWindow)`),
      'main preload API', 20000, 100);
    await delay(2000);
    await collectGarbage(mainPage);

    const report = {
      generatedAt: new Date().toISOString(),
      executable,
      rootPid: child.pid,
      seededDatabase,
      rounds,
      settleMs,
      coldBaseline: await checkpoint(mainPage, 'cold-baseline'),
      cycles: [],
      verdict: {}
    };
    const modes = ['normal', 'initializing-close', 'anime4k-active', 'source-switch'];
    for (let round = 1; round <= rounds; round += 1) {
      const mode = modes[(round - 1) % modes.length];
      const cycle = await runRound({ mainPage, mainTarget, payload, round, mode });
      report.cycles.push(cycle);
      process.stdout.write(`[memory-audit] ${round}/${rounds} ${mode}: ${cycle.after.system.privateMB} MB private\n`);
    }

    report.hotBaseline = report.cycles[0].after;
    report.final = report.cycles.at(-1).after;
    report.coldDelta = delta(report.final, report.coldBaseline);
    report.hotDelta = delta(report.final, report.hotBaseline);
    const tail = report.cycles.slice(-5);
    report.tail = {
      rounds: tail.map(item => item.round),
      privateMB: tail.map(item => item.after.system.privateMB),
      workingSetMB: tail.map(item => item.after.system.workingSetMB),
      rendererHeapMB: tail.map(item => item.after.renderer.jsHeapUsedMB),
      privateSlopeMBPerRound: linearSlope(tail.map(item => item.after.system.privateMB)),
      workingSetSlopeMBPerRound: linearSlope(tail.map(item => item.after.system.workingSetMB)),
      rendererHeapSlopeMBPerRound: linearSlope(tail.map(item => item.after.renderer.jsHeapUsedMB))
    };
    const baselineRenderers = Number(report.hotBaseline.system.roles.renderer?.count) || 0;
    report.verdict = {
      everyPlayerTargetReleased: report.cycles.every(item => item.remainingPlayerTargets === 0),
      rendererProcessesReturnToBaseline: report.cycles.every(item =>
        (Number(item.after.system.roles.renderer?.count) || 0) <= baselineRenderers),
      coldWorkingSetWithinBudget: report.coldDelta.workingSetMB < 280,
      hotPrivateGrowthWithinBudget: report.hotDelta.privateMB < 50,
      tailPrivateMemoryStable: report.tail.privateSlopeMBPerRound <= 5,
      tailRendererHeapStable: report.tail.rendererHeapSlopeMBPerRound <= 1
    };
    report.passed = Object.values(report.verdict).every(Boolean);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({
      outputPath,
      passed: report.passed,
      coldDelta: report.coldDelta,
      hotDelta: report.hotDelta,
      tail: report.tail,
      verdict: report.verdict
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    mainPage?.close();
    await stopProcessTree({ rootPid: child?.pid, executable, marker });
    log.end();
    await delay(500);
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* profile may still be releasing */ }
  }
}

if (require.main === module) {
  main().catch(async error => {
    console.error(error.stack || error.message);
    await stopProcessTree({ rootPid: child?.pid, executable, marker });
    try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    process.exit(1);
  });
}

module.exports = { delta, linearSlope };
