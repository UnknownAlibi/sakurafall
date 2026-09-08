import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCachedImageUrl, clearImageCacheMemo, getCachedImageUrlSync } from '../src/renderer/utils/imageCache.js';

test('cover cancellation never serializes signals or memoizes stale/failed results', async () => {
  const pending = [];
  const updates = [];
  globalThis.window = { electronAPI: {
    imageCacheGetCover: (url, options) => {
      assert.equal('signal' in options, false);
      structuredClone(options);
      return new Promise(resolve => pending.push({ resolve, options }));
    },
    imageCacheUpdateRequest: async (id, action) => updates.push([id, action])
  } };
  try {
    const url = 'https://images.test/a.jpg';
    const controller = new AbortController();
    const old = resolveCachedImageUrl(url, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    assert.equal(await old, url);
    const next = resolveCachedImageUrl(url);
    await Promise.resolve();
    pending[0].resolve({ success: true, url: 'file:///old.jpg' });
    await Promise.resolve();
    assert.equal(getCachedImageUrlSync(url), null);
    pending[1].resolve({ success: false });
    assert.equal(await next, url);
    assert.equal(getCachedImageUrlSync(url), null);
    const retry = resolveCachedImageUrl(url);
    await Promise.resolve();
    pending[2].resolve({ success: true, url: 'file:///new.jpg' });
    assert.equal(await retry, 'file:///new.jpg');
    assert.equal(getCachedImageUrlSync(url), 'file:///new.jpg');
    assert.equal(updates[0][1], 'cancel');
    const other = resolveCachedImageUrl(url + '?other');
    await Promise.resolve();
    clearImageCacheMemo();
    pending[3].resolve({ success: true, url: 'file:///stale.jpg' });
    await other;
    assert.equal(getCachedImageUrlSync(url + '?other'), null);
  } finally {
    clearImageCacheMemo();
    delete globalThis.window;
  }
});
