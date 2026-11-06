// 自动对齐的准入规则（不启动 Electron，也不碰数据库）
// 运行: node --test tests/danmaku-alignment-auto.test.mjs
//
// 这里锁住「什么时候允许自动应用」：
//  - 用户手动校准过 → 永不覆盖
//  - 用户撤销过 → 本集不再自动应用
//  - 只有弹幕锚点、没有片头检测时，必须有时长证据（视频确实短了约一个片头）
//  - 片头检测 + 作品模板 → 判断片头被剪短/加长
import test from 'node:test';
import assert from 'node:assert/strict';

// store 的 action 内部会调用 window.electronAPI 保存；测试里给个空实现
globalThis.window = {
  electronAPI: {
    danmakuAlignmentSave: async () => ({ record: null })
  }
};

const { default: storeModule } = await import('../src/renderer/store/modules/danmakuAlignment.js');

function createContext(overrides = {}) {
  const state = {
    episodeKey: 'bgm:1|ep:1',
    workKey: 'bgm:1',
    bgmId: 1,
    episodeNumber: 1,
    sourceId: 'cms-a',
    alignment: { offset: 0, cuts: [], inserts: [] },
    detections: { videoIntro: null, adRanges: [], canonicalIntroLength: 0 },
    template: { introLength: 0, samples: 0 },
    danmakuAnchors: { contentStart: null, confidence: 0, samples: 0 },
    savedOrigin: '',
    autoApplied: false,
    autoReason: '',
    autoSuppressed: false,
    ...overrides
  };
  const commits = [];
  const ctx = {
    state,
    commit(type, value) { commits.push([type, value]); },
    dispatch() {}
  };
  return { ctx, commits };
}

test('手动校准过的集不会被自动结果覆盖', () => {
  const { ctx, commits } = createContext({
    savedOrigin: 'manual',
    danmakuAnchors: { contentStart: 90, confidence: 1, samples: 5 },
    detections: { videoIntro: { start: 0, end: 95 }, adRanges: [], canonicalIntroLength: 0 }
  });
  assert.equal(storeModule.actions.autoAlignFromDetections(ctx, { videoDuration: 1300, maxCommentTime: 1400 }), false);
  assert.equal(commits.length, 0);
});

test('用户撤销过自动对齐后不再应用', () => {
  const { ctx, commits } = createContext({
    autoSuppressed: true,
    danmakuAnchors: { contentStart: 90, confidence: 1, samples: 5 },
    detections: { videoIntro: { start: 0, end: 95 }, adRanges: [], canonicalIntroLength: 0 }
  });
  assert.equal(storeModule.actions.autoAlignFromDetections(ctx, {}), false);
  assert.equal(commits.length, 0);
});

test('弹幕锚点 + 片头检测 → 直接算出整体偏移', () => {
  const { ctx, commits } = createContext({
    danmakuAnchors: { contentStart: 90, confidence: 1, samples: 5 },
    detections: { videoIntro: { start: 0, end: 95 }, adRanges: [], canonicalIntroLength: 0 }
  });
  assert.equal(storeModule.actions.autoAlignFromDetections(ctx, { videoDuration: 1300, maxCommentTime: 1310 }), true);
  const applied = commits.find(([type]) => type === 'SET_ALIGNMENT');
  assert.ok(applied, '应提交 SET_ALIGNMENT');
  assert.equal(applied[1].offset, 5);
  assert.equal(commits.some(([type, value]) => type === 'SET_AUTO_APPLIED' && value.applied === true), true);
});

test('只有锚点、没有片头检测时，需要时长证据才认定片头被删', () => {
  const anchors = { contentStart: 90, confidence: 1, samples: 5 };
  const noIntro = { videoIntro: null, adRanges: [], canonicalIntroLength: 0 };

  // 视频 1300s、弹幕覆盖到 1420s → 确实短了约 90s，认定片头被删
  const trimmed = createContext({ danmakuAnchors: anchors, detections: noIntro });
  assert.equal(storeModule.actions.autoAlignFromDetections(trimmed.ctx, { videoDuration: 1300, maxCommentTime: 1420 }), true);
  const applied = trimmed.commits.find(([type]) => type === 'SET_ALIGNMENT');
  assert.equal(applied[1].offset, -90);

  // 视频与弹幕时长基本一致 → 只是 DNA 漏检，不能整体前移
  const missed = createContext({ danmakuAnchors: anchors, detections: noIntro });
  assert.equal(storeModule.actions.autoAlignFromDetections(missed.ctx, { videoDuration: 1420, maxCommentTime: 1430 }), false);
  assert.equal(missed.commits.length, 0);
});

test('片头检测 + 作品模板 → 片头被剪短时写入删减段', () => {
  const { ctx, commits } = createContext({
    template: { introLength: 90, samples: 3 },
    detections: { videoIntro: { start: 0, end: 30 }, adRanges: [], canonicalIntroLength: 0 }
  });
  assert.equal(storeModule.actions.autoAlignFromDetections(ctx, { videoDuration: 1300, maxCommentTime: 1310 }), true);
  const applied = commits.find(([type]) => type === 'SET_ALIGNMENT');
  assert.deepEqual(applied[1].cuts, [{ start: 0, end: 60 }]);
});

test('HLS 明确广告段即使没有锚点也会自动补插入区间', () => {
  const { ctx, commits } = createContext({
    detections: { videoIntro: null, adRanges: [{ start: 600, end: 660 }], canonicalIntroLength: 0 }
  });
  assert.equal(storeModule.actions.autoAlignFromDetections(ctx, { videoDuration: 1500, maxCommentTime: 1440 }), true);
  const applied = commits.find(([type]) => type === 'SET_ALIGNMENT');
  assert.deepEqual(applied[1].inserts, [{ start: 600, end: 660 }]);
});
