const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

class CacheStore {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.maxBytes = Math.max(32 * 1024 * 1024, Number(options.maxBytes) || 768 * 1024 * 1024);
    this._prunePromise = null;
  }

  _paths(namespace, key) {
    const safeNamespace = String(namespace || 'default').replace(/[^a-z0-9_-]/gi, '_');
    const hash = hashKey(key);
    const dir = path.join(this.rootDir, safeNamespace, hash.slice(0, 2));
    return {
      dir,
      body: path.join(dir, `${hash}.bin`),
      meta: path.join(dir, `${hash}.json`)
    };
  }

  async get(namespace, key, options = {}) {
    const files = this._paths(namespace, key);
    try {
      const [rawMeta, body] = await Promise.all([
        fs.readFile(files.meta, 'utf8'),
        fs.readFile(files.body)
      ]);
      const meta = JSON.parse(rawMeta);
      const now = Date.now();
      const stale = now > Number(meta.expiresAt || 0);
      if (stale && (!options.allowStale || now > Number(meta.staleUntil || 0))) return null;
      return { meta, body, stale };
    } catch (error) {
      if (error.code !== 'ENOENT') await this.delete(namespace, key).catch(() => {});
      return null;
    }
  }

  async set(namespace, key, body, options = {}) {
    const files = this._paths(namespace, key);
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const now = Date.now();
    const ttlMs = Math.max(10, Number(options.ttlMs) || 60_000);
    const staleTtlMs = Math.max(ttlMs, Number(options.staleTtlMs) || ttlMs);
    const meta = {
      key: String(key),
      createdAt: now,
      expiresAt: now + ttlMs,
      staleUntil: now + staleTtlMs,
      size: payload.length,
      status: Number(options.status) || 200,
      headers: options.headers || {}
    };
    await fs.mkdir(files.dir, { recursive: true });
    const suffix = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    const bodyTemp = `${files.body}.${suffix}.tmp`;
    const metaTemp = `${files.meta}.${suffix}.tmp`;
    await fs.writeFile(bodyTemp, payload);
    await fs.writeFile(metaTemp, JSON.stringify(meta));
    await fs.rename(bodyTemp, files.body);
    await fs.rename(metaTemp, files.meta);
    this.schedulePrune();
    return meta;
  }

  async delete(namespace, key) {
    const files = this._paths(namespace, key);
    await Promise.allSettled([fs.unlink(files.body), fs.unlink(files.meta)]);
  }

  schedulePrune() {
    if (this._prunePromise) return this._prunePromise;
    this._prunePromise = new Promise(resolve => {
      const timer = setTimeout(resolve, 1000);
      timer.unref?.();
    })
      .then(() => this.prune())
      .catch(() => {})
      .finally(() => { this._prunePromise = null; });
    return this._prunePromise;
  }

  async _listMetadata(dir = this.rootDir) {
    const output = [];
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_) { return output; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        output.push(...await this._listMetadata(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const stat = await fs.stat(fullPath);
          const meta = JSON.parse(await fs.readFile(fullPath, 'utf8'));
          output.push({
            metaPath: fullPath,
            bodyPath: fullPath.replace(/\.json$/, '.bin'),
            size: Number(meta.size) || 0,
            createdAt: Number(meta.createdAt) || stat.mtimeMs
          });
        } catch (_) { /* ignore broken cache entries */ }
      }
    }
    return output;
  }

  async prune() {
    const entries = await this._listMetadata();
    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (totalBytes <= this.maxBytes) return { totalBytes, removed: 0 };
    entries.sort((a, b) => a.createdAt - b.createdAt);
    let removed = 0;
    const target = Math.floor(this.maxBytes * 0.9);
    for (const entry of entries) {
      if (totalBytes <= target) break;
      await Promise.allSettled([fs.unlink(entry.metaPath), fs.unlink(entry.bodyPath)]);
      totalBytes -= entry.size;
      removed += 1;
    }
    return { totalBytes: Math.max(0, totalBytes), removed };
  }

  async stats() {
    const entries = await this._listMetadata();
    return {
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      maxBytes: this.maxBytes
    };
  }
}

module.exports = { CacheStore, hashKey };
