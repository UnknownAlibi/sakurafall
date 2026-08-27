/**
 * 多源元数据聚合测试
 *
 * 验证 AniList 作为 Bangumi 不可达时的备用元数据源：
 * 1. AniListProvider 条目/详情标准化（source: 'anilist'，anilistId 标识，bgm_id 为空）
 * 2. SubjectService ID 路由（anilist: 前缀 → AniList，数字 → Bangumi）
 * 3. 搜索回退（Bangumi 失败/无结果 → AniList）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { AniListProvider } = require('../src/main/services/AniListProvider');
const anilistProvider = require('../src/main/services/AniListProvider');
const subjectService = require('../src/main/services/SubjectService');
const bangumiApi = require('../src/main/services/BangumiApi');

function fakeAnilistMedia(overrides = {}) {
  return {
    id: 42,
    idMal: 10042,
    title: { romaji: 'Sousou no Frieren', english: 'Frieren', native: '葬送のフリーレン' },
    coverImage: { extraLarge: 'https://s4.anilist.co/x.jpg', large: 'https://s4.anilist.co/x.jpg', medium: 'https://s4.anilist.co/x.jpg' },
    bannerImage: 'https://s4.anilist.co/banner.jpg',
    description: '<b>勇敢的冒险</b>开始。',
    episodes: 28,
    status: 'FINISHED',
    averageScore: 88,
    genres: ['Action', 'Adventure'],
    tags: [{ name: 'Magic', rank: 90 }],
    startDate: { year: 2023, month: 9, day: 29 },
    endDate: { year: 2024, month: 3, day: 22 },
    format: 'TV',
    seasonYear: 2023,
    nextAiringEpisode: null,
    isAdult: false,
    ...overrides
  };
}

test('AniListProvider 将 GraphQL 条目标准化为 SubjectSummary', () => {
  const provider = new AniListProvider();
  const item = provider._normalizeItem(fakeAnilistMedia());

  assert.equal(item.id, 'anilist_42');
  assert.equal(item.anilistId, 42);
  assert.equal(item.bgm_id, null);
  assert.equal(item.bgmId, null);
  assert.equal(item.source, 'anilist');
  assert.equal(item.name, '葬送のフリーレン');
  assert.equal(item.name_raw, 'Sousou no Frieren');
  assert.equal(item.episode_count, 28);
  assert.equal(item.planned_episode_count, 28);
  assert.equal(item.aired_episode_count, 28); // FINISHED → 已播 = 总集数
  assert.equal(item.rating, 8.8); // 88 / 10
  assert.equal(item.air_date, '2023-09-29');
  assert.ok(Array.isArray(item.tags) && item.tags.includes('Magic'));
});

test('AniListProvider 详情标准化为 SubjectDetail 形状', () => {
  const provider = new AniListProvider();
  const detail = provider._normalizeDetail({
    ...fakeAnilistMedia(),
    studios: { nodes: [{ name: 'MADHOUSE' }] }
  });

  assert.equal(detail.summary, '勇敢的冒险开始。');
  assert.equal(detail.source, 'anilist');
  assert.deepEqual(detail.episodes, {});
  assert.deepEqual(detail.studios, ['MADHOUSE']);
  assert.ok(detail.banner.length > 0);
  assert.equal(detail.tags_with_count[0].name, 'Magic');
});

test('SubjectService 将 anilist: 前缀 ID 路由到 AniList', async () => {
  const calls = { anilist: 0, bangumi: 0 };
  const origAniDetail = anilistProvider.getDetail;
  const origBgmDetail = bangumiApi.getDetail;

  anilistProvider.getDetail = async (id) => {
    calls.anilist += 1;
    return new AniListProvider()._normalizeDetail(fakeAnilistMedia({ id }));
  };
  bangumiApi.getDetail = async () => {
    calls.bangumi += 1;
    throw new Error('不该调用 Bangumi');
  };

  try {
    const detail = await subjectService.getDetail('anilist:42');
    assert.equal(calls.anilist, 1);
    assert.equal(calls.bangumi, 0);
    assert.equal(detail.source, 'anilist');
    assert.equal(detail.anilistId, 42);
    assert.equal(detail.planned_episode_count, 28);
  } finally {
    anilistProvider.getDetail = origAniDetail;
    bangumiApi.getDetail = origBgmDetail;
  }
});

test('SubjectService 将数字 ID 路由到 Bangumi（不触达 AniList）', async () => {
  const calls = { anilist: 0, bangumi: 0 };
  const origAniDetail = anilistProvider.getDetail;
  const origBgmDetail = bangumiApi.getDetail;

  anilistProvider.getDetail = async () => {
    calls.anilist += 1;
    throw new Error('不该调用 AniList');
  };
  bangumiApi.getDetail = async (id) => {
    calls.bangumi += 1;
    return { id, name: '进击的巨人', episodes: {}, official_episodes: [], infobox: [], collection: {}, rating: 8.9 };
  };

  try {
    const detail = await subjectService.getDetail(999);
    assert.equal(calls.bangumi, 1);
    assert.equal(calls.anilist, 0);
    assert.equal(detail.id, 'bangumi_999');
    assert.equal(detail.source, 'bangumi');
  } finally {
    anilistProvider.getDetail = origAniDetail;
    bangumiApi.getDetail = origBgmDetail;
  }
});

test('SubjectService 搜索在 Bangumi 失败时回退 AniList', async () => {
  const provider = new AniListProvider();
  const origBgmSearch = bangumiApi.search;
  const origAniSearch = anilistProvider.search;

  bangumiApi.search = async () => ({ data: [], total: 0, error: 'unavailable' });
  anilistProvider.search = async (keyword, page) => ({
    data: [provider._normalizeItem(fakeAnilistMedia())],
    total: 1,
    page,
    totalPages: 1
  });

  try {
    const result = await subjectService.search('葬送测试唯一关键字', 1);
    assert.equal(result._fallbackSource, 'anilist');
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].id, 'anilist_42');
    assert.equal(result.data[0].source, 'anilist');
    assert.equal(result.data[0].bgm_id, null);
  } finally {
    bangumiApi.search = origBgmSearch;
    anilistProvider.search = origAniSearch;
  }
});

test('SubjectService 搜索在 Bangumi 有结果时不回退', async () => {
  const origBgmSearch = bangumiApi.search;
  const origAniSearch = anilistProvider.search;

  bangumiApi.search = async () => ({
    data: [{ id: 999, name: '进击的巨人', air_date: '2013-04-07', rating: 8.9 }],
    total: 1
  });
  let aniCalled = 0;
  anilistProvider.search = async () => {
    aniCalled += 1;
    return { data: [], total: 0 };
  };

  try {
    const result = await subjectService.search('进击的巨人唯一关键字', 1);
    assert.equal(result._fallbackSource, undefined);
    assert.equal(result.data[0].id, 'bangumi_999');
    assert.equal(result.data[0].source, 'bangumi');
    assert.equal(aniCalled, 0);
  } finally {
    bangumiApi.search = origBgmSearch;
    anilistProvider.search = origAniSearch;
  }
});
