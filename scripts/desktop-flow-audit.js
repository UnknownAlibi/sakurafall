const fs = require('fs');
const path = require('path');
const { CdpClient, targets, waitFor } = require('./playback-e2e-smoke');

const DEBUG_URL = process.env.SAKURAFALL_DEBUG_URL || 'http://127.0.0.1:9223';
const OUTPUT_DIR = process.argv[2] || path.join(process.cwd(), 'artifacts');

async function navigate(page, route, readySelector) {
  await page.evaluate(`location.hash = ${JSON.stringify(route)}`);
  await waitFor(
    () => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(readySelector)}))`),
    `${route} route`,
    45000
  );
}

async function capture(page, name) {
  const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
  const output = path.join(OUTPUT_DIR, name);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
  return output;
}

async function measureScroll(page) {
  return page.evaluate(`(() => new Promise(resolve => {
    const root = document.querySelector('.main-content');
    if (!root) return resolve({ error: 'missing scroll root' });
    root.scrollTop = 0;
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
    const samples = [];
    const durationMs = 1400;
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
      const elapsed = now - startedAt;
      const phase = Math.min(1, elapsed / durationMs);
      root.scrollTop = Math.round(maxScroll * (0.5 - Math.cos(phase * Math.PI * 2) / 2));
      if (phase < 1) return requestAnimationFrame(step);
      const longFrames = samples.filter(value => value > 32);
      const sorted = samples.slice().sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
      resolve({
        frames: samples.length,
        averageMs: samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length),
        p95Ms: p95,
        maximumMs: Math.max(0, ...samples),
        longFrameRatio: longFrames.length / Math.max(1, samples.length),
        maxScroll
      });
    };
    requestAnimationFrame(step);
  }))()`);
}

async function main() {
  const target = (await targets()).find(item => (
    item.type === 'page'
    && item.url.startsWith('http://localhost:5173')
    && !item.url.includes('player-window')
  ));
  if (!target) throw new Error(`SakuraFall main target was not found at ${DEBUG_URL}`);

  const page = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await page.connect();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.bringToFront');

    await page.evaluate(`location.hash = '#/anime-zone'`);
    await waitFor(
      () => page.evaluate(`Boolean(document.querySelector('.anime-zone'))`),
      'catalog route before reload'
    );
    await page.send('Page.reload', { ignoreCache: false });
    await waitFor(
      () => page.evaluate(`Boolean(document.querySelector('.anime-zone'))`),
      'reloaded catalog route'
    );
    await waitFor(
      () => page.evaluate(`document.querySelectorAll('.anime-card:not(.skeleton)').length >= 6`),
      'catalog cards'
    );
    await new Promise(resolve => setTimeout(resolve, 1400));

    const catalog = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.anime-card:not(.skeleton)'));
      const images = cards.map(card => card.querySelector('img')).filter(Boolean);
      return {
        renderedCards: cards.length,
        loadedCovers: images.filter(image => image.complete && image.naturalWidth > 0).length,
        failedCovers: images.filter(image => image.complete && image.naturalWidth === 0).length,
        totalBadges: document.querySelectorAll('.anime-ep-total-badge').length,
        updatedBadges: document.querySelectorAll('.anime-ep-badge').length,
        syncedUpdatedBadges: document.querySelectorAll('.anime-ep-badge:not(.pending)').length,
        pendingUpdatedBadges: document.querySelectorAll('.anime-ep-badge.pending').length,
        firstEpisodeStatus: cards[0]?.querySelector('.anime-ep-badge')?.textContent.trim() || '',
        firstTitle: document.querySelector('.anime-title')?.textContent.trim() || '',
        footer: document.querySelector('.anime-infinite-footer')?.textContent.trim() || ''
      };
    })()`);
    const catalogScroll = await measureScroll(page);
    const catalogScreenshot = await capture(page, 'desktop-flow-catalog.png');

    const searchBefore = await page.evaluate(`(() => {
      const input = document.querySelector('.search-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '葬送的芙莉莲');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelector('.anime-title')?.textContent.trim() || '';
    })()`);
    await new Promise(resolve => setTimeout(resolve, 900));
    const searchDidNotAutoSubmit = await page.evaluate(`(() => ({
      firstTitle: document.querySelector('.anime-title')?.textContent.trim() || '',
      loading: Boolean(document.querySelector('.anime-loading-stage'))
    }))()`);
    const searchStartedAt = Date.now();
    await page.evaluate(`document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))`);
    await waitFor(
      () => page.evaluate(`Array.from(document.querySelectorAll('.anime-title')).some(item => item.textContent.trim() === '葬送的芙莉莲')`),
      'submitted search result'
    );
    const searchMs = Date.now() - searchStartedAt;

    const detailStartedAt = Date.now();
    await page.evaluate(`Array.from(document.querySelectorAll('.anime-card')).find(card => card.textContent.includes('葬送的芙莉莲'))?.click()`);
    await waitFor(
      () => page.evaluate(`Boolean(document.querySelector('.anime-detail-modal'))`),
      'detail modal'
    );
    const detailShellMs = Date.now() - detailStartedAt;
    const episodeStartedAt = Date.now();
    await page.evaluate(`Array.from(document.querySelectorAll('.bgm-tab')).find(tab => tab.textContent.includes('选集'))?.click()`);
    await waitFor(
      () => page.evaluate(`Boolean(document.querySelector('.episode-btn'))`),
      'episode selector',
      60000
    );
    const episodeReadyMs = Date.now() - episodeStartedAt;

    await navigate(page, '#/discovery', '.discovery-page');
    await waitFor(
      () => page.evaluate(`!document.querySelector('.discovery-page .anime-loading-stage')`),
      'discovery data',
      60000
    );
    await new Promise(resolve => setTimeout(resolve, 1200));
    const discovery = await page.evaluate(`(() => {
      const hotImages = Array.from(document.querySelectorAll('.hot-card img'));
      const scheduleImages = Array.from(document.querySelectorAll('.schedule-card img'));
      const loaded = images => images.filter(image => image.complete && image.naturalWidth > 0).length;
      return {
        hotCards: document.querySelectorAll('.hot-card').length,
        scheduleDays: document.querySelectorAll('.schedule-tab').length,
        scheduleCards: document.querySelectorAll('.schedule-card').length,
        hotCoversLoaded: loaded(hotImages),
        scheduleCoversLoaded: loaded(scheduleImages),
        placeholders: document.querySelectorAll('.hot-no-cover, .schedule-no-cover').length
      };
    })()`);
    const discoveryScroll = await measureScroll(page);
    const discoveryScreenshot = await capture(page, 'desktop-flow-discovery.png');

    const routes = [];
    for (const item of [
      ['#/my-favorites', '.my-favorites'],
      ['#/downloads', '.downloads'],
      ['#/source-manager', '.source-manager'],
      ['#/settings', '.settings']
    ]) {
      const startedAt = Date.now();
      await navigate(page, item[0], item[1]);
      routes.push({ route: item[0], readyMs: Date.now() - startedAt });
    }

    console.log(JSON.stringify({
      success: true,
      catalog,
      catalogScroll,
      catalogScreenshot,
      search: {
        beforeInputTitle: searchBefore,
        afterInputTitle: searchDidNotAutoSubmit.firstTitle,
        autoLoading: searchDidNotAutoSubmit.loading,
        submittedMs: searchMs
      },
      detailShellMs,
      episodeReadyMs,
      discovery,
      discoveryScroll,
      routes,
      discoveryScreenshot
    }, null, 2));
  } finally {
    page.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
