const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { loadConfig } = require('./config');
const { CacheStore } = require('./cacheStore');
const { BangumiProxy } = require('./bangumiProxy');
const { CoverProxy } = require('./coverProxy');
const { RoomRelay } = require('./relay');
const { ReleaseService } = require('./releaseService');
const { applyCommonHeaders, sendJson } = require('./httpUtils');

function createRateLimiter(limit) {
  const buckets = new Map();
  return function check(ip) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= 60_000) {
      bucket = { startedAt: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 5000) {
      for (const [entryKey, value] of buckets) if (now - value.startedAt > 120_000) buckets.delete(entryKey);
    }
    return bucket.count <= limit;
  };
}

function createApplication(config = loadConfig()) {
  const cache = new CacheStore(config.cacheDir, { maxBytes: config.cacheMaxBytes });
  const bangumi = new BangumiProxy({
    cache,
    upstreams: config.upstreams,
    timeoutMs: config.requestTimeoutMs,
    coverProxyBase: config.publicBaseUrl,
    warmCovers: config.coverWarmEnabled ? warmCovers : null
  });
  const covers = new CoverProxy({
    cache,
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.coverMaxBytes
  });
  // 封面预热队列：搜索响应触发，磁盘缓存 + inflight 去重保证每个 URL
  // 只抓一次；并发受控避免打爆镜像图床。seen 集合超限时整体清空——
  // 最坏情况是同一 URL 短时间内重复排队一次，由缓存/inflight 兜底。
  const coverWarmQueue = [];
  const coverWarmSeen = new Set();
  let coverWarming = false;
  function warmCovers(urls) {
    if (!config.coverWarmEnabled || !Array.isArray(urls)) return;
    for (const url of urls) {
      if (typeof url !== 'string' || coverWarmSeen.has(url)) continue;
      coverWarmSeen.add(url);
      coverWarmQueue.push(url);
    }
    if (coverWarmSeen.size > 8000) coverWarmSeen.clear();
    if (coverWarmQueue.length > 240) coverWarmQueue.splice(0, coverWarmQueue.length - 240);
    scheduleCoverWarmPump();
  }
  async function scheduleCoverWarmPump() {
    if (coverWarming) return;
    coverWarming = true;
    try {
      while (coverWarmQueue.length > 0) {
        const batch = coverWarmQueue.splice(0, config.coverWarmConcurrency);
        await Promise.allSettled(batch.map(url => covers.warm(url)));
      }
    } finally {
      coverWarming = false;
    }
  }
  const relay = new RoomRelay({ roomTtlMs: config.roomTtlMs, maxMembers: config.maxRoomMembers });
  const releases = new ReleaseService(config.releaseDir);
  const rateLimit = createRateLimiter(config.rateLimitPerMinute);
  const startedAt = Date.now();

  const handler = async (req, res) => {
    const requestStarted = performance.now();
    const url = new URL(req.url, 'http://localhost');
    const ip = req.socket.remoteAddress;
    applyCommonHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!rateLimit(ip)) {
      sendJson(res, 429, { error: 'rate_limit_exceeded' }, { 'Retry-After': '60' });
      return;
    }
    try {
      if (url.pathname === '/health' || url.pathname === '/ready') {
        const cacheStats = url.pathname === '/health' ? await cache.stats() : undefined;
        sendJson(res, 200, {
          ok: true,
          service: 'sakurafall',
          version: '1.0.0',
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          rooms: relay.rooms.size,
          cache: cacheStats
        });
        return;
      }
      if (await relay.handleHttp(req, res, url)) return;
      if (releases.handle(req, res, url)) return;
      if (await covers.handle(req, res, url)) return;
      if (await bangumi.handle(req, res, url)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      sendJson(res, 500, { error: 'internal_error' });
      console.error(JSON.stringify({ level: 'error', path: url.pathname, message: error.message }));
    } finally {
      if (config.logLevel !== 'silent') {
        console.log(JSON.stringify({
          level: 'info',
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          elapsedMs: Math.round(performance.now() - requestStarted)
        }));
      }
    }
  };

  const tlsEnabled = !!(config.tlsCert && config.tlsKey);
  const server = tlsEnabled
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
    : http.createServer(handler);
  server.on('upgrade', (req, socket, head) => {
    if (!rateLimit(req.socket.remoteAddress) || !relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  return { server, cache, relay, config, tlsEnabled };
}

function start() {
  const app = createApplication();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(JSON.stringify({
      level: 'info',
      event: 'listening',
      host: app.config.host,
      port: app.config.port,
      tls: app.tlsEnabled
    }));
  });
  const shutdown = signal => {
    console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
    app.relay.close();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return app;
}

if (require.main === module) start();

module.exports = { createApplication, createRateLimiter, start };
