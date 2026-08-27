const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');

const execFileAsync = promisify(execFile);
const workspace = path.resolve(__dirname, '..');
const executable = path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const outputPath = path.join(workspace, 'artifacts', 'production-performance-audit.json');
const logPath = path.join(workspace, 'artifacts', 'production-performance-audit.log');
const debugPort = Number(process.env.SAKURAFALL_AUDIT_PORT || 9237);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-production-audit-'));
const userData = path.join(runRoot, 'user-data');
const auditStartedAt = Date.now();
let launchedAt = 0;
let child;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString()} pid=${process.pid} ${message}\n`, 'utf8');
}

function seedProductionDatabase() {
  const source = path.join(workspace, 'anime.db');
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(userData, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${source}${suffix}`;
    if (fs.existsSync(candidate)) fs.copyFileSync(candidate, path.join(userData, `anime.db${suffix}`));
  }
  return true;
}

async function fetchTargets() {
  const response = await fetch(`${debugUrl}/json/list`);
  if (!response.ok) throw new Error(`DevTools target request failed: HTTP ${response.status}`);
  return response.json();
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function samplePackagedProcesses() {
  const script = `
$targetPath = ${powershellLiteral(executable)}
$matches = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $targetPath })
$rows = @()
foreach ($item in $matches) {
  $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    $rows += [pscustomobject]@{
      pid = $process.Id
      name = $process.ProcessName
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
  const [heap, dom, performance] = await Promise.all([
    page.send('Runtime.getHeapUsage'),
    page.send('Memory.getDOMCounters'),
    page.send('Performance.getMetrics')
  ]);
  const metricMap = Object.fromEntries((performance.metrics || []).map(item => [item.name, item.value]));
  return {
    jsHeapUsedMB: Number((heap.usedSize / 1024 / 1024).toFixed(2)),
    jsHeapTotalMB: Number((heap.totalSize / 1024 / 1024).toFixed(2)),
    documents: dom.documents,
    domNodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners,
    taskDurationMs: Number(((metricMap.TaskDuration || 0) * 1000).toFixed(1)),
    scriptDurationMs: Number(((metricMap.ScriptDuration || 0) * 1000).toFixed(1)),
    layoutDurationMs: Number(((metricMap.LayoutDuration || 0) * 1000).toFixed(1)),
    layouts: metricMap.LayoutCount || 0,
    styleRecalculations: metricMap.RecalcStyleCount || 0
  };
}

async function checkpoint(page, name) {
  return {
    name,
    elapsedMs: Date.now() - launchedAt,
    system: await samplePackagedProcesses(),
    renderer: await rendererMetrics(page),
    ui: await page.evaluate(`(() => ({
      route: location.hash,
      attachedDomNodes: document.querySelectorAll('*').length,
      cards: document.querySelectorAll('.anime-card:not(.skeleton)').length,
      images: document.images.length,
      loadedImages: Array.from(document.images).filter(image => image.complete && image.naturalWidth > 0).length,
      loading: Boolean(document.querySelector('.anime-loading-stage, .anime-card.skeleton')),
      detailOpen: Boolean(document.querySelector('.anime-detail-modal'))
    }))()`)
  };
}

async function measureScroll(page) {
  return page.evaluate(`(() => new Promise(resolve => {
    const root = document.querySelector('.main-content');
    if (!root) return resolve({ error: 'missing scroll root' });
    root.scrollTop = 0;
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
    const samples = [];
    const durationMs = 1800;
    let startedAt = 0;
    let previous = 0;
    const step = now => {
      if (!startedAt) {
        startedAt = now;
        previous = now;
      } else {
        samples.push(now - previous);
        previous = now;
      }
      const phase = Math.min(1, (now - startedAt) / durationMs);
      root.scrollTop = Math.round(maxScroll * (0.5 - Math.cos(phase * Math.PI * 2) / 2));
      if (phase < 1) return requestAnimationFrame(step);
      const sorted = samples.slice().sort((a, b) => a - b);
      const percentile = value => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] || 0;
      resolve({
        frames: samples.length,
        averageMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
        p95Ms: percentile(0.95),
        maximumMs: Math.max(0, ...samples),
        longFrameRatio: samples.filter(value => value > 32).length / Math.max(1, samples.length),
        approximateFps: 1000 / (samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length)),
        maxScroll
      });
    };
    requestAnimationFrame(step);
  }))()`);
}

async function waitForCatalog(page) {
  await waitFor(
    () => page.evaluate(`document.querySelectorAll('.anime-card:not(.skeleton)').length >= 6`),
    'production catalog cards',
    60000,
    250
  );
}

async function navigate(page, route, selector) {
  const startedAt = Date.now();
  await page.evaluate(`location.hash = ${JSON.stringify(route)}`);
  await waitFor(() => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), route, 45000, 200);
  return Date.now() - startedAt;
}

async function stopApp() {
  const script = `
