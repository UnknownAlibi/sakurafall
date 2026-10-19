/**
 * 列表空封面后台补图。
 *
 * 背景：番剧目录列表直接读本地索引（目录快照），而快照里的 images 常常是空的
 * （条目刚建、封面后补），索引本身又不会因为用户浏览而刷新——于是列表长期显示
 * 占位符，详情页却能看到封面。
 *
 * 这里在列表命中索引后，对缺封面的条目按需调用详情接口补齐：
 *  - 限量：每次最多 batchSize 条，避免一页把上游打满；
 *  - 去重：同一 id 在 attemptTtlMs 内不重复尝试；
 *  - 串行：逐条请求，天然限速；
 *  - 回写：只填空值（SubjectIndexService.updateCover），不覆盖已有封面；
 *  - 通知：补到的 { bgmId: cover } 交给注入的 notifier，由主进程推给渲染层就地更新。
 */
const bangumiApi = require('./BangumiApi');
const subjectIndexService = require('./SubjectIndexService');

class SubjectCoverBackfill {
  constructor({ batchSize = 8, attemptTtlMs = 30 * 60 * 1000 } = {}) {
    this.batchSize = Math.max(1, Number(batchSize) || 8);
    this.attemptTtlMs = Math.max(60 * 1000, Number(attemptTtlMs) || 30 * 60 * 1000);
    this._inflight = new Set();
    this._attempts = new Map(); // bgmId -> 最近一次尝试时间
    this._notifier = null;
  }

  setNotifier(notifier) {
    this._notifier = typeof notifier === 'function' ? notifier : null;
  }

  /**
   * 从一批列表条目里挑出缺封面的，排进后台补图。
   * @param {Array<{cover?: string, bgmId?: number, id?: string}>} items
   */
  schedule(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const now = Date.now();
    const pending = [];
    for (const item of items) {
      if (!item || item.cover) continue;
      const bgmId = Number(item.bgmId || item.bgm_id || item.id);
      if (!Number.isSafeInteger(bgmId) || bgmId <= 0) continue;
      if (this._inflight.has(bgmId)) continue;
      if (now - (this._attempts.get(bgmId) || 0) < this.attemptTtlMs) continue;
      pending.push(bgmId);
      if (pending.length >= this.batchSize) break;
    }
    if (pending.length === 0) return;
    this._run(pending).catch(() => {});
  }

  async _run(ids) {
    const updated = {};
    for (const bgmId of ids) {
      if (this._inflight.has(bgmId)) continue;
      this._inflight.add(bgmId);
      this._attempts.set(bgmId, Date.now());
      try {
        const detail = await bangumiApi.getDetail(bgmId);
        const cover = detail?.cover ? bangumiApi._normalizeImageUrl(detail.cover) : '';
        if (cover && subjectIndexService.updateCover?.(bgmId, cover)) {
          updated[bgmId] = cover;
        }
      } catch (_error) {
        // 单条失败忽略，受 attemptTtlMs 限制后再试
      } finally {
        this._inflight.delete(bgmId);
      }
    }
    if (Object.keys(updated).length > 0 && this._notifier) {
      try {
        this._notifier(updated);
      } catch (_error) { /* 通知失败不影响数据 */ }
    }
  }
}

module.exports = {
  SubjectCoverBackfill,
  // 进程内单例：SubjectService 负责触发，index.js 负责注入推送 notifier
  subjectCoverBackfill: new SubjectCoverBackfill()
};
