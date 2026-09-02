const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const AnimeDatabase = require('../src/main/services/AnimeDatabase');
const { registerLibraryIpc } = require('../src/main/ipc/library');

function createDnaService() {
  const service = new AnimeDatabase();
  service.db = new Database(':memory:');
  service._createEpisodeSegmentsTable();
  return service;
}

function makeIntroSegment(episodeKey, episodeNumber, start, end, overrides = {}) {
  return {
    episode_key: episodeKey,
    work_key: 'bgm:400602',
    bgm_id: 400602,
    anime_name: '葬送的芙莉莲',
    episode_number: episodeNumber,
    episode_title: `第${episodeNumber}集`,
    kind: 'intro',
    start,
    end,
    confirmed: true,
    origin: 'user',
    ...overrides
  };
}

test('episode segments save, list and remove with per-kind uniqueness', () => {
  const service = createDnaService();

  const first = service.saveEpisodeSegment(makeIntroSegment('bgm:400602|ep:1', 1, 5, 95));
  assert.ok(first.segment.id > 0);
  assert.equal(first.segment.confirmed, 1);

  // 同集同 kind 覆盖保存：仍只有一条，且时间更新
  const second = service.saveEpisodeSegment(makeIntroSegment('bgm:400602|ep:1', 1, 4.5, 94.5));
  assert.notEqual(second.segment.id, first.segment.id);
  const list = service.getEpisodeSegments('bgm:400602|ep:1');
  assert.equal(list.length, 1);
  assert.equal(list[0].start, 4.5);

  // outro 与 intro 并存
  service.saveEpisodeSegment(makeIntroSegment('bgm:400602|ep:1', 1, 1300, 1420, { kind: 'outro' }));
  assert.equal(service.getEpisodeSegments('bgm:400602|ep:1').length, 2);

  assert.equal(service.removeEpisodeSegment(second.segment.id).changes, 1);
  assert.equal(service.getEpisodeSegments('bgm:400602|ep:1').length, 1);
  service.db.close();
});

test('episode segments reject invalid input', () => {
  const service = createDnaService();
  assert.throws(() => service.saveEpisodeSegment({ kind: 'intro', start: 1, end: 2 }), /缺少剧集身份/);
  assert.throws(() => service.saveEpisodeSegment({ episode_key: 'k', kind: 'nonsense', start: 1, end: 2 }), /无效的时间段类型/);
  assert.throws(() => service.saveEpisodeSegment({ episode_key: 'k', kind: 'intro', start: 10, end: 10.2 }), /时间段过短/);
  service.db.close();
});

test('auto skip rule promotes only after three stable intro confirmations', () => {
  const service = createDnaService();

  // 1 集：无规则
  service.saveEpisodeSegment(makeIntroSegment('bgm:400602|ep:1', 1, 5, 95));
  assert.equal(service.getWorkAutoSkipRule(400602, 'bgm:400602'), null);

  // 2 集：仍无规则
  service.saveEpisodeSegment(makeIntroSegment('bgm:400602|ep:2', 2, 5.5, 95.5));
  assert.equal(service.getWorkAutoSkipRule(400602, 'bgm:400602'), null);

  // 3 集稳定：升级为规则（中位数）
  const promoted = service.saveEpisodeSegment(makeIntroSegment('bgm:400602|ep:3', 3, 6, 96));
  assert.ok(promoted.autoSkipRule);
  assert.equal(promoted.autoSkipRule.episodeCount, 3);
  assert.equal(promoted.autoSkipRule.start, 5.5);
  assert.equal(promoted.autoSkipRule.end, 95.5);

  // 也可通过 work_key 回退查询（bgm_id 不匹配时）
  const byKey = service.getWorkAutoSkipRule(0, 'bgm:400602');
  assert.ok(byKey);
  assert.equal(byKey.start, 5.5);
  service.db.close();
});

test('auto skip rule refuses unstable intros', () => {
  const service = createDnaService();
  service.saveEpisodeSegment(makeIntroSegment('bgm:99|ep:1', 1, 5, 95));
  service.saveEpisodeSegment(makeIntroSegment('bgm:99|ep:2', 2, 6, 96));
  service.saveEpisodeSegment(makeIntroSegment('bgm:99|ep:3', 3, 90, 180)); // 起点极差远超 5s
  assert.equal(service.getWorkAutoSkipRule(99, 'bgm:99'), null);
  service.db.close();
});

