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
