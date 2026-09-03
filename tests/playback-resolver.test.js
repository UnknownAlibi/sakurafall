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

test('PlaybackResolver: rejects definite HTTP failures instead of waiting for a player timeout', async () => {
  const { service, reports } = createService({
    source: 'probe-failed',
    error: 'HTTP 404'
  });

  const result = await service.resolve({
    sourceId: 'gone',
    episode: { id: 'ep1', url: 'https://cdn.example/gone.m3u8' }
  });

  assert.equal(result.success, false);
  assert.equal(result.category, 'network-blocked');
  assert.equal(reports.length, 1);
});

test('PlaybackResolver: rejects TLS hostname mismatches before opening the player', async () => {
  const { service, reports } = createService({
    source: 'probe-failed',
    error: "Hostname/IP does not match certificate's altnames: IP: 64.32.20.246"
  });

  const result = await service.resolve({
    sourceId: 'xpath-age',
    episode: { id: 'ep1', url: 'https://64.32.20.246/play/test/index.m3u8' }
  });

  assert.equal(result.success, false);
  assert.equal(result.category, 'network-blocked');
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

test('PlaybackResolver: statically extracts media when a share-page host has migrated', async () => {
  const { service } = createService({ source: 'single', height: 1080 });
  service._scrapeHttp.fetch = async () => (
    '<script>window.player = {"url":"https:\\/\\/cdn.example\\/episode.m3u8"};</script>'
  );

  const result = await service.resolve({
    sourceId: 'migrated-share-source',
    episode: { id: 'ep1', url: 'https://new-share.example/share/episode-one' }
  });

  assert.equal(result.success, true);
  assert.equal(result.url, 'https://cdn.example/episode.m3u8');
  assert.equal(result.resolvedBy, 'share-static');
});

test('PlaybackResolver: does not accept the original share page as a resolved video', async () => {
  const { service } = createService({ source: 'single', height: 720 });
  service.sourceProviderRegistry.canResolveUrl = () => true;
  service.sourceProviderRegistry.resolveEpisode = async (_providerId, episode) => ({ url: episode.url });
  service._scrapeHttp.fetch = async () => '<html><body>no media</body></html>';

  const result = await service.resolve({
    sourceId: 'stale-resolver',
    episode: { id: 'ep1', url: 'https://share.example/share/episode-one' }
  });

  assert.equal(result.success, false);
  assert.equal(result.category, 'format-unsupported');
  assert.match(result.error, /网页/);
});

test('PlaybackResolver: applies one total deadline across share-page fallback stages', async () => {
  const { service } = createService({ source: 'single', height: 720 });
  service.sourceProviderRegistry.canResolveUrl = () => true;
  service.sourceProviderRegistry.resolveEpisode = () => new Promise(() => {});
  service._scrapeHttp.fetch = () => new Promise(() => {});

  const startedAt = Date.now();
  const result = await service.resolve({
    sourceId: 'stalled-share',
    episode: { id: 'ep1', url: 'https://share.example/share/episode-one' }
  }, { timeout: 1000 });

  assert.equal(result.success, false);
  assert.equal(result.category, 'resolver-timeout');
  assert.ok(Date.now() - startedAt < 1600);
});

test('PlaybackResolver: classifies a rejected share page as a routing failure', async () => {
  const { service } = createService({ source: 'single', height: 720 });
  service._scrapeHttp.fetch = async () => {
    const error = new Error('HTTP 403');
    error.statusCode = 403;
    throw error;
  };

  const result = await service.resolve({
    sourceId: 'region-blocked-share',
    episode: { id: 'ep1', url: 'https://share.example/share/episode-one' }
  });

  assert.equal(result.success, false);
  assert.equal(result.category, 'network-blocked');
  assert.match(result.hint, /TUN|直连/);
});
