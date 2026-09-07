const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');
const { stopProcessTree } = require('./audit-process-tree');

async function main() {
  const executable = path.resolve(process.argv[2]);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-pressure-'));
  const marker = `--smoke-user-data=${userData}`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const args = [marker, '--remote-debugging-port=9267'];
  if (process.env.SAKURAFALL_AUDIT_NO_SANDBOX === '1') args.push('--no-sandbox');
  const child = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' });
  let page;
  try {
    const targets = async () => (await fetch('http://127.0.0.1:9267/json/list')).json();
    const target = await waitFor(async () => {
      try { return (await targets()).find(item => item.type === 'page'); } catch (_) { return false; }
    }, 'main window', 30000, 100);
    page = new CdpClient(target.webSocketDebuggerUrl);
    await page.connect();
    await page.send('Runtime.enable');
    await waitFor(() => page.evaluate('Boolean(window.electronAPI?.getBackgroundPlaybackPressure)'), 'pressure API', 15000, 100);
    const initial = await page.evaluate('window.electronAPI.getBackgroundPlaybackPressure()', true);
    if (initial) throw new Error('Unexpected initial playback pressure');
    await page.evaluate('window.pressureEvents=[];window.electronAPI.onBackgroundPlaybackPressure(active=>window.pressureEvents.push(active))');
    const payload = { title: 'Pressure smoke', url: pathToFileURL(path.resolve('splash-sample.mp4')).href };
    const opened = await page.evaluate(`window.electronAPI.openPlayerWindow(${JSON.stringify(payload)})`, true);
    if (!opened?.success) throw new Error('Player failed to open');
    await waitFor(() => page.evaluate('window.pressureEvents.includes(true)'), 'active pressure', 10000, 100);
    const player = await waitFor(async () => (await targets()).find(item => item.url.includes('player-window')), 'player target', 15000, 100);
    const playerPage = new CdpClient(player.webSocketDebuggerUrl);
    await playerPage.connect();
    await waitFor(() => playerPage.evaluate('Boolean(window.electronAPI?.closeWindow)'), 'player preload', 15000, 100);
    await Promise.race([
      playerPage.evaluate('window.electronAPI.closeWindow()', true).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 1000))
    ]);
    playerPage.close();
    await waitFor(() => page.evaluate('window.pressureEvents.at(-1)===false'), 'pressure released', 10000, 100);
    console.log(JSON.stringify({ passed: true, events: await page.evaluate('window.pressureEvents'), noSandbox: args.includes('--no-sandbox') }));
  } finally {
    page?.close();
    await stopProcessTree({ rootPid: child.pid, executable, marker });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
