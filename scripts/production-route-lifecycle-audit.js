const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');

const execFileAsync = promisify(execFile);
const workspace = path.resolve(__dirname, '..');
const executable = path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
const outputPath = path.join(workspace, 'artifacts', 'production-route-lifecycle-audit.json');
const debugPort = Number(process.env.SAKURAFALL_LIFECYCLE_AUDIT_PORT || 9243);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-lifecycle-audit-'));
const userData = path.join(runRoot, 'user-data');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

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
      role = if ($item.CommandLine -match '--type=gpu-process') { 'gpu' } elseif ($item.CommandLine -match '--type=renderer') { 'renderer' } elseif ($item.CommandLine -match '--type=utility') { 'utility' } else { 'main' }
      workingSetMB = [math]::Round($process.WorkingSet64 / 1MB, 2)
      privateMB = [math]::Round($process.PrivateMemorySize64 / 1MB, 2)
    }
  }
}
[pscustomobject]@{
  processCount = $rows.Count
  workingSetMB = [math]::Round(($rows | Measure-Object workingSetMB -Sum).Sum, 2)
  privateMB = [math]::Round(($rows | Measure-Object privateMB -Sum).Sum, 2)
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

async function collectGarbage(page) {
  await page.send('HeapProfiler.enable');
  await page.send('HeapProfiler.collectGarbage');
  await delay(800);
}

async function checkpoint(page, name, cycle) {
  const [heap, dom, system, ui, detached] = await Promise.all([
    page.send('Runtime.getHeapUsage'),
    page.send('Memory.getDOMCounters'),
    sampleProcesses(),
    page.evaluate(`(() => ({
      route: location.hash,
      attachedDomNodes: document.querySelectorAll('*').length,
      cards: document.querySelectorAll('.anime-card:not(.skeleton)').length,
      images: document.images.length,
      loadedImages: Array.from(document.images).filter(image => image.complete && image.naturalWidth > 0).length
    }))()`),
    page.send('DOM.getDetachedDomNodes').catch(() => ({ detachedNodes: [] }))
  ]);
  const detachedRoots = (detached.detachedNodes || []).map(item => {
    const node = item.treeNode || {};
    const attributes = Array.isArray(node.attributes) ? node.attributes : [];
    const attr = name => {
      const index = attributes.indexOf(name);
      return index >= 0 ? attributes[index + 1] : '';
    };
    return {
      nodeName: node.nodeName || '',
      className: attr('class'),
      id: attr('id'),
      childNodeCount: node.childNodeCount || 0,
      retainedNodeCount: Array.isArray(item.retainedNodeIds) ? item.retainedNodeIds.length : 0
    };
  });
  return {
    name,
    cycle,
    jsHeapUsedMB: Number((heap.usedSize / 1024 / 1024).toFixed(2)),
    jsHeapTotalMB: Number((heap.totalSize / 1024 / 1024).toFixed(2)),
    documents: dom.documents,
    domNodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners,
    detachedRootCount: detachedRoots.length,
    detachedRoots: detachedRoots.slice(0, 40),
    system,
    ui
  };
}

async function navigate(page, route, selector) {
  const startedAt = Date.now();
  await page.evaluate(`location.hash = ${JSON.stringify(route)}`);
  await waitFor(
    () => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),
    route,
    45000,
    150
  );
  return Date.now() - startedAt;
}

async function waitForCatalog(page) {
  await waitFor(
    () => page.evaluate(`document.querySelectorAll('.anime-card:not(.skeleton)').length >= 6`),
    'catalog cards',
    60000,
    200
  );
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

function growth(after, before) {
  return {
    jsHeapUsedMB: Number((after.jsHeapUsedMB - before.jsHeapUsedMB).toFixed(2)),
    domNodes: after.domNodes - before.domNodes,
    attachedDomNodes: after.ui.attachedDomNodes - before.ui.attachedDomNodes,
    jsEventListeners: after.jsEventListeners - before.jsEventListeners,
    workingSetMB: Number((after.system.workingSetMB - before.system.workingSetMB).toFixed(2)),
    privateMB: Number((after.system.privateMB - before.system.privateMB).toFixed(2))
  };
}

async function main() {
  if (!fs.existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  const seededDatabase = seedDatabase();
  const child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    `--smoke-user-data=${userData}`
  ], {
    cwd: path.dirname(executable),
    windowsHide: false,
    stdio: 'ignore'
  });

  let page;
  try {
    await waitFor(async () => {
      try { return (await fetchTargets()).find(item => item.type === 'page'); } catch (_) { return null; }
    }, 'packaged DevTools endpoint', 30000, 150);

    const target = (await fetchTargets()).find(item => item.type === 'page');
    page = new CdpClient(target.webSocketDebuggerUrl);
    await page.connect();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('DOM.enable');
    await waitFor(() => page.evaluate(`Boolean(document.querySelector('.anime-zone'))`), 'anime zone', 30000, 150);
    await waitForCatalog(page);

    // One complete route cycle warms settings/theme caches before the baseline.
    await navigate(page, '#/settings', '.settings');
    await delay(800);
    await navigate(page, '#/anime-zone', '.anime-zone');
    await waitForCatalog(page);
    await delay(2500);
    await collectGarbage(page);

    const report = {
      executable,
      seededDatabase,
      pid: child.pid,
      checkpoints: [],
      routeTimings: [],
      growth: {},
      verdict: {}
    };
    report.checkpoints.push(await checkpoint(page, 'warm-baseline', 0));

    for (let cycle = 1; cycle <= 6; cycle += 1) {
      const settingsMs = await navigate(page, '#/settings', '.settings');
      await delay(450);
      const catalogMs = await navigate(page, '#/anime-zone', '.anime-zone');
      await waitForCatalog(page);
      await delay(1400);
      await collectGarbage(page);
      report.routeTimings.push({ cycle, settingsMs, catalogMs });
      report.checkpoints.push(await checkpoint(page, `after-cycle-${cycle}`, cycle));
    }

    const first = report.checkpoints[0];
    const last = report.checkpoints.at(-1);
    report.growth = growth(last, first);
    report.verdict = {
      detachedDomBounded: report.growth.domNodes <= 300,
      listenersBounded: report.growth.jsEventListeners <= 80,
      heapBounded: report.growth.jsHeapUsedMB <= 8,
      attachedDomStable: Math.abs(report.growth.attachedDomNodes) <= 80
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ success: true, outputPath, growth: report.growth, verdict: report.verdict }, null, 2));
  } finally {
    page?.close();
    await stopApp();
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch(async error => {
  console.error(error.stack || error.message);
  await stopApp();
  try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(1);
});
