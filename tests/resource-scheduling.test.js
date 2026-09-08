const test = require('node:test');
const assert = require('node:assert/strict');
const parseSnapshot = require('../src/main/utils/parseSnapshot');
const HostTaskQueue = require('../src/main/utils/hostTaskQueue');
const playbackPressure = require('../src/main/utils/playbackPressure');
const SharedRequests = require('../src/main/utils/sharedRequests');
const openSnapshot = require('../src/main/utils/openSnapshot');
const tick = () => new Promise(resolve => setImmediate(resolve));

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
  assert.deepEqual(await parseSnapshot(Buffer.from(JSON.stringify(value))), value);
});

test('worker snapshot parse rejects malformed input and cancellation', async () => {
  await assert.rejects(parseSnapshot(' '.repeat(300000) + '{'));
  const controller = new AbortController();
  const pending = parseSnapshot(JSON.stringify({ subjects: [], padding: 'x'.repeat(300000) }), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('streaming snapshots validate all subjects before delivering the first batch', async () => {
  const subjects = Array.from({ length: 1001 }, (_, id) => ({ id: id + 1, name: 'sample' }));
  const snapshot = await openSnapshot(JSON.stringify({ schemaVersion: 1, generatedAt: 1, subjects }));
  const sizes = [];
  const ids = [];
  assert.equal(Array.isArray(snapshot.subjects), false);
  for await (const batch of snapshot.subjects) {
    sizes.push(batch.length);
    ids.push(...batch.map(item => item.id));
  }
  assert.deepEqual(sizes, [200, 200, 200, 200, 200, 1]);
  assert.deepEqual(ids, subjects.map(item => item.id));
  subjects.at(-1).id = -1;
  await assert.rejects(openSnapshot(JSON.stringify({ schemaVersion: 1, subjects })), /Invalid catalog/);
});

test('stream consumers can abandon or cancel a partially consumed snapshot', async () => {
  const text = JSON.stringify({ schemaVersion: 1, subjects: Array.from({ length: 400 }, (_, id) => ({ id: id + 1 })) });
  const snapshot = await openSnapshot(text);
  for await (const batch of snapshot.subjects) { assert.equal(batch.length, 200); break; }
  assert.deepEqual(await snapshot.subjects.next(), { done: true });
  const controller = new AbortController();
  const cancelled = await openSnapshot(text, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled.subjects.next(), { name: 'AbortError' });
});

test('snapshot streaming explicitly transfers owned binary input without cloning it', async () => {
  const text = JSON.stringify({ schemaVersion: 1, padding: 'x'.repeat(300000), subjects: [{ id: 1 }] });
  const buffer = Buffer.allocUnsafeSlow(Buffer.byteLength(text));
  buffer.write(text);
  const snapshot = await openSnapshot(buffer, { transferBuffer: true });
  assert.equal(buffer.byteLength, 0);
  assert.equal((await snapshot.subjects.next()).value[0].id, 1);
  snapshot.close();
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

test('queue cancellation, priority promotion and timeout do not leak slots', async () => {
  const queue = new HostTaskQueue({ concurrency: 1, queueTimeoutMs: 60 });
  let release;
  const busy = queue.run('a', () => new Promise(resolve => { release = resolve; }));
  await tick();
  const order = [];
  let priority = 20;
  const background = queue.run('b', () => order.push('background'), { priority: () => priority });
  const foreground = queue.run('c', () => order.push('foreground'), { priority: () => 5 });
  const controller = new AbortController();
  const cancelled = assert.rejects(queue.run('d', () => assert.fail('cancelled task ran'), { signal: controller.signal }), { name: 'AbortError' });
  controller.abort();
  priority = 0;
  release();
  await Promise.all([busy, background, foreground, cancelled]);
  assert.deepEqual(order, ['background', 'foreground']);
  await tick();
  const block = queue.run('a', () => new Promise(resolve => { release = resolve; }));
  await tick();
  await assert.rejects(queue.run('b', () => assert.fail('expired task ran')), /wait timed out/);
  release();
  await block;
  await tick();
  assert.equal(queue.active, 0);
  assert.equal(queue.queue.length, 0);
});

test('aged prefetch eventually runs before fresh visible work', async () => {
  let now = 0;
  const queue = new HostTaskQueue({ concurrency: 1, now: () => now });
  let release;
  const busy = queue.run('a', () => new Promise(resolve => { release = resolve; }));
  await tick();
  const order = [];
  const old = queue.run('b', () => order.push('old'), { priority: () => 20 });
  now = 21000;
  const fresh = queue.run('c', () => order.push('fresh'));
  release();
  await Promise.all([busy, old, fresh]);
  assert.deepEqual(order, ['old', 'fresh']);
});

test('shared consumers cancel independently and a replaced job survives old cleanup', async () => {
  const shared = new SharedRequests();
  const a = new AbortController();
  const b = new AbortController();
  let release, underlyingSignal, runs = 0;
  const start = ({ signal }) => { runs++; underlyingSignal = signal; return new Promise(resolve => { release = resolve; }); };
  const first = assert.rejects(shared.run('key', start, { signal: a.signal }), { name: 'AbortError' });
  const second = assert.rejects(shared.run('key', start, { signal: b.signal }), { name: 'AbortError' });
  await tick();
  a.abort();
  assert.equal(underlyingSignal.aborted, false);
  b.abort();
  assert.equal(underlyingSignal.aborted, true);
  const oldRelease = release;
  const replacement = shared.run('key', start);
  await tick();
  oldRelease('obsolete');
  await tick();
  assert.equal(shared.entries.size, 1);
  release('new');
  assert.equal(await replacement, 'new');
  await Promise.all([first, second]);
  assert.equal(runs, 2);
  assert.equal(shared.entries.size, 0);
});

test('image request IPC cancellation is scoped to the calling window', async () => {
  const { EventEmitter } = require('node:events');
  const handlers = new Map();
  const register = require('../src/main/ipc/imageCache');
  const signals = [];
  register((name, handler) => handlers.set(name, handler), { getCover: (_url, { signal }) => {
    signals.push(signal);
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ success: false }), { once: true }));
  } });
  const a = new EventEmitter();
  const b = new EventEmitter();
  const first = handlers.get('image-cache-get-cover')({ sender: a }, 'https://image.test/a', { requestId: 'same' });
  const second = handlers.get('image-cache-get-cover')({ sender: b }, 'https://image.test/a', { requestId: 'same' });
  handlers.get('image-cache-update-request')({ sender: a }, 'same', 'cancel');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  b.emit('render-process-gone');
  assert.equal(signals[1].aborted, true);
  await Promise.all([first, second]);
  a.emit('destroyed');
  b.emit('destroyed');
});

test('paused prefetch does not block visible covers and resumes with bounded concurrency', async () => {
  const queue = new HostTaskQueue({ concurrency: 1 });
  let paused = true;
  const order = [];
  const prefetch = queue.run('same', () => order.push('prefetch'), { canRun: () => !paused, priority: () => 20 });
  await queue.run('same', () => order.push('visible'));
  assert.deepEqual(order, ['visible']);
  paused = false;
  queue.pump();
  await prefetch;
  assert.deepEqual(order, ['visible', 'prefetch']);
});

test('detail IPC isolates cancellation and releases consumers on navigation', async () => {
  const { EventEmitter } = require('node:events');
  const handlers = new Map();
  const shared = new SharedRequests();
  const a = new EventEmitter();
  const b = new EventEmitter();
  let underlyingSignal;
  let starts = 0;
  require('../src/main/ipc/subjectDetail')((name, handler) => handlers.set(name, handler), {
    getDetail: (id, options) => shared.run(id, ({ signal }) => {
      starts++;
      underlyingSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, options)
  });
  const first = handlers.get('subject-detail')({ sender: a }, 123, { requestId: 'same' });
  const second = handlers.get('subject-detail')({ sender: b }, 123, { requestId: 'same' });
  await tick();
  handlers.get('subject-detail-cancel')({ sender: a }, 'same');
  assert.equal(await first, null);
  assert.equal(underlyingSignal.aborted, false);
  assert.equal(starts, 1);
  b.emit('did-start-navigation', {}, 'https://example.test', false, true);
  assert.equal(await second, null);
  assert.equal(underlyingSignal.aborted, true);
  a.emit('destroyed');
  b.emit('destroyed');
  await tick();
  assert.equal(shared.entries.size, 0);
});
