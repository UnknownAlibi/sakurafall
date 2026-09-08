import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundTaskScheduler } from '../src/renderer/services/backgroundTaskScheduler.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('background scheduler orders queued work and respects pause state', async () => {
  const scheduler = new BackgroundTaskScheduler({ concurrency: 1 });
  const order = [];
  scheduler.pause('scroll');
  const low = scheduler.schedule({ key: 'low', priority: 50, idle: false, run: () => order.push('low') });
  const high = scheduler.schedule({ key: 'high', priority: 10, idle: false, run: () => order.push('high') });
  await tick();
  assert.deepEqual(order, []);
  scheduler.resume('scroll');
  await Promise.all([low, high]);
  assert.deepEqual(order, ['high', 'low']);
});

test('background scheduler deduplicates keys and cancels delayed groups', async () => {
  const scheduler = new BackgroundTaskScheduler({ concurrency: 1 });
  let runs = 0;
  const first = scheduler.schedule({ key: 'same', idle: false, run: () => { runs += 1; return 42; } });
  const second = scheduler.schedule({ key: 'same', idle: false, run: () => { runs += 1; } });
  assert.equal(first, second);
  assert.equal(await first, 42);
  assert.equal(runs, 1);

  const cancelled = scheduler.schedule({ key: 'later', group: 'prefetch', delayMs: 1000, run: () => { runs += 1; } });
  assert.equal(scheduler.cancelGroup('prefetch'), 1);
  assert.deepEqual(await cancelled, { cancelled: true });
  assert.equal(runs, 1);
});

test('running cancellation preserves real concurrency and cannot delete a replacement key', async () => {
  const scheduler = new BackgroundTaskScheduler({ concurrency: 1 });
  let release, signal;
  const first = scheduler.schedule({ key: 'same', idle: false, run: context => {
    signal = context.signal;
    return new Promise(resolve => { release = resolve; });
  } });
  await tick();
  assert.equal(scheduler.cancel('same'), true);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await first, { cancelled: true });
  let runs = 0;
  const replacement = scheduler.schedule({ key: 'same', idle: false, run: () => ++runs });
  await tick();
  assert.equal(runs, 0, 'aborting cannot free a slot while the underlying task is still running');
  release();
  assert.equal(await replacement, 1);
  await tick();
  assert.equal(scheduler.active, 0);
  assert.equal(scheduler.tasks.size, 0);
});

test('pressure notifications combine reasons and coalesce temporary cancellation pauses', async () => {
  const scheduler = new BackgroundTaskScheduler();
  const states = [];
  const unsubscribe = scheduler.subscribePressure(state => states.push(state));
  scheduler.pause('scroll');
  scheduler.pause('player');
  await tick();
  scheduler.resume('scroll');
  await tick();
  scheduler.resume('player');
  scheduler.cancelGroup('empty');
  await tick();
  assert.deepEqual(states, [false, true, false]);
  unsubscribe();
  scheduler.pause('hidden');
  await tick();
  assert.deepEqual(states, [false, true, false]);
});
