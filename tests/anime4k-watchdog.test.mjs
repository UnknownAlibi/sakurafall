import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferedAheadSeconds,
  isNearLoopEnd,
  isSourceStarved
} from '../src/renderer/player/anime4kWatchdog.js';

// 最小 video 替身：只实现看门狗用到的字段。
function fakeVideo(overrides = {}) {
  const ranges = overrides._ranges || [];
  return {
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    currentTime: 0,
    duration: 10,
    buffered: {
      length: ranges.length,
      start: index => ranges[index][0],
      end: index => ranges[index][1]
    },
    ...overrides
  };
}

test('bufferedAheadSeconds 返回当前位置所在缓冲区段的剩余时长', () => {
  const video = fakeVideo({ currentTime: 4, _ranges: [[0, 2], [3, 8]] });
  assert.equal(bufferedAheadSeconds(video), 4);
  // 落在缓冲空洞里 -> 0
  assert.equal(bufferedAheadSeconds(fakeVideo({ currentTime: 2.5, _ranges: [[0, 2], [3, 8]] })), 0);
  // 没有 buffered / 已销毁 -> 0，不抛异常
  assert.equal(bufferedAheadSeconds({ currentTime: 1, buffered: null }), 0);
  assert.equal(bufferedAheadSeconds(null), 0);
});

test('数据源饥饿包含暂停、seek、播放结束与缓冲耗尽', () => {
  assert.equal(isSourceStarved(fakeVideo({ paused: true, _ranges: [[0, 10]] })), true);
  assert.equal(isSourceStarved(fakeVideo({ seeking: true, _ranges: [[0, 10]] })), true);
  assert.equal(isSourceStarved(fakeVideo({ ended: true, _ranges: [[0, 10]] })), true);
  assert.equal(isSourceStarved(fakeVideo({ readyState: 1, _ranges: [[0, 10]] })), true);
  // 缓冲用完（网络卡顿）——不算 CNN 的锅；还有富余时不应误判为饥饿
  assert.equal(isSourceStarved(fakeVideo({ currentTime: 10, _ranges: [[0, 10]] })), true);
  assert.equal(isSourceStarved(fakeVideo({ currentTime: 9.98, _ranges: [[0, 10]] })), true); // 余量 0.02s < 0.05s 阈值
  assert.equal(isSourceStarved(fakeVideo({ currentTime: 5, _ranges: [[0, 10]] })), false);
});

test('解码停摆（readyState 2 但仍有缓冲）必须归因给 CNN 而不是数据源', () => {
  // 这是修复前看门狗失声的场景：readyState < 3 被一律当成"缓冲中"，
  // 于是 55 秒的解码冻结只触发了一次降档就再无下文。
  const stalled = fakeVideo({ readyState: 2, currentTime: 3.36, _ranges: [[0, 5.09]] });
  assert.equal(isSourceStarved(stalled), false);
});

test('isNearLoopEnd 识别尾部回绕，实时流（duration 非有限）不误判', () => {
  assert.equal(isNearLoopEnd(fakeVideo({ currentTime: 9.9, duration: 10 })), true);
  assert.equal(isNearLoopEnd(fakeVideo({ currentTime: 5, duration: 10 })), false);
  assert.equal(isNearLoopEnd(fakeVideo({ currentTime: 5, duration: Infinity })), false);
  assert.equal(isNearLoopEnd(fakeVideo({ currentTime: 5, duration: 0 })), false);
});
