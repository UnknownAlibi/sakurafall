const { app, BrowserWindow } = require('electron');

const rendererUrl = process.env.SAKURAFALL_RENDERER_URL || 'http://127.0.0.1:5173/index.html';
const timeoutMs = 30000;

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  const timeout = setTimeout(() => {
    console.error('[WebGPU Smoke] timed out');
    app.exit(1);
  }, timeoutMs);

  try {
    await win.loadURL(rendererUrl);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const api = await import('/player/anime4kWebgpuClient.js');
      const source = document.createElement('canvas');
      source.width = 320;
      source.height = 180;
      const sourceContext = source.getContext('2d');
      sourceContext.fillStyle = '#101525';
      sourceContext.fillRect(0, 0, source.width, source.height);
      sourceContext.fillStyle = '#ff77aa';
      sourceContext.fillRect(32, 24, 120, 96);
      sourceContext.fillStyle = '#71d7ff';
      sourceContext.beginPath();
      sourceContext.arc(220, 90, 52, 0, Math.PI * 2);
      sourceContext.fill();

      const output = document.createElement('canvas');
      output.style.width = '640px';
      output.style.height = '360px';
      document.body.appendChild(output);

      let stats = null;
      let fatal = null;
      const client = await api.createAnime4kWebgpuPipeline(output, {
        preset: 'balanced',
        inputWidth: source.width,
        inputHeight: source.height,
        displayWidth: 640,
        displayHeight: 360,
        pixelRatio: 1,
        maxOutputEdge: 1920,
        onStats(value) { stats = value; },
        onFatal(error) { fatal = error.message; }
      });
      client.renderFrame(source, { mediaTime: 0 });
      const deadline = performance.now() + 15000;
      while (!stats && !fatal && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const firstFrame = stats;
      client.setDisplaySize(1920, 1080, 1);
      stats = null;
      sourceContext.fillStyle = '#ffffff';
      sourceContext.fillRect(144, 72, 32, 36);
      client.renderFrame(source, { mediaTime: 1 / 24 });
      const fullscreenDeadline = performance.now() + 15000;
      while (!stats && !fatal && performance.now() < fullscreenDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const report = {
        capabilities: api.getWebgpuAnime4kCapabilities(),
        profile: client.profile,
        firstFrame,
        fullscreenFrame: stats,
        fatal
      };
      client.dispose();
      return report;
    })()`, true);
    const passed = Object.values(result.capabilities).every(Boolean) &&
      result.firstFrame?.renderedFrames === 1 && result.fullscreenFrame?.renderedFrames === 2 && !result.fatal;
    console.log('[WebGPU Smoke]', JSON.stringify({ passed, ...result }, null, 2));
    clearTimeout(timeout);
    app.exit(passed ? 0 : 1);
  } catch (error) {
    clearTimeout(timeout);
    console.error('[WebGPU Smoke]', error);
    app.exit(1);
  }
}

app.whenReady().then(run).catch((error) => {
  console.error('[WebGPU Smoke]', error);
  app.exit(1);
});
