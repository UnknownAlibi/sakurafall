const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCandidateUrl,
  scoreMediaCandidate,
  selectBestMediaCandidate,
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
