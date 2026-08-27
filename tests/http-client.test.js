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
