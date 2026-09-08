export const BACKGROUND_PRIORITY = Object.freeze({
  cacheRefresh: 20,
  visibleMetadata: 30,
  pagePrefetch: 50
});

export class BackgroundTaskScheduler {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 2);
    this.queue = [];
    this.tasks = new Map();
    this.pauses = new Set();
    this.active = 0;
    this.sequence = 0;
    this.pressureListeners = new Set();
  }

  schedule({ key, group = 'default', priority = 50, delayMs = 0, idle = true, run }) {
    if (!key || typeof run !== 'function') throw new TypeError('后台任务需要 key 和 run');
    const existing = this.tasks.get(key);
    if (existing) return existing.promise;

    let resolveTask;
    let rejectTask;
    const task = {
      key,
      group,
      priority: Number(priority) || 50,
      idle: idle !== false,
      run,
      sequence: this.sequence++,
      state: delayMs > 0 ? 'delayed' : 'queued',
      timer: null,
      idleHandle: null,
      controller: new AbortController(),
      slotReleased: false,
      promise: new Promise((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      }),
      resolve: value => resolveTask(value),
      reject: error => rejectTask(error)
    };
    this.tasks.set(key, task);
    if (delayMs > 0) {
      task.timer = setTimeout(() => {
        task.timer = null;
        if (task.state === 'cancelled') return;
        task.state = 'queued';
        this.queue.push(task);
        this._pump();
      }, delayMs);
    } else {
      this.queue.push(task);
      this._pump();
    }
    return task.promise;
  }

  pause(reason = 'manual') {
    this.pauses.add(reason);
    this._notifyPressure();
  }

  resume(reason = 'manual') {
    this.pauses.delete(reason);
    this._notifyPressure();
    this._pump();
  }

  subscribePressure(listener) {
    this.pressureListeners.add(listener);
    listener(this.pauses.size > 0);
    return () => this.pressureListeners.delete(listener);
  }

  _notifyPressure() {
    if (this._pressureQueued) return;
    this._pressureQueued = true;
    queueMicrotask(() => {
      this._pressureQueued = false;
      const paused = this.pauses.size > 0;
      if (this._lastPressure === paused) return;
      this._lastPressure = paused;
      for (const listener of this.pressureListeners) listener(paused);
    });
  }

  cancel(key) {
    const task = this.tasks.get(key);
    if (!task) return false;
    const wasWaiting = task.state === 'waiting';
    task.state = 'cancelled';
    task.controller.abort();
    if (task.timer) clearTimeout(task.timer);
    if (task.idleHandle !== null && typeof globalThis.cancelIdleCallback === 'function') {
      globalThis.cancelIdleCallback(task.idleHandle);
    }
    this.queue = this.queue.filter(item => item !== task);
    this.tasks.delete(key);
    if (wasWaiting) {
      task.slotReleased = true;
      this.active = Math.max(0, this.active - 1);
    }
    task.resolve({ cancelled: true });
    this._pump();
    return true;
  }

  cancelGroup(group) {
    let cancelled = 0;
    const pauseToken = Symbol('cancel-group');
    this.pause(pauseToken);
    for (const task of [...this.tasks.values()]) {
      if (task.group === group && this.cancel(task.key)) cancelled += 1;
    }
    this.resume(pauseToken);
    return cancelled;
  }

  _pump() {
    if (this.pauses.size > 0 || this.active >= this.concurrency || this.queue.length === 0) return;
    this.queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    while (this.pauses.size === 0 && this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task || task.state !== 'queued') continue;
      task.state = 'waiting';
      task.slotReleased = false;
      this.active += 1;
      const start = () => {
        task.idleHandle = null;
        if (task.state === 'cancelled') {
          if (!task.slotReleased) this.active -= 1;
          this._pump();
          return;
        }
        if (this.pauses.size > 0) {
          task.state = 'queued';
          this.active -= 1;
          this.queue.push(task);
          this._pump();
          return;
        }
        task.state = 'running';
        Promise.resolve().then(() => {
          if (!task.controller.signal.aborted) return task.run({ signal: task.controller.signal });
        })
          .then(value => task.resolve(value), error => task.reject(error))
          .finally(() => {
            task.state = 'done';
            if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
            this.active -= 1;
            this._pump();
          });
      };
      if (task.idle && typeof globalThis.requestIdleCallback === 'function') {
        task.idleHandle = globalThis.requestIdleCallback(start, { timeout: 1600 });
      } else {
        queueMicrotask(start);
      }
    }
  }
}

export default new BackgroundTaskScheduler({ concurrency: 2 });
