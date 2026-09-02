import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const videoPlayerSource = await readFile(
  new URL('../src/renderer/components/Player/VideoPlayer.vue', import.meta.url),
  'utf8'
);
const playbackLifecycleSource = await readFile(
  new URL('../src/renderer/mixins/playerPlaybackLifecycle.js', import.meta.url),
  'utf8'
);
const playerWindowSource = await readFile(
  new URL('../src/renderer/views/PlayerWindow.vue', import.meta.url),
  'utf8'
);
const playerSources = `${videoPlayerSource}\n${playbackLifecycleSource}`;
const fallbackPolicySource = await readFile(
  new URL('../src/renderer/utils/playbackFallbackPolicy.js', import.meta.url),
  'utf8'
);
const { evaluatePlaybackEvidence, shouldAutoFallback } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(fallbackPolicySource)}`
);

const moduleSource = await readFile(
  new URL('../src/renderer/utils/playbackDiagnostics.js', import.meta.url),
  'utf8'
);
const {
  describeHlsError,
  describeNativeVideoError,
  formatPlaybackFailureForDisplay
} = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`);

test('describeHlsError: identifies manifest network failures with response code', () => {
  const failure = describeHlsError({
    type: 'networkError',
    details: 'manifestLoadError',
    fatal: true,
    response: { code: 403 }
  });

  assert.equal(failure.source, 'hls');
  assert.equal(failure.reason, 'hls-networkError-manifestLoadError');
  assert.equal(failure.responseCode, 403);
  assert.match(failure.message, /m3u8/);
  assert.match(failure.hint, /代理\/TUN|源站/);
});

test('describeHlsError: identifies media decode style failures', () => {
  const failure = describeHlsError({
    type: 'mediaError',
    details: 'bufferAppendError',
    fatal: true
  });

  assert.equal(failure.reason, 'hls-mediaError-bufferAppendError');
  assert.match(failure.message, /缓冲/);
  assert.match(failure.hint, /解码|分片/);
});

test('describeNativeVideoError: maps browser media error codes', () => {
  const failure = describeNativeVideoError({ code: 4 });

  assert.equal(failure.source, 'native');
  assert.equal(failure.reason, 'native-src-not-supported');
  assert.match(failure.userMessage, /切换其他源/);
});

test('formatPlaybackFailureForDisplay: joins message and hint', () => {
  const text = formatPlaybackFailureForDisplay({
    message: '视频分片加载失败',
    hint: '可能是源站限流。'
  });

  assert.equal(text, '视频分片加载失败 可能是源站限流。');
});

test('player unmount uses the complete media teardown path', () => {
  const beforeUnmount = videoPlayerSource.split('beforeUnmount() {')[1]?.split('\n  }\n};')[0] || '';
  assert.match(beforeUnmount, /clearTrackedTimers\(\)/);
  assert.match(beforeUnmount, /forceStopAndClean\('window-closed'\)/);
  assert.match(videoPlayerSource, /video\.removeAttribute\('src'\)/);
  assert.match(videoPlayerSource, /video\.load\(\)/);
});

test('proxied HLS streams use hls.js and do not start duplicate fallback cycles', () => {
  const hlsInitializer = videoPlayerSource.split('async initHLSPlayer(')[1]?.split('\n    initNativePlayer(')[0] || '';
  const fallbackMethod = videoPlayerSource.split('async autoFallbackToOtherSource(')[1]?.split('\n    async runAutoFallbackCycle(')[0] || '';

  assert.match(videoPlayerSource, /media=hls/);
  assert.match(hlsInitializer, /Hls\.isSupported\(\)/);
  assert.doesNotMatch(hlsInitializer.split('let Hls;')[0] || '', /canPlayType/);
  assert.match(fallbackMethod, /this\.fallbackCycleGeneration === generation/);
  assert.match(videoPlayerSource, /normalizeFallbackSourceId/);
});

