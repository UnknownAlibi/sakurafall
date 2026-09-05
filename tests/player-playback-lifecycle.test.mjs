import assert from 'node:assert/strict';
import test from 'node:test';
import lifecycle from '../src/renderer/mixins/playerPlaybackLifecycle.js';

test('a previous video play rejection cannot pause a newly selected episode', async () => {
  let rejectPlay;
  const video = { play: () => new Promise((resolve, reject) => { rejectPlay = reject; }) };
  const context = {
    $refs: { videoElement: video }, mediaLoadGeneration: 1,
    currentVideo: { url: 'first.mp4' }, playbackIntent: false, playRetryCount: 0,
    setPlaying: () => assert.fail('stale play must not change state'),
    revealControls: () => assert.fail('stale play must not reveal controls')
  };
  const pending = lifecycle.methods.requestPlayback.call(context);
  context.mediaLoadGeneration = 2;
  context.currentVideo = { url: 'second.mp4' };
  rejectPlay(new Error('old decoder failed'));
  assert.equal(await pending, false);
  assert.equal(context.playbackIntent, true);
});

test('a current play rejection still restores the user play control', async () => {
  const context = {
    $refs: { videoElement: { play: async () => { throw new Error('blocked'); } } },
    mediaLoadGeneration: 1, currentVideo: { url: 'first.mp4' },
    setPlaying(value) { this.playing = value; }, revealControls() { this.controls = true; }
  };
  assert.equal(await lifecycle.methods.requestPlayback.call(context), false);
  assert.equal(context.playbackIntent, false);
  assert.equal(context.showCenterPlay, true);
  assert.equal(context.controls, true);
});
