import assert from 'node:assert/strict';
import test from 'node:test';

const originalNavigator = globalThis.navigator;
const originalMediaMetadata = globalThis.MediaMetadata;

function restoreGlobals() {
  if (originalNavigator === undefined) delete globalThis.navigator;
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  if (originalMediaMetadata === undefined) delete globalThis.MediaMetadata;
  else globalThis.MediaMetadata = originalMediaMetadata;
}

test.afterEach(restoreGlobals);

test('buildPlayerMediaMetadata exposes anime, episode and artwork to Windows', async () => {
  const { buildPlayerMediaMetadata } = await import('../src/renderer/utils/playerMediaSession.js');
  assert.deepEqual(buildPlayerMediaMetadata({
    anime: { name: '樱月物语', cover: '//img.example/cover.jpg', sourceName: '高清线路' },
    episode: { title: '第12集' }
  }), {
    title: '第12集',
    artist: '樱月物语',
    album: '高清线路',
    artwork: [{ src: 'https://img.example/cover.jpg' }]
  });
});

test('buildPositionState clamps invalid media positions', async () => {
  const { buildPositionState } = await import('../src/renderer/utils/playerMediaSession.js');
  assert.deepEqual(buildPositionState({ duration: 100, currentTime: 150, playbackRate: 1.5 }), {
    duration: 100,
    playbackRate: 1.5,
    position: 100
  });
  assert.equal(buildPositionState({ duration: Infinity, currentTime: 2 }), null);
});

test('media session maps hardware controls and disables next at the final episode', async () => {
  const handlers = new Map();
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) { handlers.set(action, handler); },
    setPositionState() {}
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaSession } });
  globalThis.MediaMetadata = class MediaMetadata { constructor(data) { Object.assign(this, data); } };

  const { createPlayerMediaSession } = await import('../src/renderer/utils/playerMediaSession.js');
  const calls = [];
  const controller = createPlayerMediaSession({
    onPlay: () => calls.push('play'),
    onPause: () => calls.push('pause'),
    onNext: () => calls.push('next'),
    onSeekBy: value => calls.push(value),
    getSeekStep: () => 5
  });
  controller.setNextEnabled(true);
  assert.equal(controller.mount(), true);

  handlers.get('play')();
  handlers.get('pause')();
  handlers.get('seekforward')({});
  handlers.get('nexttrack')();
  assert.deepEqual(calls, ['play', 'pause', 5, 'next']);

  controller.setNextEnabled(false);
  assert.equal(handlers.get('nexttrack'), null);
  controller.destroy();
  assert.equal(mediaSession.playbackState, 'none');
});
