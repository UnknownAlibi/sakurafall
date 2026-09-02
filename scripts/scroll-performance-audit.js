// 番剧库列表滚动性能审计。
//
// 用「生产构建产物 + 未打包 Electron」运行，避免为了改一行 CSS 就重打 85MB 的
// app.asar。渲染层来自 dist/renderer（vite preview 提供），主进程就是工作区源码。
//
// 用法：
//   npx vite build
//   node scripts/scroll-performance-audit.js
//
// 环境变量：
//   SCROLL_DURATION_MS   采样时长（默认 3000）
//   SCROLL_STEP_PX       每帧滚动像素（默认 28）
//   SCROLL_ROUNDS        重复采样轮数（默认 2，取较好的一轮以排除冷启动噪声）

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');

const workspace = path.resolve(__dirname, '..');
const debugPort = Number(process.env.SAKURAFALL_SCROLL_PORT || 9241);
const debugUrl = `http://127.0.0.1:${debugPort}`;
const previewUrl = 'http://127.0.0.1:5173';
const outputPath = path.join(workspace, 'artifacts', 'scroll-performance-audit.json');
const DURATION_MS = Number(process.env.SCROLL_DURATION_MS || 3000);
const STEP_PX = Number(process.env.SCROLL_STEP_PX || 28);
const ROUNDS = Number(process.env.SCROLL_ROUNDS || 2);
const LONG_FRAME_MS = 32;
// 多档窗口尺寸对比，如 "1280x800,1920x1080,2560x1440"。光栅化面积与 overdraw
// 随分辨率乘性增长，单尺寸数据无法暴露这类成本。
const WINDOW_SIZES = (process.env.SCROLL_WINDOW_SIZES || '')
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean)
  .map(item => {
    const [width, height] = item.split('x').map(Number);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
  })
  .filter(Boolean);

let electronChild;
let previewChild;

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
}

