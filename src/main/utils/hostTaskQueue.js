class HostTaskQueue {
  constructor({ concurrency = 6, perHost = 2, maxQueued = 240 } = {}) {
    this.concurrency = concurrency;
    this.perHost = perHost;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.hosts = new Map();
    this.queue = [];
  }

  run(host, task) {
    if (this.queue.length >= this.maxQueued) return Promise.reject(new Error('Cover queue is full; retry later'));
    return new Promise((resolve, reject) => {
      this.queue.push({ host, task, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.active < this.concurrency) {
      const index = this.queue.findIndex(item => (this.hosts.get(item.host) || 0) < this.perHost);
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0];
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
