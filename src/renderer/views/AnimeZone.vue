<template>
  <div class="anime-zone">
    <!-- 顶栏：番剧资料库 + 搜索 -->
    <div class="top-bar">
      <div class="top-bar-left">
        <div class="library-brand">
          <BrandMark :size="36" />
          <div class="library-brand-copy">
            <strong>樱落番剧部</strong>
            <small>番剧资料库与本地片源</small>
          </div>
        </div>
      </div>

      <div class="top-bar-right">
        <SearchBar
          :value="searchInput"
          :placeholder="searchPlaceholder"
          :has-keyword="searchKeyword"
          @search="handleSearch"
          @input="onSearchBarInput"
          @clear="clearSearch"
        />
        <button
          class="image-search-btn"
          @click="openImageSearch"
          title="以图搜番"
          aria-label="以图搜番"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 继续观看 -->
    <ContinueWatching
      :items="recentHistory"
      :resuming-key="resumingHistoryKey"
      @resume="resumePlay"
      @remove="onRemoveHistory"
    />

    <AnimeCatalogToolbar
      :loading="loading"
      :total-items="totalItems"
      :selected-type="selectedBangumiType"
      :selected-sort="selectedBangumiSort"
      :selected-region="selectedBangumiRegion"
      :selected-year="selectedBangumiYear"
      :search-keyword="searchKeyword"
      :type-options="bangumiTypeOptions"
      :sort-options="availableBangumiSortOptions"
      :region-options="bangumiRegionOptions"
      :year-options="bangumiYearOptions"
      :season-options="bangumiSeasonOptions"
      :season-year="bangumiSeasonYear"
      :season-quarter="bangumiSeasonQuarter"
      :current-season-label="currentBangumiSeasonLabel"
      :active-type-name="activeBangumiType.name"
      :active-sort-name="activeBangumiSort.name"
      :active-region-name="activeBangumiRegion.name"
      @select-type="onBangumiTypeSelect"
      @select-sort="onBangumiSortSelect"
      @select-region="onBangumiRegionSelect"
      @year-change="onBangumiYearChange"
      @season-change="onSeasonSelectChange"
      @clear-search="clearSearch"
      @clear-year="clearBangumiYear"
    />

    <div class="catalog-stage" :class="listFadeClass">
      <AnimeCatalogGrid
        ref="animeGrid"
        :loading="loading"
        :anime-list="animeList"
        :rendered-list="renderedAnimeList"
        :virtualized="useVirtualAnimeGrid"
        :top-spacer="virtualTopSpacerHeight"
        :bottom-spacer="virtualBottomSpacerHeight"
        :favorite-map="favoriteMap"
        :failed-image-ids="failedImageIds"
        :search-keyword="searchKeyword"
        :load-error="loadError || ''"
        @view="viewAnimeDetail"
        @toggle-favorite="onToggleFavorite"
        @image-error="onImageError"
        @image-load="onImageLoad"
        @card-visible="onAnimeCardVisible"
        @retry="loadError ? refreshData() : (searchKeyword ? clearSearch() : refreshData())"
      />
    </div>

    <!-- 分页 -->
    <Pagination
      v-if="!isBangumiMode && totalPages > 1 && !loading"
      :current-page="currentPage"
      :total-pages="totalPages"
      @change="changePage"
    />

    <AnimeInfiniteFooter
      v-if="isBangumiMode && animeList.length > 0"
      :loading="loadingMore"
      :error="loadMoreError"
      :limit-reason="loadMoreLimitReason"
      :complete="!hasMoreAnimePages"
      :loaded="animeList.length"
      :total="totalItems"
      @retry="retryLoadMore"
    />

    <!-- 动漫详情弹窗 -->
    <AnimeDetail
      v-if="detailAnime"
      :anime="detailAnime"
      :isFavorited="isAnimeFavorited(detailAnime)"
      :opening-episode-key="openingEpisodeKey"
      @close="closeDetail"
      @toggle-fav="onToggleFavorite"
      @play-episode="onPlayEpisode"
      @search-tag="onBangumiTagSearch"
      @source-availability="onSourceAvailability"
    />

    <!-- 以图搜番弹窗 -->
    <ImageSearch
      v-if="showImageSearch"
      @close="closeImageSearch"
      @locate="onImageSearchLocate"
    />
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';
import AnimeDetail from '../components/AnimeZone/AnimeDetail.vue';
import ContinueWatching from '../components/AnimeZone/ContinueWatching.vue';
import SearchBar from '../components/AnimeZone/SearchBar.vue';
import Pagination from '../components/AnimeZone/Pagination.vue';
import ImageSearch from '../components/AnimeZone/ImageSearch.vue';
import BrandMark from '../components/Common/BrandMark.vue';
import AnimeCatalogToolbar from '../components/AnimeZone/AnimeCatalogToolbar.vue';
import AnimeCatalogGrid from '../components/AnimeZone/AnimeCatalogGrid.vue';
import AnimeInfiniteFooter from '../components/AnimeZone/AnimeInfiniteFooter.vue';
import animeCatalogVirtualization from '../mixins/animeCatalogVirtualization.js';
import animeInfiniteScroll from '../mixins/animeInfiniteScroll.js';
import animeEpisodeAvailability from '../mixins/animeEpisodeAvailability.js';
import animeDetailModal from '../mixins/animeDetailModal.js';
import { bangumiRegionOptions, filterCatalogSortOptions, normalizeCatalogSort } from '../utils/catalogSort.js';
import {
  continueWatchingKey,
  resolveContinueWatching
} from '../utils/continueWatching.js';
import { plannedEpisodeCount } from '../utils/episodeMetadata.js';

