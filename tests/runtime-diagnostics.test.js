const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RuntimeDiagnosticsService, sanitizeValue } = require('../src/main/services/RuntimeDiagnosticsService');

test('runtime diagnostics writes structured JSONL and redacts secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakurafall-diag-'));
  try {
    const service = new RuntimeDiagnosticsService({ baseDir: dir, appVersion: 'test' });
    service.captureError('renderer-error', new Error('boom'), { token: 'private', route: '/anime' });
    const summary = service.getSummary();
    assert.equal(summary.files.length, 1);
    assert.equal(summary.latest[0].type, 'renderer-error');
    assert.equal(summary.latest[0].details.context.token, '[redacted]');
    assert.equal(summary.latest[0].details.context.route, '/anime');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeValue handles circular and oversized renderer payloads', () => {
  const value = { password: 'secret', text: 'x'.repeat(5000) };
  value.self = value;
  const sanitized = sanitizeValue(value);
  assert.equal(sanitized.password, '[redacted]');
  assert.match(sanitized.text, /truncated/);
  assert.equal(sanitized.self, '[circular]');
});