function summarize(frames) {
  const sorted = frames.slice().sort((a, b) => a - b);
  const total = frames.reduce((sum, value) => sum + value, 0);
  const average = total / Math.max(1, frames.length);
  const longFrames = frames.filter(value => value > LONG_FRAME_MS).length;
  return {
    frames: frames.length,
    averageFrameMs: Math.round(average * 100) / 100,
    fps: Math.round((1000 / Math.max(0.001, average)) * 10) / 10,
    p50FrameMs: Math.round(percentile(sorted, 0.5) * 100) / 100,
    p95FrameMs: Math.round(percentile(sorted, 0.95) * 100) / 100,
    maxFrameMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    longFrameRatio: Math.round((longFrames / Math.max(1, frames.length)) * 1000) / 1000
  };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 用 CDP 派发真实的 mouseWheel 事件：滚动由输入管线驱动（走合成器），
// rAF 采样只负责记录主线程帧间隔。程序化改 scrollTop 只会测到主线程吞吐，
// 反映不出光栅化 / 合成阶段的成本。
function startSamplingExpression() {
  return `(() => {
    window.__frames = [];
    window.__sampling = true;
    let last = performance.now();
    function tick(now) {
      window.__frames.push(now - last);
      last = now;
      if (window.__sampling) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return true;
  })()`;
}

function stopSamplingExpression() {
  return `(() => {
    window.__sampling = false;
    const root = document.querySelector('.main-content');
    return {
      frames: window.__frames || [],
      cards: document.querySelectorAll('.anime-card').length,
      scrollHeight: root ? root.scrollHeight : 0,
      scrollTop: root ? Math.round(root.scrollTop) : 0,
      virtualized: !!document.querySelector('.anime-grid.virtual-grid')
    };
  })()`;
}

async function measureWithRealWheel(client) {
  const rootBox = await client.evaluate(`(() => {
    const root = document.querySelector('.main-content');
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!rootBox) throw new Error('no .main-content scroll root');

  await client.evaluate(`(() => { const root = document.querySelector('.main-content'); if (root) root.scrollTop = 0; })()`);
  await client.evaluate(startSamplingExpression());

  // 只在实际内容范围内滚动。滚到底之后继续派发 wheel 会变成空转，
  // 采样到的帧率虚高，完全掩盖真实的虚拟窗口重建成本。
  const geometry = await client.evaluate(`(() => {
    const root = document.querySelector('.main-content');
    return root ? { scrollHeight: root.scrollHeight, clientHeight: root.clientHeight } : null;
  })()`);
  const travel = Math.max(0, (geometry?.scrollHeight || 0) - (geometry?.clientHeight || 0));
  const maxSteps = Math.max(1, Math.floor(travel / STEP_PX));
  const wheelCount = Math.min(Math.max(1, Math.round(DURATION_MS / 16)), maxSteps);
  for (let index = 0; index < wheelCount; index += 1) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: rootBox.x,
      y: rootBox.y,
      deltaX: 0,
      deltaY: STEP_PX
    });
    await delay(16);
  }

  return client.evaluate(stopSamplingExpression());
}

// 番剧库是无限滚动的，冷启动时只有十几张卡片——这点数据量根本压不出卡顿。
// 先滚到底部反复触发翻页，把可视列表灌到足够规模再开始采样。
async function ensureCards(client, minCards) {
  const deadline = Date.now() + 150000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await client.evaluate(`document.querySelectorAll('.anime-card').length`).catch(() => 0);
    if (count >= minCards) return count;
    await client.evaluate(`(() => {
      const root = document.querySelector('.main-content');
      if (root) root.scrollTop = root.scrollHeight;
      return true;
    })()`).catch(() => {});
    await delay(1500);
  }
  console.log(`warn: only ${count} cards after timeout (wanted ${minCards})`);
  return count;
}

async function startPreview() {
  previewChild = spawn(
    'npx',
    ['vite', 'preview', '--port', '5173', '--strictPort', '--host', '127.0.0.1'],
    { cwd: workspace, stdio: 'ignore', shell: process.platform === 'win32' }
  );
  await waitFor(async () => {
    try {
      const response = await fetch(`${previewUrl}/index.html`);
      return response.ok;
    } catch (_error) {
      return false;
    }
  }, 'vite preview server', 60000, 700);
}

async function startElectron() {
  const packagedExe = process.env.SAKURAFALL_APP_EXE
    || path.join(workspace, 'dist-app', 'win-unpacked', 'SakuraFall.exe');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-scroll-audit-'));
  const usePackaged = process.env.SCROLL_AUDIT_PACKAGED === '1' && fs.existsSync(packagedExe);
  if (usePackaged) {
    // 打包版才是用户真正跑的东西：asar 解包、资源路径、预加载脚本都不同，
    // 未打包运行会低估实际开销。
    console.log(`target: packaged (${path.relative(workspace, packagedExe)})`);
    electronChild = spawn(packagedExe, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`], {
      cwd: path.dirname(packagedExe),
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    return waitForRendererTarget(userData);
  }
  console.log('target: unpackaged (vite preview + electron .)');
  const electronPath = require('electron');
  electronChild = spawn(
    electronPath,
    [workspace, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userData}`],
    { cwd: workspace, stdio: 'ignore', shell: process.platform === 'win32' }
  );
  return waitForRendererTarget(userData);
}

async function waitForRendererTarget(userData) {
  void userData;
  const target = await waitFor(async () => {
    const list = await fetch(`${debugUrl}/json/list`).then(response => (response.ok ? response.json() : [])).catch(() => []);
    return list.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'renderer devtools target', 90000, 800);
  return target;
}

function viewportExpression() {
  return `(() => {
    const grid = document.querySelector('.anime-grid');
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
    const dpr = window.devicePixelRatio;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr,
      physicalPixels: Math.round(window.innerWidth * dpr) + 'x' + Math.round(window.innerHeight * dpr),
      gridColumns: columns,
      cardsMounted: document.querySelectorAll('.anime-card').length
    };
  })()`;
}

async function resizeWindow(client, width, height) {
  // 用视口模拟代替真实窗口 resize：旧打包内置的 Electron 可能没有
  // Browser.getWindowForTarget，而 Emulation 域早在 Chromium 60+ 就可用。
  // 布局、媒体查询、光栅化面积都会按目标视口计算，足以暴露分辨率成本。
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 0,
    mobile: false
  });
  // 给虚拟网格的 resize 监听与重新测量留出时间
  await delay(900);
}

function cleanup() {
  try { electronChild?.kill(); } catch (_error) { /* ignore */ }
  try { previewChild?.kill(); } catch (_error) { /* ignore */ }
}

async function main() {
  const packaged = process.env.SCROLL_AUDIT_PACKAGED === '1';
  if (!packaged) await startPreview();
  const target = await startElectron();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Performance.enable');

  await waitFor(async () => {
    const value = await client.evaluate(`document.querySelectorAll('.anime-card').length`).catch(() => 0);
    return value > 0 ? value : 0;
  }, 'first anime cards', 90000, 900);
  const MIN_CARDS = Number(process.env.SCROLL_MIN_CARDS || 60);
  const cardCount = await ensureCards(client, MIN_CARDS);
  console.log(`cards mounted: ${cardCount}`);
  // 让刚挂载的封面解码/缓存落地，避免把加载抖动算进滚动帧率
  await delay(1500);

  const sizes = WINDOW_SIZES.length > 0 ? WINDOW_SIZES : [null];
  const sizeResults = [];
  for (const size of sizes) {
    if (size) {
      await resizeWindow(client, size.width, size.height);
      console.log(`\n=== window ${size.width}x${size.height} ===`);
    }
    const viewport = await client.evaluate(viewportExpression());
    console.log(`viewport ${viewport.innerWidth}x${viewport.innerHeight} dpr=${viewport.dpr} physical=${viewport.physicalPixels} cols=${viewport.gridColumns} cards=${viewport.cardsMounted}`);

    const rounds = [];
    for (let index = 0; index < ROUNDS; index += 1) {
      const raw = await measureWithRealWheel(client);
      if (raw?.error) throw new Error(raw.error);
      const stats = summarize(raw.frames);
      stats.cards = raw.cards;
      stats.virtualized = raw.virtualized;
      stats.scrollHeight = raw.scrollHeight;
      rounds.push(stats);
      console.log(`round ${index + 1}: fps=${stats.fps} avg=${stats.averageFrameMs}ms p95=${stats.p95FrameMs}ms max=${stats.maxFrameMs}ms long=${stats.longFrameRatio} cards=${stats.cards}`);
    }
    const averageFps = Math.round((rounds.reduce((sum, item) => sum + item.fps, 0) / rounds.length) * 10) / 10;
    sizeResults.push({ size, viewport, averageFps, rounds });
  }

  const overallBest = sizeResults
    .flatMap(result => result.rounds)
    .reduce((bestSoFar, item) => (item.fps > bestSoFar.fps ? item : bestSoFar));
  const overallAverage = Math.round(
    (sizeResults.reduce((sum, result) => sum + result.averageFps, 0) / sizeResults.length) * 10
  ) / 10;
  const report = {
    capturedAt: new Date().toISOString(),
    mode: packaged ? 'packaged app' : 'production-build + unpackaged electron',
    stepPx: STEP_PX,
    pxPerSecond: Math.round(STEP_PX * (1000 / 16)),
    durationMs: DURATION_MS,
    averageFps: overallAverage,
    best: overallBest,
    sizes: sizeResults
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n=== summary ===`);
  for (const result of sizeResults) {
    const label = result.size ? `${result.size.width}x${result.size.height}` : 'default';
    const physical = result.viewport.physicalPixels;
    console.log(`${label.padEnd(12)} logical=${result.viewport.innerWidth}x${result.viewport.innerHeight} physical=${physical.padEnd(10)} avg fps=${result.averageFps}`);
  }
  console.log(`overall avg fps=${overallAverage}`);
  console.log(`report: ${path.relative(workspace, outputPath)}`);
  client.close();
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch(error => {
    console.error(`scroll audit failed: ${error.message}`);
    cleanup();
    process.exit(1);
  });
