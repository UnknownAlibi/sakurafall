const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const HttpClient = require('../src/main/utils/HttpClient');

function createTextServer(delayMs = 0) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`hit-${hits}`);
    }, delayMs);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/data`,
        hits: () => hits,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

test('HttpClient: dedupes identical in-flight GET requests', async () => {
  const server = await createTextServer(25);
  const client = new HttpClient({ timeout: 5000 });

  try {
    const [first, second] = await Promise.all([
      client.fetch(server.url),
      client.fetch(server.url)
    ]);

    assert.equal(first, second);
    assert.equal(server.hits(), 1);

    await client.fetch(server.url);
    assert.equal(server.hits(), 2);
  } finally {
    await server.close();
  }
});

test('HttpClient: binary snapshot responses never share a text response promise', async () => {
  const server = await createTextServer(10);
  const client = new HttpClient();
  try {
    const [text, buffer] = await Promise.all([
      client.fetch(server.url), client.fetch(server.url, { responseType: 'buffer' })
    ]);
    assert.equal(typeof text, 'string');
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(server.hits(), 2);
  } finally { await server.close(); }
});

test('HttpClient: does not dedupe abortable requests', async () => {
  const server = await createTextServer(25);
  const client = new HttpClient({ timeout: 5000 });
  const first = new AbortController();
  const second = new AbortController();

  try {
    await Promise.all([
      client.fetch(server.url, { signal: first.signal }),
      client.fetch(server.url, { signal: second.signal })
    ]);

    assert.equal(server.hits(), 2);
  } finally {
    await server.close();
  }
});

test('HttpClient: rejects responses larger than the configured limit', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x'.repeat(96 * 1024));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/large`;
  const client = new HttpClient({ timeout: 5000, maxResponseBytes: 64 * 1024 });

  try {
    await assert.rejects(
      client.fetch(url),
      error => error?.code === 'RESPONSE_TOO_LARGE'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('HttpClient: rejects non-success HTTP status codes', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>not found</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/missing`;
  const client = new HttpClient({ timeout: 5000 });

  try {
    await assert.rejects(
      client.fetch(url),
      error => error?.code === 'HTTP_STATUS' && error?.statusCode === 404
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('HttpClient: cross-origin redirect strips authorization headers', async () => {
  let seenAuth = null;
  let seenEmby = null;
  const target = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || null;
    seenEmby = req.headers['x-emby-token'] || null;
    res.end('ok');
  });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetUrl = `http://127.0.0.1:${target.address().port}/target`;

  const redirector = http.createServer((_req, res) => {
    res.writeHead(302, { Location: targetUrl });
    res.end();
  });
  await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
  const redirectUrl = `http://127.0.0.1:${redirector.address().port}/start`;

  const client = new HttpClient({ timeout: 5000 });
  try {
    const body = await client.fetch(redirectUrl, {
      headers: {
        Authorization: 'Bearer should-not-leak',
        'X-Emby-Token': 'emby-token-should-not-leak'
      }
    });
    assert.equal(body, 'ok');
    assert.equal(seenAuth, null, '跨域重定向必须移除 Authorization');
    assert.equal(seenEmby, null, '跨域重定向必须移除 X-Emby-Token');
  } finally {
    await new Promise(resolve => target.close(resolve));
    await new Promise(resolve => redirector.close(resolve));
  }
});

test('HttpClient: same-origin redirect keeps authorization headers', async () => {
  let seenAuth = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/target' });
      res.end();
      return;
    }
    seenAuth = req.headers.authorization || null;
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/start`;
  const client = new HttpClient({ timeout: 5000 });

  try {
    const body = await client.fetch(url, { headers: { Authorization: 'Bearer keep' } });
    assert.equal(body, 'ok');
    assert.equal(seenAuth, 'Bearer keep');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('HttpClient: rejects redirects to non-http protocols', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: 'file:///etc/passwd' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/escape`;
  const client = new HttpClient({ timeout: 5000 });

  try {
    await assert.rejects(
      client.fetch(url),
      error => error?.code === 'UNSAFE_REDIRECT'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
