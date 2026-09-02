const test = require('node:test');
const assert = require('node:assert/strict');
const { SubjectService } = require('../src/main/services/SubjectService');
const subjectIndexService = require('../src/main/services/SubjectIndexService');
const bangumiApi = require('../src/main/services/BangumiApi');
const {
  hasQualifiedRating,
  isSubjectCatalogEligible,
  subjectReleaseState,
  validDateKey
} = require('../src/main/services/SubjectCatalogPolicy');

function createSubject(id, airDate = '2026-01-01') {
  return {
    id,
    bgm_id: id,
    name: `Subject ${id}`,
    air_date: airDate
  };
}

test('catalog policy keeps one released universe for every sort', () => {
  const todayKey = '2026-08-28';
  assert.equal(validDateKey('2026-02-29'), '');
  assert.equal(subjectReleaseState(createSubject(1, '2026-08-28'), todayKey).state, 'released-dated');
  const samples = [
    [createSubject(2, '2026-08-29'), false],
    [{ ...createSubject(3, ''), year: 2025 }, true],
    [{ ...createSubject(4, ''), tags: ['2029年放送'] }, false],
    [createSubject(5, '2026-08-28'), true],
    [{ ...createSubject(6, ''), year: null }, false]
  ];
  for (const [subject, expected] of samples) {
    assert.equal(isSubjectCatalogEligible(subject, { sort: 'date', todayKey }), expected);
    assert.equal(isSubjectCatalogEligible(subject, { sort: 'score', todayKey }), expected);
  }
});

test('rating quality affects order, never catalog membership', () => {
  const todayKey = '2026-08-28';
  const oldTitle = { ...createSubject(10, ''), year: 2020, rating: 8.5, votes: 120 };
  assert.equal(hasQualifiedRating(oldTitle), true);
  assert.equal(isSubjectCatalogEligible(oldTitle, { sort: 'score', todayKey }), true);
  assert.equal(isSubjectCatalogEligible({ ...oldTitle, rating: 0 }, { sort: 'score', todayKey }), true);
  assert.equal(isSubjectCatalogEligible({ ...oldTitle, rating: 10, votes: 1, rank: 0 }, { sort: 'score', todayKey }), true);
  assert.equal(isSubjectCatalogEligible({ ...oldTitle, year: null }, { sort: 'score', todayKey }), false);
  assert.equal(isSubjectCatalogEligible({ ...oldTitle, tags: ['2027冬'] }, { sort: 'score', todayKey }), false);
});

test('SubjectService reuses released catalog scan results across sequential pages', async () => {
  const service = new SubjectService();
  let requests = 0;
  service._requestCatalogPage = async ({ limit, offset }) => {
    requests += 1;
    return {
      total: 1200,
      data: Array.from({ length: limit }, (_, index) => createSubject(offset + index + 1))
    };
  };

  const first = await service._collectReleasedCatalogPage({
    page: 1,
    limit: 24,
    sort: 'date',
    year: null,
    month: null,
    cat: null,
    todayKey: '2026-07-31'
  });
  const requestsAfterFirstPage = requests;
  const second = await service._collectReleasedCatalogPage({
    page: 2,
    limit: 24,
    sort: 'date',
    year: null,
    month: null,
    cat: null,
    todayKey: '2026-07-31'
  });

  assert.equal(first.data.length, 24);
  assert.equal(second.data.length, 24);
  assert.equal(second.data[0].bgm_id, 25);
  assert.equal(requestsAfterFirstPage, 4);
  assert.equal(requests, requestsAfterFirstPage);
});