export default {
  name: 'AnimeZone',
  mixins: [animeCatalogVirtualization, animeInfiniteScroll, animeEpisodeAvailability, animeDetailModal],
  components: { AnimeDetail, ContinueWatching, SearchBar, Pagination, ImageSearch, BrandMark, AnimeCatalogToolbar, AnimeCatalogGrid, AnimeInfiniteFooter },
  data() {
    return {
      searchInput: '',
      listFadeClass: '',
      _listFadeTimer: null,
      failedImageIds: new Set(),
      totalItems: 0,
      selectedBangumiType: 'all',
      selectedBangumiSort: 'date',
      selectedBangumiRegion: 'all',
      selectedBangumiYear: '',
      bangumiSortOptions: [
        { id: 'date', name: '最新上映', sort: 'date' },
        { id: 'score', name: '评分优先', sort: 'score' }
      ],
      bangumiRegionOptions: bangumiRegionOptions.map(option => ({ ...option })),
      bangumiTypeOptions: [
        { id: 'all', name: '全部', mode: 'catalog' },
        { id: 'season', name: '本季', mode: 'season' },
        { id: 'tv', name: 'TV', mode: 'catalog', cat: 1 },
        { id: 'ova', name: 'OVA', mode: 'catalog', cat: 2 },
        { id: 'movie', name: '剧场版', mode: 'catalog', cat: 3 },
        { id: 'web', name: 'WEB', mode: 'catalog', cat: 5 },
        { id: 'manga', name: '漫画改', mode: 'browse', tag: '漫画改', sort: 'rank' },
        { id: 'original', name: '原创', mode: 'browse', tag: '原创', sort: 'rank' },
        { id: 'novel', name: '小说改', mode: 'browse', tag: '小说改', sort: 'rank' },
        { id: 'game', name: '游戏改', mode: 'browse', tag: '游戏改', sort: 'rank' },
        { id: 'isekai', name: '异世界', mode: 'browse', tag: '异世界', sort: 'rank' },
        { id: 'daily', name: '日常', mode: 'browse', tag: '日常', sort: 'rank' },
        { id: 'comedy', name: '搞笑', mode: 'browse', tag: '搞笑', sort: 'rank' },
        { id: 'love', name: '恋爱', mode: 'browse', tag: '恋爱', sort: 'rank' },
        { id: 'battle', name: '战斗', mode: 'browse', tag: '战斗', sort: 'rank' },
        { id: 'sci-fi', name: '科幻', mode: 'browse', tag: '科幻', sort: 'rank' },
        { id: 'healing', name: '治愈', mode: 'browse', tag: '治愈', sort: 'rank' },
        { id: 'mystery', name: '悬疑', mode: 'browse', tag: '悬疑', sort: 'rank' },
        { id: 'mecha', name: '机甲', mode: 'browse', tag: '机甲', sort: 'rank' },
        { id: 'music', name: '音乐', mode: 'browse', tag: '音乐', sort: 'rank' },
        { id: 'sports', name: '运动', mode: 'browse', tag: '运动', sort: 'rank' },
        { id: 'food', name: '美食', mode: 'browse', tag: '美食', sort: 'rank' },
        { id: 'fantasy', name: '奇幻', mode: 'browse', tag: '奇幻', sort: 'rank' },
        { id: 'adventure', name: '冒险', mode: 'browse', tag: '冒险', sort: 'rank' },
        { id: 'horror', name: '恐怖', mode: 'browse', tag: '恐怖', sort: 'rank' },
        { id: 'history', name: '历史', mode: 'browse', tag: '历史', sort: 'rank' },
        { id: 'war', name: '战争', mode: 'browse', tag: '战争', sort: 'rank' },
        { id: 'magic', name: '魔法', mode: 'browse', tag: '魔法', sort: 'rank' },
        { id: 'school', name: '校园', mode: 'browse', tag: '校园', sort: 'rank' },
        { id: 'detective', name: '推理', mode: 'browse', tag: '推理', sort: 'rank' },
        { id: 'idol', name: '偶像', mode: 'browse', tag: '偶像', sort: 'rank' },
        { id: 'doujin', name: '同人', mode: 'browse', tag: '同人', sort: 'rank' },
        { id: 'short', name: '短片', mode: 'browse', tag: '短片', sort: 'rank' }
      ],
      selectedFanzhiCategory: '30',
      selectedGenre: '',
      selectedCmsMultiSource: '',
      selectedCmsMultiCategory: '30',
      _prefetchAbort: false,
      _prefetchToken: 0,
      _prefetchTimer: null,
      _prefetchQueue: [],
      _prefetchMaxQueue: 8,
      _prefetchQueuedIds: new Set(),
      _prefetchInFlightIds: new Set(),
      _prefetchWorkerRunning: false,
      _prefetchWorkerToken: 0,
      _coverObserver: null,
      _mainScrollEl: null,
      _isMainScrolling: false,
      _scrollIdleTimer: null,
      _lastMainScrollAt: 0,
      _pendingAnimeUpdates: new Map(),
      _pendingUpdateFlushTimer: null,
      _pendingUpdateIdleHandle: null,
      _coverObserverRefreshTimer: null,
      _imageRetryTimers: new Map(),
      _imageRetriedIds: new Map(),
      _filterDebounceTimer: null,
      _bangumiRefreshTimer: null,
      _bangumiRefreshIdleHandle: null,
      _bangumiRefreshToken: 0,
      _bangumiMetaEnrichToken: 0,
      _bangumiMetaStartTimer: null,
      _bangumiMetaIdleHandle: null,
      _bangumiPagePrefetchTimer: null,
      _bangumiPagePrefetchIdleHandle: null,
      _bangumiPagePrefetchToken: 0,
      _bangumiPrefetchedPageKeys: new Set(),
      _playRequestToken: 0,
      _resumeRequestToken: 0,
      _listRequestToken: 0,
      _detailRequestToken: 0,
      _preloadBgmIdToken: 0,
      _preloadBgmIdHandles: new Set(),
      _sourceSwitchToken: 0,
      resumingHistoryKey: '',
      _pendingPlayerWindowId: null,
      showImageSearch: false,
      searchDebounceTimer: null,
      loadError: null
    };
  },
  watch: {
    // 列表加载完成时触发整体淡入（避免加载中淡出导致的白屏闪烁）
    loading(isLoading) {
      if (isLoading) return;
      if (this._listFadeTimer) {
        clearTimeout(this._listFadeTimer);
        this._listFadeTimer = null;
      }
      this.listFadeClass = 'list-fading-in';
      this._listFadeTimer = setTimeout(() => {
        this._listFadeTimer = null;
        this.listFadeClass = '';
      }, 320);
    }
  },
  computed: {
    ...mapGetters('anime', [
      'animeList',
      'currentPage',
      'totalPages',
      'loading',
      'searchKeyword',
      'popularTypes',
      'dataSource',
      'isBangumiMode',
      'isFanzhiMode',
      'fanzhiCategories',
      'fanzhiCurrentCategory',
      'fanzhiGenreTags',
      'fanzhiSelectedGenre',
      'cmsMultiSources',
      'cmsMultiCurrentSource',
      'cmsMultiCategories',
      'cmsMultiCurrentCategory',
      'bangumiSeasonYear',
      'bangumiSeasonQuarter'
    ]),
    ...mapGetters('favorite', [
      'favoriteMap',
      'recentHistory'
    ]),

    activeBangumiType() {
      return this.bangumiTypeOptions.find(option => option.id === this.selectedBangumiType) || this.bangumiTypeOptions[0];
    },

    activeBangumiSort() {
      return this.bangumiSortOptions.find(option => option.id === this.selectedBangumiSort) || this.bangumiSortOptions[0];
    },

    activeBangumiRegion() {
      return this.bangumiRegionOptions.find(option => option.id === this.selectedBangumiRegion) || this.bangumiRegionOptions[0];
    },

    availableBangumiSortOptions() {
      return filterCatalogSortOptions(this.activeBangumiType, this.bangumiSortOptions);
    },

    bangumiYearOptions() {
      const currentYear = new Date().getFullYear();
      const years = [];
      for (let year = currentYear; year >= 1970; year -= 1) {
        years.push(year);
      }
      return years;
    },

    currentSeasonLabel() {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      // 番剧季度：1月冬番、4月春番、7月夏番、10月秋番
      const seasonMap = { 1: '冬', 2: '冬', 3: '冬', 4: '春', 5: '春', 6: '春', 7: '夏', 8: '夏', 9: '夏', 10: '秋', 11: '秋', 12: '秋' };
      return `${year}年${month}月${seasonMap[month]}番`;
    },

    // Bangumi 季度选择器：从 2015 年到当前季度，按时间倒序
    bangumiSeasonOptions() {
      const now = new Date();
      const curYear = now.getFullYear();
      const curMonth = now.getMonth() + 1;
      const curQuarter = Math.ceil(curMonth / 3); // 1冬2春3夏4秋
      const quarterNames = { 1: '冬', 2: '春', 3: '夏', 4: '秋' };

      const options = [];
      // 当前季度放最前（标记为"本季"）
      options.push({ year: curYear, quarter: curQuarter, label: `${curYear} ${quarterNames[curQuarter]}番（本季）`, isCurrent: true });
      // 向前回溯到 2015 年
      let y = curYear, q = curQuarter;
      while (y > 2015 || q > 1) {
        q -= 1;
        if (q < 1) { q = 4; y -= 1; }
        options.push({ year: y, quarter: q, label: `${y} ${quarterNames[q]}番` });
      }
      return options;
    },

    // 当前选中的季度标签（null=显示本季日历）
    currentBangumiSeasonLabel() {
      if (!this.bangumiSeasonYear || !this.bangumiSeasonQuarter) return '本季新番';
      const quarterNames = { 1: '冬', 2: '春', 3: '夏', 4: '秋' };
      return `${this.bangumiSeasonYear} ${quarterNames[this.bangumiSeasonQuarter]}番`;
    },

    searchPlaceholder() {
      return '搜索番剧...';
    }
  },
  methods: {
    ...mapActions('anime', [
      'fetchAnimeList',
      'fetchAnimeDetail',
      'fetchPopularTypes',
      'setDataSource',
      'fetchBangumiList',
      'fetchBangumiDetail',
      'fetchFanzhiCategories',
      'fetchFanzhiList',
      'fetchFanzhiDetail',
      'fetchFanzhiPlayUrl',
      'searchFanzhi',
      'switchFanzhiCategory',
      'fetchFanzhiGenreTags',
      'searchFanzhiByGenre',
      'clearFanzhiGenreFilter',
      'loadCmsMultiSources',
      'setCmsMultiSource',
      'fetchCmsMultiList',
      'fetchCmsMultiDetail',
      'searchCmsMulti',
      'searchCmsMultiAllSources',
      'selectBestCmsEpisodeSource',
      'testCmsMultiAll'
    ]),
    ...mapActions('favorite', [
      'checkFavoritesBatch',
      'fetchRecentHistory',
      'removePlayHistory'
    ]),

    toPositiveEpisodeNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) && number > 0 ? number : 0;
    },

    getPlannedEpisodeCount(anime) {
      return plannedEpisodeCount(anime);
    },

    buildBangumiListRequest(page = 1, search = '', extra = {}) {
      const filter = this.activeBangumiType || {};
      const selectedSortId = normalizeCatalogSort(filter, this.selectedBangumiSort);
      const requestSort = this.bangumiSortOptions.find(option => option.id === selectedSortId)?.sort || 'date';
      const tags = [filter.tag, this.activeBangumiRegion.tag].filter(Boolean);
      const platformByCategory = { 1: 'TV', 2: 'OVA', 3: '剧场版', 5: 'WEB' };
      const metaTags = tags.length > 0 && filter.cat ? [platformByCategory[filter.cat]].filter(Boolean) : [];
      const requestMode = tags.length > 0 ? 'browse' : (filter.mode || 'browse');

      return {
        page,
        search,
        year: filter.mode === 'season' ? this.bangumiSeasonYear : null,
        quarter: filter.mode === 'season' ? this.bangumiSeasonQuarter : null,
        tag: filter.tag || '',
        tags,
        metaTags,
        sort: requestSort,
        mode: requestMode,
        cat: requestMode === 'catalog' ? (filter.cat || null) : null,
        browseYear: filter.mode === 'season' ? null : (this.selectedBangumiYear || null),
        ...extra
      };
    },

    bangumiListSignature(page = 1, search = '') {
      const request = this.buildBangumiListRequest(page, search);
      return JSON.stringify({
        source: this.dataSource,
        selectedType: this.selectedBangumiType,
        selectedSort: this.selectedBangumiSort,
        selectedRegion: this.selectedBangumiRegion,
        selectedYear: this.selectedBangumiYear,
        request
      });
    },

    scheduleBangumiStaleRefresh(page = 1, search = '') {
      if (!this.isBangumiMode) return;
      if (this._bangumiRefreshTimer) {
        clearTimeout(this._bangumiRefreshTimer);
        this._bangumiRefreshTimer = null;
      }
      if (this._bangumiRefreshIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._bangumiRefreshIdleHandle);
        this._bangumiRefreshIdleHandle = null;
      }

      const token = ++this._bangumiRefreshToken;
      const signature = this.bangumiListSignature(page, search);
      const run = async () => {
        this._bangumiRefreshTimer = null;
        this._bangumiRefreshIdleHandle = null;
        if (token !== this._bangumiRefreshToken || signature !== this.bangumiListSignature(page, search)) return;

        try {
          const result = await this.fetchBangumiList(this.buildBangumiListRequest(page, search, {
            refresh: true,
            staleWhileRevalidate: false,
            silent: true,
            commitResult: false
          }));
          if (token !== this._bangumiRefreshToken || signature !== this.bangumiListSignature(page, search)) return;
          if (!result || result.error || result.stale) return;
          // Stale-while-revalidate only warms the cache. Replacing the visible
          // result here made an untouched filter suddenly change cards and total.
        } catch (error) {
          console.warn('[AnimeZone] Bangumi 后台刷新失败:', error?.message || error);
        }
      };

      this._bangumiRefreshTimer = setTimeout(() => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          this._bangumiRefreshIdleHandle = window.requestIdleCallback(run, { timeout: 1500 });
        } else {
          run();
        }
      }, 2200);
    },

    scheduleBangumiListMetaEnrichment(list = this.animeList) {
      if (!this.isBangumiMode || !Array.isArray(list) || list.length === 0) return;
      this.cancelBangumiMetaEnrichmentSchedule();
      const targets = list
        .filter(item => item?.source === 'bangumi' && (item.bgm_id || item.bgmId))
        // Subject detail can fill a missing planned total, but it cannot reliably
        // tell how many episodes a playback provider currently exposes. Avoid a
        // page-wide request fan-out for rank/votes or a guessed update badge.
        .filter(item => !this.getPlannedEpisodeCount(item))
        .slice(0, 24);
      if (targets.length === 0) return;

      const token = ++this._bangumiMetaEnrichToken;
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const waitForIdle = () => new Promise(resolve => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: 2200 });
        } else {
          setTimeout(resolve, 420);
        }
      });
      const isActive = () => token === this._bangumiMetaEnrichToken && this.isBangumiMode;

      const enrichOne = async (item) => {
        if (!isActive()) return;
        while (this._isMainScrolling && isActive()) {
          await delay(260);
        }
        await waitForIdle();
        if (!isActive()) return;

        const bgmId = item.bgm_id || item.bgmId;
        const detail = await window.electronAPI?.subjectDetail?.(bgmId);
        if (!isActive() || !detail) return;

        const updates = {};
        const episodeCount = this.toPositiveEpisodeNumber(
          detail.planned_episode_count ||
          detail.plannedEpisodeCount ||
          detail.total_episode_count ||
          detail.totalEpisodeCount ||
          detail.episode_count ||
          detail.episodeCount
        );
        if (episodeCount > 0 && episodeCount !== this.getPlannedEpisodeCount(item)) {
          updates.planned_episode_count = episodeCount;
          updates.total_episode_count = episodeCount;
        }
        updates._episodeProgressChecked = true;
        if (detail.rating && detail.rating !== item.rating) {
          updates.rating = detail.rating;
        }
        if (detail.rating_total && detail.rating_total !== item.votes) {
          updates.votes = detail.rating_total;
        }
        if (detail.rank && detail.rank !== item.rank) {
          updates.rank = detail.rank;
        }
        if (Object.keys(updates).length > 0) {
          this.queueAnimeListUpdate(item.id, updates);
        }
      };

      const run = async () => {
        const concurrency = 1;
        for (let i = 0; i < targets.length && isActive(); i += concurrency) {
          await Promise.all(targets.slice(i, i + concurrency).map(enrichOne));
          await delay(120);
        }
      };

      const start = () => {
        this._bangumiMetaStartTimer = null;
        this._bangumiMetaIdleHandle = null;
        if (!isActive()) return;
        run().catch(error => {
          if (isActive()) console.warn('[AnimeZone] Bangumi 列表元数据补全失败:', error?.message || error);
        });
      };

      // Let initial card rendering and image decoding finish before enrichment.
      this._bangumiMetaStartTimer = setTimeout(() => {
        this._bangumiMetaStartTimer = null;
        if (!isActive()) return;
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          this._bangumiMetaIdleHandle = window.requestIdleCallback(start, { timeout: 3000 });
        } else {
          this._bangumiMetaStartTimer = setTimeout(start, 500);
        }
      }, 2600);
    },

    cancelBangumiMetaEnrichmentSchedule() {
      if (this._bangumiMetaStartTimer) {
        clearTimeout(this._bangumiMetaStartTimer);
        this._bangumiMetaStartTimer = null;
      }
      if (this._bangumiMetaIdleHandle !== null && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._bangumiMetaIdleHandle);
      }
      this._bangumiMetaIdleHandle = null;
    },

    scheduleBangumiAdjacentPagePrefetch(page = 1, search = '') {
      if (!this.isBangumiMode || search || page >= this.totalPages) return;
      if (this._bangumiPagePrefetchTimer) {
        clearTimeout(this._bangumiPagePrefetchTimer);
        this._bangumiPagePrefetchTimer = null;
      }
      if (this._bangumiPagePrefetchIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._bangumiPagePrefetchIdleHandle);
        this._bangumiPagePrefetchIdleHandle = null;
      }

      const nextPage = page + 1;
      const signature = this.bangumiListSignature(nextPage, search);
      if (this._bangumiPrefetchedPageKeys.has(signature)) return;
      const token = ++this._bangumiPagePrefetchToken;

      const run = async () => {
        this._bangumiPagePrefetchTimer = null;
        this._bangumiPagePrefetchIdleHandle = null;
        if (token !== this._bangumiPagePrefetchToken || !this.isBangumiMode) return;
        try {
          await this.fetchBangumiList(this.buildBangumiListRequest(nextPage, search, {
            refresh: false,
            staleWhileRevalidate: false,
            silent: true,
            commitResult: false
          }));
          this._bangumiPrefetchedPageKeys.add(signature);
          if (this._bangumiPrefetchedPageKeys.size > 80) {
            this._bangumiPrefetchedPageKeys.delete(this._bangumiPrefetchedPageKeys.values().next().value);
          }
        } catch (error) {
          console.warn('[AnimeZone] Bangumi 下一页预取失败:', error?.message || error);
        }
      };

      this._bangumiPagePrefetchTimer = setTimeout(() => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          this._bangumiPagePrefetchIdleHandle = window.requestIdleCallback(run, { timeout: 1800 });
        } else {
          run();
        }
      }, 2400);
    },

    // 切换数据源模式（本地/在线）
    async switchSource(mode) {
      if (mode === this.dataSource) return;
      const sourceSwitchToken = ++this._sourceSwitchToken;
      const isLatestSourceSwitch = () => sourceSwitchToken === this._sourceSwitchToken;
      this.cancelPrefetchCovers();
      this.cancelEpisodeAvailabilityEnrichment();
      this.resetImageFailures();
      this.selectedGenre = '';
      this.$store.commit('anime/SET_FANZHI_SELECTED_GENRE', '');
      // 切换离开 Bangumi 时重置季度选择，下次回来默认显示本季
      if (mode !== 'bangumi') {
        this.$store.commit('anime/SET_BANGUMI_SEASON', { year: null, quarter: null });
      }
      await this.setDataSource(mode);
      if (!isLatestSourceSwitch()) return;
      this.searchInput = '';

      // 初始化多源数据
      if (mode === 'cms-multi') {
        const sources = await this.loadCmsMultiSources();
        if (!isLatestSourceSwitch()) return;
        if (sources.length > 0 && !this.selectedCmsMultiSource) {
          this.selectedCmsMultiSource = sources[0].id;
          await this.setCmsMultiSource(this.selectedCmsMultiSource);
          if (!isLatestSourceSwitch()) return;
        }
        const categories = await window.electronAPI.cmsMultiGetCategories();
        if (!isLatestSourceSwitch()) return;
        this.$store.commit('anime/SET_CMS_MULTI_CATEGORIES', categories);
        if (categories.length > 0) {
          this.selectedCmsMultiCategory = categories[0].id;
        }
      }

      await this.loadCurrentList(1, '');
    },

    // 当选择不同的非凡资源网分类时
    async onFanzhiCategoryChange() {
      this.cancelPrefetchCovers(); // 中断之前的封面预取
      this.resetImageFailures(); // 清空失败图片缓存
      this.selectedGenre = ''; // 切换分类时清除类型筛选
      // 先更新 store 中的分类，再走 loadCurrentList 统一入口（确保 prefetchCovers 被触发）
      this.$store.commit('anime/SET_FANZHI_CURRENT_CATEGORY', this.selectedFanzhiCategory);
      this.$store.commit('anime/SET_FANZHI_SELECTED_GENRE', '');
      this._scheduleFilterReload('');
    },

    // CategoryFilter 子组件事件：选择非凡分类
    async onSelectFanzhiCategory(catId) {
      this.selectedFanzhiCategory = catId;
      await this.onFanzhiCategoryChange();
    },

    // CategoryFilter 子组件事件：选择 CMS 多源
    async onSelectCmsMultiSource(sourceId) {
      this.selectedCmsMultiSource = sourceId;
      await this.onCmsMultiSourceChange();
    },

    // CategoryFilter 子组件事件：选择 CMS 多源分类
    async onSelectCmsMultiCategory(catId) {
      this.selectedCmsMultiCategory = catId;
      await this.onCmsMultiCategoryChange();
    },

    // 切换 CMS 多源
    async onCmsMultiSourceChange() {
      this.cancelPrefetchCovers();
      this.resetImageFailures();
      await this.setCmsMultiSource(this.selectedCmsMultiSource);
      // 获取新源的分类并选第一个
      const categories = await window.electronAPI.cmsMultiGetCategories();
      this.$store.commit('anime/SET_CMS_MULTI_CATEGORIES', categories);
      if (categories.length > 0) {
        this.selectedCmsMultiCategory = categories[0].id;
      }
      await this.loadCurrentList(1, '');
    },

    // 切换 CMS 多源分类
    async onCmsMultiCategoryChange() {
      this.cancelPrefetchCovers();
      this.resetImageFailures();
      this.$store.commit('anime/SET_CMS_MULTI_CURRENT_CATEGORY', this.selectedCmsMultiCategory);
      this._scheduleFilterReload('');
    },

    // 选择类型标签
    async onGenreSelect(genre) {
      this.cancelPrefetchCovers();
      this.resetImageFailures();
      this.selectedGenre = genre;
      this.searchInput = '';
      await this.loadCurrentList(1, '');
    },

    // 清除类型筛选
    async onGenreClear() {
      this.cancelPrefetchCovers();
      this.resetImageFailures();
      this.selectedGenre = '';
      this.$store.commit('anime/SET_FANZHI_SELECTED_GENRE', '');
      await this.loadCurrentList(1, '');
    },

    async handleSearch() {
      // 立即执行搜索（回车/点击搜索按钮时）
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = null;
      }
      const keyword = this.searchInput.trim();
      if (keyword) {
        // 搜索时清除类型筛选
        this.selectedGenre = '';
        this.$store.commit('anime/SET_FANZHI_SELECTED_GENRE', '');
      }
      await this.loadCurrentList(1, keyword);
    },

    // 切换 Bangumi 季度（year+quarter），null 表示回到本季日历
    async onSelectBangumiSeason(year, quarter) {
      this.$store.commit('anime/SET_BANGUMI_SEASON', { year, quarter });
      this.searchInput = '';
      await this.loadCurrentList(1, '');
      const mainContent = document.querySelector('.main-content');
      // 翻页直接跳顶，不用 smooth（避免与列表重渲染叠加导致卡顿）
      if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'auto' });
    },

    async onBangumiTypeSelect(typeId) {
      if (this.selectedBangumiType === typeId && !this.searchKeyword) return;
      this.cancelPrefetchCovers();
      this.cancelProgressiveRender();
      this.resetImageFailures();
      this.selectedGenre = '';
      this.searchInput = '';
      this.selectedBangumiType = typeId;
      this.selectedBangumiSort = normalizeCatalogSort(this.activeBangumiType, this.selectedBangumiSort);
      if (this.dataSource !== 'bangumi') {
        await this.setDataSource('bangumi');
      }
      if (typeId !== 'season') {
        this.$store.commit('anime/SET_BANGUMI_SEASON', { year: null, quarter: null });
      } else {
        this.selectedBangumiYear = '';
        this.selectedBangumiRegion = 'all';
      }
      this._scheduleFilterReload('');
    },

    async onBangumiSortSelect(sortId) {
      const normalizedSort = normalizeCatalogSort(this.activeBangumiType, sortId);
      if (normalizedSort !== sortId) return;
      if (this.selectedBangumiSort === sortId) return;
      this.cancelPrefetchCovers();
      this.cancelProgressiveRender();
      this.resetImageFailures();
      this.selectedBangumiSort = sortId;
      if (this.dataSource !== 'bangumi') {
        await this.setDataSource('bangumi');
      }
      this._scheduleFilterReload(this.searchKeyword);
    },

    async onBangumiRegionSelect(regionId) {
      if (this.selectedBangumiRegion === regionId) return;
      this.cancelPrefetchCovers();
      this.cancelProgressiveRender();
      this.resetImageFailures();
      this.selectedBangumiRegion = this.bangumiRegionOptions.some(option => option.id === regionId) ? regionId : 'all';
      if (this.selectedBangumiType === 'season') this.selectedBangumiType = 'all';
      if (this.dataSource !== 'bangumi') await this.setDataSource('bangumi');
      this._scheduleFilterReload(this.searchKeyword);
    },

    async onBangumiYearChange(event) {
      this.selectedBangumiYear = event.target.value || '';
      if (this.dataSource !== 'bangumi') {
        await this.setDataSource('bangumi');
      }
      if (this.selectedBangumiType === 'season') {
        this.selectedBangumiType = 'all';
      }
      await this.loadCurrentList(1, this.searchKeyword);
      const mainContent = document.querySelector('.main-content');
      if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'auto' });
    },

    async clearBangumiYear() {
      if (!this.selectedBangumiYear) return;
      this.selectedBangumiYear = '';
      await this.loadCurrentList(1, this.searchKeyword);
    },

    // select change 事件：解析 "year-quarter" 或空串
    onSeasonSelectChange(event) {
      const val = event.target.value;
      if (!val) {
        this.onSelectBangumiSeason(null, null);
      } else {
        const [y, q] = val.split('-').map(Number);
        this.onSelectBangumiSeason(y, q);
      }
    },

    // SearchBar 子组件事件：输入框值变化
    onSearchBarInput(value) {
      this.searchInput = value;
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
        this.searchDebounceTimer = null;
      }
    },

    async searchByType(type) {
      this.searchInput = type;
      await this.loadCurrentList(1, type);
    },

    async changePage(page) {
      if (page >= 1 && page <= this.totalPages && page !== this.currentPage) {
        await this.loadCurrentList(page, this.searchKeyword);
        // 翻页后回到页面顶部（滚动的是 .main-content 容器，不是 window）
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
          mainContent.scrollTo({ top: 0, behavior: 'auto' });
        }
      }
    },

    /**
     * 统一的列表加载方法，自动判断当前数据源
     * @param {number} page - 页码
     * @param {string} search - 搜索关键词
     * @param {boolean} refresh - 是否跳过缓存强制刷新
     */

    /**
     * 处理进入番剧库时携带的路由 query（从发现页/追番页/历史跳转）：
     * - openAnimeDetail + returnTo：直接打开详情弹窗，关闭后回到来源页
     * - openDetail：番之次元条目直接打开选集
     * - search：以关键词搜索并加载列表
     * mounted（首次）与 activated（KeepAlive 再进入）都会调用；
     * 各分支处理后立即 $router.replace 清除 query，天然幂等不会重复触发。
     */
    async handleEnterRouteQuery() {
      const openDetailId = this.$route.query.openDetail;
      const openAnimeDetail = this.$route.query.openAnimeDetail;
      const searchQuery = this.$route.query.search;
      const sourceQuery = this.$route.query.source;
      if (!openDetailId && !openAnimeDetail && !searchQuery) return;

      if (openAnimeDetail) {
        // 记录来源页，关闭弹窗后自动回去，避免用户被留在番剧库
        const returnTo = this.$route.query.returnTo;
        if (returnTo && this.$router.getRoutes().some(r => r.name === returnTo)) {
          this._detailReturnTo = returnTo;
        }
        this.$router.replace({ name: 'anime-zone' }).catch(() => {});
        this._openDetailTimer = setTimeout(() => {
          try {
            const animeData = JSON.parse(openAnimeDetail);
            this.viewAnimeDetail(animeData);
          } catch (e) {
            console.warn('[AnimeZone] openAnimeDetail 解析失败:', e);
          }
        }, 400);
      } else if (openDetailId) {
        // 清除 query 参数，避免刷新时重复触发
        this.$router.replace({ name: 'anime-zone' }).catch(() => {});
        // 延迟打开，等列表加载完
        this._openDetailTimer = setTimeout(async () => {
          try {
            const detail = await this.fetchFanzhiDetail({ id: openDetailId, silent: true });
            if (detail) {
              this.showEpisodeSelector(detail);
            }
          } catch { /* 静默 */ }
        }, 800);
      } else if (searchQuery) {
        // 从追番页跳来搜索
        this.$router.replace({ name: 'anime-zone' }).catch(() => {});
        if (sourceQuery && this.dataSource !== 'bangumi') {
          await this.setDataSource('bangumi');
        }
        this.searchInput = searchQuery;
        await this.loadCurrentList(1, searchQuery);
      }
    },

    /** 类型/排序/分类切换的轻量防抖，连续点击只执行最后一次。 */
    _scheduleFilterReload(keyword = '') {
      if (this._filterDebounceTimer) {
        clearTimeout(this._filterDebounceTimer);
      }
      // Show feedback immediately while retaining a very small coalescing window
      // for rapid chip clicks.
      this.$store.commit('anime/SET_LOADING', true);
      this._filterDebounceTimer = setTimeout(() => {
        this._filterDebounceTimer = null;
        this.loadCurrentList(1, keyword);
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'auto' });
      }, 35);
    },

    async loadCurrentList(page = 1, search = '', refresh = false) {
      if (page === 1) this.resetInfiniteLoadState();
      const requestToken = ++this._listRequestToken;
      const isLatestRequest = () => requestToken === this._listRequestToken;
      const applyTotal = (result) => {
        if (!isLatestRequest() || result?.stale) return false;
        this.totalItems = result?.total || 0;
        return true;
      };

      this._bangumiMetaEnrichToken += 1;
      this._bangumiPagePrefetchToken += 1;
      this.cancelEpisodeAvailabilityEnrichment();
      this.cancelBangumiMetaEnrichmentSchedule();
      if (this._bangumiPagePrefetchTimer) {
        clearTimeout(this._bangumiPagePrefetchTimer);
        this._bangumiPagePrefetchTimer = null;
      }
      if (this._bangumiRefreshIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._bangumiRefreshIdleHandle);
        this._bangumiRefreshIdleHandle = null;
      }
      if (this._bangumiPagePrefetchIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._bangumiPagePrefetchIdleHandle);
        this._bangumiPagePrefetchIdleHandle = null;
      }
      this.cancelPrefetchCovers();
      this.loadError = null;
      try {
        if (this.isFanzhiMode) {
          // 非凡资源网模式
          if (this.selectedGenre && !search) {
            // 有类型筛选且非搜索时，按类型筛选（class URL参数）
            const result = await this.searchFanzhiByGenre({ genre: this.selectedGenre, page });
            if (!applyTotal(result)) return false;
          } else if (search) {
            const result = await this.searchFanzhi({ keyword: search, page });
            if (!applyTotal(result)) return false;
          } else {
            const result = await this.fetchFanzhiList({ categoryId: this.selectedFanzhiCategory, page });
            if (!applyTotal(result)) return false;
          }
        } else if (this.dataSource === 'cms-multi') {
          // 通用 CMS 多源模式
          if (search) {
            const result = await this.searchCmsMulti({ keyword: search, page });
            if (!applyTotal(result)) return false;
          } else {
            const result = await this.fetchCmsMultiList({ categoryId: this.selectedCmsMultiCategory, page, refresh });
            if (!applyTotal(result)) return false;
          }
        } else if (this.isBangumiMode) {
          // Bangumi 模式：无搜索时按选中季度加载（支持历史季度 + 分页）
          const result = await this.fetchBangumiList(this.buildBangumiListRequest(page, search, {
            refresh,
            staleWhileRevalidate: !refresh
          }));
          if (!applyTotal(result)) return false;
          // 超出 Bangumi API offset 上限（>10000）：不报错，给出筛选提示
          if (result?._outOfRange) {
            this.loadError = '当前页超出 Bangumi API 范围（offset>10000），请使用年份或标签筛选查看更多番剧';
            return false;
          }
          if (result?._staleWhileRevalidate && !refresh) {
            this.scheduleBangumiStaleRefresh(page, search);
          }
        } else {
          // 本地数据库模式
          const result = await this.fetchAnimeList({ page, limit: 20, search });
          if (!applyTotal(result)) return false;
        }
      } catch (error) {
        if (!isLatestRequest()) return false;
        this.loadError = error.message || '加载失败，请稍后重试';
        return false;
      }

      if (!isLatestRequest()) return false;

      // 非凡资源网模式下，列表无封面，后台自动补封面
      if (this.isFanzhiMode) {
        this.prefetchCovers();
      }

      // 批量检查当前列表的收藏状态
      if (this.animeList.length > 0) {
        this.checkFavoritesBatch(this.animeList);
        // 只有旧的资源站列表需要按名称回查 Bangumi；Bangumi 首页数据本身已经带 bgm_id。
        if (!this.isBangumiMode) {
          this.preloadBgmIds(this.animeList);
        } else {
          this.scheduleBangumiListMetaEnrichment(this.animeList);
          this.scheduleBangumiAdjacentPagePrefetch(page, search);
        }
      }

      this.bindMainScrollTracker();
      this.$nextTick(() => this.scheduleInfiniteLoadCheck(180));
      return true;
    },

    /**
     * 后台预加载番剧的 bgm_id（资源站番剧按名称回查 Bangumi）
     * 用户点击时直接命中 SubjectService 内存缓存，跳过 subjectSearch 网络请求
     */
    preloadBgmIds(animeList) {
      // 只预加载无 bgm_id 的资源站番剧（bangumi 源已有 bgm_id）
      const needPreload = animeList.filter(a => !a.bgm_id && a.name && a.source !== 'bangumi');
      if (needPreload.length === 0) return;

      // 限制并发为 4，避免批量请求拖慢 Bangumi API
      const CONCURRENCY = 4;
      this.cancelBgmIdPreloadSchedule();
      const token = this._preloadBgmIdToken;
      const isLatestPreload = () => token === this._preloadBgmIdToken;

      const preloadOne = async (anime) => {
        if (!isLatestPreload()) return;
        try {
          const result = await window.electronAPI?.subjectSearch?.(anime.name, 1);
          if (!isLatestPreload()) return;
          if (result?.data && result.data.length > 0) {
            const bgmId = result.data[0].bgmId || result.data[0].bgm_id;
            if (bgmId) {
              // 写入 store（SubjectService 内存缓存已由 search 方法自动写入）
              this.queueAnimeListUpdate(anime.id, { bgm_id: bgmId });
            }
          }
        } catch (e) {
          // 静默失败，不影响列表显示
        }
      };

      // 分批并发执行
      for (let i = 0; i < needPreload.length; i += CONCURRENCY) {
        if (!isLatestPreload()) return;
        const batch = needPreload.slice(i, i + CONCURRENCY);
        // 用 requestIdleCallback 在空闲时执行，避免阻塞 UI
        const runBatch = () => {
          if (!isLatestPreload()) return;
          Promise.all(batch.map(preloadOne));
        };
        if (window.requestIdleCallback) {
          const entry = { type: 'idle', handle: null };
          entry.handle = window.requestIdleCallback(() => {
            this._preloadBgmIdHandles.delete(entry);
            runBatch();
          }, { timeout: 2000 });
          this._preloadBgmIdHandles.add(entry);
        } else {
          const entry = { type: 'timer', handle: null };
          entry.handle = setTimeout(() => {
            this._preloadBgmIdHandles.delete(entry);
            runBatch();
          }, 500 + i * 100);
          this._preloadBgmIdHandles.add(entry);
        }
      }
    },

    cancelBgmIdPreloadSchedule() {
      this._preloadBgmIdToken += 1;
      this._preloadBgmIdHandles.forEach(entry => {
        if (entry.type === 'idle' && window.cancelIdleCallback) {
          window.cancelIdleCallback(entry.handle);
        } else {
          clearTimeout(entry.handle);
        }
      });
      this._preloadBgmIdHandles.clear();
    },

    cancelPrefetchCovers() {
      this._prefetchAbort = true;
      this._prefetchToken += 1;
      if (this._prefetchTimer) {
        clearTimeout(this._prefetchTimer);
        this._prefetchTimer = null;
      }
      if (this._coverObserver) {
        this._coverObserver.disconnect();
        this._coverObserver = null;
      }
      if (this._coverObserverRefreshTimer) {
        clearTimeout(this._coverObserverRefreshTimer);
        this._coverObserverRefreshTimer = null;
      }
      this.clearPendingAnimeUpdates();
      this._prefetchQueue = [];
      this._prefetchQueuedIds.clear();
      this._prefetchInFlightIds.clear();
    },

    /**
     * ffzy 列表页没有封面时，只给进入视野附近的卡片补详情。
     * 这样避免启动后把整页详情都打到源站，滚动到哪里再补到哪里。
     */
    prefetchCovers() {
      this.cancelPrefetchCovers();
      this._prefetchAbort = false;
      const token = this._prefetchToken;
      this._prefetchTimer = setTimeout(() => {
        this._prefetchTimer = null;
        this.setupVisibleCoverPrefetch(token);
      }, 650);
    },

    scheduleVisibleCoverPrefetch(token = this._prefetchToken) {
      if (this._prefetchAbort || token !== this._prefetchToken || !this.isFanzhiMode) return;
      if (this._coverObserverRefreshTimer) clearTimeout(this._coverObserverRefreshTimer);
      this._coverObserverRefreshTimer = setTimeout(() => {
        this._coverObserverRefreshTimer = null;
        this.setupVisibleCoverPrefetch(token);
      }, this._isMainScrolling ? 520 : 220);
    },

    shouldPrefetchAnimeDetail(anime) {
      return anime && anime.source === 'ffzy' && (!anime.cover || !anime._detailLoaded);
    },

    findAnimeById(id) {
      return this.animeList.find(item => String(item.id) === String(id));
    },

    setupVisibleCoverPrefetch(token) {
      if (this._prefetchAbort || token !== this._prefetchToken || !this.isFanzhiMode) return;
      if (this._coverObserver) {
        this._coverObserver.disconnect();
        this._coverObserver = null;
      }

      const cards = Array.from(this.$el.querySelectorAll('.anime-card[data-anime-id]'));
      if (cards.length === 0) return;

      if (typeof window === 'undefined' || typeof window.IntersectionObserver !== 'function') {
        this.enqueueCoverPrefetch(this.animeList.slice(0, 12), token);
        return;
      }

      const scrollRoot = document.querySelector('.main-content');
      const root = scrollRoot && scrollRoot.contains(cards[0]) ? scrollRoot : null;
      const observer = new IntersectionObserver((entries) => {
        if (this._prefetchAbort || token !== this._prefetchToken) return;
        const visibleItems = [];
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const anime = this.findAnimeById(entry.target.dataset.animeId);
          if (anime) {
            visibleItems.push({ anime, target: entry.target });
          }
        });
        if (visibleItems.length > 0) {
          const capacity = Math.min(4, Math.max(0, this._prefetchMaxQueue - this._prefetchQueue.length - this._prefetchInFlightIds.size));
          const selectedItems = visibleItems.slice(0, capacity);
          selectedItems.forEach(item => observer.unobserve(item.target));
          this.enqueueCoverPrefetch(selectedItems.map(item => item.anime), token);
        }
      }, {
        root,
        rootMargin: '220px 0px',
        threshold: 0.01
      });

      cards.forEach(card => observer.observe(card));
      this._coverObserver = observer;
    },

    enqueueCoverPrefetch(items, token = this._prefetchToken) {
      if (this._prefetchAbort || token !== this._prefetchToken) return;
      const capacity = Math.max(0, this._prefetchMaxQueue - this._prefetchQueue.length - this._prefetchInFlightIds.size);
      if (capacity <= 0) return;
      const nextItems = (items || [])
        .filter(this.shouldPrefetchAnimeDetail)
        .slice(0, capacity);
      nextItems.forEach(anime => {
        const id = String(anime.id);
        if (this._prefetchQueuedIds.has(id) || this._prefetchInFlightIds.has(id)) return;
        this._prefetchQueuedIds.add(id);
        this._prefetchQueue.push(anime);
      });

      if (this._prefetchQueue.length > 0) {
        this.startCoverPrefetchWorker(token);
      }
    },

    startCoverPrefetchWorker(token) {
      this._prefetchWorkerToken = token;
      if (this._prefetchWorkerRunning) return;
      this._prefetchWorkerRunning = true;
      this.runCoverPrefetchWorker(token).catch(() => {});
    },

    async runCoverPrefetchWorker(token) {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const waitForIdle = () => new Promise(resolve => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: 900 });
        } else {
          setTimeout(resolve, 260);
        }
      });
      const stillActive = () => !this._prefetchAbort && token === this._prefetchToken;
      let processed = 0;

      try {
        while (this._prefetchQueue.length > 0 && stillActive()) {
          const anime = this._prefetchQueue.shift();
          const id = String(anime?.id || '');
          if (!id) continue;
          this._prefetchQueuedIds.delete(id);

          const latestAnime = this.findAnimeById(id) || anime;
          if (!this.shouldPrefetchAnimeDetail(latestAnime)) continue;

          this._prefetchInFlightIds.add(id);
          try {
            while (this._isMainScrolling && stillActive()) {
              await delay(220);
            }
            await waitForIdle();
            if (!stillActive() || this._isMainScrolling) continue;
            const detail = await window.electronAPI.playbackSourceGetDetail(latestAnime.id);
            if (!stillActive() || !detail) continue;
            const updates = { _detailLoaded: true };
            if (detail.cover) updates.cover = detail.cover;
            if (detail.episode_count > 0) {
              updates.episode_count = detail.episode_count;
              updates.available_episode_count = detail.episode_count;
            }
            if (detail.type?.length) updates.type = detail.type;
            if (detail.intro) updates.intro = detail.intro;
            if (detail.year) updates.year = detail.year;
            this.queueAnimeListUpdate(latestAnime.id, updates);
          } catch (err) {
            // 预取失败不打扰用户；点开详情时仍会重新请求。
          } finally {
            this._prefetchInFlightIds.delete(id);
          }

          processed += 1;
          await delay(420);
        }
      } finally {
        this._prefetchWorkerRunning = false;
        if (this._prefetchQueue.length > 0 && !this._prefetchAbort) {
          this.startCoverPrefetchWorker(this._prefetchToken);
        } else if (processed > 0 && stillActive()) {
          this.scheduleVisibleCoverPrefetch(token);
        }
      }
    },

    bindMainScrollTracker() {
      const mainContent = document.querySelector('.main-content');
      if (!mainContent || this._mainScrollEl === mainContent) return;

      if (this._mainScrollEl) {
        this._mainScrollEl.removeEventListener('scroll', this.onMainScroll);
      }

      this._mainScrollEl = mainContent;
      this._mainScrollEl.addEventListener('scroll', this.onMainScroll, { passive: true });
      this.scheduleVirtualGridMeasure();
    },

    onMainScroll() {
      this._isMainScrolling = true;
      this._lastMainScrollAt = performance.now();
      this.scheduleVirtualGridUpdate();
      this.scheduleInfiniteLoadCheck();
      if (this._scrollIdleTimer) return;

      const finishScroll = () => {
        const remaining = 180 - (performance.now() - this._lastMainScrollAt);
        if (remaining > 0) {
          this._scrollIdleTimer = setTimeout(finishScroll, remaining);
          return;
        }
        this._scrollIdleTimer = null;
        this._isMainScrolling = false;
        this.scheduleVirtualGridMeasure();
        this.scheduleVisibleCoverPrefetch();
        if (this._prefetchQueue.length > 0 && !this._prefetchAbort) {
          this.startCoverPrefetchWorker(this._prefetchToken);
        }
        this.schedulePendingAnimeUpdateFlush();
      };
      this._scrollIdleTimer = setTimeout(finishScroll, 180);
    },

    queueAnimeListUpdate(id, updates) {
      if (updates?.cover) {
        this.clearImageFailure(id);
      }
      const key = String(id);
      const current = this._pendingAnimeUpdates.get(key);
      this._pendingAnimeUpdates.set(key, {
        id,
        updates: current ? { ...current.updates, ...updates } : updates
      });

      this.schedulePendingAnimeUpdateFlush();
    },

    schedulePendingAnimeUpdateFlush() {
      if (this._pendingAnimeUpdates.size === 0 || this._pendingUpdateFlushTimer || this._pendingUpdateIdleHandle !== null) return;

      this._pendingUpdateFlushTimer = setTimeout(() => {
        this._pendingUpdateFlushTimer = null;
        if (this._isMainScrolling) return;

        const flush = () => {
          this._pendingUpdateIdleHandle = null;
          this._pendingUpdateFlushTimer = null;
          if (this._isMainScrolling) return;
          this.flushPendingAnimeUpdates();
        };

        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          this._pendingUpdateIdleHandle = window.requestIdleCallback(flush, { timeout: 1200 });
        } else {
          this._pendingUpdateFlushTimer = setTimeout(flush, 120);
        }
      }, 160);
    },

    flushPendingAnimeUpdates() {
      if (this._pendingAnimeUpdates.size === 0) return;
      const updates = Array.from(this._pendingAnimeUpdates.values());
      this._pendingAnimeUpdates.clear();
      this.$store.commit('anime/UPDATE_ANIME_LIST_BATCH', updates);
    },

    clearPendingAnimeUpdates() {
      if (this._pendingUpdateFlushTimer) {
        clearTimeout(this._pendingUpdateFlushTimer);
        this._pendingUpdateFlushTimer = null;
      }
      if (this._pendingUpdateIdleHandle !== null && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this._pendingUpdateIdleHandle);
      }
      this._pendingUpdateIdleHandle = null;
      this._pendingAnimeUpdates.clear();
    },

    /**
     * 打开以图搜番弹窗
     */
    openImageSearch() {
      this.showImageSearch = true;
    },

    /**
     * 关闭以图搜番弹窗
     */
    closeImageSearch() {
      this.showImageSearch = false;
    },

    /**
     * 以图搜番结果点击：直接走 Bangumi 资料主干。
     * 命中则打开详情，未命中则留在 Bangumi 列表搜索。
     */
    async onImageSearchLocate({ name }) {
      this.closeImageSearch();
      if (!name) return;

      // 先尝试 Bangumi 搜索（直接调用 IPC，不经过 store）
      try {
        const bgmResult = window.electronAPI?.subjectSearch
          ? await window.electronAPI.subjectSearch(name, 1)
          : await window.electronAPI.bangumiSearch(name, 1);
        if (bgmResult && !bgmResult.error && bgmResult.data && bgmResult.data.length > 0) {
          // 取第一条最匹配的，直接打开详情
          const hit = bgmResult.data[0];
          await this.viewAnimeDetail(hit);
          return;
        }
      } catch (e) {
        // 继续走 CMS 搜索
      }

      // 回退：留在 Bangumi 列表搜索
      if (this.dataSource !== 'bangumi') {
        await this.setDataSource('bangumi');
      }
      this.searchInput = name;
      await this.loadCurrentList(1, name);
    },

    /**
     * 详情弹窗打开钩子（由 mixin 调用）：弹窗期间暂停分集可用性探测
     */
    onDetailModalOpen() {
      this.pauseEpisodeAvailabilityEnrichment();
    },

    /**
     * 详情弹窗关闭后的钩子（由 mixin 调用）：重启分集可用性探测
     */
    afterDetailClose() {
      this.startEpisodeAvailabilityWorker();
    },

    async refreshData() {
      // 跳过缓存强制刷新；同时复位失败封面标记，
      // 让瞬时故障（代理 502/网络抖动）期间被标记的封面重新加载
      this.resetImageFailures();
      await this.loadCurrentList(1, '', true);
    },

    clearSearch() {
      this.searchInput = '';
      this.resetImageFailures();
      this.loadCurrentList(1, '');
    },

    clearImageFailure(animeId) {
      const key = String(animeId);
      let changed = false;
      [animeId, key].forEach(value => {
        if (this.failedImageIds.has(value)) {
          this.failedImageIds.delete(value);
          changed = true;
        }
      });
      if (changed) this.failedImageIds = new Set(this.failedImageIds);

      const timer = this._imageRetryTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this._imageRetryTimers.delete(key);
      }
      this._imageRetriedIds.delete(key);
      this._imageRetriedIds.delete(animeId);
    },

    clearImageRetryTimers() {
      this._imageRetryTimers.forEach(timer => clearTimeout(timer));
      this._imageRetryTimers.clear();
    },

    // 切换筛选/刷新时整体复位失败封面状态（含重试计数），给所有封面重新加载的机会
    resetImageFailures() {
      this.clearImageRetryTimers();
      this._imageRetriedIds.clear();
      this.failedImageIds = new Set();
    },

    onImageError(animeId) {
      const key = String(animeId);
      this.failedImageIds.add(key);
      this.failedImageIds = new Set(this.failedImageIds);
      // 瞬时故障（封面代理 502 / 网络抖动）会在几十秒内恢复，
      // 单次重试会让卡片在整个会话内保持"无封面"死状态；
      // 改为有界退避重试：8s / 20s / 45s 共 3 次，成功后由 clearImageFailure 复位
      const attempts = this._imageRetriedIds.get(key) || 0;
      const retryDelays = [8000, 20000, 45000];
      if (attempts >= retryDelays.length) return;
      this._imageRetriedIds.set(key, attempts + 1);
      const timer = setTimeout(() => {
        this._imageRetryTimers.delete(key);
        if (this.failedImageIds.delete(key) || this.failedImageIds.delete(animeId)) {
          this.failedImageIds = new Set(this.failedImageIds);
        }
      }, retryDelays[attempts]);
      this._imageRetryTimers.set(key, timer);
    },

    onImageLoad(event, animeId) {
      if (animeId !== undefined && animeId !== null) {
        this.clearImageFailure(animeId);
      }
      // 图片加载完成后渐显
      event.target.classList.add('loaded');
    },

    /**
     * 判断动漫是否已收藏 / 切换收藏状态：由 animeDetailModal mixin 提供
     */

    async onBangumiTagSearch(tagName) {
      this.closeDetail();
      if (this.dataSource !== 'bangumi') {
        await this.setDataSource('bangumi');
      }
      const matched = this.bangumiTypeOptions.find(option => option.tag === tagName || option.name === tagName);
      if (matched) {
        await this.onBangumiTypeSelect(matched.id);
        return;
      }
      this.selectedBangumiType = 'all';
      this.searchInput = tagName || '';
      await this.loadCurrentList(1, this.searchInput);
    },

    /**
     * 从继续观看卡片恢复播放
     */
    async resumePlay(historyItem) {
      if (!historyItem) return;
      const resumeToken = ++this._resumeRequestToken;
      const isCurrent = () => resumeToken === this._resumeRequestToken;
      this.resumingHistoryKey = continueWatchingKey(historyItem);

      try {
        const result = await resolveContinueWatching({
          history: historyItem,
          api: window.electronAPI,
          loadCmsSources: () => this.loadCmsMultiSources(),
          fetchCmsDetail: options => this.fetchCmsMultiDetail(options)
        });
        if (!isCurrent()) return;
        if (result.status === 'provider-missing') {
          this.$notify?.warning('原片源不可用', '该播放源已移除或停用，请重新选择片源。');
          await this.viewAnimeDetail(result.animeForDetail);
          return;
        }
        if (result.status === 'episode-missing') {
          this.$notify?.warning('原分集不可用', '片源仍在，但原来的分集已经找不到，请重新选择。');
          await this.viewAnimeDetail(result.animeForDetail);
          return;
        }
        await this.onPlayEpisode({
          anime: result.anime,
          episode: result.matched.episode,
          episodeIndex: result.matched.episodeIndex,
          lineId: result.matched.lineId,
          requestKey: `resume:${continueWatchingKey(historyItem)}:${result.matched.lineId}:${result.matched.episodeIndex}`,
          playPosition: historyItem.play_position
        });
      } catch (error) {
        if (!isCurrent()) return;
        console.warn('[AnimeZone] 继续观看恢复失败:', error);
        this.$notify?.warning('续播失败', '原片源暂时无法读取，已打开详情供重新选择。');
        await this.viewAnimeDetail({
          id: historyItem.anime_id,
          source: historyItem.source,
          name: historyItem.name,
          cover: historyItem.cover,
          bgm_id: historyItem.bgm_id
        });
      } finally {
        if (isCurrent()) this.resumingHistoryKey = '';
      }
    },

    /**
     * 删除继续观看记录
     */
    async onRemoveHistory(item) {
      const animeId = item?.anime_id ?? item?.id;
      const source = item?.source || 'legacy';
      if (animeId == null) return;
      const removed = await this.removePlayHistory({ animeId, source });
      if (removed) {
        await this.fetchRecentHistory(10);
      } else {
        this.$notify?.error('删除失败', '观看记录没有删除，请稍后重试。');
      }
    },
  },

  async mounted() {
    const lifecycleToken = Symbol('anime-zone-lifecycle');
    this._animeZoneLifecycleToken = lifecycleToken;
    const isActive = () => this._animeZoneLifecycleToken === lifecycleToken;
    window.addEventListener('resize', this.scheduleVirtualGridMeasure, { passive: true });
    try {
      // 加载最近播放历史（续播卡片）
      this.fetchRecentHistory(10).catch(() => {});

      // 首页固定以 Bangumi 资料为主干；资源站播放源只在详情页按需搜索。
      if (this.dataSource !== 'bangumi') {
        await this.setDataSource('bangumi');
        if (!isActive()) return;
      }
      let loaded = false;
      try {
        loaded = await this.loadCurrentList();
        if (!isActive()) return;
      } catch (err) {
        loaded = false;
      }

      // Bangumi 完全不可用且无缓存时，使用安装的 CMS 片源包兜底。
      if (!loaded || this.animeList.length === 0) {
        const fallbackSources = await this.loadCmsMultiSources().catch(() => []);
        if (!isActive()) return;
        if (fallbackSources.length > 0) {
          await this.switchSource('cms-multi');
          if (!isActive()) return;
        }
      }

      if (this.dataSource === 'local') {
        await this.fetchPopularTypes();
        if (!isActive()) return;
      }
    } catch (error) {
      // 初始化失败
    }

    // 如果从"我的追番"跳来，自动打开详情弹窗
    if (!isActive()) return;
    this._catalogInitDone = true;
    await this.handleEnterRouteQuery();
  },

  activated() {
    // Keep the catalog warm between desktop navigation tabs, but only bind
    // viewport work while the page is actually visible.
    // 本组件被 KeepAlive 缓存，mounted 只在首次创建时执行；
    // 之后的再进入（如从发现页/追番页点卡片跳转）只会触发 activated，
    // 路由 query 里的详情/搜索参数必须在这里处理，否则弹窗永远不打开。
    if (this._catalogInitDone) this.handleEnterRouteQuery();
    const refreshForNetworkMode = sessionStorage.getItem('sakurafall:catalog-network-mode-refresh') === '1';
    if (refreshForNetworkMode) {
      sessionStorage.removeItem('sakurafall:catalog-network-mode-refresh');
      // 列表将重置到第一页，丢弃 App.vue 按路由记忆的滚动位置，
      // 避免路由级恢复逻辑把容器滚回旧位置。
      this.$root?._routeScrollPositions?.delete?.('anime-zone');
      const mainContent = document.querySelector('.main-content');
      if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'auto' });
      this.resetInfiniteLoadState();
      this.cancelVirtualGridWork();
      this.cancelProgressiveRender();
      this.cancelPrefetchCovers();
      this.cancelEpisodeAvailabilityEnrichment();
      this.resetImageFailures();
      this.$store.commit('anime/SET_LOADING', true);
    }

    window.removeEventListener('resize', this.scheduleVirtualGridMeasure);
    window.addEventListener('resize', this.scheduleVirtualGridMeasure, { passive: true });
    this.$nextTick(async () => {
      this.bindMainScrollTracker();
      this.scheduleVirtualGridMeasure();
      if (refreshForNetworkMode) {
        if (this.dataSource !== 'bangumi') await this.setDataSource('bangumi');
        await this.loadCurrentList(1, this.searchKeyword || '', true);
        this.scheduleInfiniteLoadCheck(180);
        return;
      }
      this.scheduleInfiniteLoadCheck(180);
      if (this.isBangumiMode && this.animeList.length > 0) {
        this.scheduleBangumiListMetaEnrichment(this.animeList);
        this.scheduleBangumiAdjacentPagePrefetch(this.currentPage, this.searchKeyword || '');
      } else if (this.isFanzhiMode) {
        this.prefetchCovers();
      }
    });
  },

  deactivated() {
    window.removeEventListener('resize', this.scheduleVirtualGridMeasure);
    if (this._mainScrollEl) {
      this._mainScrollEl.removeEventListener('scroll', this.onMainScroll);
      this._mainScrollEl = null;
    }
    this.resetInfiniteLoadState();
    this.cancelVirtualGridWork();
    this.cancelProgressiveRender();
    this.cancelPrefetchCovers();
    this.cancelEpisodeAvailabilityEnrichment();
    this.cancelBangumiMetaEnrichmentSchedule();
    this.cancelBgmIdPreloadSchedule();
    if (this._bangumiRefreshTimer) {
      clearTimeout(this._bangumiRefreshTimer);
      this._bangumiRefreshTimer = null;
    }
    if (this._bangumiPagePrefetchTimer) {
      clearTimeout(this._bangumiPagePrefetchTimer);
      this._bangumiPagePrefetchTimer = null;
    }
    if (this._bangumiRefreshIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this._bangumiRefreshIdleHandle);
      this._bangumiRefreshIdleHandle = null;
    }
    if (this._bangumiPagePrefetchIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this._bangumiPagePrefetchIdleHandle);
      this._bangumiPagePrefetchIdleHandle = null;
    }
  },

  beforeUnmount() {
    this._animeZoneLifecycleToken = null;
    this._listRequestToken += 1;
    this._detailRequestToken += 1;
    this._playRequestToken += 1;
    this._resumeRequestToken += 1;
    this._sourceSwitchToken += 1;
    this._bangumiRefreshToken += 1;
    this._bangumiMetaEnrichToken += 1;
    this._bangumiPagePrefetchToken += 1;
    this.cancelBangumiMetaEnrichmentSchedule();
    // 清理定时器，避免组件销毁后回调访问已销毁的实例
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    if (this._openDetailTimer) {
      clearTimeout(this._openDetailTimer);
      this._openDetailTimer = null;
    }
    if (this._filterDebounceTimer) {
      clearTimeout(this._filterDebounceTimer);
      this._filterDebounceTimer = null;
    }
    if (this._listFadeTimer) {
      clearTimeout(this._listFadeTimer);
      this._listFadeTimer = null;
    }
    if (this._bangumiRefreshTimer) {
      clearTimeout(this._bangumiRefreshTimer);
      this._bangumiRefreshTimer = null;
    }
    if (this._bangumiPagePrefetchTimer) {
      clearTimeout(this._bangumiPagePrefetchTimer);
      this._bangumiPagePrefetchTimer = null;
    }
    if (this._bangumiRefreshIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this._bangumiRefreshIdleHandle);
      this._bangumiRefreshIdleHandle = null;
    }
    if (this._bangumiPagePrefetchIdleHandle !== null && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(this._bangumiPagePrefetchIdleHandle);
      this._bangumiPagePrefetchIdleHandle = null;
    }
    if (this._scrollIdleTimer) {
      clearTimeout(this._scrollIdleTimer);
      this._scrollIdleTimer = null;
    }
    this.resetInfiniteLoadState();
    if (this._mainScrollEl) {
      this._mainScrollEl.removeEventListener('scroll', this.onMainScroll);
      this._mainScrollEl = null;
    }
    window.removeEventListener('resize', this.scheduleVirtualGridMeasure);
    // 中断封面预取异步循环，避免销毁后继续 commit 到 store
    this.cancelVirtualGridWork();
    this.cancelProgressiveRender();
    this.cancelPrefetchCovers();
    this.cancelEpisodeAvailabilityEnrichment();
    this.cancelBgmIdPreloadSchedule();
    this.clearImageRetryTimers();
  }
};
</script>

