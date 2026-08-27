import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectDiscontinuityAdRanges,
  collectExplicitHlsAdRanges,
  collectHlsAdRanges,
  findActiveAdRange
} from '../src/renderer/utils/hlsAdMarkers.js';

test('explicit HLS interstitial and SCTE-35 date ranges are detected', () => {
  const ranges = collectExplicitHlsAdRanges({
    dateRanges: {
      ad: {
        id: 'ad-1',
        class: 'com.apple.hls.interstitial',
        isInterstitial: true,
        startTime: 120,
        duration: 15,
        attr: { ID: 'ad-1', CLASS: 'com.apple.hls.interstitial' }
      },
      chapter: {
        id: 'chapter-1',
        class: 'chapter',
        startTime: 30,
        duration: 10,
        attr: { ID: 'chapter-1', CLASS: 'chapter' }
      },
      scte: {
        id: 'scte-1',
        startTime: 240,
        duration: 20,
        attr: { ID: 'scte-1', 'SCTE35-OUT': '0xFC' }
      }
    }
  });

  assert.deepEqual(ranges.map(range => range.id), ['ad-1', 'scte-1']);
  assert.equal(findActiveAdRange(ranges, 125)?.end, 135);
  assert.equal(findActiveAdRange(ranges, 125, ['ad-1']), null);
});

test('paired CUE markers create a bounded ad range without guessing discontinuities', () => {
  const ranges = collectExplicitHlsAdRanges({
    fragments: [
      { sn: 1, start: 30, tagList: [['DIS']] },
      { sn: 2, start: 36, tagList: [['CUE-OUT']] },
      { sn: 3, start: 42, tagList: [] },
      { sn: 4, start: 48, tagList: [['CUE-IN']] }
    ]
  });

  assert.equal(ranges.length, 1);
  assert.deepEqual({ start: ranges[0].start, end: ranges[0].end }, { start: 36, end: 48 });
});

test('short HLS discontinuity groups are diagnostic only and never auto-skipped', () => {
  const fragments = [
    { sn: 1, cc: 0, start: 0, duration: 6 },
    { sn: 2, cc: 0, start: 6, duration: 6 },
    ...Array.from({ length: 20 }, (_, index) => ({
      sn: index + 3,
      cc: 1,
      start: 12 + index * 6,
      duration: 6
    })),
    { sn: 23, cc: 2, start: 132, duration: 5 },
    { sn: 24, cc: 2, start: 137, duration: 5 }
  ];
  const ranges = collectDiscontinuityAdRanges({ fragments, live: false });

  assert.deepEqual(ranges.map(range => [range.start, range.end]), [[0, 12], [132, 142]]);
  assert.deepEqual(collectHlsAdRanges({ fragments }), []);
});

test('discontinuity heuristics do not guess on live or uniformly short playlists', () => {
  const fragments = [
    { cc: 0, start: 0, duration: 20 },
    { cc: 1, start: 20, duration: 20 }
  ];
  assert.deepEqual(collectDiscontinuityAdRanges({ fragments }), []);
  assert.deepEqual(collectDiscontinuityAdRanges({ fragments, live: true }), []);
});
