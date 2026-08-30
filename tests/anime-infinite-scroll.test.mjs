import test from 'node:test';
import assert from 'node:assert/strict';
import animeStore from '../src/renderer/store/modules/anime.js';
import animeCatalogVirtualization from '../src/renderer/mixins/animeCatalogVirtualization.js';
import animeInfiniteScroll from '../src/renderer/mixins/animeInfiniteScroll.js';

test('APPEND_ANIME_LIST appends unique cards and advances the loaded page', () => {
  const state = {
    animeList: [
      { id: '1', source: 'bangumi', name: 'One' },
      { id: '2', source: 'bangumi', name: 'Two' }
    ],
    currentPage: 1,
    totalPages: 4
  };
  const originalFirst = state.animeList[0];

  animeStore.mutations.APPEND_ANIME_LIST(state, {
    data: [
      { id: '2', source: 'bangumi', name: 'Duplicate' },
      { id: '3', source: 'bangumi', name: 'Three' }
    ],
    page: 2,
    totalPages: 4
  });

  assert.deepEqual(state.animeList.map(item => item.id), ['1', '2', '3']);
  assert.equal(state.animeList[0], originalFirst);
  assert.equal(state.currentPage, 2);
  assert.equal(state.totalPages, 4);
});

test('APPEND_ANIME_LIST advances through an empty page without duplicating data', () => {
  const state = {
    animeList: [{ id: '1', source: 'bangumi' }],
    currentPage: 2,
    totalPages: 5
  };

  animeStore.mutations.APPEND_ANIME_LIST(state, {
    data: [],
    page: 3,
    totalPages: 5
  });

  assert.equal(state.animeList.length, 1);
  assert.equal(state.currentPage, 3);
});

test('virtualization measures the actual grid instead of its section wrapper', () => {
  const grid = { matches: selector => selector === '.anime-grid' };
  const section = {
    matches: () => false,
    querySelector: selector => selector === '.anime-grid' ? grid : null
  };
  const context = { $refs: { animeGrid: { $el: section } } };

  const result = animeCatalogVirtualization.methods.getAnimeGridElement.call(context);
  assert.equal(result, grid);
});

test('crossing the virtualization threshold measures columns before sizing the window', () => {
  let measured = 0;
  const context = {
    animeList: Array.from({ length: 168 }, (_, id) => ({ id })),
    useVirtualAnimeGrid: true,
    visibleAnimeLimit: 40,
    virtualColumnCount: 1,
    virtualStartIndex: 0,
    virtualEndIndex: 48,
    _virtualGridTop: 0,
    cancelProgressiveRender() {},
    measureVirtualGrid() {
      measured += 1;
      this.virtualColumnCount = 6;
    },
    $nextTick(callback) {
      callback();
    },
    scheduleVirtualGridMeasure() {},
    scheduleVisibleCoverPrefetch() {}
  };

  animeCatalogVirtualization.methods.handleAppendedAnimeList.call(context, 40);

  assert.equal(measured, 1);
  assert.equal(context.virtualColumnCount, 6);
  assert.equal(context.virtualStartIndex, 0);
  assert.equal(context.virtualEndIndex, 60);
  assert.equal(context._virtualGridTop, null);
});

test('infinite loading stops with an honest message at the Bangumi offset limit', async () => {
  const commits = [];
  const context = {
    isBangumiMode: true,
    loading: false,
    loadingMore: false,
    loadMoreError: '',
    loadMoreLimitReason: '',
    hasMoreAnimePages: true,
    currentPage: 417,
    totalPages: 1204,
    totalItems: 28891,
    searchKeyword: '',
    _infiniteLoadToken: 0,
    bangumiListSignature: () => 'same-query',
    buildBangumiListRequest: () => ({}),
    fetchBangumiList: async () => ({ _outOfRange: true }),
    $store: {
      commit(type, payload) {
        commits.push({ type, payload });
      }
    },
    $nextTick(callback) {
      callback();
    },
    scheduleInfiniteLoadCheck() {}
  };

  const loaded = await animeInfiniteScroll.methods.loadNextAnimePage.call(context);

  assert.equal(loaded, false);
  assert.match(context.loadMoreLimitReason, /接口浏览上限/);
  assert.deepEqual(commits, [{
    type: 'anime/APPEND_ANIME_LIST',
    payload: { data: [], page: 417, totalPages: 417 }
  }]);
});

test('infinite loading keeps the remote total when a cold page comes from the local index', async () => {
  const commits = [];
  let requestOptions = null;
  const context = {
    isBangumiMode: true,
    loading: false,
    loadingMore: false,
    loadMoreError: '',
    loadMoreLimitReason: '',
    hasMoreAnimePages: true,
    currentPage: 5,
    totalPages: 1204,
    totalItems: 28891,
    animeList: Array.from({ length: 120 }, (_, id) => ({ id: String(id + 1), source: 'bangumi' })),
    searchKeyword: '',
    _infiniteLoadToken: 0,
    bangumiListSignature: () => 'same-query',
    buildBangumiListRequest(_page, _search, options) {
      requestOptions = options;
      return options;
    },
    fetchBangumiList: async () => ({
      data: [{ id: '121', source: 'bangumi' }],
      page: 6,
      total: 557,
      totalPages: 24,
      _servedFromIndex: true
    }),
    $store: {
      commit(type, payload) {
        commits.push({ type, payload });
      }
    },
    checkFavoritesBatch() {},
    scheduleBangumiListMetaEnrichment() {},
    scheduleBangumiAdjacentPagePrefetch() {},
    scheduleVirtualGridMeasure() {},
    scheduleInfiniteLoadCheck() {},
    $nextTick(callback) {
      callback();
    }
  };

  const loaded = await animeInfiniteScroll.methods.loadNextAnimePage.call(context);

  assert.equal(loaded, true);
  assert.equal(requestOptions.staleWhileRevalidate, true);
  assert.equal(context.totalItems, 28891);
  assert.equal(commits[0].payload.totalPages, 1204);
});

test('infinite loading does not rewrite the active filter total', async () => {
  const context = {
    isBangumiMode: true,
    loading: false,
    loadingMore: false,
    loadMoreError: '',
    loadMoreLimitReason: '',
    hasMoreAnimePages: true,
    currentPage: 1,
    totalPages: 42,
    totalItems: 1000,
    animeList: [{ id: '1', source: 'bangumi' }],
    searchKeyword: '',
    _infiniteLoadToken: 0,
    bangumiListSignature: () => 'stable-filter',
    buildBangumiListRequest: () => ({}),
    fetchBangumiList: async () => ({
      data: [{ id: '2', source: 'bangumi' }],
      page: 2,
      total: 987,
      totalPages: 42
    }),
    $store: { commit() {} },
    checkFavoritesBatch() {},
    scheduleBangumiListMetaEnrichment() {},
    scheduleBangumiAdjacentPagePrefetch() {},
    scheduleVirtualGridMeasure() {},
    scheduleInfiniteLoadCheck() {},
    $nextTick(callback) { callback(); }
  };

  const loaded = await animeInfiniteScroll.methods.loadNextAnimePage.call(context);

  assert.equal(loaded, true);
  assert.equal(context.totalItems, 1000);
});
