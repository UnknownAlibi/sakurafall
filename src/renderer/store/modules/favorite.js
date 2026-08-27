/**
 * 收藏 / 追番 / 播放历史 Vuex 模块
 */
export default {
    namespaced: true,

    state: {
        // 收藏列表（我的追番页）
        favoriteList: [],
        favoriteTotal: 0,
        favoritePage: 1,
        favoriteTotalPages: 0,
        favoriteLoading: false,

        // 当前列表中各动漫的收藏状态映射 { "source:id": true }
        favoriteMap: {},

        // 播放历史 / 续播
        recentHistory: [],
        historyLoading: false
    },

    getters: {
        favoriteList: state => state.favoriteList,
        favoriteTotal: state => state.favoriteTotal,
        favoritePage: state => state.favoritePage,
        favoriteTotalPages: state => state.favoriteTotalPages,
        favoriteLoading: state => state.favoriteLoading,
        favoriteMap: state => state.favoriteMap,

        recentHistory: state => state.recentHistory,
        historyLoading: state => state.historyLoading,

        /**
         * 判断指定动漫是否已收藏
         * 用法：store.getters['favorite/isFavorite']({ id, source })
         */
        isFavorite: state => ({ id, source = 'legacy' }) => {
            return !!state.favoriteMap[`${source}:${id}`];
        }
    },

    mutations: {
        SET_FAVORITE_LIST(state, { data, total, page, totalPages }) {
            state.favoriteList = data;
            state.favoriteTotal = total;
            state.favoritePage = page;
            state.favoriteTotalPages = totalPages;
        },

        SET_FAVORITE_LOADING(state, loading) {
            state.favoriteLoading = loading;
        },

        SET_FAVORITE_MAP(state, map) {
            state.favoriteMap = map;
        },

        /**
         * 更新单条收藏状态
         */
        UPDATE_FAVORITE_STATUS(state, { key, favorited }) {
            if (favorited) {
                state.favoriteMap[key] = true;
            } else {
                delete state.favoriteMap[key];
            }
            // 触发响应式更新
            state.favoriteMap = { ...state.favoriteMap };
        },

        SET_RECENT_HISTORY(state, list) {
            state.recentHistory = list;
        },

        SET_HISTORY_LOADING(state, loading) {
            state.historyLoading = loading;
        },

        /**
         * 即时从收藏列表移除一条（取消收藏后无需整页刷新）
         */
        REMOVE_FAVORITE_FROM_LIST(state, { id, source = 'legacy' }) {
            state.favoriteList = state.favoriteList.filter(
                item => !(String(item.anime_id) === String(id) && (item.source || 'legacy') === source)
            );
            state.favoriteTotal = Math.max(0, state.favoriteTotal - 1);
        },

        /**
         * 更新收藏列表中单条动漫的进度（播放后实时更新UI）
         * 返回新引用以确保 Vue 响应式更新（直接改对象属性不会触发）
         */
        UPDATE_FAVORITE_PROGRESS(state, { animeId, source, episodeTitle, episodeIndex }) {
            const idx = state.favoriteList.findIndex(
                f => f.anime_id === String(animeId) && f.source === source
            );
            if (idx !== -1) {
                const newList = state.favoriteList.slice();
                newList[idx] = {
                    ...newList[idx],
                    last_episode: episodeTitle,
                    last_episode_index: episodeIndex
                };
                state.favoriteList = newList;
            }
        }
    },

    actions: {
        /**
         * 添加收藏
         * 如果 anime 带 bgm_id，主进程会按 bgm_id 去重（同 bgm_id 的旧收藏会被更新源信息）
         */
        async addFavorite({ commit }, anime) {
            try {
                const source = anime.source || 'legacy';
                const key = `${source}:${anime.id}`;
                // 注意：anime 来自 Vue 响应式数据，type 等嵌套对象是 Proxy，
                // Electron IPC 结构化克隆 Proxy 会抛 "An object could not be cloned"。
                // 这里必须拆成纯原始值再发送。
                const payload = {
                    id: String(anime.id ?? ''),
                    source,
                    name: anime.name != null ? String(anime.name) : '',
                    cover: anime.cover != null ? String(anime.cover) : '',
                    intro: anime.intro != null ? String(anime.intro) : '',
                    year: anime.year != null ? String(anime.year) : '',
                    area: anime.area != null ? String(anime.area) : '',
                    type: Array.isArray(anime.type) ? anime.type.map(String) : [],
                    episode_count: Number(anime.episode_count) || 0,
                    bgm_id: anime.bgm_id != null ? Number(anime.bgm_id) : null
                };
                const result = await window.electronAPI.favoriteAdd(payload);

                if (result && !result.error) {
                    commit('UPDATE_FAVORITE_STATUS', { key, favorited: true });
                    return true;
                }
                console.warn('[Favorite] 添加收藏未成功:', key, result);
                return false;
            } catch (error) {
                console.error('[Favorite] 添加收藏失败:', error);
                return false;
            }
        },

        /**
         * 取消收藏
         */
        async removeFavorite({ commit }, { id, source = 'legacy' }) {
            try {
                const result = await window.electronAPI.favoriteRemove(id, source);
                if (result && !result.error) {
                    const key = `${source}:${id}`;
                    commit('UPDATE_FAVORITE_STATUS', { key, favorited: false });
                    console.warn('[Favorite] 取消收藏成功:', key, result);
                    return true;
                }
                console.warn('[Favorite] 取消收藏未成功:', `${source}:${id}`, result);
                return false;
            } catch (error) {
                console.error('[Favorite] 取消收藏失败:', error);
                return false;
            }
        },

        /**
         * 切换收藏状态
         */
        async toggleFavorite({ state, dispatch }, anime) {
            const source = anime.source || 'legacy';
            const key = `${source}:${anime.id}`;
            const isFav = !!state.favoriteMap[key];

            if (isFav) {
                return await dispatch('removeFavorite', { id: anime.id, source });
            } else {
                return await dispatch('addFavorite', anime);
            }
        },

        /**
         * 获取收藏列表（我的追番页）
         */
        async fetchFavoriteList({ commit }, { page = 1, limit = 50 } = {}) {
            commit('SET_FAVORITE_LOADING', true);
            try {
                const result = await window.electronAPI.favoriteList(page, limit);
                commit('SET_FAVORITE_LIST', {
                    data: result.data || [],
                    total: result.total || 0,
                    page: result.page || page,
                    totalPages: result.totalPages || 0
                });
                return result;
            } catch (error) {
                console.error('[Favorite] 获取收藏列表失败:', error);
                throw error;
            } finally {
                commit('SET_FAVORITE_LOADING', false);
            }
        },

        /**
         * 检查单条收藏状态
         */
        async checkFavorite({ commit }, { id, source = 'legacy' }) {
            try {
                const isFav = await window.electronAPI.favoriteCheck(id, source);
                const key = `${source}:${id}`;
                commit('UPDATE_FAVORITE_STATUS', { key, favorited: isFav });
                return isFav;
            } catch (error) {
                console.error('[Favorite] 检查收藏状态失败:', error);
                return false;
            }
        },

        /**
         * 批量检查收藏状态（用于列表页标记）
         */
        async checkFavoritesBatch({ commit }, items) {
            if (!items || items.length === 0) return;

            try {
                const checkItems = items.map(a => ({
                    id: a.id,
                    source: a.source || 'legacy'
                }));
                const map = await window.electronAPI.favoriteCheckBatch(checkItems);
                commit('SET_FAVORITE_MAP', map);
                return map;
            } catch (error) {
                console.error('[Favorite] 批量检查收藏状态失败:', error);
                return {};
            }
        },

        // ── 播放历史 / 续播 ─────────────────────────────────

        /**
         * 更新播放进度（播放视频时调用）
         * @param {Object} data - { anime_id, source, name, cover, episode_title, episode_index, play_url, anime_data }
         */
        async updatePlayHistory({ commit }, data) {
            try {
                const result = await window.electronAPI.historyUpdate(data);
                // 同步更新收藏列表中的进度显示
                if (data.anime_id && data.source) {
                    commit('UPDATE_FAVORITE_PROGRESS', {
                        animeId: data.anime_id,
                        source: data.source,
                        episodeTitle: data.episode_title,
                        episodeIndex: data.episode_index
                    });
                }
                return result;
            } catch (error) {
                console.error('[History] 更新播放历史失败:', error);
                return null;
            }
        },

        /**
         * 获取最近播放历史（续播卡片）
         */
        async fetchRecentHistory({ commit }, limit = 10) {
            commit('SET_HISTORY_LOADING', true);
            try {
                const list = await window.electronAPI.historyRecent(limit);
                commit('SET_RECENT_HISTORY', list || []);
                return list;
            } catch (error) {
                console.error('[History] 获取播放历史失败:', error);
                return [];
            } finally {
                commit('SET_HISTORY_LOADING', false);
            }
        },

        /**
         * 获取指定动漫播放进度
         */
        async getPlayProgress(_, { animeId, source = 'legacy' }) {
            try {
                return await window.electronAPI.historyProgress(animeId, source);
            } catch (error) {
                console.error('[History] 获取播放进度失败:', error);
                return null;
            }
        },

        /**
         * 删除播放历史
         */
        async removePlayHistory(_, { animeId, source = 'legacy' }) {
            try {
                return await window.electronAPI.historyRemove(animeId, source);
            } catch (error) {
                console.error('[History] 删除播放历史失败:', error);
                return null;
            }
        },

        /**
         * 清空播放历史
         */
        async clearPlayHistory() {
            try {
                return await window.electronAPI.historyClear();
            } catch (error) {
                console.error('[History] 清空播放历史失败:', error);
                return null;
            }
        }
    }
};
