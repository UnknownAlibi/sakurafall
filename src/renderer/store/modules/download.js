/**
 * 番剧下载 Vuex 模块
 *
 * state:
 *   - downloadList: 下载任务列表（按 createdAt 倒序）
 *   - downloadDir:  当前下载目录
 *   - activeCount:  正在下载的任务数（派生自 downloadList）
 *
 * 监听主进程 on-download-progress 事件实时更新 state
 */

// 模块级变量：保存进度监听的解绑函数
let _progressUnbind = null;

export default {
    namespaced: true,

    state: {
        downloadList: [],
        downloadDir: '',
        // 是否已完成初次加载（避免重复拉取）
        initialized: false
    },

    getters: {
        downloadList: state => state.downloadList,
        downloadDir: state => state.downloadDir,
        initialized: state => state.initialized,

        /**
         * 正在下载的任务数（pending + downloading）
         */
        activeCount: state => {
            return state.downloadList.filter(t =>
                t.status === 'pending' || t.status === 'downloading'
            ).length;
        },

        /**
         * 已完成任务数
         */
        completedCount: state => {
            return state.downloadList.filter(t => t.status === 'completed').length;
        },

        /**
         * 失败/暂停任务数
         */
        problematicCount: state => {
            return state.downloadList.filter(t =>
                t.status === 'failed' || t.status === 'paused'
            ).length;
        },

        /**
         * 按 id 索引任务，便于 O(1) 查找
         */
        taskById: state => id => state.downloadList.find(t => t.id === id) || null
    },

    mutations: {
        SET_DOWNLOAD_LIST(state, list) {
            state.downloadList = Array.isArray(list) ? list : [];
        },

        SET_DOWNLOAD_DIR(state, dir) {
            state.downloadDir = dir || '';
        },

        SET_INITIALIZED(state, val) {
            state.initialized = !!val;
        },

        /**
         * 用主进程推送的 task 更新或插入列表
         * 保持倒序（createdAt desc）
         */
        UPSERT_TASK(state, task) {
            if (!task || !task.id) return;
            const idx = state.downloadList.findIndex(t => t.id === task.id);
            if (idx >= 0) {
                // 替换为新对象，确保响应式更新
                state.downloadList.splice(idx, 1, { ...state.downloadList[idx], ...task });
            } else {
                state.downloadList.unshift({ ...task });
            }
        },

        /**
         * 从列表中移除指定任务
         */
        REMOVE_TASK(state, id) {
            const idx = state.downloadList.findIndex(t => t.id === id);
            if (idx >= 0) state.downloadList.splice(idx, 1);
        }
    },

    actions: {
        /**
         * 拉取一次下载列表与下载目录（首次进入下载页时调用）
         */
        async loadDownloadList({ commit }) {
            try {
                const result = await window.electronAPI.downloadList();
                commit('SET_DOWNLOAD_LIST', result?.tasks || []);
                commit('SET_DOWNLOAD_DIR', result?.downloadDir || '');
                commit('SET_INITIALIZED', true);
                return result;
            } catch (error) {
                console.error('[Download] 加载下载列表失败:', error);
                return null;
            }
        },

        /**
         * 添加下载任务
         * @param {Object} payload - { anime, episode, url }
         */
        async addDownload({ commit }, payload) {
            try {
                const result = await window.electronAPI.downloadAdd(payload);
                if (result && result.success && result.task) {
                    commit('UPSERT_TASK', result.task);
                    return result.task;
                }
                if (result && result.error) {
                    console.error('[Download] 添加下载任务失败:', result.error);
                }
                return null;
            } catch (error) {
                console.error('[Download] 添加下载任务失败:', error);
                return null;
            }
        },

        /**
         * 取消下载（保留记录）
         */
        async cancelDownload({ commit }, id) {
            try {
                const result = await window.electronAPI.downloadCancel(id);
                if (result && result.task) {
                    commit('UPSERT_TASK', result.task);
                }
                return result;
            } catch (error) {
                console.error('[Download] 取消下载失败:', error);
                return null;
            }
        },

        /**
         * 暂停下载
         */
        async pauseDownload({ commit }, id) {
            try {
                const result = await window.electronAPI.downloadPause(id);
                if (result && result.task) {
                    commit('UPSERT_TASK', result.task);
                }
                return result;
            } catch (error) {
                console.error('[Download] 暂停下载失败:', error);
                return null;
            }
        },

        /**
         * 恢复下载
         */
        async resumeDownload({ commit }, id) {
            try {
                const result = await window.electronAPI.downloadResume(id);
                if (result && result.task) {
                    commit('UPSERT_TASK', result.task);
                }
                return result;
            } catch (error) {
                console.error('[Download] 恢复下载失败:', error);
                return null;
            }
        },

        /**
         * 删除下载记录和文件
         */
        async removeDownload({ commit }, id) {
            try {
                const result = await window.electronAPI.downloadRemove(id);
                if (result && result.success) {
                    commit('REMOVE_TASK', id);
                }
                return result;
            } catch (error) {
                console.error('[Download] 删除下载失败:', error);
                return null;
            }
        },

        /**
         * 选择下载目录（弹出系统对话框）
         */
        async selectDownloadDir({ commit }) {
            try {
                const result = await window.electronAPI.downloadSelectDir();
                if (result && !result.canceled && result.dir) {
                    commit('SET_DOWNLOAD_DIR', result.dir);
                    return result.dir;
                }
                return null;
            } catch (error) {
                console.error('[Download] 选择下载目录失败:', error);
                return null;
            }
        },

        /**
         * 在系统文件管理器中打开下载目录
         */
        async openDownloadDir(_, dirPath) {
            try {
                return await window.electronAPI.downloadOpenDir(dirPath);
            } catch (error) {
                console.error('[Download] 打开下载目录失败:', error);
                return null;
            }
        },

        /**
         * 在系统文件管理器中定位已下载文件
         */
        async openDownloadFile(_, filePath) {
            try {
                return await window.electronAPI.downloadOpenFile(filePath);
            } catch (error) {
                console.error('[Download] 定位文件失败:', error);
                return null;
            }
        },

        /**
         * 监听主进程推送的下载进度事件
         * 应在应用启动时（App.vue mounted）调用一次
         */
        bindProgressListener({ commit }) {
            if (!window.electronAPI || !window.electronAPI.onDownloadProgress) return;
            // 重复绑定时先解绑
            if (_progressUnbind) {
                try { _progressUnbind(); } catch (_) { /* ignore */ }
            }
            _progressUnbind = window.electronAPI.onDownloadProgress((task) => {
                commit('UPSERT_TASK', task);
            });
        },

        /**
         * 解绑下载进度监听（应用卸载时调用）
         */
        unbindProgressListener() {
            if (_progressUnbind) {
                try { _progressUnbind(); } catch (_) { /* ignore */ }
                _progressUnbind = null;
            }
        }
    }
};
