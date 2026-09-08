class HostTaskQueue {
  constructor({ concurrency = 6, perHost = 2, maxQueued = 240, queueTimeoutMs = 20000, agingMs = 500, now = Date.now } = {}) {
    this.concurrency = concurrency;
    this.perHost = perHost;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.hosts = new Map();
    this.queue = [];
    this.queueTimeoutMs = queueTimeoutMs;
    this.agingMs = agingMs;
    this.now = now;
  }

  run(host, task, { signal, priority = () => 0, canRun = () => true } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error('Cover queue is full; retry later'));
    return new Promise((resolve, reject) => {
      const item = { host, task, resolve, reject, priority, canRun, queuedAt: this.now() };
      const cancel = (error) => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        item.cleanup();
        reject(error);
        this.pump();
      };
      const abort = () => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new Error('Cover queue wait timed out')), this.queueTimeoutMs);
      item.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(item);
      this.pump();
    });
  }

  pump() {
    const now = this.now();
    const score = item => item.priority() - (now - item.queuedAt) / this.agingMs;
    this.queue.sort((a, b) => score(a) - score(b) || a.queuedAt - b.queuedAt);
    while (this.active < this.concurrency) {
      const index = this.queue.findIndex(item => item.canRun() && (this.hosts.get(item.host) || 0) < this.perHost);
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0];
      item.cleanup();
      this.active += 1;
      this.hosts.set(item.host, (this.hosts.get(item.host) || 0) + 1);
      Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
        this.active -= 1;
        const remaining = this.hosts.get(item.host) - 1;
        if (remaining) this.hosts.set(item.host, remaining);
        else this.hosts.delete(item.host);
        this.pump();
      });
    }
  }
}

module.exports = HostTaskQueue;
