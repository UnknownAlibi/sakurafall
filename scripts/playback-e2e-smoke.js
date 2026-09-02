const fs = require('fs');
const path = require('path');

const DEBUG_URL = process.env.SAKURAFALL_DEBUG_URL || 'http://127.0.0.1:9223';
const TITLE = process.argv[2] || '葬送的芙莉莲';
const OUTPUT = process.argv[3] || path.join(process.cwd(), 'artifacts', 'playback-smoke.png');

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        const task = this.pending.get(message.id);
        if (!task) return;
        this.pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error.message));
        else task.resolve(message.result);
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, userGesture = false) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  close() {
    this.socket?.close();
  }
}

async function targets() {
  const response = await fetch(`${DEBUG_URL}/json/list`);
  if (!response.ok) throw new Error(`DevTools target request failed: HTTP ${response.status}`);
  return response.json();
}

async function waitFor(check, label, timeout = 45000, interval = 500) {
  const startedAt = Date.now();
  let latest;
  while (Date.now() - startedAt < timeout) {
    latest = await check();
    if (latest) return latest;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${label}. Last result: ${JSON.stringify(latest)}`);
}

function expressionForSearch(title) {
  return `(() => {
    const input = document.querySelector('.search-input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(title)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true
    }));
    return true;
  })()`;
}

function expressionForCardClick(title) {
  return `(() => {
    const cards = Array.from(document.querySelectorAll('.anime-card'));
    const card = cards.find(item => item.querySelector('.anime-title')?.textContent.trim() === ${JSON.stringify(title)})
      || cards.find(item => item.textContent.includes(${JSON.stringify(title)}));
    if (!card) return false;
    card.click();
    return true;
  })()`;
}

async function main() {
  let page;
  let player;
  const initialTargets = await targets();
  const pageTarget = initialTargets.find(item => item.type === 'page'
    && !item.url.includes('player-window')
    && (item.url.includes('/anime-zone') || item.url.includes('localhost:5173')));
  if (!pageTarget) throw new Error('SakuraFall anime-zone target was not found');

  try {
    page = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await page.connect();
    await page.send('Runtime.enable');

    const hasSearchInput = await page.evaluate(`!!document.querySelector('.search-input')`);
    if (!hasSearchInput) {
      const openedAnimeZone = await page.evaluate(`(() => {
        const items = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        const entry = items.find(item => /番剧库|番剧索引/.test(item.textContent || ''));
        if (!entry) return false;
        entry.click();
        return true;
      })()`, true);
      if (!openedAnimeZone) {
        const pageSummary = await page.evaluate(`({
          title: document.title,
          text: (document.body?.innerText || '').slice(0, 1200),
          controls: Array.from(document.querySelectorAll('a, button, [role="button"]')).slice(0, 30).map(item => item.textContent.trim())
        })`);
        throw new Error(`Anime-zone navigation was not found: ${JSON.stringify(pageSummary)}`);
      }
      await waitFor(
        () => page.evaluate(`!!document.querySelector('.search-input')`),
        'anime-zone search input',
        15000
      );
    }

    console.log(`[smoke] Searching for ${TITLE}`);
    if (!await page.evaluate(expressionForSearch(TITLE), true)) {
      throw new Error('Search input was not found');
    }

    await waitFor(
      () => page.evaluate(`Array.from(document.querySelectorAll('.anime-title')).some(item => item.textContent.trim() === ${JSON.stringify(TITLE)})`),
      `search result ${TITLE}`
    );
    if (!await page.evaluate(expressionForCardClick(TITLE), true)) {
      throw new Error(`Anime card was not found: ${TITLE}`);
    }

    console.log('[smoke] Opening the episode tab');
    await waitFor(
      () => page.evaluate(`document.querySelector('.anime-detail-modal')?.textContent.includes(${JSON.stringify(TITLE)}) || false`),
      'anime detail modal'
    );
    const clickedTab = await page.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('.bgm-tab')).find(item => item.textContent.includes('选集'));
      if (!tab) return false;
      tab.click();
      return true;
    })()`, true);
    if (!clickedTab) throw new Error('Episode tab was not found');

    console.log('[smoke] Waiting for playable sources');
    const sourceName = await waitFor(
      () => page.evaluate(`(() => {
        const preferred = ['非凡资源', '红牛资源', '速博资源'];
        const cards = Array.from(document.querySelectorAll('.play-source-card'));
        const selected = preferred
          .map(name => cards.find(card => card.querySelector('.source-name')?.textContent.trim() === name))
          .find(Boolean) || cards.find(card => card.querySelector('.source-name'));
        return selected?.querySelector('.source-name')?.textContent.trim() || '';
      })()`),
      'a playable source',
      60000
    );

    console.log(`[smoke] Selecting the first episode from ${sourceName}`);
    await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.play-source-card'));
      const card = cards.find(item => item.querySelector('.source-name')?.textContent.trim() === ${JSON.stringify(sourceName)});
      if (!card) return false;
      if (!card.querySelector('.episode-btn')) card.querySelector('.source-header')?.click();
      return true;
    })()`, true);
    await waitFor(
      () => page.evaluate(`(() => {
        const cards = Array.from(document.querySelectorAll('.play-source-card'));
        const card = cards.find(item => item.querySelector('.source-name')?.textContent.trim() === ${JSON.stringify(sourceName)});
        return Boolean(card?.querySelector('.episode-btn'));
      })()`),
      `episode buttons from ${sourceName}`
    );
    const clickedEpisode = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.play-source-card'));
      const card = cards.find(item => item.querySelector('.source-name')?.textContent.trim() === ${JSON.stringify(sourceName)});
      const episode = card?.querySelector('.episode-btn');
      if (!episode) return false;
      episode.click();
      return true;
    })()`, true);
    if (!clickedEpisode) throw new Error(`Could not click an episode from ${sourceName}`);

    console.log('[smoke] Waiting for the player window');
    const playerTarget = await waitFor(async () => {
      const currentTargets = await targets();
      return currentTargets.find(item => item.type === 'page' && item.id !== pageTarget.id && (
        item.url.includes('player') || item.title.includes('播放器')
      ));
    }, 'player window', 60000);

    player = new CdpClient(playerTarget.webSocketDebuggerUrl);
    await player.connect();
    await player.send('Runtime.enable');
    await player.send('Page.enable');

    const initialState = await waitFor(
      () => player.evaluate(`(() => {
        const video = document.querySelector('video');
        if (!video) return null;
        return {
          currentTime: video.currentTime,
          readyState: video.readyState,
          paused: video.paused,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
          width: video.videoWidth,
          height: video.videoHeight
        };
      })()`),
      'player video element',
      30000
    );

    console.log('[smoke] Confirming decoded frames and time progression');
    const playingState = await waitFor(
      () => player.evaluate(`(() => {
        const video = document.querySelector('video');
        if (!video) return null;
        const state = {
          currentTime: video.currentTime,
          readyState: video.readyState,
          paused: video.paused,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
          width: video.videoWidth,
          height: video.videoHeight
        };
        return !state.error && state.readyState >= 2 && state.currentTime > ${Number(initialState.currentTime || 0) + 0.5}
          ? state
          : null;
      })()`),
      'video time progression',
      45000,
      1000
    );

    console.log('[smoke] Verifying controls hide and return on mouse movement');
    await player.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 360, y: 280 });
    await waitFor(
      () => player.evaluate(`document.querySelector('.control-bar')?.classList.contains('visible') || false`),
      'controls visible before auto hide',
      3000,
      100
    );

    const playbackStats = await waitFor(
      () => player.evaluate(`(() => {
        const label = document.querySelector('.playback-stats')?.textContent?.trim() || '';
        return /\\d+×\\d+/.test(label) && /\\d+(?:\\.\\d+)? FPS/.test(label) ? label : null;
      })()`),
      'decoded resolution and frame rate',
      15000,
      500
    );

    const controlsHidden = await waitFor(
      () => player.evaluate(`!document.querySelector('.control-bar')?.classList.contains('visible')`),
      'controls auto hide',
      8000,
      250
    );
    await player.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 420, y: 320 });
    const controlsRestored = await waitFor(
      () => player.evaluate(`document.querySelector('.control-bar')?.classList.contains('visible') || false`),
      'controls restored by mouse movement',
      3000,
      100
    );

    console.log('[smoke] Verifying the source candidate panel');
    const sourcePanelOpened = await player.evaluate(`(() => {
      const button = document.querySelector('.source-switch-btn');
      if (!button) return false;
      button.click();
      return true;
    })()`, true);
    if (!sourcePanelOpened) throw new Error('Source switch button was not found');
    const sourcePanelState = await waitFor(
      () => player.evaluate(`(() => {
        const boundary = document.querySelector('.error-boundary');
        if (boundary) return { pageError: boundary.textContent.trim() };
        const panel = document.querySelector('.source-panel');
        if (!panel || panel.querySelector('.source-panel-state .loading-spinner')) return null;
        return {
          candidateCount: panel.querySelectorAll('.source-candidate').length,
          lineBadgeCount: panel.querySelectorAll('.line-badge').length,
          error: panel.querySelector('.source-panel-state.error')?.textContent.trim() || ''
        };
      })()`),
      'source candidate panel',
      60000,
      500
    );
    if (sourcePanelState.pageError) {
      throw new Error(`Source panel crashed the page: ${sourcePanelState.pageError}`);
    }
    await player.evaluate(`document.querySelector('.source-panel-close')?.click()`, true);

    console.log('[smoke] Verifying progress-bar click and drag seeking');
    await player.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 640,
      y: 760
    });
    const progressRect = await waitFor(
      () => player.evaluate(`(() => {
        const slider = document.querySelector('.progress-slider');
        if (!slider) return null;
        const rect = slider.getBoundingClientRect();
        return rect.width > 100 ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      })()`),
      'progress slider'
    );
    const progressY = progressRect.top + progressRect.height / 2;
    const clickX = progressRect.left + progressRect.width * 0.28;
    await player.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: progressY, button: 'left', clickCount: 1 });
    await player.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: progressY, button: 'left', clickCount: 1 });
    const clickedSeekState = await waitFor(
      () => player.evaluate(`(() => {
        const video = document.querySelector('video');
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
        const ratio = video.currentTime / video.duration;
        return ratio > 0.23 && ratio < 0.34 ? { currentTime: video.currentTime, duration: video.duration, ratio } : null;
      })()`),
      'progress click seek',
      15000,
      250
    );
    const dragStartX = progressRect.left + progressRect.width * 0.36;
    const dragEndX = progressRect.left + progressRect.width * 0.52;
    await player.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragStartX, y: progressY, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 5; step += 1) {
      const x = dragStartX + (dragEndX - dragStartX) * (step / 5);
      await player.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: progressY, button: 'left', buttons: 1 });
    }
    await player.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragEndX, y: progressY, button: 'left', clickCount: 1 });
    const draggedSeekState = await waitFor(
      () => player.evaluate(`(() => {
        const video = document.querySelector('video');
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return null;
        const ratio = video.currentTime / video.duration;
        return ratio > 0.46 && ratio < 0.58 ? { currentTime: video.currentTime, duration: video.duration, ratio } : null;
      })()`),
      'progress drag seek',
      15000,
      250
    );

    console.log('[smoke] Verifying line and episode transitions');
    const lineSwitch = await player.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('.line-selector .line-tab'));
      if (tabs.length < 2) return { skipped: true, reason: 'single-line source' };
      const active = tabs.find(tab => tab.classList.contains('active')) || tabs[0];
      const target = tabs.find(tab => tab !== active);
      const result = {
        skipped: false,
        original: active.textContent.trim(),
        target: target.textContent.trim()
      };
      target.click();
      return result;
    })()`, true);

    let lineSwitchState = lineSwitch;
    let episodeSwitchState = null;
    let returnLineState = null;
    if (!lineSwitch.skipped) {
      lineSwitchState = await waitFor(
        () => player.evaluate(`(() => {
          const video = document.querySelector('video');
          const root = document.querySelector('.video-player-container');
          const component = root?.__vueParentComponent?.proxy;
          const activeLine = document.querySelector('.line-selector .line-tab.active')?.textContent.trim() || '';
          if (activeLine !== ${JSON.stringify(lineSwitch.target)} || !video || video.error
            || video.readyState < 2 || video.paused || video.currentTime <= 0.5
            || component?.error || component?.autoRecovering) return null;
          return {
            activeLine,
            lineId: component?.currentVideo?.lineId || '',
            episode: component?.currentVideo?.episode?.title || '',
            currentTime: video.currentTime,
            readyState: video.readyState,
            playbackState: component?.playbackState || ''
          };
        })()`),
        `line ${lineSwitch.target} playback`,
        60000,
        500
      );

      const clickedSecondEpisode = await player.evaluate(`(() => {
        const buttons = Array.from(document.querySelectorAll('.episodes-list .episode-btn'));
        if (buttons.length < 2) return false;
        buttons[1].click();
        return true;
      })()`, true);
      if (!clickedSecondEpisode) throw new Error('Second episode button was not found');

      episodeSwitchState = await waitFor(
        () => player.evaluate(`(() => {
          const video = document.querySelector('video');
          const root = document.querySelector('.video-player-container');
          const component = root?.__vueParentComponent?.proxy;
          const episode = component?.currentVideo?.episode;
          const episodeNumber = Number(episode?.index);
          if (!video || video.error || video.readyState < 2 || video.paused || video.currentTime <= 0.5
            || episodeNumber !== 1 || component?.error || component?.autoRecovering) return null;
          return {
            lineId: component?.currentVideo?.lineId || '',
            episode: episode?.title || '',
            episodeIndex: episodeNumber,
            currentTime: video.currentTime,
            playbackState: component?.playbackState || ''
          };
        })()`),
        'second episode on target line',
        60000,
        500
      );

      await player.evaluate(`(() => {
        const tabs = Array.from(document.querySelectorAll('.line-selector .line-tab'));
        const original = tabs.find(tab => tab.textContent.trim() === ${JSON.stringify(lineSwitch.original)});
        if (!original) return false;
        original.click();
        return true;
      })()`, true);

      returnLineState = await waitFor(
        () => player.evaluate(`(() => {
          const video = document.querySelector('video');
          const root = document.querySelector('.video-player-container');
          const component = root?.__vueParentComponent?.proxy;
          const activeLine = document.querySelector('.line-selector .line-tab.active')?.textContent.trim() || '';
          const episodeIndex = Number(component?.currentVideo?.episode?.index);
          if (activeLine !== ${JSON.stringify(lineSwitch.original)} || episodeIndex !== 1
            || !video || video.error || video.readyState < 2 || video.paused || video.currentTime <= 0.5
            || component?.error || component?.autoRecovering) return null;
          return {
            activeLine,
            lineId: component?.currentVideo?.lineId || '',
            episode: component?.currentVideo?.episode?.title || '',
            episodeIndex,
            currentTime: video.currentTime,
            playbackState: component?.playbackState || ''
          };
        })()`),
        `return to line ${lineSwitch.original}`,
        60000,
        500
      );
    }

    const screenshot = await player.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, Buffer.from(screenshot.data, 'base64'));

    console.log(JSON.stringify({
      success: true,
      title: TITLE,
      sourceName,
      playerTitle: playerTarget.title,
      initialState,
      playingState,
      playbackStats,
      controlsHidden,
      controlsRestored,
      sourcePanelState,
      clickedSeekState,
      draggedSeekState,
      lineSwitchState,
      episodeSwitchState,
      returnLineState,
      screenshot: OUTPUT
    }, null, 2));
  } finally {
    player?.close();
    page?.close();
  }
}

async function inspectExistingPlayer() {
  const playerTarget = (await targets()).find(item => item.type === 'page' && item.url.includes('player-window'));
  if (!playerTarget) throw new Error('Player target was not found');

  const player = new CdpClient(playerTarget.webSocketDebuggerUrl);
  try {
    await player.connect();
    await player.send('Runtime.enable');
    await player.send('Page.enable');
    const state = await player.evaluate(`(async () => {
      const video = document.querySelector('video');
      const root = document.querySelector('.video-player-container');
      const component = root?.__vueParentComponent?.proxy;
      const currentUrl = component?.currentVideo?.url || '';
      const inspectUrl = ${JSON.stringify(process.env.SAKURAFALL_INSPECT_URL || '')} || currentUrl;
      let proxyFetch = null;
      if (inspectUrl) {
        try {
          const response = await fetch(inspectUrl);
          const body = await response.text();
          proxyFetch = {
            url: inspectUrl,
            ok: response.ok,
            status: response.status,
            contentType: response.headers.get('content-type') || '',
            body: body.slice(0, 2000)
          };
        } catch (error) {
          proxyFetch = { url: inspectUrl, error: error?.message || String(error) };
        }
      }
      return {
        video: video ? {
          src: video.currentSrc || video.src,
          currentTime: video.currentTime,
          duration: video.duration,
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          ended: video.ended,
          error: video.error ? { code: video.error.code, message: video.error.message } : null,
          width: video.videoWidth,
          height: video.videoHeight
        } : null,
        player: component ? {
          currentUrl,
          isHls: component.isHLSStream?.(currentUrl),
          hasHls: !!component.hls,
          hlsErrorCount: component.hlsErrorCount,
          hlsRecoveryAttemptPending: component.hlsRecoveryAttemptPending,
          playbackState: component.playbackState,
          playbackIntent: component.playbackIntent,
          startupBuffering: component.startupBuffering,
          smoothRebuffering: component.smoothRebuffering,
          activeMediaGeneration: component.activeMediaGeneration,
          mediaLoadGeneration: component.mediaLoadGeneration,
          activeMediaMode: component.activeMediaMode,
          triedSources: component.triedFallbackSourceIds,
          fallbackRunning: !!component.fallbackCyclePromise,
          lastFailure: component.lastPlaybackFailure
        } : null,
        proxyFetch,
        text: document.body.innerText.slice(0, 3000)
      };
    })()`);
    const screenshot = await player.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ ...state, screenshot: OUTPUT }, null, 2));
  } finally {
    player.close();
  }
}

module.exports = { CdpClient, targets, waitFor };

if (require.main === module) {
  const task = process.argv.includes('--inspect-player') ? inspectExistingPlayer() : main();
  task.catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
