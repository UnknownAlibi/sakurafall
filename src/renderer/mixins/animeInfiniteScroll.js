export default {
  data() {
    return {
      loadingMore: false,
      loadMoreError: '',
      loadMoreLimitReason: '',
      _infiniteLoadToken: 0,
      _infiniteLoadTimer: null
    };
  },

  computed: {
    hasMoreAnimePages() {
      return this.currentPage < this.totalPages;
    }
  },

  methods: {
    resetInfiniteLoadState() {
      this._infiniteLoadToken += 1;
      this.loadingMore = false;
      this.loadMoreError = '';
      this.loadMoreLimitReason = '';
      if (this._infiniteLoadTimer) {
        clearTimeout(this._infiniteLoadTimer);
        this._infiniteLoadTimer = null;
      }
    },

    scheduleInfiniteLoadCheck(delay = 70) {
      if (!this.isBangumiMode || this.loading || this.loadingMore || !this.hasMoreAnimePages || this.loadMoreError || this.loadMoreLimitReason) return;
      if (this._infiniteLoadTimer) return;
      this._infiniteLoadTimer = setTimeout(() => {
        this._infiniteLoadTimer = null;
        const scrollRoot = this._mainScrollEl || document.querySelector('.main-content');
        if (!scrollRoot || this.loadingMore || !this.hasMoreAnimePages) return;
        const remaining = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight;
        // 提前 1.5 屏触发：冷缓存翻页需 1-3s 增量扫描，0.65 屏会被正常
        // 滚动速度追上（用户看到加载等待）；1.5 屏在滚到底前完成预取。
        const threshold = Math.max(600, scrollRoot.clientHeight * 1.5);
        if (remaining <= threshold) this.loadNextAnimePage();
      }, delay);
    },

    async loadNextAnimePage() {
      if (!this.isBangumiMode || this.loading || this.loadingMore || !this.hasMoreAnimePages || this.loadMoreLimitReason) return false;

      const basePage = this.currentPage;
      const nextPage = basePage + 1;
      const search = this.searchKeyword || '';
      const signature = this.bangumiListSignature(nextPage, search);
      const token = ++this._infiniteLoadToken;
      const isActive = () => (
        token === this._infiniteLoadToken
        && this.isBangumiMode
        && signature === this.bangumiListSignature(nextPage, search)
      );

      this.loadingMore = true;
      this.loadMoreError = '';
      try {
        const result = await this.fetchBangumiList(this.buildBangumiListRequest(nextPage, search, {
          refresh: false,
          staleWhileRevalidate: true,
          silent: true,
          commitResult: false
        }));
        if (!isActive() || result?.stale) return false;
        if (!result || result.error) throw new Error(result?.error || '加载下一页失败');
        if (result._outOfRange) {
          this.loadMoreLimitReason = '已到番剧库接口浏览上限，请使用年份或类型筛选继续查看';
          this.$store.commit('anime/APPEND_ANIME_LIST', {
            data: [],
            page: basePage,
            totalPages: basePage
          });
          return false;
        }

        const incoming = Array.isArray(result.data) ? result.data : [];
        if (incoming.length === 0) {
          if (result._truncated) {
            // 集合尚未扫满（公共镜像限流）：保留剩余分页，允许用户稍后
            // 重试继续扩扫，而不是把“暂时拿不到”误报成“没有更多结果”。
            this.loadMoreError = '数据源暂时受限，请稍后重试以继续加载更多';
            return false;
          }
          if ((Number(result.total) || 0) > this.animeList.length) {
            this.loadMoreLimitReason = '当前排序没有更多可直接加载的结果，请使用年份或类型筛选';
          }
          this.$store.commit('anime/APPEND_ANIME_LIST', {
            data: [],
            page: basePage,
            totalPages: basePage
          });
          return false;
        }
        this.$store.commit('anime/APPEND_ANIME_LIST', {
          data: incoming,
          page: result.page || nextPage,
          totalPages: Math.max(this.totalPages, Number(result.totalPages) || 0)
        });
        // Keep the filter-session total stable. Progressive collection scans
        // may discover more metadata, but scrolling must not rewrite the count
        // the user received when the filter was applied.
        if (!result._servedFromIndex && !this.totalItems) {
          this.totalItems = result.total || this.totalItems;
        }
        if (incoming.length > 0) {
          this.checkFavoritesBatch(incoming);
          this.scheduleBangumiListMetaEnrichment(incoming);
        }
        this.scheduleBangumiAdjacentPagePrefetch(nextPage, search);
        this.$nextTick(() => this.scheduleVirtualGridMeasure());
        return true;
      } catch (error) {
        if (!isActive()) return false;
        this.loadMoreError = error?.message || '加载下一页失败';
        return false;
      } finally {
        if (isActive()) {
          this.loadingMore = false;
          this.$nextTick(() => this.scheduleInfiniteLoadCheck(180));
        }
      }
    },

    // 底部“重新加载”入口：清掉限流错误后重试当前分页
    retryLoadMore() {
      this.loadMoreError = '';
      this.$nextTick(() => this.loadNextAnimePage());
    }
  }
};
