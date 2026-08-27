const test = require('node:test');
const assert = require('node:assert/strict');
const SourceHealthTracker = require('../src/main/services/cms/SourceHealthTracker');

test('observed smooth playback outranks a high-history stuttering source', () => {
  const tracker = new SourceHealthTracker();
  tracker.sourceHealth.set('smooth', {
    successCount: 5,
    playbackSuccessCount: 5,
    averageLatency: 500,
    averageQualityHeight: 720,
    playbackSessionCount: 5,
    sustainedPlaybackCount: 4,
    averageStartupMs: 800,
    averageStallRatio: 0.01,
    averageDroppedFrameRatio: 0.001
  });
  tracker.sourceHealth.set('stuttering', {
    successCount: 100,
    playbackSuccessCount: 100,
    averageLatency: 300,
    averageQualityHeight: 1080,
    playbackSessionCount: 6,
    sustainedPlaybackCount: 6,
    averageStartupMs: 400,
    averageStallRatio: 0.18,
    averageDroppedFrameRatio: 0
  });

  assert.ok(
    tracker.calculateSourceHealthScore('smooth') > tracker.calculateSourceHealthScore('stuttering')
  );
});

test('advertising reports reduce source priority without forcing cooldown', () => {
  const tracker = new SourceHealthTracker();
  tracker.sourceHealth.set('clean', { successCount: 4, playbackSuccessCount: 4 });
  tracker.sourceHealth.set('ads', {
    successCount: 4,
    playbackSuccessCount: 4,
    advertisingReportCount: 3
  });

  assert.ok(tracker.calculateSourceHealthScore('clean') > tracker.calculateSourceHealthScore('ads'));
  assert.equal(tracker.isCoolingDown('ads'), false);
});