test('library IPC registers episode dna channels', async () => {
  const handlers = new Map();
  let savedPayload = null;
  const animeDb = {
    saveEpisodeSegment: data => { savedPayload = data; return { segment: { id: 7, ...data }, autoSkipRule: null }; },
    getEpisodeSegments: key => [{ id: 7, episode_key: key, kind: 'intro' }],
    removeEpisodeSegment: id => ({ changes: Number(id === 7) }),
    getWorkAutoSkipRule: () => ({ kind: 'intro', start: 5, end: 95, episodeCount: 3 })
  };
  registerLibraryIpc({ handle: (channel, listener) => handlers.set(channel, listener), animeDb });

  assert.ok(handlers.has('episode-segment-save'));
  assert.ok(handlers.has('episode-segment-list'));
  assert.ok(handlers.has('episode-segment-remove'));
  assert.ok(handlers.has('episode-segment-auto-skip-rule'));

  const saved = await handlers.get('episode-segment-save')({}, { episode_key: 'k', kind: 'intro', start: 1, end: 2 });
  assert.equal(saved.segment.id, 7);
  assert.equal(savedPayload.episode_key, 'k');

  const listed = await handlers.get('episode-segment-list')({}, 'k');
  assert.equal(listed[0].kind, 'intro');

  const removed = await handlers.get('episode-segment-remove')({}, 7);
  assert.equal(removed.changes, 1);

  const rule = await handlers.get('episode-segment-auto-skip-rule')({}, 0, 'bgm:1');
  assert.equal(rule.episodeCount, 3);
});

// ===== Worker：音频能量 + 场景切换找片头候选 =====
// episodeDnaWorker.js 运行在浏览器 Worker 环境（self），Node 下用 self 垫片加载。

function loadDnaWorker() {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/renderer/player/episodeDnaWorker.js'),
    'utf8'
  );
  const posted = [];
  const self = { postMessage: message => posted.push(message) };
  new Function('self', `${source}`)(self);
  return { self, posted };
}

function analyze(worker, payload) {
  worker.posted.length = 0;
  worker.self.onmessage({ data: { type: 'analyze', payload } });
  assert.equal(worker.posted.length, 1);
  assert.equal(worker.posted[0].type, 'result');
  return worker.posted[0].candidates;
}

/**
 * 构造合成特征：片头 2s-90s 高音频能量，90s 处能量骤降 + 亮度突变（场景切换）
 */
function buildSyntheticFeatures() {
  const windowMs = 500;
  const totalWindows = 480; // 240s
  const times = new Array(totalWindows);
  const rms = new Array(totalWindows);
  const luma = new Array(totalWindows);
  for (let i = 0; i < totalWindows; i++) {
    const t = i * (windowMs / 1000);
    times[i] = t;
    const inIntro = t >= 2 && t < 90;
    rms[i] = inIntro ? 0.5 : 0.02;
    // 90s 前后亮度从 200 跳到 40（模拟 OP→正片转场）
    luma[i] = t < 90 ? 200 : 40;
  }
  return { windowMs, times, rms, luma };
}

test('dna worker finds intro candidate from synthetic energy drop and scene change', () => {
  const worker = loadDnaWorker();
  const candidates = analyze(worker, buildSyntheticFeatures());

  assert.ok(candidates.length >= 1, '应至少产出一个片头候选');
  const best = candidates[0];
  assert.ok(best.confidence >= 0.3 && best.confidence <= 0.95);
  assert.ok(best.end >= 86 && best.end <= 94, `片头结束应靠近 90s，实际 ${best.end}`);
  assert.ok(best.start <= 3, `片头开始应靠近 2s，实际 ${best.start}`);
  assert.ok(best.end - best.start >= 20, '候选时长至少 20s');
  assert.ok(['audio-energy', 'scene-change'].includes(best.reason));
});

test('dna worker degrades gracefully with audio-only or scene-only features', () => {
  const worker = loadDnaWorker();
  const { windowMs, times, rms, luma } = buildSyntheticFeatures();

  // 仅音频：仍应产出候选
  const audioOnly = analyze(worker, { windowMs, times, rms, luma: null });
  assert.ok(audioOnly.length >= 1, '仅音频能量也应找到候选');

  // 仅场景：亮度突变应产出候选
  const sceneOnly = analyze(worker, { windowMs, times, rms: null, luma });
  assert.ok(sceneOnly.length >= 1, '仅场景切换也应找到候选');

  // 数据不足：不产出候选
  assert.deepEqual(analyze(worker, { windowMs, times: times.slice(0, 10), rms: rms.slice(0, 10), luma: luma.slice(0, 10) }), []);
});

test('dna worker reports errors without crashing', () => {
  const worker = loadDnaWorker();
  worker.posted.length = 0;
  worker.self.onmessage({ data: { type: 'analyze', payload: null } });
  assert.equal(worker.posted[0].type, 'error');
  // 非分析消息被忽略
  worker.posted.length = 0;
  worker.self.onmessage({ data: { type: 'other' } });
  assert.equal(worker.posted.length, 0);
});
