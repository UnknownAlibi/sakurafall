const { Worker } = require('node:worker_threads');
const path = require('node:path');

function parseSnapshot(text, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Snapshot cancelled'), { name: 'AbortError' }));
  if (text.length < 256 * 1024) return Promise.resolve().then(() => JSON.parse(text));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'snapshotParser.worker.js'), { workerData: text });
    let result;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(Object.assign(new Error('Snapshot cancelled'), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(new Error('Snapshot parsing timed out')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', error => finish(error));
    worker.on('exit', () => { if (!settled) finish(new Error('Snapshot parser exited early')); });
    worker.on('message', message => {
      if (settled) return;
      if (message.type === 'error') return finish(new Error(message.message));
      if (message.type === 'complete') return finish(null, message.value);
      if (message.type === 'done') return finish(null, result);
      if (message.type === 'header') result = { ...message.value, subjects: [] };
      if (message.type === 'batch') result.subjects.push(...message.value);
      // Acknowledgements bound structured-clone work and yield between batches.
      setImmediate(() => { if (!settled) worker.postMessage('next'); });
    });
  });
}

module.exports = parseSnapshot;
