const path = require('node:path');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map(item => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.SAKURAFALL_DATA_DIR || '/var/lib/sakurafall');
  return {
    host: env.SAKURAFALL_HOST || '127.0.0.1',
    port: positiveInteger(env.SAKURAFALL_PORT, 3100),
    publicBaseUrl: String(env.SAKURAFALL_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    dataDir,
    cacheDir: path.join(dataDir, 'cache'),
    releaseDir: path.join(dataDir, 'releases'),
    tlsCert: String(env.SAKURAFALL_TLS_CERT || '').trim(),
    tlsKey: String(env.SAKURAFALL_TLS_KEY || '').trim(),
    upstreams: splitList(env.SAKURAFALL_BANGUMI_UPSTREAMS, [
      'https://bgmapi.anibt.net',
      'https://api.bgm.tv',
      'https://api.bangumi.lol'
    ]),
    requestTimeoutMs: positiveInteger(env.SAKURAFALL_REQUEST_TIMEOUT_MS, 3500),
    cacheMaxBytes: positiveInteger(env.SAKURAFALL_CACHE_MAX_MB, 768) * 1024 * 1024,
    coverMaxBytes: positiveInteger(env.SAKURAFALL_COVER_MAX_MB, 10) * 1024 * 1024,
    // 搜索响应返回时后台预抓封面（r/400 缩略变体），并预取下一页搜索结果，
    // 让客户端滚动加载时封面直接命中服务器磁盘缓存。
    coverWarmEnabled: env.SAKURAFALL_COVER_WARM_ENABLED !== 'false',
    coverWarmConcurrency: positiveInteger(env.SAKURAFALL_COVER_WARM_CONCURRENCY, 6),
    rateLimitPerMinute: positiveInteger(env.SAKURAFALL_RATE_LIMIT_PER_MINUTE, 360),
    roomTtlMs: positiveInteger(env.SAKURAFALL_ROOM_TTL_MINUTES, 30) * 60 * 1000,
    maxRoomMembers: positiveInteger(env.SAKURAFALL_MAX_ROOM_MEMBERS, 24),
    logLevel: env.SAKURAFALL_LOG_LEVEL || 'info'
  };
}

module.exports = { loadConfig, positiveInteger, splitList };
