import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const videoPlayerSource = await readFile(
  new URL('../src/renderer/components/Player/VideoPlayer.vue', import.meta.url),
  'utf8'
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
