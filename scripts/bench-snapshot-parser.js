const { performance } = require('node:perf_hooks');
const parseSnapshot = require('../src/main/utils/parseSnapshot');

async function measure(label, run) {
  let last = performance.now();
  let maximumDelayMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximumDelayMs = Math.max(maximumDelayMs, now - last - 5);
    last = now;
  }, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  const start = performance.now();
  const result = await run();
  const durationMs = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 20));
  clearInterval(timer);
  return { label, count: result.subjects.length, durationMs, maximumDelayMs };
}

async function main() {
  const text = JSON.stringify({ schemaVersion: 1, subjects: Array.from({ length: 29015 }, (_, id) => ({
    id: id + 1, type: 2, name: `Subject ${id}`, summary: 'Synthetic benchmark text. '.repeat(72)
  })) });
  console.log(JSON.stringify({
    bytes: Buffer.byteLength(text),
    measurements: [
      await measure('main-thread', () => JSON.parse(text)),
      await measure('worker-batched', () => parseSnapshot(text))
    ]
  }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
