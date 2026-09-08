const { Worker, isMarkedAsUntransferable } = require('node:worker_threads');
const path = require('node:path');

// The consumer owns the next-batch credit. At most one batch crosses the worker
// boundary before SQLite has finished with it; the main process never collects
// a second full subject array.
module.exports = function openSnapshot(text, { signal, transferBuffer = false } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const transferable = transferBuffer && Buffer.isBuffer(text) && text.byteLength >= 256 * 1024 &&
      text.byteOffset === 0 && text.byteLength === text.buffer.byteLength &&
      !(typeof isMarkedAsUntransferable === 'function' && isMarkedAsUntransferable(text.buffer));
    const worker = new Worker(path.join(__dirname, 'snapshotParser.worker.js'), {
      workerData: { stream: true, text },
      transferList: transferable ? [text.buffer] : []
    });
    let closed = false;
    let failure;
    let waiting;
    let headerDelivered = false;
    const finish = error => {
      if (closed) return;
      closed = true;
      failure = error;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      if (!headerDelivered) reject(error || new Error('Snapshot closed before metadata'));
      if (waiting) {
        if (error) waiting.reject(error);
        else waiting.resolve({ done: true });
        waiting = null;
      }
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error('Snapshot consumption timed out')), 30000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('error', finish);
    worker.on('exit', () => { if (!closed) finish(new Error('Snapshot worker exited early')); });
    worker.on('message', message => {
      if (closed) return;
      if (message.type === 'error') {
        const ErrorType = message.name === 'SyntaxError' ? SyntaxError : Error;
        return finish(new ErrorType(message.message));
      }
      if (message.type === 'header') {
        headerDelivered = true;
        const subjects = {
          length: message.count,
          [Symbol.asyncIterator]() { return this; },
          next() {
            if (failure) return Promise.reject(failure);
            if (closed) return Promise.resolve({ done: true });
            if (waiting) return Promise.reject(new Error('Concurrent snapshot iteration is not supported'));
            return new Promise((resolveBatch, rejectBatch) => {
              waiting = { resolve: resolveBatch, reject: rejectBatch };
              worker.postMessage('next');
            });
          },
          return() { finish(); return Promise.resolve({ done: true }); }
        };
        resolve({ ...message.value, subjects, close: () => finish() });
      } else if (message.type === 'batch') {
        if (!waiting) return finish(new Error('Unrequested snapshot batch'));
        const request = waiting;
        waiting = null;
        request.resolve({ done: false, value: message.value });
      } else if (message.type === 'done') finish();
    });
  });
};