<style scoped>
/* ── 全局 ── */
.anime-zone {
  max-width: 1640px;
  padding: 0 28px 36px;
  margin: 0 auto;
  min-height: 100vh;
  position: relative;
}

/* ── 列表切换/翻页过渡：数据加载完成时整体轻微上浮（opacity 交由卡片入场负责，
     避免 wrapper 从 opacity:1→0 跳变引发白屏闪烁） ── */
.catalog-stage { opacity: 1; }
.catalog-stage.list-fading-in { animation: catalog-list-rise 0.3s var(--ease-smooth); }
@keyframes catalog-list-rise {
  from { transform: translateY(8px); }
  to { transform: translateY(0); }
}

/* ── 顶栏 ── */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 28px;
  margin: 0 -28px;
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  background: var(--bg-surface);
  z-index: 100;
  transition: background-color 0.3s var(--ease-smooth), border-color 0.3s var(--ease-smooth);
  box-shadow: 0 4px 14px rgba(37, 36, 62, 0.04);
}

.top-bar::after {
  content: '';
  position: absolute;
  left: 24px;
  bottom: -1px;
  width: 84px;
  height: 3px;
  background: var(--primary-color);
}

.top-bar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.library-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
}

.library-brand-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.library-brand-copy strong {
  font-size: 18px;
  line-height: 1.2;
  color: var(--text-primary);
  font-weight: 750;
}

.library-brand-copy small {
  font-size: 11px;
  line-height: 1.2;
  color: var(--brand-cyan-deep);
  font-weight: 500;
}

/* 顶栏右侧：搜索框 + 以图搜番按钮 */
.top-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.image-search-btn {
  width: 34px;
  height: 34px;
  border: 1px solid rgba(var(--primary-rgb), 0.16);
  background: var(--bg-card-glass);
  color: var(--text-secondary);
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
  flex-shrink: 0;
  padding: 0;
}

.image-search-btn:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
  background: var(--primary-lighter);
}

/* ── 响应式 ── */
@media (max-width: 768px) {
  .top-bar {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .top-bar-left {
    flex-wrap: wrap;
  }

  .top-bar-right {
    width: 100%;
  }

  .top-bar-right .search-box {
    flex: 1;
  }
}
</style>
