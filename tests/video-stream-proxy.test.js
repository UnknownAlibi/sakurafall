const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const {
  buildProxyUrl,
  parseProxyUrl,
  isHlsTarget,
  rewriteHlsManifest,
  setProxy,
  proxyRemoteStream
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

test('视频流线路走代理时上游请求经代理转发，清空代理后回到直连', async () => {
  // 目标服务器（模拟视频直链）
  let targetHits = 0;
  const target = http.createServer((req, res) => {
    targetHits += 1;
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end('video-bytes');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;

  // 本地代理：只统计 CONNECT 隧道，隧道内字节原样转发
  const tunnels = [];
  const proxy = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    tunnels.push(String(req.url));
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port) || 80, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  try {
    // 默认直连：不产生代理隧道
    const direct = await proxyRemoteStream(
      { method: 'GET', headers: {} },
      { target: `http://127.0.0.1:${targetPort}/a.mp4` }
    );
    assert.equal(direct.status, 200);
    assert.equal(await direct.text(), 'video-bytes');
    assert.deepEqual(tunnels, []);

    // 走代理：请求经 CONNECT 隧道到达目标
    setProxy(`http://127.0.0.1:${proxyPort}`);
    const proxied = await proxyRemoteStream(
      { method: 'GET', headers: {} },
      { target: `http://127.0.0.1:${targetPort}/b.mp4` }
    );
    assert.equal(proxied.status, 200);
    assert.equal(await proxied.text(), 'video-bytes');
    assert.deepEqual(tunnels, [`127.0.0.1:${targetPort}`]);

    // 清空代理（线路切回直连）后不再新建隧道
    setProxy('');
    const restored = await proxyRemoteStream(
      { method: 'GET', headers: {} },
      { target: `http://127.0.0.1:${targetPort}/c.mp4` }
    );
    assert.equal(restored.status, 200);
    assert.equal(tunnels.length, 1);
    assert.equal(targetHits, 3);
  } finally {
    setProxy('');
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => target.close(resolve));
  }
});