test('media callbacks and HLS recovery are scoped to the active playback generation', () => {
  assert.match(playerSources, /beginPlaybackTransition\(reason/);
  assert.match(playerSources, /isCurrentMediaSession\('native'\)/);
  assert.match(playerSources, /this\.hls !== hlsInstance/);
  assert.match(playerSources, /generation !== this\.mediaLoadGeneration \|\| this\.hls !== recoveringInstance/);
  assert.match(playerSources, /this\.hlsErrorCount = 0/);
});

test('automatic fallback requires confirmed loss of progress and buffered media', () => {
  const base = {
    playbackIntent: true,
    ended: false,
    errorCode: 0,
    observedTime: 20,
    observationStartedAt: 1000,
    lastProgressAt: 1000
  };

  assert.equal(shouldAutoFallback({ ...base, currentTime: 21, readyState: 2, bufferAhead: 0 }), false);
  assert.equal(shouldAutoFallback({ ...base, currentTime: 20, readyState: 4, bufferAhead: 3 }), false);
  assert.equal(shouldAutoFallback({ ...base, currentTime: 20, readyState: 1, bufferAhead: 0 }), true);
  assert.equal(shouldAutoFallback({ ...base, playbackIntent: false, currentTime: 20 }), false);
  assert.deepEqual(
    evaluatePlaybackEvidence({ ...base, currentTime: 20, readyState: 4, bufferAhead: 2 }),
    { progressed: false, progressObserved: false, buffered: true, canContinue: true }
  );
});

test('fatal HLS events recover in place before the watchdog may switch routes', () => {
  const hlsHandler = playbackLifecycleSource.split('handleHLSError(')[1]?.split('\n    createHlsFailure(')[0] || '';
  const watchdog = playbackLifecycleSource.split('\n    scheduleHlsRecoveryWatchdog(data')[1] || '';
  assert.match(hlsHandler, /scheduleHlsRecoveryWatchdog/);
  assert.doesNotMatch(hlsHandler, /autoFallbackToOtherSource/);
  assert.doesNotMatch(hlsHandler, /\.destroy\(\)/);
  assert.match(watchdog, /shouldAutoFallback/);
  assert.match(videoPlayerSource, /scheduleNativeFallbackConfirmation\(failure\)/);
});

test('playback startup without progress is confirmed and then falls back', () => {
  const startupStart = playbackLifecycleSource.indexOf('\n    schedulePlaybackStartupWatchdog(\n');
  const startupEnd = playbackLifecycleSource.indexOf('\n    scheduleNativeFallbackConfirmation(', startupStart);
  const startupWatchdog = playbackLifecycleSource.slice(startupStart, startupEnd);
  assert.match(videoPlayerSource, /schedulePlaybackStartupWatchdog\(generation, url\)/);
  assert.match(startupWatchdog, /playback-startup-timeout/);
  assert.match(startupWatchdog, /getBufferedAhead/);
  assert.match(startupWatchdog, /requestPlayback\('startup-watchdog'\)/);
  assert.match(startupWatchdog, /autoFallbackToOtherSource/);
  assert.match(videoPlayerSource, /clearPlaybackStartupWatchdog\(\)/);
});

test('line resolution failures enter automatic fallback without false active selection', () => {
  const selectLine = playerWindowSource.split('async selectLine(lineId)')[1]
    ?.split('\n    pauseInternalPlayer(')[0] || '';
  assert.match(playerWindowSource, /fallbackAfterEpisodeResolutionFailure/);
  assert.match(playerWindowSource, /await this\.fallbackAfterEpisodeResolutionFailure\(player, failure/);
  assert.match(playerWindowSource, /player\.rememberFallbackAttempt/);
  assert.match(playerWindowSource, /player\.autoFallbackToOtherSource/);
  assert.doesNotMatch(selectLine, /this\.selectedLine\s*=\s*lineId/);
});

test('multi-line source candidates expose their formatter to the Options API template', () => {
  assert.match(videoPlayerSource, /import \{ extractEpisodeNumber, formatLineName \} from/);
  assert.match(videoPlayerSource, /methods:\s*\{\s*formatLineName,/);
  assert.match(videoPlayerSource, /formatLineName\(candidate\.lineId\)/);
});
