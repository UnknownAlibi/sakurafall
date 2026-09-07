const test = require('node:test');
const assert = require('node:assert/strict');
const parseSnapshot = require('../src/main/utils/parseSnapshot');
const HostTaskQueue = require('../src/main/utils/hostTaskQueue');
const playbackPressure = require('../src/main/utils/playbackPressure');

test('background pressure remains active until the last player closes', () => {
  const states = [];
  const windows = new Set();
  const pressure = playbackPressure(windows, () => ({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (_channel, active) => states.push(active) }
  }));
  const a = {};
  const b = {};
  pressure.add(a);
  pressure.add(b);
  pressure.delete(a);
  pressure.delete(b);
  assert.deepEqual(states, [true, true, true, false]);
});

test('worker snapshot parsing preserves batches and metadata', async () => {
  const value = { schemaVersion: 1, generatedAt: 10, subjects: Array.from({ length: 1001 }, (_, id) => ({ id, summary: 'x'.repeat(400) })) };
  assert.deepEqual(await parseSnapshot(JSON.stringify(value)), value);
});

test('worker snapshot parse rejects malformed input and cancellation', async () => {
  await assert.rejects(parseSnapshot(' '.repeat(300000) + '{'));
  const controller = new AbortController();
  const pending = parseSnapshot(JSON.stringify({ subjects: [], padding: 'x'.repeat(300000) }), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('host queues avoid head-of-line blocking and recover failed slots', async () => {
  const queue = new HostTaskQueue({ concurrency: 2, perHost: 1 });
  const started = [];
  let release;
  const first = queue.run('a', () => { started.push('a1'); return new Promise(resolve => { release = resolve; }); });
  const second = queue.run('a', () => { started.push('a2'); throw new Error('expected'); });
  const rejected = assert.rejects(second, /expected/);
  await queue.run('b', () => started.push('b1'));
  assert.deepEqual(started, ['a1', 'b1']);
  release();
  await first;
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queue.active, 0);
  assert.equal(queue.hosts.size, 0);
});
