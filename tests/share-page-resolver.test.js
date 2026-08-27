const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SharePageResolverService,
  extractMediaUrl
} = require('../src/main/services/sources/SharePageResolverService');

function createResolver() {
  let fetchCount = 0;
  const httpClient = {
    setTimeout() {},
    setProxy() {},
    async fetch(_url, options) {
      fetchCount += 1;
      assert.equal(options.headers.Referer, 'https://source.example/');
      return '<script>const url = "https:\\/\\/cdn.example\\/video.m3u8?token=1";</script>';
    }
  };
  const service = new SharePageResolverService({ httpClient });
  service.setResolvers([{
    id: 'author.share',
    name: 'Share resolver',
    hosts: ['share.example.com'],
    pathPrefixes: ['/share/'],
    requestHeaders: { Referer: 'https://source.example/' },
    playbackHeaders: { Referer: 'https://source.example/' }
  }]);
  return { service, getFetchCount: () => fetchCount };
}

test('extractMediaUrl handles escaped and relative media urls', () => {
  assert.equal(
    extractMediaUrl('const url="https:\\/\\/cdn.example\\/a.m3u8"', 'https://share.example.com/share/1'),
    'https://cdn.example/a.m3u8'
  );
  assert.equal(
    extractMediaUrl("let playUrl='/media/a.mp4'", 'https://share.example.com/share/1'),
    'https://share.example.com/media/a.mp4'
  );
});

test('resolver matches declared hosts and caches successful results', async () => {
  const { service, getFetchCount } = createResolver();
  assert.equal(service.canResolve('https://share.example.com/share/abc'), true);
  assert.equal(service.canResolve('https://other.example.com/share/abc'), false);

  const first = await service.resolve('https://share.example.com/share/abc');
  const second = await service.resolve('https://share.example.com/share/abc');
  assert.equal(first.url, 'https://cdn.example/video.m3u8?token=1');
  assert.equal(second.fromCache, true);
  assert.equal(getFetchCount(), 1);
});

test('resolver exposes only configured request and playback headers', () => {
  const { service } = createResolver();
  assert.deepEqual(
    service.getRequestHeaders('https://share.example.com/share/abc'),
    { Referer: 'https://source.example/' }
  );
  assert.equal(
    service.getPlaybackHeaders('https://share.example.com/share/abc').Referer,
    'https://source.example/'
  );
});
