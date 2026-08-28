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

test('catalog policy only treats real, reached dates as latest releases', () => {
  const todayKey = '2026-08-28';
  assert.equal(validDateKey('2026-02-29'), '');
  assert.equal(subjectReleaseState(createSubject(1, '2026-08-28'), todayKey).state, 'released-dated');
  assert.equal(isSubjectCatalogEligible(createSubject(2, '2026-08-29'), { sort: 'date', todayKey }), false);
  assert.equal(isSubjectCatalogEligible({ ...createSubject(3, ''), year: 2025 }, { sort: 'date', todayKey }), false);
  assert.equal(isSubjectCatalogEligible({ ...createSubject(4, ''), tags: ['2029年放送'] }, { sort: 'date', todayKey }), false);
  assert.equal(isSubjectCatalogEligible(createSubject(5, '2026-08-28'), { sort: 'date', todayKey }), true);
});

test('catalog score policy rejects future, unrated and tiny unranked samples', () => {
  const todayKey = '2026-08-28';
  const oldTitle = { ...createSubject(10, ''), year: 2020, rating: 8.5, votes: 120 };
  assert.equal(hasQualifiedRating(oldTitle), true);
  assert.equal(isSubjectCatalogEligible(oldTitle, { sort: 'score', todayKey }), true);
  assert.equal(isSubjectCatalogEligible({ ...oldTitle, rating: 0 }, { sort: 'score', todayKey }), false);
  assert.equal(isSubjectCatalogEligible({ ...oldTitle, rating: 10, votes: 1, rank: 0 }, { sort: 'score', todayKey }), false);
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

test('SubjectService serves an uncached catalog page from the local index first', async () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  subjectIndexService.querySubjects = filters => ({
    data: [createSubject(101)],
    total: 557,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: 24,
    fromIndex: true
  });
  service._requestCatalogPage = async () => {
    throw new Error('network should not block the stale-while-revalidate response');
  };

  try {
    const result = await service.catalog({
      page: 6,
      limit: 24,
      sort: 'date',
      includeFuture: false,
      staleWhileRevalidate: true
    });

    assert.equal(result.data[0].bgm_id, 101);
    assert.equal(result._servedFromIndex, true);
    assert.equal(result._staleWhileRevalidate, true);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService serves TV and other platform filters from the local index', async () => {
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
    const result = await service.catalog({
      cat: 1,
      page: 1,
      limit: 24,
      sort: 'date',
      staleWhileRevalidate: true
    });

    assert.equal(capturedFilters.platform, 'TV');
    assert.equal(capturedFilters.requireDated, true);
    assert.equal(result.cat, 1);
    assert.equal(result.total, 1598);
    assert.equal(result._servedFromIndex, true);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService uses numeric local ratings for platform score sorting', async () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  let capturedFilters = null;
  subjectIndexService.querySubjects = filters => {
    capturedFilters = filters;
    return {
      data: [{ ...createSubject(151), rating: 9.2 }],
      total: 412,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: 18,
      fromIndex: true
    };
  };
  service._requestCatalogPage = async () => {
    throw new Error('score is not supported by the public catalog endpoint');
  };

  try {
    const result = await service.catalog({ cat: 1, page: 1, limit: 24, sort: 'score' });

    assert.equal(capturedFilters.platform, 'TV');
    assert.equal(capturedFilters.sort, 'rating');
    assert.equal(capturedFilters.requireRated, true);
    assert.equal(result.data[0].rating, 9.2);
    assert.equal(result._indexBackedScoreSort, true);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
  }
});

test('SubjectService falls back to indexed tags when Bangumi returns an empty filter result', async () => {
  const service = new SubjectService();
  const originalQuery = subjectIndexService.querySubjects;
  const originalRequest = bangumiApi.request;
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
  bangumiApi.request = async (_url, options) => {
    assert.deepEqual(options.body.filter.tag, ['mecha']);
    assert.equal(options.body.filter.meta_tags, undefined);
    return { total: 0, data: [] };
  };

  try {
    const result = await service.browse({ tag: 'mecha', sort: 'score', page: 1, limit: 24 });

    assert.deepEqual(capturedFilters.tags, ['mecha']);
    assert.equal(result.data[0].bgm_id, 203);
    assert.equal(result._emptyResponseFallback, true);
  } finally {
    subjectIndexService.querySubjects = originalQuery;
    bangumiApi.request = originalRequest;
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
    const result = await service.browse({
      tag: '短片',
      sort: 'date',
      page: 1,
      limit: 24,
      staleWhileRevalidate: true
    });

    assert.equal(result._servedFromIndex, undefined);
    assert.equal(networkRequests, 1);
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
    assert.equal(options.body.sort, 'score');
    assert.deepEqual(options.body.filter.tag, ['恋爱']);
    assert.equal(options.body.filter.meta_tags, undefined);
    assert.deepEqual(options.body.filter.air_date, ['<=2026-08-13']);
    return { total: subjects.length, data: subjects };
  };

  try {
    const latest = await service.browse({ tag: '恋爱', sort: 'date', page: 1, limit: 24 });
    const highestRated = await service.browse({ tag: '恋爱', sort: 'score', page: 1, limit: 24 });

    assert.deepEqual(latest.data.map(item => item.bgm_id), [2, 3, 1]);
    assert.deepEqual(highestRated.data.map(item => item.bgm_id), [1, 3, 2]);
    assert.equal(latest.total, 3);
    assert.equal(highestRated.total, 3);
    assert.equal(requests, 2);
  } finally {
    bangumiApi.request = originalRequest;
    bangumiApi._normalizeItem = originalNormalizeItem;
  }
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

test('SubjectService bounds cold tag collection scans', async () => {
  const service = new SubjectService();
  let requests = 0;
  service._requestBrowsePage = async ({ limit, offset }) => {
    requests += 1;
    return {
      total: 10000,
      data: Array.from({ length: limit }, (_, index) => createSubject(offset + index + 1))
    };
  };

  const result = await service._getReleasedBrowseCollection({
    metaTags: ['奇幻'],
    refresh: true
  });

  assert.equal(requests, 8);
  assert.equal(result.data.length, 400);
  assert.equal(result.truncated, true);
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
