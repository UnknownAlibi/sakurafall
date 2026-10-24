// 数据库延迟写队列
//
// better-sqlite3 是同步 API，逐条写会阻塞主进程。这里把非关键写入
// （播放进度、历史）聚合成单事务，事务成功后才丢弃队列；失败保留并退避重试。
// 单条操作内部隔离异常：坏数据只跳过该条，不阻断其余写入。

class DbWriteQueue {
  constructor(options = {}) {
    this.getDb = typeof options.getDb === 'function' ? options.getDb : () => null;
    this.flushInterval = Math.max(100, Number(options.flushInterval) || 2000);
    this.retryDelay = Math.max(500, Number(options.retryDelay) || 5000);
    this.maxSize = Math.max(1, Number(options.maxSize) || 50);
    this.queue = [];
    this.flushTimer = null;
    this.retryTimer = null;
  }

  get size() {
    return this.queue.length;
  }

  enqueue(fn) {
    this.queue.push(fn);
    if (this.queue.length >= this.maxSize) {
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushInterval);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  flush({ allowRetry = true } = {}) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const db = this.getDb();
    if (!db || this.queue.length === 0) return;
    const ops = this.queue.slice();
    try {
      const tx = db.transaction(() => {
        for (const fn of ops) {
          try {
            fn(db);
          } catch (error) {
            console.warn('[DB] 延迟写入失败:', error.message);
          }
        }
      });
      tx();
      this.queue.length = 0;
    } catch (error) {
      console.error('[DB] 延迟写入事务失败，保留队列等待重试:', error);
      if (allowRetry) this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    if (this.retryTimer || this.queue.length === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, this.retryDelay);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

module.exports = { DbWriteQueue };