test('SubjectService excludes future entries while retaining fetched released entries', async () => {
  const service = new SubjectService();
  service._requestCatalogPage = async ({ limit, offset }) => ({
    total: 800,
    data: Array.from({ length: limit }, (_, index) => {
      const id = offset + index + 1;
      return createSubject(id, id <= 40 ? '2029-01-01' : '2026-01-01');
    })
  });

  const first = await service._collectReleasedCatalogPage({
    page: 1,
    limit: 24,
    sort: 'date',
    year: null,
    month: null,
    cat: null,
    todayKey: '2026-07-31'
  });
  const second = await service._collectReleasedCatalogPage({
    page: 2,
    limit: 24,
    sort: 'date',
    year: null,
    month: null,
    cat: null,
    todayKey: '2026-07-31'
  });

  assert.equal(first.data[0].bgm_id, 41);
  assert.equal(second.data[0].bgm_id, 65);
  assert.equal(first.data.every(item => item.air_date <= '2026-07-31'), true);
  assert.equal(second.data.every(item => item.air_date <= '2026-07-31'), true);
});

test('SubjectService does not expose a partial local total before a catalog network result', async () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  let indexReads = 0;
  subjectIndexService.querySubjects = filters => {
    indexReads += 1;
    return {
      data: [createSubject(101)],
      total: 557,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: 24,
      fromIndex: true
    };
  };
  service._requestCatalogPage = async ({ limit, offset }) => ({
    total: 900,
    data: Array.from({ length: limit }, (_, index) => createSubject(offset + index + 200))
  });

  try {
    const result = await service.catalog({
      page: 6,
      limit: 24,
      sort: 'date',
      includeFuture: false,
      staleWhileRevalidate: true
    });

    assert.equal(result.data[0].bgm_id, 320);
    assert.equal(result.total, 900);
    assert.equal(result._servedFromIndex, undefined);
    assert.equal(indexReads, 0);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService local fallback keeps one TV universe across sort modes', () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  let capturedFilters = null;
  subjectIndexService.querySubjects = filters => {
    capturedFilters = filters;
    return {
      data: [createSubject(150)],
      total: 1598,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: 67,
      fromIndex: true
    };
  };

  try {
    const latest = service._readCatalogPageFromIndex({
      cat: 1,
      page: 1,
      limit: 24,
      sort: 'date'
    });
    assert.equal(capturedFilters.requireDated, false);
    assert.equal(capturedFilters.platform, 'TV');
    const highestRated = service._readCatalogPageFromIndex({
      cat: 1,
      page: 1,
      limit: 24,
      sort: 'score'
    });
    assert.equal(capturedFilters.requireRated, false);
    assert.equal(latest.total, highestRated.total);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService catalog score uses ranked pages with the same public scope total as latest', async () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  subjectIndexService.querySubjects = () => {
    throw new Error('partial index must not define the public total');
  };
  let catalogRequests = 0;
  service._requestCatalogPage = async ({ limit, offset }) => {
    catalogRequests += 1;
    return {
      total: 8903,
      data: Array.from({ length: limit }, (_, index) => ({
        ...createSubject(offset + index + 151),
        rating: Math.max(0, 9.2 - ((offset + index) / 1000)),
        votes: 200
      }))
    };
  };
  service._getCatalogScopeTotal = async () => 29119;

  try {
    const result = await service.catalog({ cat: 1, page: 1, limit: 24, sort: 'score' });

    assert.equal(result.data[0].rating, 9.2);
    assert.equal(result.total, 29119);
    assert.equal(catalogRequests, 4);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService falls back to indexed tags when Bangumi returns an empty filter result', async () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  let capturedFilters = null;
  subjectIndexService.querySubjects = filters => {
    capturedFilters = filters;
    return {
      data: [{ ...createSubject(203), rating: 8.1 }],
      total: 22,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: 1,
      fromIndex: true
    };
  };
  service._getReleasedBrowseCollection = async () => ({ data: [], total: 0, sourceTotal: 0 });

  try {
    const result = await service.browse({ tag: 'mecha', sort: 'score', page: 1, limit: 24 });

    assert.deepEqual(capturedFilters.tags, ['mecha']);
    assert.equal(result.data[0].bgm_id, 203);
    assert.equal(result._emptyResponseFallback, true);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService waits for the network collection on a tag-filtered date browse', async () => {
  // 回归：筛选（标签/年份）+ date 排序曾从增量索引直读，
  // 首屏只显示几条；现在 staleWhileRevalidate 也必须走网络集合路径
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  subjectIndexService.querySubjects = filters => ({
    data: [createSubject(202)],
    total: 1,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: 1,
    fromIndex: true
  });
  const originalRequest = bangumiApi.request;
  const originalNormalizeItem = bangumiApi._normalizeItem;
  let networkRequests = 0;
  bangumiApi._normalizeItem = item => ({
    bgm_id: item.id,
    name: item.name,
    air_date: item.date
  });
  bangumiApi.request = async () => {
    networkRequests += 1;
    return {
      total: 3,
      data: [
        { id: 501, name: 'A', date: '2026-01-05' },
        { id: 502, name: 'B', date: '2026-02-10' },
        { id: 503, name: 'C', date: '2026-03-15' }
      ]
    };
  };

  try {
    // 本测试聚焦“必须走网络集合路径”：屏蔽年份分段，保持基础排序并行扫描
    service._browseYearSegments = () => null;
    const result = await service.browse({
      tag: '短片',
      sort: 'date',
      page: 1,
      limit: 24,
      staleWhileRevalidate: true
    });

    assert.equal(result._servedFromIndex, undefined);
    assert.equal(networkRequests, 3);
    assert.equal(result.total, 3);
    assert.deepEqual(result.data.map(item => item.bgm_id), [503, 502, 501]);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
    bangumiApi.request = originalRequest;
    bangumiApi._normalizeItem = originalNormalizeItem;
  }
});

test('SubjectService derives trending anime from the cached public calendar', async () => {
  const service = new SubjectService();
  const originalGetSchedule = bangumiApi.getSchedule;
  bangumiApi.getSchedule = async () => [{
    weekday: { id: 1, cn: '星期一' },
    items: [
      { ...createSubject(1), rating: 7.2, rank: 30 },
      { ...createSubject(2), rating: 8.7, rank: 10 },
      { ...createSubject(3), rating: 8.1, rank: 20 }
    ]
  }];

  try {
    const result = await service.getTrendingSubjects({ limit: 2 });
    assert.deepEqual(result.map(item => item.bgm_id), [2, 3]);
  } finally {
    bangumiApi.getSchedule = originalGetSchedule;
  }
});

test('SubjectService attaches cached episode progress to the first catalog render', () => {
  const service = new SubjectService();
  service.db = {
    getCacheAny(key) {
      assert.equal(key, 'bangumi:aired-eps:v2:42');
      return {
        content: { count: 7, planned: 12, total: 12 },
        expired: false
      };
    }
  };

  const summary = service._toSubjectSummary(createSubject(42));
  assert.equal(summary.aired_episode_count, 7);
  assert.equal(summary.planned_episode_count, 12);
  assert.equal(summary._airedEpisodeSynced, true);
  assert.equal(summary._airedEpisodeSnapshotExpired, false);
});

test('SubjectService sorts one released tag collection by date and real score', async () => {
  const service = new SubjectService();
  const originalRequest = bangumiApi.request;
  const originalNormalizeItem = bangumiApi._normalizeItem;
  let requests = 0;
  const subjects = [
    { id: 1, name: 'Older high score', date: '2025-01-01', rating: { score: 9.1, total: 500 } },
    { id: 2, name: 'Newest lower score', date: '2026-06-01', rating: { score: 7.2, total: 300 } },
    { id: 3, name: 'Middle score', date: '2026-03-01', rating: { score: 8.4, total: 400 } },
    { id: 4, name: 'Future title', date: '2029-01-01', rating: { score: 9.9, total: 100 } },
    { id: 5, name: 'Undated future title', date: '', tags: ['2027冬'], rating: { score: 10, total: 1 } }
  ];

  service._todayDateKey = () => '2026-08-13';
  // 本测试聚焦“date/score 共享同一集合的排序”：屏蔽年份分段，走基础排序并行路径
  service._browseYearSegments = () => null;
  bangumiApi._normalizeItem = item => ({
    bgm_id: item.id,
    name: item.name,
    air_date: item.date,
    rating: item.rating.score,
    votes: item.rating.total,
    tags: item.tags || []
  });
  bangumiApi.request = async (_url, options) => {
    requests += 1;
    assert.equal(['score', 'rank', 'heat'].includes(options.body.sort), true);
    assert.deepEqual(options.body.filter.tag, ['恋爱']);
    assert.equal(options.body.filter.meta_tags, undefined);
    assert.deepEqual(options.body.filter.air_date, ['<=2026-08-13']);
    // score 排序按真实 API 语义返回评分降序；其余排序返回原数组序。
    // score 视图现在信任服务端顺序（append-only，分页窗口不漂移）。
    const data = options.body.sort === 'score'
      ? [...subjects].sort((a, b) => b.rating.score - a.rating.score)
      : subjects;
    return { total: subjects.length, data };
  };

  try {
    const latest = await service.browse({ tag: '恋爱', sort: 'date', page: 1, limit: 24 });
    const highestRated = await service.browse({ tag: '恋爱', sort: 'score', page: 1, limit: 24 });

    assert.deepEqual(latest.data.map(item => item.bgm_id), [2, 3, 1]);
    assert.deepEqual(highestRated.data.map(item => item.bgm_id), [1, 3, 2]);
    assert.equal(latest.total, 3);
    assert.equal(highestRated.total, 3);
    assert.equal(requests, 3);
  } finally {
    bangumiApi.request = originalRequest;
    bangumiApi._normalizeItem = originalNormalizeItem;
  }
});

test('SubjectService date browse scans recent quarter windows first with stable pagination', async () => {
  // 回归：date 排序曾只用基础 score/rank/heat 扫描（高分老经典番为主），
  // 本地按日期排序后新番 2-3 页耗尽；现在按季度窗口从新到旧完整扫描，
  // 且翻页窗口稳定（每页固定条数，不因集合增长漂移丢条目）。
  const service = new SubjectService();
  service._todayDateKey = () => '2026-08-13';
  const scanCalls = [];

  service._requestBrowsePage = async ({ sort, limit, offset, dateRange }) => {
    const range = (dateRange || []).join('..');
    scanCalls.push(`${sort}:${range}:${limit}:${offset}`);
    // 年份分段探测（limit=1）：y4=328，其余各 100 → 真实总量 728
    if (limit === 1) {
      return {
        total: range.startsWith('>=2024-01-01') ? 328 : 100,
        data: [{ bgm_id: 9001, name: 'probe', air_date: '2025-01-01' }]
      };
    }
    // 当前季度（2026-07 ~ 2026-08-13）：100 条新番
    if (range === '>=2026-07-01..<=2026-08-13') {
      const remaining = Math.max(0, 100 - offset);
      return {
        total: 100,
        data: Array.from({ length: Math.min(limit, remaining) }, (_, index) => ({
          bgm_id: offset + index + 1,
          name: `New ${offset + index + 1}`,
          air_date: '2026-07-15',
          rating: 7.5
        }))
      };
    }
    // 上个季度（2026-04 ~ 2026-06）：80 条较新番
    if (range === '>=2026-04-01..<=2026-06-30') {
      const remaining = Math.max(0, 80 - offset);
      return {
        total: 80,
        data: Array.from({ length: Math.min(limit, remaining) }, (_, index) => ({
          bgm_id: 200 + offset + index + 1,
          name: `Recent ${offset + index + 1}`,
          air_date: '2026-05-10',
          rating: 7.2
        }))
      };
    }
    // 其余季度窗口暂无数据
    if (dateRange && dateRange[0] >= '>=2025') {
      return { total: 0, data: [] };
    }
    // 更老的分段/基础排序：老经典番
    return {
      total: 60,
      data: Array.from({ length: Math.min(limit, Math.max(0, 60 - offset)) }, (_, index) => ({
        bgm_id: 8000 + offset + index + 1,
        name: 'Classic',
        air_date: '2001-01-01',
        rating: 9.5
      }))
    };
  };

  const page1 = await service.browse({ tag: '恋爱', sort: 'date', page: 1, limit: 24 });
  const requestsAfterPage1 = scanCalls.length;
  const page2 = await service.browse({ tag: '恋爱', sort: 'date', page: 2, limit: 24 });
  const requestsAfterPage2 = scanCalls.length;
  const page5 = await service.browse({ tag: '恋爱', sort: 'date', page: 5, limit: 24 });

  // 首页全部是当季新番（日期 2026-07），不再被高分老番淹没
  assert.equal(page1.data.length, 24);
  assert.ok(page1.data.every(item => item.air_date === '2026-07-15'));
  // 真实总量来自分段探测之和
  assert.equal(page1.total, 728);
  // 第 2 页不触发新扫描（当前季度已扫满 100 条），翻页窗口稳定不重叠。
  // date 排序用集合插入序（季度窗口从新到旧扫入），第 2 页紧接第 1 页的
  // 插入序位置（当前季度 score 顺序 1-100）。
  assert.equal(requestsAfterPage2, requestsAfterPage1);
  assert.deepEqual(
    page2.data.map(item => item.bgm_id),
    page1.data.map(item => item.bgm_id).map(id => id + 24)
  );
  // 第 5 页仍在输出较新番（2026-05 的上季度数据），不是老经典番
  assert.ok(page5.data.some(item => item.air_date === '2026-05-10'));
  assert.ok(page5.data.every(item => Number(item.air_date.slice(0, 4)) >= 2026));
  // 扫描从当季窗口开始（首个非探测请求是 2026Q3 分段）
  assert.ok(scanCalls.some(call => call.startsWith('score:>=2026-07-01..<=2026-08-13:20:0')));
});

test('SubjectService keeps region tags separate from official platform metadata', async () => {
  const service = new SubjectService();
  const originalRequest = bangumiApi.request;
  const originalNormalizeItem = bangumiApi._normalizeItem;
  bangumiApi._normalizeItem = item => item;
  bangumiApi.request = async (_url, options) => {
    assert.deepEqual(options.body.filter.tag, ['国漫', '战斗']);
    assert.deepEqual(options.body.filter.meta_tags, ['WEB']);
    return {
      total: 1,
      data: [{ id: 501, name: 'Combined filter', air_date: '2025-01-01', rating: 8.2, votes: 200 }]
    };
  };

  try {
    const result = await service.browse({
      tags: ['国漫', '战斗'],
      metaTags: ['WEB'],
      sort: 'score',
      page: 1,
      limit: 24
    });
    assert.equal(result.data.length, 1);
    assert.deepEqual(result.tags, ['国漫', '战斗']);
    assert.deepEqual(result.metaTags, ['WEB']);
  } finally {
    bangumiApi.request = originalRequest;
    bangumiApi._normalizeItem = originalNormalizeItem;
  }
});

test('every filter scope keeps identical membership for latest and rating sorts', async () => {
  const scopes = [
    { tags: ['日本'] },
    { tags: ['中国'] },
    { tags: ['欧美'] },
    { tags: ['韩国'] },
    { tags: ['日本', '战斗'] },
    { tags: ['中国'], metaTags: ['WEB'] },
    { tags: ['日本'], metaTags: ['TV'], year: 2024 }
  ];

  for (const scope of scopes) {
    const service = new SubjectService();
    service._getReleasedBrowseCollection = async () => ({
      data: [
        { ...createSubject(1, '2022-01-01'), rating: 9.1, votes: 300 },
        { ...createSubject(2, '2024-01-01'), rating: 0, votes: 0 },
        { ...createSubject(3, ''), year: 2020, rating: 7.5, votes: 80 }
      ],
      total: 3,
      sourceTotal: 3,
      releaseDate: '2026-08-29',
      truncated: false
    });
    const latest = await service.browse({ ...scope, sort: 'date', page: 1, limit: 24 });
    const rating = await service.browse({ ...scope, sort: 'score', page: 1, limit: 24 });
    assert.equal(rating.total, latest.total, JSON.stringify(scope));
    assert.deepEqual(
      new Set(rating.data.map(item => item.bgm_id)),
      new Set(latest.data.map(item => item.bgm_id)),
      JSON.stringify(scope)
    );
  }
});

test('SubjectService loads only one request round for a cold tag-filtered first page', async () => {
  const service = new SubjectService();
  let requests = 0;
  const sortOffsets = { score: 0, rank: 10000, heat: 20000 };
  service._requestBrowsePage = async ({ sort = 'score', limit, offset }) => {
    requests += 1;
    return {
      total: 10000,
      data: Array.from({ length: limit }, (_, index) => createSubject(sortOffsets[sort] + offset + index + 1))
    };
  };

  const result = await service._getReleasedBrowseCollection({
    metaTags: ['奇幻'],
    refresh: true
  });

  // total=10000 触发截断检测：3 个排序页 + 5 个年份分段探测（limit=1）
  assert.equal(requests, 8);
  assert.equal(result.data.length, 60);
  assert.equal(result.truncated, true);
});

test('SubjectService incrementally expands a tag collection only when a later page needs it', async () => {
  const service = new SubjectService();
  let requests = 0;
  const sortOffsets = { score: 0, rank: 10000, heat: 20000 };
  service._requestBrowsePage = async ({ sort = 'score', limit, offset }) => {
    requests += 1;
    return {
      total: 1000,
      data: Array.from({ length: limit }, (_, index) => createSubject(sortOffsets[sort] + offset + index + 1))
    };
  };

  const first = await service._getReleasedBrowseCollection({
    userTags: ['fantasy'],
    minItems: 24,
    refresh: true
  });
  const second = await service._getReleasedBrowseCollection({
    userTags: ['fantasy'],
    minItems: 61
  });

  assert.equal(first.data.length, 60);
  assert.equal(second.data.length, 120);
  // total=1000 触发截断检测：首次扫描 3 个排序页 + 5 个分段探测（limit=1）；
  // 第二次（内存缓存命中 60 条 + 探测结果）只补 1 轮扩扫 = 3
  assert.equal(requests, 11);
  assert.deepEqual(second.scannedPages, { score: 2, rank: 2, heat: 2 });
});

test('SubjectService does not serve a year-filtered date browse from the partial local index', async () => {
  // 回归：年份 + date 排序曾直接读增量索引，只有几条数据；
  // 现在必须走网络集合路径（_getReleasedBrowseCollection）
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  subjectIndexService.querySubjects = filters => ({
    data: [createSubject(301)],
    total: 1,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: 1,
    fromIndex: true
  });
  let collectionCalls = 0;
  service._getReleasedBrowseCollection = async ({ year }) => {
    collectionCalls += 1;
    assert.equal(year, 2024);
    const items = Array.from({ length: 60 }, (_, index) => createSubject(1000 + index));
    return {
      data: items,
      total: items.length,
      sourceTotal: 60,
      releaseDate: '2026-08-27',
      futureFiltered: true,
      truncated: false
    };
  };

  try {
    const result = await service.browse({ sort: 'date', year: 2024, page: 1, limit: 24 });

    assert.equal(collectionCalls, 1);
    assert.equal(result._servedFromIndex, undefined);
    assert.equal(result.data.length, 24);
    assert.equal(result.total, 60);
    assert.equal(result.totalPages, 3);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});
