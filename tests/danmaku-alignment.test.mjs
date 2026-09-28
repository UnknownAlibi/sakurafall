// 弹幕时间轴对齐单元测试
// 运行: node --test tests/danmaku-alignment.test.mjs
//
// 覆盖：映射纯函数（cuts/inserts/offset/丢弃）、检测推导、持久层 CRUD 与历史建议。
// 说明：better-sqlite3 是为 Electron 的 Node 版本编译的原生模块，纯 Node 下用内存 mock 模拟 SQL 子集。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAlignment,
  createEmptyAlignment,
  isAlignmentEmpty,
  mapCanonicalToVideoTime,
  remapDanmakuComments,
  deriveAlignmentFromDetections,
  describeAlignment,
  addInsertRange
} from '../src/renderer/utils/danmakuAlignment.js';
import storeModule from '../src/main/services/DanmakuAlignmentStore.js';
import {
  inferDanmakuContentStart,
  pickReferenceComments,
  isStructuralDanmaku,
  isHighlightDanmaku
} from '../src/renderer/utils/danmakuAnchors.js';

const { DanmakuAlignmentStore } = storeModule;

test('normalizeAlignment: 收敛越界值、丢弃过短/非法区间', () => {
  const result = normalizeAlignment({
    offset: 9999,
    cuts: [{ start: 60, end: 20 }, { start: 5, end: 5.05 }],
    inserts: [{ start: 180, end: 120 }]
  });
  assert.equal(result.offset, 1800); // 上限 30 分钟
  assert.deepEqual(result.cuts, []);
  assert.deepEqual(result.inserts, []);
});

test('mapCanonicalToVideoTime: 未校准即恒等映射', () => {
  const empty = createEmptyAlignment();
  assert.equal(isAlignmentEmpty(empty), true);
  assert.equal(mapCanonicalToVideoTime(123.4, empty), 123.4);
  assert.equal(mapCanonicalToVideoTime(0, empty), 0);
});

test('mapCanonicalToVideoTime: 手动偏移正数=弹幕延后', () => {
  const alignment = { offset: 1.5, cuts: [], inserts: [] };
  assert.equal(mapCanonicalToVideoTime(100, alignment), 101.5);
  assert.equal(mapCanonicalToVideoTime(100, { offset: -2, cuts: [], inserts: [] }), 98);
});

test('mapCanonicalToVideoTime: 片头被删时整段前移，删减区间内的弹幕丢弃', () => {
  // 标准版片头 0-90 秒，本视频没有片头
  const alignment = { offset: 0, cuts: [{ start: 0, end: 90 }], inserts: [] };
  assert.equal(mapCanonicalToVideoTime(30, alignment), null);   // 落在被删片头里
  assert.equal(mapCanonicalToVideoTime(90, alignment), 0);      // 正片起点对齐
  assert.equal(mapCanonicalToVideoTime(600, alignment), 510);   // 整体前移 90 秒
});

test('mapCanonicalToVideoTime: 中段插入广告时跨越点后整体后移，广告区间内丢弃', () => {
  // 视频 10:00-11:00 插了 60 秒广告
  const alignment = { offset: 0, cuts: [], inserts: [{ start: 600, end: 660 }] };
  assert.equal(mapCanonicalToVideoTime(500, alignment), 500);
  assert.equal(mapCanonicalToVideoTime(600, alignment), null);  // 落在广告里
  assert.equal(mapCanonicalToVideoTime(700, alignment), 760);   // 跨过广告后 +60
});

test('mapCanonicalToVideoTime: 删片头 + 插广告可叠加，并叠加手动微调', () => {
  const alignment = {
    offset: 1,
    cuts: [{ start: 0, end: 90 }],
    inserts: [{ start: 510, end: 540 }]
  };
  assert.equal(mapCanonicalToVideoTime(100, alignment), 11);   // 100-90+1
  // 600-90=510 恰好落在广告起点内 → 丢弃（那一段画面是广告）
  assert.equal(mapCanonicalToVideoTime(600, alignment), null);
  assert.equal(mapCanonicalToVideoTime(700, alignment), 641);  // 700-90=610 ≥ 540 → +30 → +1
});

