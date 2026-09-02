const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { CacheStore } = require('../src/cacheStore');

test('cache store distinguishes fresh and stale values', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakurafall-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new CacheStore(root);
  await cache.set('test', 'key', Buffer.from('value'), { ttlMs: 20, staleTtlMs: 200 });
  const fresh = await cache.get('test', 'key', { allowStale: true });
  assert.equal(fresh.body.toString(), 'value');
  assert.equal(fresh.stale, false);
  await new Promise(resolve => setTimeout(resolve, 30));
  const stale = await cache.get('test', 'key', { allowStale: true });
  assert.equal(stale.body.toString(), 'value');
  assert.equal(stale.stale, true);
  assert.equal(await cache.get('test', 'key'), null);
});
