// Each consumer owns its cancellation; only the last departure aborts the work.
class SharedRequests {
  constructor() {
    this.entries = new Map();
  }

  run(key, start, { signal, priority = () => 0, canRun = () => true } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), consumers: new Set() };
      this.entries.set(key, entry);
      entry.promise = Promise.resolve().then(() => start({
        signal: entry.controller.signal,
        priority: () => Math.min(50, ...Array.from(entry.consumers, consumer => consumer.priority())),
        canRun: () => Array.from(entry.consumers).some(consumer => consumer.canRun())
      })).finally(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      });
    }
    return new Promise((resolve, reject) => {
      const consumer = { priority, canRun };
      const detach = () => {
        entry.consumers.delete(consumer);
        signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        detach();
        reject(signal.reason);
        if (!entry.consumers.size) {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          entry.controller.abort();
        }
      };
      entry.consumers.add(consumer);
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => { detach(); resolve(value); }, error => { detach(); reject(error); });
    });
  }
}

module.exports = SharedRequests;