test('remapDanmakuComments: 不修改原数组，丢弃错位弹幕并按时间排序', () => {
  const comments = [
    { time: 600, text: 'a' },
    { time: 30, text: 'b' },
    { time: 700, text: 'c' }
  ];
  const aligned = remapDanmakuComments(comments, { offset: 0, cuts: [{ start: 0, end: 90 }], inserts: [] });
  // 30 秒的弹幕落在被删片头里 → 丢弃；其余整体前移 90 秒
  assert.deepEqual(aligned.map(item => item.text), ['a', 'c']);
  assert.deepEqual(aligned.map(item => item.time), [510, 610]);
  assert.equal(comments[0].time, 600, '原数组不应被改写');

  const untouched = remapDanmakuComments(comments, createEmptyAlignment());
  assert.notEqual(untouched, comments);
  // 未校准时不重排、不改时间，保持上游弹幕源给出的原始顺序
  assert.deepEqual(untouched.map(item => item.time), [600, 30, 700]);
});

test('remapDanmakuComments: 已知视频时长时丢弃映射到片尾之后的弹幕', () => {
  const comments = [{ time: 100, text: 'keep' }, { time: 1500, text: 'beyond' }];
  const aligned = remapDanmakuComments(comments, { offset: 0, cuts: [], inserts: [] }, { videoDuration: 1420 });
  assert.deepEqual(aligned.map(item => item.text), ['keep']);
});

test('deriveAlignmentFromDetections: 本视频没有片头 → 删除标准片头段', () => {
  const { alignment, notes } = deriveAlignmentFromDetections({
    videoIntro: null,
    canonicalIntroLength: 90
  });
  assert.deepEqual(alignment.cuts, [{ start: 0, end: 90 }]);
  assert.equal(alignment.inserts.length, 0);
  assert.equal(notes.length, 1);
});

test('deriveAlignmentFromDetections: 片头更长 → 头部插入；片头一致 → 不动', () => {
  const longer = deriveAlignmentFromDetections({
    videoIntro: { start: 0, end: 120 },
    canonicalIntroLength: 90
  });
  assert.deepEqual(longer.alignment.inserts, [{ start: 0, end: 30 }]);

  const same = deriveAlignmentFromDetections({
    videoIntro: { start: 0, end: 90 },
    canonicalIntroLength: 90
  });
  assert.deepEqual(same.alignment.cuts, []);
  assert.deepEqual(same.alignment.inserts, []);
});

test('deriveAlignmentFromDetections: HLS 广告段转为插入锚点并保留手动偏移', () => {
  const { alignment, notes } = deriveAlignmentFromDetections({
    videoIntro: { start: 0, end: 90 },
    canonicalIntroLength: 90,
    adRanges: [{ start: 600, end: 690 }, { start: 100, end: 100.1 }],
    base: { offset: 2 }
  });
  assert.equal(alignment.offset, 2);
  assert.deepEqual(alignment.inserts, [{ start: 600, end: 690 }]);
  assert.equal(notes.some(note => note.includes('插入内容')), true);
});

test('addInsertRange: 追加重叠/乱序的广告区间并保持有序，过短区间忽略', () => {
  const base = { offset: 0, cuts: [], inserts: [{ start: 600, end: 660 }] };
  const added = addInsertRange(base, 300, 330);
  assert.deepEqual(added.inserts.map(range => range.start), [300, 600]);
  assert.equal(added.inserts[0].end, 330);

  const ignored = addInsertRange(base, 100, 100.5);
  assert.deepEqual(ignored.inserts, base.inserts);
});

test('inferDanmakuContentStart: 从「空降/正片开始」成簇标记推断正片起点', () => {
  const comments = [
    { time: 10, text: '前排' },
    { time: 88.2, text: '空降成功' },
    { time: 90.5, text: '正片开始' },
    { time: 92, text: '空降' },
    { time: 600, text: '空降（这条在搜索窗口内也算）' },
    { time: 1200, text: '正片开始' } // 超出搜索窗口，忽略
  ];
  const result = inferDanmakuContentStart(comments);
  assert.equal(result.contentStart, 90.5, '取成簇标记的中位数');
  assert.equal(result.samples, 3, '600 秒那条孤立标记不在簇内');
  assert.ok(result.confidence > 0.5);
});

