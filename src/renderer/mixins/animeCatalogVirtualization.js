// 一旦连续加载两页左右就接管 DOM 数量，避免卡片、封面和阴影累积到滚动线程上。
const VIRTUAL_GRID_THRESHOLD = 48;
const INITIAL_CARD_BATCH = 16;

export default {
  data() {
    return {
      _renderListFrame: null,
      _renderListTimer: null,
      _lastAnimeListSignature: '',
      _lastAnimeListKeys: [],
      visibleAnimeLimit: INITIAL_CARD_BATCH,
      virtualStartIndex: 0,
      virtualEndIndex: 48,
      virtualColumnCount: 1,
      virtualRowHeight: 300,
      virtualGridGap: 20,
      _virtualGridFrame: null,
      _virtualGridTimer: null,
      _virtualMeasureFrame: null,
      _virtualMeasureTimer: null,
      _virtualGridTop: null
    };
  },

  computed: {
    useVirtualAnimeGrid() {
      return this.animeList.length > VIRTUAL_GRID_THRESHOLD;
    },

    renderedAnimeList() {
      if (this.useVirtualAnimeGrid) {
        return this.animeList.slice(this.virtualStartIndex, this.virtualEndIndex);
      }
      return this.animeList.slice(0, this.visibleAnimeLimit);
    },

    virtualRowPitch() {
      return this.virtualRowHeight + this.virtualGridGap;
    },

    virtualTopSpacerHeight() {
      if (!this.useVirtualAnimeGrid) return 0;
      const row = Math.floor(this.virtualStartIndex / this.virtualColumnCount);
      return Math.max(0, row * this.virtualRowPitch);
    },

    virtualBottomSpacerHeight() {
      if (!this.useVirtualAnimeGrid) return 0;
      const totalRows = Math.ceil(this.animeList.length / this.virtualColumnCount);
      const endRow = Math.ceil(this.virtualEndIndex / this.virtualColumnCount);
      return Math.max(0, (totalRows - endRow) * this.virtualRowPitch);
    }
  },

  watch: {
    animeList: {
      handler(list) {
        const keys = this.getAnimeListKeys(list);
        const signature = keys.join('|');
        if (signature === this._lastAnimeListSignature) return;
        const previousKeys = this._lastAnimeListKeys;
        const appended = previousKeys.length > 0
          && keys.length >= previousKeys.length
          && previousKeys.every((key, index) => key === keys[index]);
        this._lastAnimeListSignature = signature;
        this._lastAnimeListKeys = keys;
        if (appended) {
          this.handleAppendedAnimeList(previousKeys.length);
        } else {
          this.resetProgressiveRender();
          this.failedImageIds = new Set();
          this.clearImageRetryTimers?.();
          this._imageRetriedIds?.clear?.();
        }
      },
      immediate: true
    },

    loading(isLoading) {
      if (isLoading) this.cancelProgressiveRender();
    }
  },

  methods: {
    getAnimeGridElement() {
      const ref = this.$refs.animeGrid;
      const root = ref?.$el || ref || null;
      if (!root) return null;
      if (root.matches?.('.anime-grid')) return root;
      return root.querySelector?.('.anime-grid') || null;
    },

    getAnimeListSignature(list = this.animeList) {
      return this.getAnimeListKeys(list).join('|');
    },

    getAnimeListKeys(list = this.animeList) {
      return (list || []).map(item => `${item?.source || ''}:${item?.id || ''}`);
    },

    handleAppendedAnimeList(previousLength) {
      const total = this.animeList.length;
      this.cancelProgressiveRender();
      if (!this.useVirtualAnimeGrid) {
        this.visibleAnimeLimit = Math.min(
          total,
          Math.max(this.visibleAnimeLimit, previousLength) + Math.max(0, total - previousLength)
        );
        return;
      }

      if (previousLength < VIRTUAL_GRID_THRESHOLD) {
        // Measure the still-mounted non-virtual grid before the appended render
        // crosses the virtualization threshold.
        this.measureVirtualGrid();
        this.virtualStartIndex = 0;
        this.virtualEndIndex = Math.min(total, Math.max(48, this.virtualColumnCount * 10));
        this._virtualGridTop = null;
      } else {
        this.virtualEndIndex = Math.min(
          total,
          Math.max(this.virtualEndIndex, this.virtualStartIndex + this.virtualColumnCount * 12)
        );
      }
      this.$nextTick(() => {
        this.scheduleVirtualGridMeasure();
        this.scheduleVisibleCoverPrefetch?.();
      });
    },

    resetProgressiveRender() {
      this.cancelProgressiveRender();
      const total = this.animeList.length;
      if (this.useVirtualAnimeGrid) {
        this.visibleAnimeLimit = INITIAL_CARD_BATCH;
        this.resetVirtualGridWindow();
        return;
      }
      this.visibleAnimeLimit = Math.min(total, INITIAL_CARD_BATCH);
      if (this.visibleAnimeLimit < total) this.scheduleProgressiveRender();
    },

    cancelProgressiveRender() {
      if (this._renderListFrame) cancelAnimationFrame(this._renderListFrame);
      if (this._renderListTimer) clearTimeout(this._renderListTimer);
      this._renderListFrame = null;
      this._renderListTimer = null;
    },

    scheduleProgressiveRender() {
      if (this._renderListFrame || this._renderListTimer) return;
      const run = () => {
        this._renderListFrame = null;
        this._renderListTimer = null;
        this.growVisibleAnimeList();
      };
      this._renderListTimer = setTimeout(() => {
        this._renderListTimer = null;
        this._renderListFrame = requestAnimationFrame(run);
      }, this._isMainScrolling ? 120 : 34);
    },

    growVisibleAnimeList() {
      const total = this.animeList.length;
      if (this.visibleAnimeLimit >= total) return;
      const pressure = document.documentElement.getAttribute('data-performance-pressure');
      const batchSize = pressure === 'high' || this._isMainScrolling ? 6 : 8;
      this.visibleAnimeLimit = Math.min(total, this.visibleAnimeLimit + batchSize);
      if (this.visibleAnimeLimit < total) {
        this.scheduleProgressiveRender();
      } else {
        this.$nextTick(() => this.setupVisibleCoverPrefetch?.(this._prefetchToken));
      }
    },

    resetVirtualGridWindow() {
      this.virtualStartIndex = 0;
      this.virtualEndIndex = Math.min(this.animeList.length, Math.max(48, this.virtualColumnCount * 10));
      this._virtualGridTop = null;
      this.$nextTick(() => {
        this.scheduleVirtualGridMeasure();
        this.scheduleVisibleCoverPrefetch?.();
      });
    },

    cancelVirtualGridWork() {
      if (this._virtualGridFrame) cancelAnimationFrame(this._virtualGridFrame);
      if (this._virtualMeasureFrame) cancelAnimationFrame(this._virtualMeasureFrame);
      if (this._virtualGridTimer) clearTimeout(this._virtualGridTimer);
      if (this._virtualMeasureTimer) clearTimeout(this._virtualMeasureTimer);
      this._virtualGridFrame = null;
      this._virtualGridTimer = null;
      this._virtualMeasureFrame = null;
      this._virtualMeasureTimer = null;
    },

    scheduleVirtualGridMeasure() {
      if (!this.useVirtualAnimeGrid || this._virtualMeasureFrame || this._virtualMeasureTimer) return;
      const runMeasure = () => {
        if (!this._virtualMeasureFrame && !this._virtualMeasureTimer) return;
        if (this._virtualMeasureFrame) cancelAnimationFrame(this._virtualMeasureFrame);
        if (this._virtualMeasureTimer) clearTimeout(this._virtualMeasureTimer);
        this._virtualMeasureFrame = null;
        this._virtualMeasureTimer = null;
        this.measureVirtualGrid();
        this.updateVirtualGridWindow(true);
      };
      this._virtualMeasureFrame = requestAnimationFrame(runMeasure);
      // Chromium throttles animation frames for fully obscured Electron windows.
      this._virtualMeasureTimer = setTimeout(runMeasure, 96);
    },

    measureVirtualGrid() {
      const grid = this.getAnimeGridElement();
      if (!grid) return;
      const styles = window.getComputedStyle(grid);
      const columns = styles.gridTemplateColumns.split(' ').map(value => value.trim()).filter(Boolean).length;
      const gap = parseFloat(styles.rowGap || styles.gap || '20');
      if (Number.isFinite(columns) && columns > 0) this.virtualColumnCount = columns;
      if (Number.isFinite(gap) && gap >= 0) this.virtualGridGap = gap;

      const card = grid.querySelector('.anime-card');
      if (card) {
        const height = card.getBoundingClientRect().height;
        if (Number.isFinite(height) && height > 80) this.virtualRowHeight = Math.round(height);
      } else if (grid.clientWidth > 0) {
        const width = (grid.clientWidth - this.virtualGridGap * Math.max(0, this.virtualColumnCount - 1)) / this.virtualColumnCount;
        this.virtualRowHeight = Math.round(width * 1.33 + 72);
      }

      const scrollRoot = this._mainScrollEl || document.querySelector('.main-content');
      if (scrollRoot) {
        const gridRect = grid.getBoundingClientRect();
        const rootRect = scrollRoot.getBoundingClientRect();
        this._virtualGridTop = gridRect.top - rootRect.top + scrollRoot.scrollTop;
      }
    },

    scheduleVirtualGridUpdate() {
      if (!this.useVirtualAnimeGrid || this._virtualGridFrame || this._virtualGridTimer) return;
      const runUpdate = () => {
        if (!this._virtualGridFrame && !this._virtualGridTimer) return;
        if (this._virtualGridFrame) cancelAnimationFrame(this._virtualGridFrame);
        if (this._virtualGridTimer) clearTimeout(this._virtualGridTimer);
        this._virtualGridFrame = null;
        this._virtualGridTimer = null;
        this.updateVirtualGridWindow();
      };
      this._virtualGridFrame = requestAnimationFrame(runUpdate);
      this._virtualGridTimer = setTimeout(runUpdate, 96);
    },

    updateVirtualGridWindow(force = false) {
      if (!this.useVirtualAnimeGrid) return;
      const grid = this.getAnimeGridElement();
      const scrollRoot = this._mainScrollEl || document.querySelector('.main-content');
      if (!grid || !scrollRoot) return;

      if (!Number.isFinite(this._virtualGridTop)) {
        const gridRect = grid.getBoundingClientRect();
        const rootRect = scrollRoot.getBoundingClientRect();
        this._virtualGridTop = gridRect.top - rootRect.top + scrollRoot.scrollTop;
      }
      const viewportHeight = scrollRoot.clientHeight || window.innerHeight || 720;
      const rowPitch = Math.max(1, this.virtualRowPitch);
      const totalRows = Math.ceil(this.animeList.length / this.virtualColumnCount);
      const visibleTop = Math.max(0, scrollRoot.scrollTop - this._virtualGridTop);
      const visibleBottom = Math.max(0, visibleTop + viewportHeight);
      const visibleStartRow = Math.max(0, Math.floor(visibleTop / rowPitch));
      const visibleEndRow = Math.min(totalRows, Math.ceil(visibleBottom / rowPitch));
      const currentStartRow = Math.floor(this.virtualStartIndex / this.virtualColumnCount);
      const currentEndRow = Math.ceil(this.virtualEndIndex / this.virtualColumnCount);
      const guardRows = 4;
      const hasTopGuard = currentStartRow === 0 || visibleStartRow >= currentStartRow + guardRows;
      const hasBottomGuard = currentEndRow === totalRows || visibleEndRow <= currentEndRow - guardRows;
      if (!force && hasTopGuard && hasBottomGuard) return;

      // 保留更宽的稳定窗口，并按固定行块移动。旧窗口只有约 4 行缓冲，扣除
      // 3 行保护区后几乎每滚动一行都会卸载/挂载卡片，封面解码随之形成周期性掉帧。
      const viewportRows = Math.max(1, Math.ceil(viewportHeight / rowPitch));
      // 缓冲行数必须与视口高度解耦。此前 bufferRows = max(7, viewportRows + 3)
      // 会随视口线性膨胀：2K 视口挂载约 150 张卡片、4K 约 190 张，光栅化面积
      // 和封面解码量成倍增长——正是"窗口分辨率越大滚动越卡"的主要来源。
      // 固定上下各 6 行（约 1900px）在 7500px/s 的快滚下仍有 250ms 余量，
      // 足够 rAF 内完成窗口平移。
      const bufferRows = 6;
      const chunkRows = 3;
      const rawStartRow = Math.max(0, visibleStartRow - bufferRows);
      const startRow = Math.max(0, Math.floor(rawStartRow / chunkRows) * chunkRows);
      const endRow = Math.min(totalRows, startRow + viewportRows + bufferRows * 2 + chunkRows);
      const startIndex = Math.min(this.animeList.length, startRow * this.virtualColumnCount);
      const endIndex = Math.min(this.animeList.length, Math.max(startIndex + this.virtualColumnCount * 4, endRow * this.virtualColumnCount));
      if (startIndex !== this.virtualStartIndex || endIndex !== this.virtualEndIndex) {
        this.virtualStartIndex = startIndex;
        this.virtualEndIndex = endIndex;
      }
    }
  }
};
