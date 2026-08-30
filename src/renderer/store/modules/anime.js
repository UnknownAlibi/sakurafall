export default {
    namespaced: true,
    state: {
        animeList: [],
        currentAnime: null,
        currentPage: 1,
        totalPages: 0,
        loading: false,
        searchKeyword: '',
        popularTypes: [],

        // 数据源模式：主页默认以 Bangumi 资料为主干；资源站只在详情页作为播放源匹配
        dataSource: 'bangumi',

        // Bangumi 相关
        bangumiCalendar: [],
        bangumiLoading: false,
        bangumiSchedule: [],       // 新番时间表（按星期分组）
        bangumiScheduleLoading: false,
        _scheduleRefreshSeq: 0,    // 后台刷新序列号，防止竞态覆盖
        // 当前浏览的季度：year=年份, quarter=1冬2春3夏4秋；null 表示显示当前季度(calendar)
        bangumiSeasonYear: null,
        bangumiSeasonQuarter: null,
        bangumiBrowseTag: '',
        listRequestSeq: 0,
        activeListRequestSeq: 0,

        // 非凡资源网相关
        fanzhiCategories: [],
        fanzhiCurrentCategory: '30',
        fanzhiGenreTags: [],
        fanzhiSelectedGenre: '',

        // 通用 CMS 多源相关
        cmsMultiSources: [],
        cmsMultiCurrentSource: null,
        cmsMultiCategories: [],
        cmsMultiCurrentCategory: '30'
    },

    getters: {
        animeList: state => state.animeList,
        currentAnime: state => state.currentAnime,
        currentPage: state => state.currentPage,
        totalPages: state => state.totalPages,
        loading: state => state.loading,
        searchKeyword: state => state.searchKeyword,
        popularTypes: state => state.popularTypes,
        dataSource: state => state.dataSource,
        bangumiCalendar: state => state.bangumiCalendar,
        bangumiLoading: state => state.bangumiLoading,
        bangumiSchedule: state => state.bangumiSchedule,
        bangumiScheduleLoading: state => state.bangumiScheduleLoading,
        bangumiSeasonYear: state => state.bangumiSeasonYear,
        bangumiSeasonQuarter: state => state.bangumiSeasonQuarter,
        bangumiBrowseTag: state => state.bangumiBrowseTag,
        fanzhiCategories: state => state.fanzhiCategories,
        fanzhiCurrentCategory: state => state.fanzhiCurrentCategory,
        fanzhiGenreTags: state => state.fanzhiGenreTags,
        fanzhiSelectedGenre: state => state.fanzhiSelectedGenre,
        cmsMultiSources: state => state.cmsMultiSources,
        cmsMultiCurrentSource: state => state.cmsMultiCurrentSource,
        cmsMultiCategories: state => state.cmsMultiCategories,
        cmsMultiCurrentCategory: state => state.cmsMultiCurrentCategory,
        isBangumiMode: state => state.dataSource === 'bangumi',
        isFanzhiMode: state => state.dataSource === 'fanzhi'
    },

    mutations: {
        SET_ANIME_LIST(state, { data, total: _total, page, totalPages }) {
            state.animeList = data;
            state.currentPage = page;
            state.totalPages = totalPages;
        },

        APPEND_ANIME_LIST(state, { data, page, totalPages }) {
            const existingKeys = new Set(
                state.animeList.map(item => `${item?.source || 'anime'}:${item?.id || ''}`)
            );
            const appended = [];
            for (const item of data || []) {
                const key = `${item?.source || 'anime'}:${item?.id || ''}`;
                if (!item || existingKeys.has(key)) continue;
                existingKeys.add(key);
                appended.push(item);
            }
            if (appended.length > 0) state.animeList = state.animeList.concat(appended);
            state.currentPage = Math.max(state.currentPage, Number(page) || state.currentPage);
            state.totalPages = Number(totalPages) || state.totalPages;
        },

        SET_CURRENT_ANIME(state, anime) {
            state.currentAnime = anime;
        },

        UPDATE_ANIME_IN_LIST(state, { id, updates }) {
            const idx = state.animeList.findIndex(a => a.id === id);
            if (idx !== -1) {
                // 使用 splice 确保 Vue 3 响应式系统正确检测数组变化
                state.animeList.splice(idx, 1, { ...state.animeList[idx], ...updates });
            }
        },

        UPDATE_ANIME_LIST_BATCH(state, updatesList = []) {
            if (!Array.isArray(updatesList) || updatesList.length === 0) return;

            const updatesById = new Map(
                updatesList
                    .filter(item => item && item.id && item.updates)
                    .map(item => [item.id, item.updates])
            );
            if (updatesById.size === 0) return;

            // Preserve the array and untouched item identities. Replacing the whole
            // list for every metadata/cover response makes every visible card diff.
            state.animeList.forEach((item, index) => {
                const updates = updatesById.get(item.id);
                if (updates) {
                    state.animeList.splice(index, 1, { ...item, ...updates });
                }
            });
        },

        SET_LOADING(state, loading) {
            state.loading = loading;
        },

        BEGIN_LIST_REQUEST(state, requestId) {
            state.listRequestSeq = requestId;
            state.activeListRequestSeq = requestId;
            state.loading = true;
        },

        SET_SEARCH_KEYWORD(state, keyword) {
            state.searchKeyword = keyword;
        },

        SET_POPULAR_TYPES(state, types) {
            state.popularTypes = types;
        },

        SET_DATA_SOURCE(state, source) {
            state.dataSource = source;
        },

        SET_BANGUMI_CALENDAR(state, calendar) {
            state.bangumiCalendar = calendar;
        },

        SET_BANGUMI_LOADING(state, loading) {
            state.bangumiLoading = loading;
        },

        SET_BANGUMI_SCHEDULE(state, schedule) {
            state.bangumiSchedule = Array.isArray(schedule) ? schedule : [];
        },

        SET_BANGUMI_SCHEDULE_LOADING(state, loading) {
            state.bangumiScheduleLoading = loading;
        },

        SET_SCHEDULE_REFRESH_SEQ(state, seq) {
            state._scheduleRefreshSeq = seq;
        },

        SET_BANGUMI_SEASON(state, { year, quarter }) {
            state.bangumiSeasonYear = year;
            state.bangumiSeasonQuarter = quarter;
        },

        SET_BANGUMI_BROWSE_TAG(state, tag) {
            state.bangumiBrowseTag = tag || '';
        },

        SET_FANZHI_CATEGORIES(state, categories) {
            state.fanzhiCategories = categories;
        },

        SET_FANZHI_CURRENT_CATEGORY(state, categoryId) {
            state.fanzhiCurrentCategory = categoryId;
        },

        SET_FANZHI_GENRE_TAGS(state, tags) {
            state.fanzhiGenreTags = tags;
        },

        SET_FANZHI_SELECTED_GENRE(state, genre) {
            state.fanzhiSelectedGenre = genre;
        },

        SET_CMS_MULTI_SOURCES(state, sources) {
            state.cmsMultiSources = sources;
            if (sources.length > 0 && !state.cmsMultiCurrentSource) {
                state.cmsMultiCurrentSource = sources[0].id;
            }
        },

        SET_CMS_MULTI_CURRENT_SOURCE(state, sourceId) {
            state.cmsMultiCurrentSource = sourceId;
        },

        SET_CMS_MULTI_CATEGORIES(state, categories) {
            state.cmsMultiCategories = categories;
        },

        SET_CMS_MULTI_CURRENT_CATEGORY(state, categoryId) {
            state.cmsMultiCurrentCategory = categoryId;
        }
    },

    actions: {
        // ── 本地数据库 Actions ─────────────────────────────────

        async fetchAnimeList({ commit, state }, { page = 1, limit = 20, search = '' } = {}) {
            const requestId = state.listRequestSeq + 1;
            commit('BEGIN_LIST_REQUEST', requestId);
            const isCurrent = () => state.activeListRequestSeq === requestId;

            try {
                const result = await window.electronAPI.getAnimeList(page, limit, search);
                if (!isCurrent()) return { ...result, stale: true };
                commit('SET_ANIME_LIST', result);
                commit('SET_SEARCH_KEYWORD', search);
                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                console.error('获取动漫列表失败:', error);
                throw error;
            } finally {
                if (isCurrent()) commit('SET_LOADING', false);
            }
        },

        async fetchAnimeDetail({ commit }, animeId) {
            commit('SET_LOADING', true);

            try {
                const anime = await window.electronAPI.getAnimeDetail(animeId);
                commit('SET_CURRENT_ANIME', anime);
                return anime;
            } catch (error) {
                console.error('获取动漫详情失败:', error);
                throw error;
            } finally {
                commit('SET_LOADING', false);
            }
        },

        async searchAnime(_, { keyword, limit = 10 }) {
            try {
                const results = await window.electronAPI.searchAnime(keyword, limit);
                return results;
            } catch (error) {
                console.error('搜索动漫失败:', error);
                return [];
            }
        },

        async fetchPopularTypes({ commit }) {
            try {
                const types = await window.electronAPI.getPopularTypes();
                commit('SET_POPULAR_TYPES', types);
                return types;
            } catch (error) {
                console.error('获取热门分类失败:', error);
                return [];
            }
        },

        // ── 数据源切换 ─────────────────────────

        /**
         * 切换数据获取模式（本地 / 在线 / Bangumi / 多源聚合）
         */
        setDataSource({ commit }, source) {
            commit('SET_DATA_SOURCE', source);
        },

        // ── Bangumi (番组计划) 数据源 Actions ─────────────────────────

        /**
         * 获取 Bangumi 季度番剧日历
         */
        async fetchBangumiCalendar({ commit }) {
            commit('SET_BANGUMI_LOADING', true);
            try {
                const calendar = await window.electronAPI.bangumiGetCalendar();
                commit('SET_BANGUMI_CALENDAR', calendar);
                return calendar;
            } catch (error) {
                console.error('[Bangumi] 获取季度番剧失败:', error);
                return [];
            } finally {
                commit('SET_BANGUMI_LOADING', false);
            }
        },

        /**
         * 获取 Bangumi 番剧列表（扁平化）
         * 网络优先：total 始终来自 Bangumi 全库，保证分页数稳定；
         * 网络失败时回退本地索引，避免完全无数据。
         */
        async fetchBangumiList({ commit, state }, { page = 1, search = '', year = null, quarter = null, tag = '', tags = [], metaTags = [], sort = 'rank', mode = 'browse', browseYear = null, cat = null, refresh = false, staleWhileRevalidate = false, silent = false, commitResult = true } = {}) {
            const requestId = state.listRequestSeq + 1;
            if (!silent) {
                commit('BEGIN_LIST_REQUEST', requestId);
            }
            const isCurrent = () => silent || state.activeListRequestSeq === requestId;

            // 本地索引查询辅助函数：网络失败时作为 fallback，避免完全无数据
            const indexSortMap = { date: 'latest', rank: 'rank', heat: 'popular', score: 'rating', match: 'popular' };
            const indexSort = indexSortMap[sort] || 'popular';
            const serveFromIndexFallback = async () => {
                if (!window.electronAPI?.subjectIndexQuery) return null;
                try {
                    const indexResult = await window.electronAPI.subjectIndexQuery({
                        keyword: search || '',
                        tag: tag || '',
                        tags,
                        platform: metaTags[0] || '',
                        year: (mode === 'season' && year) ? Number(year) : (browseYear ? Number(browseYear) : null),
                        sort: indexSort,
                        page,
                        pageSize: 24,
                        releasedOnly: mode !== 'season',
                        requireDated: false,
                        requireRated: false
                    });
                    if (indexResult && indexResult.fromIndex && (indexResult.data?.length > 0 || (page > 1 && (indexResult.total || 0) > 0))) {
                        return indexResult;
                    }
                } catch (_e) { /* fallthrough */ }
                return null;
            };

            try {
                let result;
                let nextSeason = null;
                if (search) {
                    if ((tag || tags.length || metaTags.length || browseYear) && window.electronAPI.subjectBrowse) {
                        result = await window.electronAPI.subjectBrowse({ keyword: search, tag, tags, metaTags, sort: 'match', page, limit: 24, year: browseYear });
                    } else if (window.electronAPI.subjectSearch) {
                        result = await window.electronAPI.subjectSearch(search, page);
                    } else {
                        result = await window.electronAPI.bangumiSearch(search, page);
                    }
                    commit('SET_BANGUMI_BROWSE_TAG', tag || '');
                } else if (mode === 'catalog') {
                    result = window.electronAPI.subjectCatalog
                        ? await window.electronAPI.subjectCatalog({ sort, cat, year: browseYear, page, limit: 24, includeFuture: false, refresh, staleWhileRevalidate })
                        : await window.electronAPI.bangumiSearch('', page);
                    nextSeason = { year: null, quarter: null };
                    commit('SET_BANGUMI_BROWSE_TAG', cat ? `cat:${cat}` : 'catalog');
                } else if (mode === 'browse' || mode === 'trending' || tag || sort === 'heat' || sort === 'score') {
                    result = window.electronAPI.subjectBrowse
                        ? await window.electronAPI.subjectBrowse({ tag, tags, metaTags, sort, page, limit: 24, year: browseYear, refresh, staleWhileRevalidate })
                        : await window.electronAPI.bangumiSearch(tag, page);
                    nextSeason = { year: null, quarter: null };
                    commit('SET_BANGUMI_BROWSE_TAG', tag || mode || '');
                } else if (year && quarter) {
                    // 指定季度：用季度搜索接口，支持分页 + 历史季度
                    result = window.electronAPI.subjectSeason
                        ? await window.electronAPI.subjectSeason(year, quarter, page)
                        : await window.electronAPI.bangumiGetSeason(year, quarter, page);
                    nextSeason = { year, quarter };
                    commit('SET_BANGUMI_BROWSE_TAG', '');
                } else {
                    const schedule = window.electronAPI.subjectCalendar
                        ? await window.electronAPI.subjectCalendar()
                        : await window.electronAPI.bangumiGetSchedule();
                    const data = [];
                    (schedule || []).forEach(day => {
                        (day.items || []).forEach(item => data.push(item));
                    });
                    result = {
                        data,
                        total: data.length,
                        page,
                        totalPages: 1
                    };
                    nextSeason = { year: null, quarter: null };
                    commit('SET_BANGUMI_BROWSE_TAG', '');
                }

                if (!isCurrent()) return { ...(Array.isArray(result) ? { data: result } : result), stale: true };
                if (nextSeason) commit('SET_BANGUMI_SEASON', nextSeason);

                if (Array.isArray(result)) {
                    result = {
                        data: result,
                        total: result.length,
                        page,
                        totalPages: 1
                    };
                }

                if (result.error) {
                    throw new Error(result.error);
                }

                if (commitResult) {
                    commit('SET_ANIME_LIST', {
                        data: result.data || [],
                        total: result.total || 0,
                        page: result.page || page,
                        totalPages: result.totalPages || 1
                    });
                    commit('SET_SEARCH_KEYWORD', search);
                }

                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                console.error('[Bangumi] 获取列表失败:', error);
                // 网络失败时回退到本地索引，避免完全无数据
                const fallback = await serveFromIndexFallback();
                if (fallback) {
                    if (isCurrent() && commitResult) {
                        commit('SET_ANIME_LIST', {
                            data: fallback.data || [],
                            total: fallback.total || 0,
                            page: fallback.page || page,
                            totalPages: fallback.totalPages || 1
                        });
                        commit('SET_SEARCH_KEYWORD', search);
                    }
                    return { ...fallback, _servedFromIndex: true, _fromFallback: true };
                }
                throw error;
            } finally {
                if (!silent && isCurrent()) commit('SET_LOADING', false);
            }
        },

        /**
         * 获取 Bangumi 番剧详情
         */
        async fetchBangumiDetail({ commit }, payload) {
            const bgmId = typeof payload === 'object' && payload !== null ? (payload.bgmId || payload.id) : payload;
            const silent = typeof payload === 'object' && payload !== null && payload.silent === true;
            if (!silent) commit('SET_LOADING', true);

            try {
                const anime = await window.electronAPI.bangumiGetDetail(bgmId);
                if (anime) {
                    commit('SET_CURRENT_ANIME', anime);
                }
                return anime;
            } catch (error) {
                console.error('[Bangumi] 获取详情失败:', error);
                throw error;
            } finally {
                if (!silent) commit('SET_LOADING', false);
            }
        },

        /**
         * 测试 Bangumi API 连通性
         */
        async testBangumi() {
            try {
                return await window.electronAPI.bangumiTest();
            } catch (error) {
                console.error('[Bangumi] API 测试失败:', error);
                return { ok: false, msg: error.message };
            }
        },

        /**
         * 获取新番时间表（按星期分组）
         * P0：本地索引优先——先查本地索引立即显示，再后台网络刷新
         */
        async fetchBangumiSchedule({ commit, state }) {
            commit('SET_BANGUMI_SCHEDULE_LOADING', true);
            const refreshSeq = state._scheduleRefreshSeq + 1;
            commit('SET_SCHEDULE_REFRESH_SEQ', refreshSeq);
            // 本地索引优先：按星期 1-7 查询本地已索引的番剧
            if (window.electronAPI?.subjectIndexWeekday) {
                try {
                    const weekdayNames = [
                        { en: 'Mon', cn: '周一', id: 1 },
                        { en: 'Tue', cn: '周二', id: 2 },
                        { en: 'Wed', cn: '周三', id: 3 },
                        { en: 'Thu', cn: '周四', id: 4 },
                        { en: 'Fri', cn: '周五', id: 5 },
                        { en: 'Sat', cn: '周六', id: 6 },
                        { en: 'Sun', cn: '周日', id: 7 }
                    ];
                    const localSchedule = [];
                    let localHasData = false;
                    const weekdayResults = await Promise.all(weekdayNames.map(async (wd) => {
                        try {
                            const items = await window.electronAPI.subjectIndexWeekday(wd.id);
                            return { weekday: wd, items: Array.isArray(items) ? items : [] };
                        } catch (_weekdayErr) {
                            return { weekday: wd, items: [] };
                        }
                    }));
                    for (const group of weekdayResults) {
                        if (group.items.length > 0) localHasData = true;
                        localSchedule.push(group);
                    }
                    if (localHasData) {
                        commit('SET_BANGUMI_SCHEDULE', localSchedule);
                        commit('SET_BANGUMI_SCHEDULE_LOADING', false);
                        // 后台网络刷新（静默，不覆盖正在显示的结果除非拿到新数据）
                        // 用序列号防止竞态：若期间又发起新的刷新，旧请求结果被丢弃
                        (async () => {
                            try {
                                const schedule = window.electronAPI.subjectCalendar
                                    ? await window.electronAPI.subjectCalendar()
                                    : await window.electronAPI.bangumiGetSchedule();
                                if (state._scheduleRefreshSeq === refreshSeq) {
                                    commit('SET_BANGUMI_SCHEDULE', schedule);
                                }
                            } catch (_e) {
                                // 后台刷新失败忽略，本地数据继续显示
                            }
                        })();
                        return localSchedule;
                    }
                } catch (_e) {
                    // 本地查询失败，回退到网络
                }
            }
            try {
                const schedule = window.electronAPI.subjectCalendar
                    ? await window.electronAPI.subjectCalendar()
                    : await window.electronAPI.bangumiGetSchedule();
                commit('SET_BANGUMI_SCHEDULE', schedule);
                return schedule;
            } catch (error) {
                console.error('[Bangumi] 获取新番时间表失败:', error);
                return [];
            } finally {
                commit('SET_BANGUMI_SCHEDULE_LOADING', false);
            }
        },

        // ── 非凡资源网 (ffzy.tv) 数据源 Actions ─────────────────────────

        /**
         * 获取非凡资源网分类
         */
        async fetchFanzhiCategories({ commit }) {
            try {
                const categories = await window.electronAPI.playbackSourceGetCategories();
                commit('SET_FANZHI_CATEGORIES', categories);
                return categories;
            } catch (error) {
                console.error('[Fanzhi] 获取分类失败:', error);
                return [];
            }
        },

        /**
         * 获取非凡资源网动漫列表
         */
        async fetchFanzhiList({ commit, state }, { categoryId, page = 1 } = {}) {
            const requestId = state.listRequestSeq + 1;
            commit('BEGIN_LIST_REQUEST', requestId);
            const isCurrent = () => state.activeListRequestSeq === requestId;

            const cid = categoryId || state.fanzhiCurrentCategory;

            try {
                const result = await window.electronAPI.playbackSourceGetList(cid, page);
                if (!isCurrent()) return { ...result, stale: true };

                if (result.error) {
                    throw new Error(result.error);
                }

                commit('SET_ANIME_LIST', {
                    data: result.data || [],
                    total: result.total || 0,
                    page: result.page || page,
                    totalPages: result.totalPages || 1
                });
                // 非搜索模式，清空搜索关键词
                commit('SET_SEARCH_KEYWORD', '');

                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                console.error('[Fanzhi] 获取列表失败:', error);
                throw error;
            } finally {
                if (isCurrent()) commit('SET_LOADING', false);
            }
        },

        /**
         * 获取非凡资源网动漫详情
         */
        async fetchFanzhiDetail({ commit }, payload) {
            const id = typeof payload === 'object' && payload !== null ? payload.id : payload;
            const silent = typeof payload === 'object' && payload !== null && payload.silent === true;
            if (!silent) commit('SET_LOADING', true);

            try {
                const anime = await window.electronAPI.playbackSourceGetDetail(id);
                if (anime) {
                    commit('SET_CURRENT_ANIME', anime);
                    // 顺手更新列表里的封面
                    if (anime.cover) {
                        commit('UPDATE_ANIME_IN_LIST', { id, updates: { cover: anime.cover } });
                    }
                }
                return anime;
            } catch (error) {
                console.error('[Fanzhi] 获取详情失败:', error);
                throw error;
            } finally {
                if (!silent) commit('SET_LOADING', false);
            }
        },

        /**
         * 获取非凡资源网播放地址
         */
        async fetchFanzhiPlayUrl(_, playPath) {
            try {
                return await window.electronAPI.playbackSourceResolveUrl(playPath);
            } catch (error) {
                console.error('[Fanzhi] 获取播放地址失败:', error);
                return null;
            }
        },

        /**
         * 搜索非凡资源网
         */
        async searchFanzhi({ commit, state }, { keyword, page = 1 } = {}) {
            const requestId = state.listRequestSeq + 1;
            commit('BEGIN_LIST_REQUEST', requestId);
            const isCurrent = () => state.activeListRequestSeq === requestId;

            try {
                const result = await window.electronAPI.playbackSourceSearch(keyword, page);
                if (!isCurrent()) return { ...result, stale: true };

                if (result.error) {
                    throw new Error(result.error);
                }

                commit('SET_ANIME_LIST', {
                    data: result.data || [],
                    total: result.total || 0,
                    page: result.page || page,
                    totalPages: result.totalPages || 1
                });
                commit('SET_SEARCH_KEYWORD', keyword);

                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                console.error('[Fanzhi] 搜索失败:', error);
                throw error;
            } finally {
                if (isCurrent()) commit('SET_LOADING', false);
            }
        },

        /**
         * 切换非凡资源网分类
         */
        async switchFanzhiCategory({ commit, dispatch }, categoryId) {
            commit('SET_FANZHI_CURRENT_CATEGORY', categoryId);
            commit('SET_FANZHI_SELECTED_GENRE', ''); // 切换分类时清除类型筛选
            await dispatch('fetchFanzhiList', { categoryId, page: 1 });
        },

        /**
         * 获取非凡资源网类型标签
         */
        async fetchFanzhiGenreTags({ commit }) {
            try {
                const tags = [];
                commit('SET_FANZHI_GENRE_TAGS', tags);
                return tags;
            } catch (error) {
                return [];
            }
        },

        /**
         * 按类型标签筛选非凡资源网（使用 class URL 参数，真正按类型筛选）
         */
        async searchFanzhiByGenre({ commit, state }, { genre, page = 1 } = {}) {
            const requestId = state.listRequestSeq + 1;
            commit('BEGIN_LIST_REQUEST', requestId);
            const isCurrent = () => state.activeListRequestSeq === requestId;

            try {
                const result = await window.electronAPI.playbackSourceSearch(genre, page);
                if (!isCurrent()) return { ...result, stale: true };

                if (result.error) {
                    throw new Error(result.error);
                }

                commit('SET_ANIME_LIST', {
                    data: result.data || [],
                    total: result.total || 0,
                    page: result.page || page,
                    totalPages: result.totalPages || 1
                });
                commit('SET_SEARCH_KEYWORD', '');
                commit('SET_FANZHI_SELECTED_GENRE', genre);

                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                throw error;
            } finally {
                if (isCurrent()) commit('SET_LOADING', false);
            }
        },

        /**
         * 清除类型筛选，恢复分类列表
         */
        async clearFanzhiGenreFilter({ commit, state, dispatch }) {
            commit('SET_FANZHI_SELECTED_GENRE', '');
            await dispatch('fetchFanzhiList', { categoryId: state.fanzhiCurrentCategory, page: 1 });
        },

        /**
         * 测试非凡资源网连通性
         */
        async testFanzhi() {
            try {
                return await window.electronAPI.playbackSourceTest();
            } catch (error) {
                console.error('[Fanzhi] API 测试失败:', error);
                return { success: false, message: error.message };
            }
        },

        // ── 通用 CMS 多源 Actions ─────────────────────────

        async loadCmsMultiSources({ commit }) {
            try {
                const sources = await window.electronAPI.cmsMultiGetSources();
                commit('SET_CMS_MULTI_SOURCES', sources);
                return sources;
            } catch (error) {
                console.error('[CmsMulti] 加载源列表失败:', error);
                return [];
            }
        },

        async setCmsMultiSource({ commit }, sourceId) {
            try {
                await window.electronAPI.cmsMultiSetSource(sourceId);
                commit('SET_CMS_MULTI_CURRENT_SOURCE', sourceId);
                // 切换源后重新获取分类
                const categories = await window.electronAPI.cmsMultiGetCategories();
                commit('SET_CMS_MULTI_CATEGORIES', categories);
                // 默认选中第一个分类
                if (categories.length > 0) {
                    const defaultCat = categories[0].id;
                    commit('SET_CMS_MULTI_CURRENT_CATEGORY', defaultCat);
                }
            } catch (error) {
                console.error('[CmsMulti] 切换源失败:', error);
            }
        },

        async fetchCmsMultiList({ commit, state }, { categoryId, page = 1, refresh = false } = {}) {
            const requestId = state.listRequestSeq + 1;
            commit('BEGIN_LIST_REQUEST', requestId);
            const isCurrent = () => state.activeListRequestSeq === requestId;
            const cid = categoryId || state.cmsMultiCurrentCategory;
            try {
                const result = await window.electronAPI.cmsMultiGetList(cid, page, { refresh });
                if (!isCurrent()) return { ...result, stale: true };
                if (result.error) throw new Error(result.error);
                commit('SET_ANIME_LIST', {
                    data: result.data || [],
                    total: result.total || 0,
                    page: result.page || page,
                    totalPages: result.totalPages || 1
                });
                commit('SET_SEARCH_KEYWORD', '');
                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                console.error('[CmsMulti] 获取列表失败:', error);
                throw error;
            } finally {
                if (isCurrent()) commit('SET_LOADING', false);
            }
        },

        async fetchCmsMultiDetail({ commit }, { id, sourceId, refresh = false, silent = false } = {}) {
            if (!silent) commit('SET_LOADING', true);
            try {
                const anime = await window.electronAPI.cmsMultiGetDetail(id, { sourceId, refresh });
                if (anime) {
                    commit('SET_CURRENT_ANIME', anime);
                }
                return anime;
            } catch (error) {
                console.error('[CmsMulti] 获取详情失败:', error);
                throw error;
            } finally {
                if (!silent) commit('SET_LOADING', false);
            }
        },

        async searchCmsMulti({ commit, state }, { keyword, page = 1 } = {}) {
            const requestId = state.listRequestSeq + 1;
            commit('BEGIN_LIST_REQUEST', requestId);
            const isCurrent = () => state.activeListRequestSeq === requestId;
            try {
                const result = await window.electronAPI.cmsMultiSearch(keyword, page);
                if (!isCurrent()) return { ...result, stale: true };
                if (result.error) throw new Error(result.error);
                commit('SET_ANIME_LIST', {
                    data: result.data || [],
                    total: result.total || 0,
                    page: result.page || page,
                    totalPages: result.totalPages || 1
                });
                commit('SET_SEARCH_KEYWORD', keyword);
                return result;
            } catch (error) {
                if (!isCurrent()) return { stale: true };
                console.error('[CmsMulti] 搜索失败:', error);
                throw error;
            } finally {
                if (isCurrent()) commit('SET_LOADING', false);
            }
        },

        async searchCmsMultiAllSources(_, keyword) {
            try {
                return await window.electronAPI.cmsMultiSearchAllSources(keyword);
            } catch (error) {
                console.error('[CmsMulti] 全源搜索失败:', error);
                return [];
            }
        },

        async selectBestCmsEpisodeSource(_, { keyword, target } = {}) {
            try {
                return await window.electronAPI.cmsMultiSelectBestEpisodeSource(keyword, target || {});
            } catch (error) {
                console.error('[CmsMulti] 选择最佳播放源失败:', error);
                return { best: null, candidates: [], skipped: [], error: error.message };
            }
        },

        async testCmsMultiAll() {
            try {
                return await window.electronAPI.cmsMultiTestAll();
            } catch (error) {
                console.error('[CmsMulti] 测试全部源失败:', error);
                return [];
            }
        }
    }
};
