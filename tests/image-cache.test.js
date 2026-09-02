const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ImageCacheService } = require('../src/main/services/ImageCacheService');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

function createImageServer() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': PNG_1X1.length
    });
    res.end(PNG_1X1);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/cover.png`,
        close: () => new Promise(done => server.close(done)),
        hits: () => hits
      });
    });
  });
}

test('ImageCacheService: normalizes only remote image urls', () => {
  const cache = new ImageCacheService({ cacheDir: path.join(os.tmpdir(), `img-cache-${Date.now()}`) });
  assert.equal(cache.normalizeImageUrl('//example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.equal(cache.normalizeImageUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.equal(cache.normalizeImageUrl('file:///tmp/a.jpg'), '');
  assert.equal(cache.normalizeImageUrl('data:image/png;base64,abc'), '');
  cache.clear();
});

test('ImageCacheService: uses Bangumi mirror resize endpoints for thumbnails', () => {
  const cache = new ImageCacheService();
  const mirrorCover = 'http://lain.bangumi.lol/pic/cover/l/fa/da/example.jpg';
  const anibtCover = 'https://bgmimg.anibt.net/pic/cover/l/fa/da/example.jpg';

  assert.equal(
    cache._variantSourceUrl(mirrorCover, { type: 'thumbnail', width: 160 }),
    'https://lain.bangumi.lol/r/200/pic/cover/l/fa/da/example.jpg'
  );
  assert.equal(
    cache._variantSourceUrl(anibtCover, { type: 'thumbnail', width: 720 }),
    'https://bgmimg.anibt.net/r/800/pic/cover/l/fa/da/example.jpg'
  );
  assert.equal(
    cache._variantSourceUrl('https://lain.bgm.tv/pic/crt/l/ab/cd/example.jpg', { type: 'thumbnail', width: 240 }),
    'https://lain.bgm.tv/r/400/pic/crt/l/ab/cd/example.jpg'
  );
  assert.equal(cache._variantSourceUrl(mirrorCover, { type: 'original' }), mirrorCover);

  const proxiedCover = `https://47.109.87.3:8443/cover?url=${encodeURIComponent(anibtCover)}`;
  const proxiedThumbnail = new URL(cache._variantSourceUrl(
    proxiedCover,
    { type: 'thumbnail', width: 360 }
  ));
  assert.equal(
    proxiedThumbnail.searchParams.get('url'),
    'https://bgmimg.anibt.net/r/400/pic/cover/l/fa/da/example.jpg'
  );

  const proxiedCommonCover = `https://47.109.87.3:8443/cover?url=${encodeURIComponent(
    'https://bgmimg.anibt.net/pic/cover/c/fa/da/example.jpg'
  )}`;
  const proxiedCommonThumbnail = new URL(cache._variantSourceUrl(
    proxiedCommonCover,
    { type: 'thumbnail', width: 480 }
  ));
  assert.equal(
    proxiedCommonThumbnail.searchParams.get('url'),
    'https://bgmimg.anibt.net/r/600/pic/cover/l/fa/da/example.jpg'
  );
});

test('ImageCacheService: falls back to the embedded original when the cover proxy is offline', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-proxy-fallback-'));
  const cache = new ImageCacheService({ cacheDir, maxEntries: 10 });
  const direct = 'https://lain.bgm.tv/pic/cover/l/test.jpg';
  const proxy = `https://47.109.87.3:8443/cover?url=${encodeURIComponent(direct)}`;
  const attempts = [];
  cache._fetchBuffer = async url => {
    attempts.push(url);
    if (url.startsWith('https://47.109.87.3:8443/')) throw new Error('service offline');
    return { buffer: PNG_1X1, contentType: 'image/png' };
  };

  try {
    const result = await cache.getCover(proxy);
    assert.equal(result.success, true);
    assert.deepEqual(attempts, [proxy, direct]);
    assert.equal(cache._isProxyFallbackCooling(proxy), true);
  } finally {
    cache.clear();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('ImageCacheService: stores an upstream thumbnail without decoding it again', async () => {
  const server = await createImageServer();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-upstream-thumb-cache-'));
  let processed = 0;
  const cache = new ImageCacheService({
    cacheDir,
    maxEntries: 10,
    imageProcessor: async buffer => {
      processed += 1;
      return { buffer, contentType: 'image/png', ext: '.png' };
    }
  });
  cache._variantSourceUrl = url => `${url}?width=400`;

  try {
    const thumbnail = await cache.getCover(server.url, { variant: 'thumbnail', width: 360 });
    assert.equal(thumbnail.success, true);
    assert.equal(processed, 0);
    assert.equal(server.hits(), 1);
  } finally {
    cache.clear();
    await server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('ImageCacheService: downloads image once and reuses local file', async () => {
  const server = await createImageServer();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-cache-'));
  const cache = new ImageCacheService({ cacheDir, maxEntries: 10 });

  try {
    const first = await cache.getCover(server.url);
    assert.equal(first.success, true);
    assert.equal(first.fromCache, false);
    assert.equal(server.hits(), 1);
    assert.equal(first.url.startsWith('file:'), true);

    const filePath = decodeURIComponent(new URL(first.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    assert.equal(fs.existsSync(filePath), true);

    const second = await cache.getCover(server.url);
    assert.equal(second.success, true);
    assert.equal(second.fromCache, true);
    assert.equal(second.url, first.url);
    assert.equal(server.hits(), 1);

    const cleared = cache.clear();
    assert.equal(cleared.removed, 1);
  } finally {
    await server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('ImageCacheService: stores thumbnails separately from original covers', async () => {
  const server = await createImageServer();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-thumb-cache-'));
  let processed = 0;
  const cache = new ImageCacheService({
    cacheDir,
    maxEntries: 10,
    imageProcessor: async (buffer, options) => {
      processed += 1;
      assert.equal(options.type, 'thumbnail');
      assert.equal(options.width, 360);
      return { buffer, contentType: 'image/png', ext: '.png' };
    }
  });

  try {
    const thumbnail = await cache.getCover(server.url, { variant: 'thumbnail', width: 360 });
    const cachedThumbnail = await cache.getCover(server.url, { variant: 'thumbnail', width: 360 });
    const original = await cache.getCover(server.url);
    const allCached = cache.getAllCachedUrls();
    const batchCached = cache.batchLookupCachedUrls(
      [server.url],
      { variant: 'thumbnail', width: 360 }
    );

    assert.equal(thumbnail.success, true);
    assert.equal(cachedThumbnail.url, thumbnail.url);
    assert.notEqual(original.url, thumbnail.url);
    assert.equal(processed, 1);
    assert.equal(server.hits(), 2);
    assert.equal(allCached[`${server.url}::thumbnail:360`], thumbnail.url);
    assert.equal(batchCached[`${server.url}::thumbnail:360`], thumbnail.url);
  } finally {
    cache.clear();
    await server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('ImageCacheService: derives a thumbnail from an existing original without another download', async () => {
  const server = await createImageServer();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-original-cache-'));
  const cache = new ImageCacheService({
    cacheDir,
    maxEntries: 10,
    imageProcessor: async buffer => ({ buffer, contentType: 'image/png', ext: '.png' })
  });

  try {
    const original = await cache.getCover(server.url);
    const thumbnail = await cache.getCover(server.url, { variant: 'thumbnail', width: 360 });

    assert.equal(original.success, true);
    assert.equal(thumbnail.success, true);
    assert.notEqual(original.url, thumbnail.url);
    assert.equal(server.hits(), 1);
  } finally {
    cache.clear();
    await server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