$targetPath = ${powershellLiteral(executable)}
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -eq $targetPath } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true
  }).catch(() => {});
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  fs.rmSync(logPath, { force: true });
  log('audit-start');
  const seededDatabase = seedProductionDatabase();
  log(`database-seeded=${seededDatabase}`);

  launchedAt = Date.now();
  child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--smoke-user-data=${userData}`
  ], {
    cwd: path.dirname(executable),
    windowsHide: false,
    stdio: 'ignore'
  });
  log(`launcher-started pid=${child.pid}`);

  await waitFor(async () => {
    try {
      return (await fetchTargets()).find(item => item.type === 'page');
    } catch (_) {
      return null;
    }
  }, 'packaged DevTools endpoint', 30000, 150);

  const target = (await fetchTargets()).find(item => item.type === 'page');
  log(`target-ready url=${target?.url || ''}`);
  const page = new CdpClient(target.webSocketDebuggerUrl);
  const report = {
    executable,
    launchedAt: new Date(launchedAt).toISOString(),
    setupDurationMs: launchedAt - auditStartedAt,
    seededDatabase,
    startup: {},
    scroll: {},
    interactions: {},
    checkpoints: []
  };

  try {
    await page.connect();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Performance.enable');
    log('cdp-connected');
    await waitFor(() => page.evaluate(`Boolean(document.querySelector('.anime-zone'))`), 'anime zone', 30000, 150);
    report.startup.shellReadyMs = Date.now() - launchedAt;
    await waitForCatalog(page);
    report.startup.catalogReadyMs = Date.now() - launchedAt;
    log(`catalog-ready elapsed=${report.startup.catalogReadyMs}`);
    await delay(1500);
    report.checkpoints.push(await checkpoint(page, 'catalog-ready'));

    report.scroll.catalog = await measureScroll(page);
    await delay(1000);
    report.checkpoints.push(await checkpoint(page, 'after-catalog-scroll'));

    const catalogSignature = await page.evaluate(`Array.from(document.querySelectorAll('.anime-card:not(.skeleton)')).slice(0, 8).map(card => card.dataset.animeId || card.textContent.trim()).join('|')`);
    const filterStartedAt = Date.now();
    await page.evaluate(`(() => {
      const sorts = document.querySelectorAll('.toolbar-row .toolbar-chip');
      const types = document.querySelectorAll('.bangumi-type-chip');
      sorts[1]?.click();
      types[8]?.click();
    })()`);
    await waitFor(
      () => page.evaluate(`(() => {
        const loading = Boolean(document.querySelector('.anime-card.skeleton, .anime-loading-stage'));
        const signature = Array.from(document.querySelectorAll('.anime-card:not(.skeleton)')).slice(0, 8).map(card => card.dataset.animeId || card.textContent.trim()).join('|');
        return !loading && signature && signature !== ${JSON.stringify(catalogSignature)};
      })()`),
      'filter results',
      20000,
      100
    );
    await waitForCatalog(page);
    report.interactions.scoreTypeReadyMs = Date.now() - filterStartedAt;
    await delay(1200);
    report.checkpoints.push(await checkpoint(page, 'after-score-type-filter'));
    log('filter-complete');

    report.interactions.discoveryReadyMs = await navigate(page, '#/discovery', '.discovery-page');
    await waitFor(
      () => page.evaluate(`!document.querySelector('.discovery-page .anime-loading-stage')`),
      'discovery content',
      60000,
      250
    );
    report.scroll.discovery = await measureScroll(page);
    report.checkpoints.push(await checkpoint(page, 'discovery'));
    log('discovery-complete');

    const routeCycles = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const settingsMs = await navigate(page, '#/settings', '.settings');
      const catalogMs = await navigate(page, '#/anime-zone', '.anime-zone');
      await waitForCatalog(page);
      routeCycles.push({ settingsMs, catalogMs });
    }
    report.interactions.routeCycles = routeCycles;
    await delay(1500);
    report.checkpoints.push(await checkpoint(page, 'after-route-cycles'));
    log('route-cycles-complete');

    const detailStartedAt = Date.now();
    await page.evaluate(`document.querySelector('.anime-card:not(.skeleton)')?.click()`);
    await waitFor(() => page.evaluate(`Boolean(document.querySelector('.anime-detail-modal'))`), 'detail modal', 15000, 100);
    report.interactions.detailShellMs = Date.now() - detailStartedAt;
    await waitFor(() => page.evaluate(`!document.querySelector('.detail-loading-state')`), 'detail metadata', 30000, 200).catch(() => {});
    report.checkpoints.push(await checkpoint(page, 'detail-open'));
    log('detail-open');
    await page.evaluate(`document.querySelector('.anime-detail-modal .close-btn')?.click()`);
    await waitFor(() => page.evaluate(`!document.querySelector('.anime-detail-modal')`), 'detail close', 5000, 100);

    await delay(10000);
    report.checkpoints.push(await checkpoint(page, 'final-idle'));
    await page.send('HeapProfiler.enable');
    await page.send('HeapProfiler.collectGarbage');
    await delay(1200);
    report.checkpoints.push(await checkpoint(page, 'after-forced-gc'));
    const first = report.checkpoints[0];
    const finalIdle = report.checkpoints.find(item => item.name === 'final-idle');
    const final = report.checkpoints[report.checkpoints.length - 1];
    report.growth = {
      naturalIdle: {
        workingSetMB: Number((finalIdle.system.workingSetMB - first.system.workingSetMB).toFixed(2)),
        privateMB: Number((finalIdle.system.privateMB - first.system.privateMB).toFixed(2)),
        jsHeapUsedMB: Number((finalIdle.renderer.jsHeapUsedMB - first.renderer.jsHeapUsedMB).toFixed(2)),
        domNodes: finalIdle.renderer.domNodes - first.renderer.domNodes,
        attachedDomNodes: finalIdle.ui.attachedDomNodes - first.ui.attachedDomNodes,
        jsEventListeners: finalIdle.renderer.jsEventListeners - first.renderer.jsEventListeners
      },
      afterForcedGc: {
      workingSetMB: Number((final.system.workingSetMB - first.system.workingSetMB).toFixed(2)),
      privateMB: Number((final.system.privateMB - first.system.privateMB).toFixed(2)),
      jsHeapUsedMB: Number((final.renderer.jsHeapUsedMB - first.renderer.jsHeapUsedMB).toFixed(2)),
      domNodes: final.renderer.domNodes - first.renderer.domNodes,
      attachedDomNodes: final.ui.attachedDomNodes - first.ui.attachedDomNodes,
      jsEventListeners: final.renderer.jsEventListeners - first.renderer.jsEventListeners
      }
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    log('report-written');
    console.log(JSON.stringify({ success: true, outputPath, ...report }, null, 2));
  } finally {
    page.close();
    await stopApp();
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch(async error => {
  log(`audit-error ${error.stack || error.message}`);
  console.error(error.stack || error.message);
  await stopApp();
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
