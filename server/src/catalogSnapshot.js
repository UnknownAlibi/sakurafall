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

/**
 * 条目是否带可用封面。列表接口对刚建条目的 images 常是空字符串，
 * 用它判断"这次观察到的封面是不是空壳"，避免把已抓到的封面覆盖掉。
 */
function hasUsableImages(subject) {
  const images = subject?.images;
  if (!images || typeof images !== 'object') return false;
  return Object.values(images).some(value => typeof value === 'string' && value.trim());
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
    // 公网镜像单页可能要几秒，偶发超时不该让整轮预热作废：单页重试 + 退避
    this.warmFetchAttempts = Math.max(1, Number(options.warmFetchAttempts) || 3);
    this.warmRetryDelayMs = Math.max(200, Number(options.warmRetryDelayMs) || 1200);
    // 每轮预热顺带用详情接口重抓多少个"无封面"条目（0 = 关闭）。
    // 列表接口对新建条目的 images 常为空，只靠列表页永远补不上封面。
    this.coverRefillLimit = Math.max(0, Number(options.coverRefillLimit) || 200);
    this.coverRefillDelayMs = Math.max(50, Number(options.coverRefillDelayMs) || 350);
    // 补图游标：每轮从上次结束的位置继续，避免"永远重试最前面那 200 条"，
    // 让真正有图的条目在有限轮次内都能被覆盖到。
    this._coverRefillCursorId = 0;
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
      // 稀疏观察（列表接口 images 为空）不得抹掉已抓到的封面
      if (previous && !hasUsableImages(cleanSubject) && hasUsableImages(previous.subject)) {
        merged.images = previous.subject.images;
      }
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
    const etag = `"${crypto.createHash('sha1').update(gzip).digest('hex')}"`;
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

  startWarmup(fetchPage, fetchDetail) {
    if (this._closed || !this.enabled || !this.warmEnabled || typeof fetchPage !== 'function') return;
    if (this._warmTimer) clearTimeout(this._warmTimer);
    const run = () => {
      this._warmTimer = null;
      this.warm(fetchPage, fetchDetail).catch(error => console.warn('[CatalogSnapshot] 预热失败:', error.message));
    };
    const initialDelay = this.lastFullWarmAt > 0 ? 30_000 : 2_000;
    this._warmTimer = setTimeout(run, initialDelay);
    this._warmTimer.unref?.();
  }

  warm(fetchPage, fetchDetail) {
    if (this._closed) return Promise.resolve({ skipped: true });
    if (this._warming) return this._warming;
    let succeeded = false;
    this._warming = this._runWarm(fetchPage, fetchDetail)
      .then(result => {
        succeeded = true;
        return result;
      })
      .finally(() => {
        this._warming = null;
        if (this._closed || !this.warmEnabled) return;
        const nextDelay = succeeded ? this.warmIntervalMs : Math.min(this.warmIntervalMs, 10 * 60 * 1000);
        this._warmTimer = setTimeout(() => this.warm(fetchPage, fetchDetail).catch(() => {}), nextDelay);
        this._warmTimer.unref?.();
      });
    return this._warming;
  }

  /** 单页抓取失败时重试：镜像偶发超时不应让整轮预热作废 */
  async _fetchPageWithRetry(fetchPage, category, offset) {
    const attempts = this.warmFetchAttempts;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchPage({ category, limit: this.pageSize, offset });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, this.warmRetryDelayMs * attempt));
        }
      }
    }
    throw lastError;
  }

  async _runWarm(fetchPage, fetchDetail) {
    // Keep published data unchanged until every category has a complete scan.
    const staged = new Map();
    // 慢镜像一轮要跑 20 分钟以上，期间目录会新增条目：分页位移会造成
    // 同一 id 跨页重复、total 变大。这些属于正常抖动，记录下来继续跑；
    // 只有"页数据不完整/非法条目"才让整轮作废。
    let duplicateCount = 0;
    let totalDriftCount = 0;
    console.log(JSON.stringify({
      level: 'info',
      event: 'catalog-warm-start',
      records: this.records.size,
      generatedAt: this.generatedAt
    }));
    for (const category of DEFAULT_CATEGORIES) {
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      const seen = new Set();
      while (offset < total && offset <= 10_000) {
        if (this._closed) return { skipped: true };
        const observedAt = this.generatedAt;
        const page = await this._fetchPageWithRetry(fetchPage, category, offset);
        if (this._closed) return { skipped: true };
        const items = Array.isArray(page?.data)
          ? page.data.map(item => ({ ...item, platform: item.platform || CATEGORY_PLATFORM[category] || '' }))
          : [];
        const nextTotal = Number(page?.total);
        if (!Number.isSafeInteger(nextTotal) || nextTotal < 0) throw new Error('Catalog returned an invalid total');
        if (Number.isFinite(total) && nextTotal !== total) {
          // 扫描期间新条目入库会让 total 增长；只拒绝"缩到已扫位置以下"的异常情况
          if (nextTotal < offset) throw new Error('Catalog total shrank below scanned offset');
          totalDriftCount += 1;
        }
        total = nextTotal;
        if (total > 10_000 + this.pageSize) throw new Error('Catalog category exceeds scan range');
        if (items.length === 0 && offset < total) throw new Error('Catalog returned an incomplete page');
        if (offset + items.length > total) items.length = Math.max(0, total - offset);
        for (const item of items) {
          const id = Number(item.id || item.bgm_id || item.bgmId);
          if (!isSubject(item) || !Number.isSafeInteger(id)) throw new Error('Catalog returned an invalid subject');
          if (seen.has(id)) {
            duplicateCount += 1;
            continue;
          }
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
    const refilled = await this._refillMissingCovers(fetchDetail);
    // 运维可见性：一整轮预热 + 补图可能要跑很久，完成后留一条记录便于核对
    console.log(JSON.stringify({
      level: 'info',
      event: 'catalog-warm',
      total: this.records.size,
      refilled,
      duplicates: duplicateCount,
      totalDrift: totalDriftCount,
      generatedAt: this.generatedAt
    }));
    return { total: this.records.size, generatedAt: this.generatedAt, refilled };
  }

  /**
   * 用详情接口补抓"无封面"条目的 images。
   * 列表接口对刚建的条目经常返回空 images，仅靠列表页扫描永远补不上；
   * 每轮限量 + 限速，避免给上游造成压力。
   * @param {(id: number) => Promise<object>} fetchDetail
   * @returns {Promise<number>} 实际补到的条数
   */
  async _refillMissingCovers(fetchDetail) {
    if (this._closed || !this.enabled || this.coverRefillLimit <= 0) return 0;
    if (typeof fetchDetail !== 'function') return 0;
    const emptyIds = [];
    for (const [id, record] of this.records) {
      if (!hasUsableImages(record.subject)) emptyIds.push(id);
    }
    if (emptyIds.length === 0) return 0;
    emptyIds.sort((a, b) => a - b);
    // 从游标处继续（到尾再绕回开头）：否则每轮都重试最前面那批无图条目，
    // 排在后面的条目永远等不到补图机会。
    let startIndex = 0;
    if (this._coverRefillCursorId > 0) {
      const found = emptyIds.findIndex(id => id > this._coverRefillCursorId);
      startIndex = found >= 0 ? found : 0;
    }
    const ordered = startIndex > 0
      ? [...emptyIds.slice(startIndex), ...emptyIds.slice(0, startIndex)]
      : emptyIds;
    const pending = ordered.slice(0, this.coverRefillLimit);

    let updated = 0;
    let failed = 0;
    let noImage = 0;
    for (const id of pending) {
      if (this._closed) break;
      try {
        const detail = await fetchDetail(id);
        const subject = collectSubjects(detail)[0];
        if (!subject || !hasUsableImages(subject)) {
          // 上游本身就没有封面（大量冷门条目属于这种），换下一条
          noImage += 1;
        } else if (this.ingest(subject) > 0) {
          updated += 1;
        }
      } catch (_error) {
        failed += 1;
      }
      if (this.coverRefillDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.coverRefillDelayMs));
      }
    }
    this._coverRefillCursorId = pending[pending.length - 1] || 0;
    if (updated > 0) this.flush();
    console.log(JSON.stringify({
      level: 'info',
      event: 'catalog-cover-refill',
      empty: emptyIds.length,
      scanned: pending.length,
      updated,
      noImage,
      failed,
      cursor: this._coverRefillCursorId
    }));
    return updated;
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
