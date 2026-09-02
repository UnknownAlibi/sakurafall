const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCandidateUrl,
  scoreMediaCandidate,
  selectBestMediaCandidate,
  mergeMediaElementMetadata,
  serializeExtraHeaders
} = require('../src/main/services/sources/WebPageMediaSniffer');

test('media sniffer candidate scoring prefers HLS and avoids obvious ad URLs', () => {
  const best = selectBestMediaCandidate([
    { url: 'https://cdn.example.com/ad/preroll.mp4', mimeType: 'video/mp4', discoveredAt: 1 },
    { url: 'https://cdn.example.com/main/index.m3u8', mimeType: 'application/vnd.apple.mpegurl', discoveredAt: 2 },
    { url: 'https://cdn.example.com/poster.jpg', mimeType: 'image/jpeg', discoveredAt: 3 }
  ]);

  assert.equal(best.url, 'https://cdn.example.com/main/index.m3u8');
  assert.ok(scoreMediaCandidate(best) > 200);
  assert.equal(scoreMediaCandidate({ url: 'https://cdn.example.com/poster.jpg' }), -1);
});

test('media sniffer rejects non-network URLs and sanitizes extra headers', () => {
  assert.equal(normalizeCandidateUrl('blob:https://example.com/id'), '');
  assert.equal(normalizeCandidateUrl('javascript:alert(1)'), '');
  assert.equal(
    serializeExtraHeaders({ Referer: 'https://example.com/\r\nInjected: yes' }),
    'Referer: https://example.com/ Injected: yes'
  );
});

test('media sniffer rejects a measured short clip and prefers episode-length media', () => {
  const shortClip = {
    url: 'https://cdn.example.com/opaque-a.mp4',
    mimeType: 'video/mp4',
    duration: 3.1,
    discoveredAt: 1
  };
  const episode = {
    url: 'https://cdn.example.com/opaque-b.mp4',
    mimeType: 'video/mp4',
    duration: 1420,
    videoWidth: 1920,
    videoHeight: 1080,
    discoveredAt: 2
  };

  assert.equal(scoreMediaCandidate(shortClip), -1);
  assert.equal(selectBestMediaCandidate([shortClip, episode]).url, episode.url);
});

test('media element metadata is attached to the matching network candidate', () => {
  const candidates = [{
    url: 'https://cdn.example.com/video.mp4',
    mimeType: 'video/mp4',
    discoveredAt: 1
  }];
  const enriched = mergeMediaElementMetadata(candidates, [{
    url: 'https://cdn.example.com/video.mp4',
    duration: 3.1,
    videoWidth: 640,
    videoHeight: 360
  }]);

  assert.equal(enriched[0].duration, 3.1);
  assert.equal(scoreMediaCandidate(enriched[0]), -1);
});

test('blob-backed media metadata is assigned to the latest direct request', () => {
  const candidates = [
    { url: 'https://cdn.example.com/older.mp4', mimeType: 'video/mp4', discoveredAt: 1 },
    { url: 'https://cdn.example.com/latest.mp4', mimeType: 'video/mp4', discoveredAt: 2 }
  ];
  const enriched = mergeMediaElementMetadata(candidates, [{
    url: 'blob:https://player.example.com/opaque',
    duration: 3.1,
    readyState: 4
  }]);

  assert.equal(enriched[0].duration, undefined);
  assert.equal(enriched[1].duration, 3.1);
  assert.equal(scoreMediaCandidate(enriched[1]), -1);
});

test('sniffer source keeps bounded metadata and total timeout guards', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').resolve('src/main/services/sources/WebPageMediaSniffer.js'),
    'utf8'
  );
  assert.match(source, /Promise\.race\(\[/);
  assert.match(source, /MEDIA_SNIFFER_METADATA_TIMEOUT/);
  assert.match(source, /if \(settled\) return;/);
});