test('inferDanmakuContentStart: 无标记返回 null，孤立一条只给低置信度', () => {
  assert.deepEqual(inferDanmakuContentStart([{ time: 5, text: '哈哈哈哈' }]), {
    contentStart: null, confidence: 0, samples: 0
  });

  const single = inferDanmakuContentStart([{ time: 91, text: '空降' }]);
  assert.equal(single.contentStart, 91);
  assert.equal(single.confidence, 0.25);
  assert.equal(single.samples, 1);
});

test('isStructuralDanmaku / isHighlightDanmaku: 识别结构性标记与高能弹幕', () => {
  assert.equal(isStructuralDanmaku('空降成功'), true);
  assert.equal(isStructuralDanmaku('OP'), true);
  assert.equal(isStructuralDanmaku('这集真好看'), false);
  assert.equal(isHighlightDanmaku('前方高能'), true);
  assert.equal(isHighlightDanmaku('这里笑死我了'), true);
});

test('pickReferenceComments: 取目标时间附近弹幕并按接近程度排序', () => {
  const comments = [
    { time: 100, text: '远' },
    { time: 61, text: '近' },
    { time: 62, text: '近二' },
    { time: 400, text: '超范围' }
  ];
  const items = pickReferenceComments(comments, 60, { radius: 50, limit: 10 });
  assert.deepEqual(items.map(item => item.text), ['近', '近二', '远']);
  assert.equal(items.every(item => item.time <= 110), true);
});

test('deriveAlignmentFromDetections: 弹幕侧正片起点优先，直接算出整体偏移', () => {
  // 弹幕版正片从 90s 开始；本视频片头 0-95s → 视频整体比弹幕晚 5 秒
  const withIntro = deriveAlignmentFromDetections({
    danmakuContentStart: 90,
    videoIntro: { start: 0, end: 95 },
    base: { offset: 3 }
  });
  assert.equal(withIntro.alignment.offset, 5);
  assert.match(withIntro.notes[0], /弹幕版正片起点 01:30/);

  // 本视频删了片头（未检测到片头）→ 按正片从 0 开始，弹幕整体前移 90 秒
  const cutIntro = deriveAlignmentFromDetections({ danmakuContentStart: 90, videoIntro: null });
  assert.equal(cutIntro.alignment.offset, -90);
  assert.match(cutIntro.notes[0], /前移 90 秒/);
});

test('describeAlignment: 生成中文摘要', () => {
  assert.equal(describeAlignment(createEmptyAlignment()), '未校准');
  const text = describeAlignment({ offset: 1.5, cuts: [{ start: 0, end: 90 }], inserts: [] });
  assert.match(text, /手动偏移 \+1\.5 秒/);
  assert.match(text, /删减段 00:00–01:30/);
});

// ── 持久层：内存 mock 模拟 danmaku_alignments 表 ─────────────────
class MockStatement {
  constructor(rows, sql) {
    this.rows = rows;
    this.sql = sql;
  }

  get(...params) {
    if (/FROM danmaku_alignments WHERE episode_key = \? AND source_id = \? AND provider_id = \?/.test(this.sql)) {
      const [episodeKey, sourceId, providerId] = params;
      return this.rows.find(row => row.episode_key === episodeKey
        && row.source_id === sourceId && row.provider_id === providerId);
    }
    return undefined;
  }

  all(...params) {
    if (/SELECT episode_key, offset FROM danmaku_alignments/.test(this.sql)) {
      const [workKey, sourceId, excludeKey] = params;
      return this.rows.filter(row => row.work_key === workKey
        && row.source_id === sourceId && row.episode_key !== excludeKey);
    }
    return [];
  }

