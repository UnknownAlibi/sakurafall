const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CdpClient, waitFor } = require('./playback-e2e-smoke');
const { stopProcessTree } = require('./audit-process-tree');

async function main() {
  const executable = path.resolve(process.argv[2]);
  const durationMs = Math.max(5000, Number(process.argv.find(arg => arg.startsWith('--duration='))?.split('=')[1]) || 5000);
  const seed = JSON.parse(fs.readFileSync('artifacts/catalog-snapshot-audit.json', 'utf8')).diskFirstImport.database;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-scheduling-'));
  fs.copyFileSync(seed, path.join(userData, 'anime.db'));
  const marker = `--smoke-user-data=${userData}`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const offline = !process.argv.includes('--online');
  const args = [marker, '--remote-debugging-port=9268'];
  if (offline) args.push('--smoke-offline');
  if (process.argv.includes('--no-sandbox')) args.push('--no-sandbox');
  const child = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' });
  let page;
  let server;
  const report = { passed: false, executable, offline, noSandbox: args.includes('--no-sandbox') };
  const output = path.resolve(`artifacts/catalog-scheduling-${offline ? 'offline' : 'online'}.json`);
  try {
    const target = await waitFor(async () => {
      try { return (await (await fetch('http://127.0.0.1:9268/json/list')).json()).find(item => item.type === 'page'); }
      catch (_) { return false; }
    }, 'packaged main window', 30000, 100);
    page = new CdpClient(target.webSocketDebuggerUrl);
    await page.connect();
    await page.send('Runtime.enable');
    await waitFor(() => page.evaluate('Boolean(window.electronAPI?.subjectIndexQuery)'), 'preload', 15000, 100);
    await waitFor(() => page.evaluate(`Array.from(document.querySelectorAll('button')).some(item=>item.textContent.trim()==='开始使用')`), 'first-run guide', 15000, 100);
    const button = await page.evaluate(`(() => { const r=Array.from(document.querySelectorAll('button')).find(item=>item.textContent.trim()==='开始使用').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', clickCount: 1 });
    await waitFor(() => page.evaluate(`!Array.from(document.querySelectorAll('button')).some(item=>item.textContent.trim()==='开始使用')`), 'guide dismissed', 5000, 100);
    const source = fs.readFileSync('src/renderer/views/AnimeZone.vue', 'utf8');
    const tags = [...new Set([...source.matchAll(/mode:\s*'browse',\s*tag:\s*'([^']+)'/g)].map(match => match[1]))];
    report.filters = await page.evaluate(`(async () => {
      const cases = [{}, ...${JSON.stringify(tags)}.map(tag => ({tag})),
        ...['日本','中国','欧美','韩国'].map(tag => ({tag})),
        ...['TV','OVA','剧场版','WEB'].map(platform => ({platform}))];
      const output = [];
      for (const filters of cases) {
        const rows = [];
        for (const sort of ['latest','rating','rank']) {
          const start = performance.now();
          const result = await window.electronAPI.subjectIndexQuery({...filters,sort,releasedOnly:true});
          rows.push({sort,total:result.total,ms:performance.now()-start});
        }
        output.push({filters,rows});
      }
      return output;
    })()`);
    for (const entry of report.filters) assert.ok(entry.rows.every(row => row.total === entry.rows[0].total), 'sort changed total');
    report.love = await page.evaluate(`(async () => {
      const items = [];
      let first;
      for (let page = 1; ; page++) {
        const result = await window.electronAPI.subjectIndexQuery({tag:'恋爱',sort:'latest',releasedOnly:true,pageSize:50,page});
        first ||= result;
        if(result.catalogVersion !== first.catalogVersion) throw new Error('version changed');
        items.push(...result.data.map(item => ({id:item.id,date:item.airDate})));
        if (page >= result.totalPages) break;
      }
      return {items,total:first.total,version:first.catalogVersion};
    })()`);
    assert.equal(report.love.items.length, report.love.total);
    assert.equal(new Set(report.love.items.map(item => item.id)).size, report.love.total);
    const dated = report.love.items.filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date));
    assert.ok(dated.every((item, index) => !index || dated[index - 1].date >= item.date), 'latest dates are not monotonic');
    await waitFor(() => page.evaluate('Boolean(document.querySelector(".bangumi-type-chip"))'), 'catalog toolbar', 20000, 100);
    const started = Date.now();
    await page.evaluate(`(() => {
      const click = (selector, name) => Array.from(document.querySelectorAll(selector)).find(item => item.textContent.trim()===name)?.click();
      click('.bangumi-type-chip','恋爱');
      click('.toolbar-chip','最新上映');
    })()`);
    const firstId = report.love.items[0].id;
    await waitFor(() => page.evaluate(`Boolean(document.querySelector('.anime-card[data-anime-id="${firstId}"]')) && !document.querySelector('.anime-loading-stage,.anime-card.skeleton')`), 'love latest first card', 20000, 100);
    report.filterReadyMs = Date.now() - started;
    report.scroll = await page.evaluate(`(() => new Promise(resolve => {
      const root = document.querySelector('.main-content');
      const expected = ${JSON.stringify(report.love.items.map(item => item.id))};
      const positions = new Map(expected.map((id,index)=>[id,index]));
      const samples = [], mismatches = [];
      let first=0,last=0,highest=0;
      const frame = time => {
        if (!first) first=time;
        if(last) samples.push(time-last);
        last=time;
        root.scrollTop += 16;
        const visible=Array.from(document.querySelectorAll('.anime-card[data-anime-id]')).map(item=>positions.get(item.dataset.animeId));
        if(visible.some((value,index)=>value===undefined || (index && value<=visible[index-1]))) mismatches.push(time-first);
        highest=Math.max(highest,...visible.filter(Number.isFinite));
        if(time-first<${durationMs}) return requestAnimationFrame(frame);
        samples.sort((a,b)=>a-b);
        const at=p=>samples[Math.min(samples.length-1,Math.floor(samples.length*p))];
        resolve({durationMs:${durationMs},frames:samples.length,p95Ms:at(.95),p99Ms:at(.99),maxMs:at(1),highestItem:highest,mismatches:mismatches.length});
      };
      requestAnimationFrame(frame);
    }))()`);
    assert.equal(report.scroll.mismatches, 0);
    assert.ok(report.scroll.highestItem >= 48, 'UI did not scroll past two pages');
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`artifacts/catalog-scheduling-${offline ? 'offline' : 'online'}.png`, Buffer.from(screenshot.data, 'base64'));
    report.covers = await page.evaluate(`(() => {
      const images=Array.from(document.querySelectorAll('.anime-card img'));
      const loaded=images.filter(img=>img.complete && img.naturalWidth>1);
      return {rendered:images.length,loaded:loaded.length,sources:loaded.map(img=>({src:img.currentSrc,width:img.naturalWidth,height:img.naturalHeight}))};
    })()`);
    if (offline) assert.equal(report.covers.loaded, 0, 'cold offline profile fetched remote covers');
    if (!offline) {
      await new Promise(resolve => setTimeout(resolve, 12000));
      report.coversAfterIdle = await page.evaluate(`(() => {
        const images=Array.from(document.querySelectorAll('.anime-card img')).filter(img=>{
          const r=img.getBoundingClientRect();return r.bottom>110 && r.top<innerHeight;
        });
        return {visible:images.length,loaded:images.filter(img=>img.complete && img.naturalWidth>1).length};
      })()`);
      const idleShot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync('artifacts/catalog-scheduling-online-idle.png', Buffer.from(idleShot.data, 'base64'));
    }

    let requestCount = 0;
    let response;
    // Let the real scroll-idle notification settle before exercising explicit
    // pressure control; otherwise it legitimately replaces the injected state.
    await new Promise(resolve => setTimeout(resolve, 1000));
    server = http.createServer((_request, res) => { requestCount++; response = res; });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/shared.png`;
    await page.evaluate(`window.electronAPI.imageCacheSetPressure(true)`);
    await page.evaluate(`window.coverA=window.electronAPI.imageCacheGetCover(${JSON.stringify(url)},{requestId:'accept-a',priority:'prefetch'});undefined`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(requestCount, 0, 'background cover started under foreground pressure');
    await page.evaluate(`window.coverB=window.electronAPI.imageCacheGetCover(${JSON.stringify(url)},{requestId:'accept-b',priority:'visible'});undefined`);
    await waitFor(() => response, 'shared cover request', 5000, 20);
    await page.evaluate(`window.electronAPI.imageCacheUpdateRequest('accept-a','cancel')`);
    const cancelled = await page.evaluate('window.coverA');
    assert.equal(cancelled.success, false);
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLXkAAAAASUVORK5CYII=', 'base64'));
    const retained = await page.evaluate('window.coverB');
    assert.equal(retained.success, true);
    assert.equal(requestCount, 1);
    await page.evaluate('window.electronAPI.imageCacheSetPressure(false)');
    report.sharedCover = { requestCount, pausedPrefetch: true, visibleResumedSharedWork: true, cancelled: !cancelled.success, retained: retained.success };
    report.passed = true;
    delete report.love.items;
    console.log(JSON.stringify({ ...report, filters: `${report.filters.length} filter cases` }, null, 2));
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    page?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await stopProcessTree({ rootPid: child.pid, executable, marker });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
