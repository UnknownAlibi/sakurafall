const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { sendBuffer, sendJson } = require('./httpUtils');

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_FILE_VERSION = 1;
const DEFAULT_CATEGORIES = [0, 1, 2, 3, 5];
const CATEGORY_PLATFORM = { 0: '其他', 1: 'TV', 2: 'OVA', 3: '剧场版', 5: 'WEB' };

function unwrapCoverProxy(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    try {
      const parsed = new URL(value);
      if (parsed.pathname === '/cover' && parsed.searchParams.get('url')) {
        return parsed.searchParams.get('url');
      }
    } catch (_) { /* ordinary strings are expected */ }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => unwrapCoverProxy(item, depth + 1));
  if (typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = unwrapCoverProxy(item, depth + 1);
  return output;
}

function isSubject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Number(value.id || value.bgm_id || value.bgmId) > 0 &&
    (Number(value.type) === 2 || value.type === undefined) &&
    typeof (value.name || value.name_cn) === 'string';
}

function collectSubjects(value, output = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return output;
  if (isSubject(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSubjects(item, output, depth + 1);
    return output;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectSubjects(item, output, depth + 1);
  }
  return output;
}

function toCatalogSubject(subject) {
  const keys = ['id', 'type', 'name', 'name_cn', 'date', 'air_date', 'air_weekday',
    'platform', 'images', 'rating', 'score', 'rank', 'eps', 'total_episodes',
    'collection', 'collection_total', 'nsfw', 'summary', 'aliases'];
  const result = Object.fromEntries(keys.filter(key => subject[key] !== undefined)
    .map(key => [key, subject[key]]));
  result.tags = (subject.tags || []).map(tag => typeof tag === 'string' ? tag : { name: tag.name, count: tag.count });
  result.infobox = (subject.infobox || []).filter(item => /别名|中文名|话数|放送开始|上映年度/.test(item.key || ''));
  return result;
}

class CatalogSnapshotService {
  constructor(options = {}) {
    this.filePath = path.join(options.dataDir || process.cwd(), 'catalog-snapshot.json');
    this.enabled = options.enabled !== false;
    this.warmEnabled = options.warmEnabled === true;
    this.warmIntervalMs = Math.max(60_000, Number(options.warmIntervalMs) || 24 * 60 * 60_000);
    this.warmDelayMs = Math.max(25, Number(options.warmDelayMs) || 180);
    this.pageSize = Math.max(20, Math.min(100, Number(options.pageSize) || 100));
    this.records = new Map();
    this.generatedAt = 0;
    this.lastFullWarmAt = 0;
    this._dirty = false;
    this._writeTimer = null;
    this._warmTimer = null;
    this._warming = null;
    this._bulkIngest = false;
    this._closed = false;
    this._payloadCache = new Map();
    this._payloadCacheBytes = 0;
    this.payloadCacheMaxBytes = Math.max(1024, Number(options.payloadCacheMaxBytes) || 96 * 1024 * 1024);
    this._load();
  }

  _load() {
    if (!this.enabled) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed.fileVersion !== SNAPSHOT_FILE_VERSION || !Array.isArray(parsed.records)) return;
      for (const record of parsed.records) {
        const id = Number(record?.subject?.id || record?.subject?.bgm_id || record?.subject?.bgmId);
        if (!id) continue;
        this.records.set(id, {
          subject: record.subject,
          updatedAt: Number(record.updatedAt) || Number(parsed.generatedAt) || Date.now()
        });
      }
      this.generatedAt = Number(parsed.generatedAt) || 0;
      this.lastFullWarmAt = Number(parsed.lastFullWarmAt) || 0;
    } catch (_) {
      // A missing or partially written file is equivalent to an empty snapshot.
    }
  }

  ingest(value, observedAt = Date.now()) {
    if (!this.enabled || this._closed) return 0;
    observedAt = Math.max(this.generatedAt + 1, Number(observedAt) || Date.now());
    const subjects = collectSubjects(value);
    let changed = 0;
    for (const subject of subjects) {
      const id = Number(subject.id || subject.bgm_id || subject.bgmId);
      if (!id) continue;
      const cleanSubject = unwrapCoverProxy(subject);
      const previous = this.records.get(id);
      const merged = previous ? { ...previous.subject, ...cleanSubject } : cleanSubject;
      const nextJson = JSON.stringify(merged);
      if (previous && JSON.stringify(previous.subject) === nextJson) continue;
      this.records.set(id, { subject: merged, updatedAt: observedAt });
      changed += 1;
    }
    if (changed > 0) {
      this.generatedAt = Math.max(this.generatedAt, observedAt);
      this._dirty = true;
      this._clearPayloadCache();
      if (!this._bulkIngest) this._scheduleWrite();
    }
    return changed;
  }

  _scheduleWrite() {
    if (this._writeTimer || !this.enabled) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      this.flush();
    }, 1500);
    this._writeTimer.unref?.();
  }

  flush() {
    if (!this._dirty || !this.enabled) return false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const payload = {
        fileVersion: SNAPSHOT_FILE_VERSION,
        generatedAt: this.generatedAt,
        lastFullWarmAt: this.lastFullWarmAt,
        records: [...this.records.values()]
      };
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify(payload));
      fs.renameSync(temporaryPath, this.filePath);
      this._dirty = false;
      return true;
    } catch (error) {
      console.warn('[CatalogSnapshot] 写入失败:', error.message);
      return false;
    }
  }

  _buildPayload(since = 0) {
    const safeSince = Math.max(0, Number(since) || 0);
    const key = safeSince > 0 ? `delta:${safeSince}` : 'full';
    const cached = this._payloadCache.get(key);
    if (cached) {
      this._payloadCache.delete(key);
      this._payloadCache.set(key, cached);
      return cached;
    }
    const subjects = [];
    for (const record of this.records.values()) {
      if (safeSince > 0 && record.updatedAt <= safeSince) continue;
      subjects.push(toCatalogSubject(record.subject));
    }
    const body = Buffer.from(JSON.stringify({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: this.generatedAt,
      full: safeSince === 0,
      catalogReady: this.lastFullWarmAt > 0,
      total: this.records.size,
      subjects
    }));
    const gzip = zlib.gzipSync(body, { level: 6 });
    const etag = `\"${crypto.createHash('sha1').update(gzip).digest('hex')}\"`;
    const result = { body, gzip, etag };
    const bytes = body.byteLength + gzip.byteLength;
    if (bytes <= this.payloadCacheMaxBytes) {
      while (this._payloadCache.size && (this._payloadCache.size >= 8 || this._payloadCacheBytes + bytes > this.payloadCacheMaxBytes)) {
        const oldest = this._payloadCache.keys().next().value;
        const evicted = this._payloadCache.get(oldest);
        this._payloadCacheBytes -= evicted.body.byteLength + evicted.gzip.byteLength;
        this._payloadCache.delete(oldest);
      }
      this._payloadCache.set(key, result);
      this._payloadCacheBytes += bytes;
    }
    return result;
  }

  _clearPayloadCache() {
    this._payloadCache.clear();
    this._payloadCacheBytes = 0;
  }

  handle(req, res, url) {
    if (url.pathname !== '/v1/catalog/snapshot') return false;
    if (!['GET', 'HEAD'].includes(req.method)) {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return true;
    }
    const since = Number(url.searchParams.get('since')) || 0;
    const payload = this._buildPayload(since);
    if (req.headers['if-none-match'] === payload.etag) {
      res.writeHead(304, { ETag: payload.etag });
      res.end();
      return true;
    }
    const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(String(req.headers['accept-encoding'] || ''));
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      ETag: payload.etag,
      Vary: 'Accept-Encoding',
      'X-SakuraFall-Catalog-Count': String(this.records.size)
    };
    if (acceptsGzip) headers['Content-Encoding'] = 'gzip';
    sendBuffer(res, 200, acceptsGzip ? payload.gzip : payload.body, headers, req.method);
    return true;
  }

  startWarmup(fetchPage) {
    if (this._closed || !this.enabled || !this.warmEnabled || typeof fetchPage !== 'function') return;
    if (this._warmTimer) clearTimeout(this._warmTimer);
    const run = () => {
      this._warmTimer = null;
      this.warm(fetchPage).catch(error => console.warn('[CatalogSnapshot] 预热失败:', error.message));
    };
    const initialDelay = this.lastFullWarmAt > 0 ? 30_000 : 2_000;
    this._warmTimer = setTimeout(run, initialDelay);
    this._warmTimer.unref?.();
  }

  warm(fetchPage) {
    if (this._closed) return Promise.resolve({ skipped: true });
    if (this._warming) return this._warming;
    let succeeded = false;
    this._warming = this._runWarm(fetchPage)
      .then(result => {
        succeeded = true;
        return result;
      })
      .finally(() => {
        this._warming = null;
        if (this._closed || !this.warmEnabled) return;
        const nextDelay = succeeded ? this.warmIntervalMs : Math.min(this.warmIntervalMs, 10 * 60 * 1000);
        this._warmTimer = setTimeout(() => this.warm(fetchPage).catch(() => {}), nextDelay);
        this._warmTimer.unref?.();
      });
    return this._warming;
  }

  async _runWarm(fetchPage) {
    // Keep published data unchanged until every category has a complete scan.
    const staged = new Map();
    for (const category of DEFAULT_CATEGORIES) {
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      const seen = new Set();
      while (offset < total && offset <= 10_000) {
        if (this._closed) return { skipped: true };
        const observedAt = this.generatedAt;
        const page = await fetchPage({ category, limit: this.pageSize, offset });
        if (this._closed) return { skipped: true };
        const items = Array.isArray(page?.data)
          ? page.data.map(item => ({ ...item, platform: item.platform || CATEGORY_PLATFORM[category] || '' }))
          : [];
        const nextTotal = Number(page?.total);
        if (!Number.isSafeInteger(nextTotal) || nextTotal < 0) throw new Error('Catalog returned an invalid total');
        if (Number.isFinite(total) && nextTotal !== total) throw new Error('Catalog total changed during scan');
        total = nextTotal;
        if (total > 10_000 + this.pageSize) throw new Error('Catalog category exceeds scan range');
        if (items.length === 0 && offset < total) throw new Error('Catalog returned an incomplete page');
        if (offset + items.length > total) throw new Error('Catalog page exceeds reported total');
        for (const item of items) {
          const id = Number(item.id || item.bgm_id || item.bgmId);
          if (!isSubject(item) || !Number.isSafeInteger(id) || seen.has(id)) throw new Error('Catalog returned an invalid or repeated subject');
          seen.add(id);
          staged.set(id, { subject: item, observedAt });
        }
        if (items.length === 0) break;
        offset += items.length;
        if (offset < total) await new Promise(resolve => setTimeout(resolve, this.warmDelayMs));
      }
      if (offset !== total) throw new Error('Catalog scan ended before reported total');
    }
    if (this._closed) return { skipped: true };
    this._bulkIngest = true;
    try {
      this.ingest([...staged.entries()]
        .filter(([id, record]) => (this.records.get(id)?.updatedAt || 0) <= record.observedAt)
        .map(([, record]) => record.subject));
    } finally {
      this._bulkIngest = false;
    }
    this.lastFullWarmAt = Date.now();
    this.generatedAt = Math.max(this.generatedAt, this.lastFullWarmAt);
    this._dirty = true;
    this._clearPayloadCache();
    this.flush();
    return { total: this.records.size, generatedAt: this.generatedAt };
  }

  close() {
    this._closed = true;
    if (this._writeTimer) clearTimeout(this._writeTimer);
    if (this._warmTimer) clearTimeout(this._warmTimer);
    this._writeTimer = null;
    this._warmTimer = null;
    this.flush();
  }
}

module.exports = {
  CatalogSnapshotService,
  SNAPSHOT_SCHEMA_VERSION,
  collectSubjects,
  isSubject,
  unwrapCoverProxy
};
