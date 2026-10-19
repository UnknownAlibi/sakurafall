// 列表空封面补图
// 运行: node --test tests/subject-cover-backfill.test.js
//
// 背景：番剧目录列表直接读本地索引（9/28 的快照），其中 images 为空的条目
// 永远补不上封面；这里锁住补图的任务筛选、批量上限、去重与通知语义。
const test = require('node:test');
const assert = require('node:assert/strict');
const { SubjectCoverBackfill } = require('../src/main/services/SubjectCoverBackfill');
const bangumiApi = require('../src/main/services/BangumiApi');
const subjectIndexService = require('../src/main/services/SubjectIndexService');

function waitFor(predicate, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('只补缺封面的条目，遵守批量上限并通知渲染层', async () => {
  const backfill = new SubjectCoverBackfill({ batchSize: 2, attemptTtlMs: 60 * 1000 });
  const originalDetail = bangumiApi.getDetail;
  const originalUpdate = subjectIndexService.updateCover;
  const fetched = [];
  const events = [];
  bangumiApi.getDetail = async id => {
    fetched.push(id);
    return { cover: `https://lain.bgm.tv/${id}.jpg` };
  };
  subjectIndexService.updateCover = () => true;

  try {
    backfill.setNotifier(map => events.push(map));
    backfill.schedule([
      { id: 'bangumi_1', bgmId: 1, cover: '' },
      { id: 'bangumi_2', bgmId: 2, cover: 'https://lain.bgm.tv/has.jpg' },
      { id: 'bangumi_3', bgmId: 3 },
      { id: 'bangumi_4', bgmId: 4 }
    ]);
    await waitFor(() => events.length > 0);

    assert.deepEqual(fetched, [1, 3], '已有封面的条目跳过，且一次最多 batchSize 条');
    assert.deepEqual(Object.keys(events[0]), ['1', '3']);
    assert.equal(events[0][1], 'https://lain.bgm.tv/1.jpg');

    // TTL 内不重复请求同一 id；未尝试过的条目仍可补
    fetched.length = 0;
    backfill.schedule([{ id: 'bangumi_1', bgmId: 1 }, { id: 'bangumi_4', bgmId: 4 }]);
    await waitFor(() => fetched.length > 0);
    assert.deepEqual(fetched, [4]);
  } finally {
    bangumiApi.getDetail = originalDetail;
    subjectIndexService.updateCover = originalUpdate;
  }
});

test('详情拿不到封面或写入失败时不发通知', async () => {
  const backfill = new SubjectCoverBackfill({ batchSize: 2 });
  const originalDetail = bangumiApi.getDetail;
  const originalUpdate = subjectIndexService.updateCover;
  const events = [];
  bangumiApi.getDetail = async () => ({ cover: '' });
  subjectIndexService.updateCover = () => true;

  try {
    backfill.setNotifier(map => events.push(map));
    backfill.schedule([{ id: 'bangumi_9', bgmId: 9 }]);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(events, []);
  } finally {
    bangumiApi.getDetail = originalDetail;
    subjectIndexService.updateCover = originalUpdate;
  }
});