  run(...params) {
    if (/INSERT INTO danmaku_alignments/.test(this.sql)) {
      const [episodeKey, workKey, bgmId, episodeNumber, sourceId, providerId, offset, cuts, inserts, createdAt, updatedAt] = params;
      const idx = this.rows.findIndex(row => row.episode_key === episodeKey
        && row.source_id === sourceId && row.provider_id === providerId);
      const row = {
        episode_key: episodeKey, work_key: workKey, bgm_id: bgmId, episode_number: episodeNumber,
        source_id: sourceId, provider_id: providerId, offset, cuts, inserts,
        created_at: createdAt, updated_at: updatedAt
      };
      if (idx >= 0) this.rows[idx] = row;
      else this.rows.push(row);
      return { changes: 1 };
    }
    if (/DELETE FROM danmaku_alignments WHERE episode_key = \?/.test(this.sql)) {
      const [episodeKey, sourceId, providerId] = params;
      const before = this.rows.length;
      for (let i = this.rows.length - 1; i >= 0; i -= 1) {
        const row = this.rows[i];
        if (row.episode_key === episodeKey && row.source_id === sourceId && row.provider_id === providerId) {
          this.rows.splice(i, 1);
        }
      }
      return { changes: before - this.rows.length };
    }
    return { changes: 0 };
  }
}

function createStore() {
  const rows = [];
  const store = new DanmakuAlignmentStore();
  store.setDatabase({ prepare: sql => new MockStatement(rows, sql) });
  return { store, rows };
}

test('DanmakuAlignmentStore: 保存 / 读取 / 删除（空配置等价于删除）', () => {
  const { store, rows } = createStore();
  const saved = store.save({
    episodeKey: 'bgm:400602|ep:3',
    workKey: 'bgm:400602',
    bgmId: 400602,
    episodeNumber: 3,
    sourceId: 'cms-a',
    alignment: { offset: -90, cuts: [{ start: 0, end: 90 }], inserts: [{ start: 60, end: 5 }] }
  });
  assert.equal(saved.ok, true);
  assert.equal(rows.length, 1);

  const record = store.get({ episodeKey: 'bgm:400602|ep:3', sourceId: 'cms-a' });
  assert.equal(record.alignment.offset, -90);
  assert.deepEqual(record.alignment.cuts, [{ start: 0, end: 90 }]);
  // 脏区间（end < start）在落库前被收敛
  assert.deepEqual(record.alignment.inserts, []);

  // 不同播放源互不影响
  assert.equal(store.get({ episodeKey: 'bgm:400602|ep:3', sourceId: 'cms-b' }), null);

  // 空配置 = 删除
  const cleared = store.save({ episodeKey: 'bgm:400602|ep:3', sourceId: 'cms-a', alignment: { offset: 0, cuts: [], inserts: [] } });
  assert.equal(cleared.removed, 1);
  assert.equal(rows.length, 0);
});

test('DanmakuAlignmentStore: 同作品同源历史偏移建议（≥2 集且足够一致）', () => {
  const { store } = createStore();
  const base = { workKey: 'bgm:400602', sourceId: 'cms-a', alignment: { offset: -90, cuts: [], inserts: [] } };
  store.save({ ...base, episodeKey: 'bgm:400602|ep:1' });
  assert.equal(store.getWorkSuggestion({ workKey: 'bgm:400602', sourceId: 'cms-a' }), null, '单集不足以给出建议');

  store.save({ ...base, episodeKey: 'bgm:400602|ep:2' });
  const suggestion = store.getWorkSuggestion({ workKey: 'bgm:400602', sourceId: 'cms-a', excludeEpisodeKey: 'bgm:400602|ep:3' });
  assert.equal(suggestion.offset, -90);
  assert.equal(suggestion.sampleCount, 2);

  // 偏移差异过大（>3s）不给建议
  store.save({ episodeKey: 'bgm:400602|ep:4', workKey: 'bgm:400602', sourceId: 'cms-a', alignment: { offset: 30, cuts: [], inserts: [] } });
  assert.equal(store.getWorkSuggestion({ workKey: 'bgm:400602', sourceId: 'cms-a' }), null);
});