const fs = require('fs');
const path = require('path');

const MAX_STRING_LENGTH = 4000;
const MAX_CONTEXT_DEPTH = 4;

function trimString(value) {
  const text = String(value || '');
  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}...[truncated]` : text;
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return trimString(value);
  if (typeof value === 'function') return '[function]';
  if (depth >= MAX_CONTEXT_DEPTH) return '[depth-limit]';
  if (typeof value !== 'object') return trimString(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 30).map(item => sanitizeValue(item, depth + 1, seen));
  }

  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) {
      output[key] = '[redacted]';
    } else {
      output[key] = sanitizeValue(item, depth + 1, seen);
    }
  }
  return output;
}

class RuntimeDiagnosticsService {
  constructor(options = {}) {
    this.baseDir = options.baseDir || '';
    this.maxFiles = Math.max(2, Number(options.maxFiles) || 7);
    this.maxFileBytes = Math.max(64 * 1024, Number(options.maxFileBytes) || 2 * 1024 * 1024);
    this.appVersion = options.appVersion || '';
    this.platform = options.platform || process.platform;
  }

  setBaseDir(baseDir) {
    this.baseDir = String(baseDir || '');
  }

  report(type, details = {}) {
    if (!this.baseDir) return null;
    try {
      fs.mkdirSync(this.baseDir, { recursive: true });
      const filePath = this._activeLogPath();
      const record = {
        timestamp: new Date().toISOString(),
        type: trimString(type || 'runtime-event'),
        appVersion: this.appVersion,
        platform: this.platform,
        pid: process.pid,
        details: sanitizeValue(details)
      };
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
      this._prune();
      return record;
    } catch (_) {
      return null;
    }
  }

  captureError(type, error, context = {}) {
    const normalized = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack, code: error.code }
      : { message: trimString(error) };
    return this.report(type, { error: normalized, context });
  }

  getSummary() {
    const files = this._listFiles();
    return {
      logDir: this.baseDir,
      files: files.map(file => ({ name: file.name, size: file.size, updatedAt: file.mtimeMs })),
      latest: this._readTail(files[0]?.path, 20)
    };
  }

  _activeLogPath() {
    const date = new Date().toISOString().slice(0, 10);
    const base = path.join(this.baseDir, `runtime-${date}.jsonl`);
    try {
      if (!fs.existsSync(base) || fs.statSync(base).size < this.maxFileBytes) return base;
    } catch (_) {
      return base;
    }
    let index = 1;
    while (fs.existsSync(path.join(this.baseDir, `runtime-${date}-${index}.jsonl`))) index += 1;
    return path.join(this.baseDir, `runtime-${date}-${index}.jsonl`);
  }

  _listFiles() {
    if (!this.baseDir || !fs.existsSync(this.baseDir)) return [];
    return fs.readdirSync(this.baseDir)
      .filter(name => /^runtime-.*\.jsonl$/.test(name))
      .map(name => {
        const filePath = path.join(this.baseDir, name);
        const stat = fs.statSync(filePath);
        return { name, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  _readTail(filePath, limit) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).map(line => JSON.parse(line));
    } catch (_) {
      return [];
    }
  }

  _prune() {
    const files = this._listFiles();
    for (const file of files.slice(this.maxFiles)) {
      try { fs.unlinkSync(file.path); } catch (_) { /* ignore cleanup failure */ }
    }
  }
}

module.exports = { RuntimeDiagnosticsService, sanitizeValue };
