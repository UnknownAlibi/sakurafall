const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackResolverService } = require('../src/main/services/PlaybackResolverService');

function createService(probeResult) {
  const reports = [];
  const remembered = [];
  const service = new PlaybackResolverService();
  service.setCmsApiService({
    probeStreamQuality: async () => probeResult,
    recordPlaybackResult: (sourceId, result) => reports.push({ sourceId, result })
  });
  service.setSourceProviderRegistry({
    canResolveUrl: () => false,
    getPlaybackHeaders: () => ({ Referer: 'https://source.example/' }),
    rememberPlaybackHeaders: (sourceId, url, headers) => remembered.push({ sourceId, url, headers })
  });
  return { service, reports, remembered };
}

test('PlaybackResolver: rejects an invalid m3u8 before opening the player', async () => {
  const { service, reports } = createService({
    source: 'probe-failed',
    error: 'INVALID_M3U8_MANIFEST: HTML response'
  });

  const result = await service.resolve({
    sourceId: 'broken',
    episode: { id: 'ep1', url: 'https://cdn.example/broken.m3u8' }
  });

  assert.equal(result.success, false);
  assert.equal(result.category, 'format-unsupported');
  assert.equal(reports.length, 1);
});

test('PlaybackResolver: rejects an undeclared player page before opening the player', async () => {
  const { service, reports } = createService({ source: 'single', height: 720 });

  const result = await service.resolve({
    sourceId: 'player-page',
    episode: { id: 'ep1', url: 'https://play.example.com/play/episode-one' }
  });

  assert.equal(result.success, false);
  assert.equal(result.category, 'format-unsupported');
  assert.match(result.error, /网页/);
  assert.equal(reports.length, 1);
});

test('PlaybackResolver: sniffs media from XPath-style player pages', async () => {
  const { service } = createService(null);
  service._scrapeHttp.fetch = async () => '<html><body>dynamic player</body></html>';
  service._mediaSniffer = {
    resolve: async () => ({
      url: 'https://video.example.com/content/opaque-id',
      mimeType: 'video/mp4',
      resourceType: 'media'
    }),
    cancel() {},
    setProxy() {}
  };

  const result = await service.resolve({
    sourceId: 'xpath-rule',
    sourceType: 'xpath',
    episode: { id: 'ep1', url: 'https://source.example.com/play/episode-one' }
  });

  assert.equal(result.success, true);
  assert.equal(result.url, 'https://video.example.com/content/opaque-id');
  assert.equal(result.resolvedBy, 'webview-sniff');
});

test('PlaybackResolver: returns verified stream metadata and remembers playback headers', async () => {
  const { service, remembered } = createService({
    source: 'm3u8-master',
    height: 1080,
    bitrate: 5000000
  });

  const result = await service.resolve({
    sourceId: 'healthy',
    episode: { id: 'ep1', url: 'https://cdn.example/master.m3u8' }
  });

  assert.equal(result.success, true);
  assert.equal(result.qualityHint, '1080P');
  assert.equal(result.headers.Referer, 'https://source.example/');
  assert.equal(remembered.length, 1);
});

test('PlaybackResolver: normalizes non-ASCII media URLs before probing', async () => {
  let probedUrl = '';
  const service = new PlaybackResolverService();
  service.setCmsApiService({
    probeStreamQuality: async (url) => {
      probedUrl = url;
      return { source: 'single', height: 720 };
    },
    recordPlaybackResult() {}
  });
  service.setSourceProviderRegistry({
    canResolveUrl: () => false,
    getPlaybackHeaders: () => ({}),
    rememberPlaybackHeaders() {}
  });

  const result = await service.resolve({
    sourceId: 'encoded',
    episode: { id: 'ep1', url: 'https://cdn.example/高清 01.m3u8' }
  });

  assert.equal(result.success, true);
  assert.equal(probedUrl, 'https://cdn.example/%E9%AB%98%E6%B8%85%2001.m3u8');
});
