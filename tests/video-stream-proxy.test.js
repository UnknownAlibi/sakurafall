const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProxyUrl,
  parseProxyUrl,
  isHlsTarget,
  rewriteHlsManifest
} = require('../src/main/services/VideoStreamProxyService');

test('HLS proxy URLs carry an explicit media marker', () => {
  const target = 'https://cdn.example.com/anime/master.m3u8?token=abc';
  const proxied = buildProxyUrl(target, { referer: 'https://player.example.com/' });
  const parsed = parseProxyUrl(proxied);

  assert.match(proxied, /[?&]media=hls(?:&|$)/);
  assert.equal(parsed.target, target);
  assert.equal(parsed.referer, 'https://player.example.com/');
  assert.equal(parsed.mediaType, 'hls');
  assert.equal(isHlsTarget(target), true);
});

test('HLS manifests rewrite relative playlists, segments, keys and maps through the proxy', () => {
  const playlistUrl = 'https://cdn.example.com/show/master/index.m3u8?auth=1';
  const referer = 'https://player.example.com/';
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',
    '#EXT-X-MAP:URI="../init.mp4"',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
    'variants/720/index.m3u8',
    '#EXTINF:6,',
    'segments/0001.ts?token=xyz'
  ].join('\n');

  const rewritten = rewriteHlsManifest(manifest, playlistUrl, referer);
  const proxyUrls = rewritten.match(/sakurafall-media:\/\/proxy\/[A-Za-z0-9_-]+(?:\?[^\s",]+)?/g) || [];
  const targets = proxyUrls.map(url => parseProxyUrl(url)?.target);

  assert.equal(proxyUrls.length, 4);
  assert.ok(targets.includes('https://cdn.example.com/show/master/keys/key.bin'));
  assert.ok(targets.includes('https://cdn.example.com/show/init.mp4'));
  assert.ok(targets.includes('https://cdn.example.com/show/master/variants/720/index.m3u8'));
  assert.ok(targets.includes('https://cdn.example.com/show/master/segments/0001.ts?token=xyz'));
});

test('ordinary MP4 proxy URLs remain native-video URLs', () => {
  const proxied = buildProxyUrl('https://cdn.example.com/video.mp4');
  assert.doesNotMatch(proxied, /[?&]media=hls(?:&|$)/);
  assert.equal(parseProxyUrl(proxied).mediaType, '');
});

test('segments under an hls directory stay binary media streams', () => {
  const segment = 'https://cdn.example.com/show/hls/segment-001.ts?token=abc';
  const proxied = buildProxyUrl(segment);

  assert.equal(isHlsTarget(segment), false);
  assert.doesNotMatch(proxied, /[?&]media=hls(?:&|$)/);
});
