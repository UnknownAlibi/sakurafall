/**
 * 应用更新的全局状态。
 *
 * 设计要点：下载状态本来就由主进程托管（切页面不中断），这里只做两件事
 *   1. 把主进程的状态快照与启动时的静默检查结果收进 store，供任意界面消费；
 *   2. 让标题栏的全局更新卡片与设置页共用同一份状态，不再各存一份局部 data。
 *
 * 状态流转（主进程侧）：idle → downloading → ready →（用户确认）installing / error
 */

const IDLE_DOWNLOAD = Object.freeze({
    status: 'idle',
    percent: 0,
    received: 0,
    total: 0,
    filePath: '',
    error: '',
    latestVersion: '',
    releaseNotes: ''
});

// 监听器注销函数（放在模块作用域，避免进入响应式系统）
let listeners = { available: null, progress: null };

export default {
    namespaced: true,
    state: {
        currentVersion: '',
        checking: false,
        // checkForUpdates 的结果：{ hasUpdate, currentVersion, latestVersion, downloadUrl, releaseNotes, releaseDate, forceUpdate, error? }
        result: null,
        // 主进程托管状态快照
        download: { ...IDLE_DOWNLOAD },
        // 用户「忽略此版本」后不再主动提示（卡片里仍可手动更新）
        ignoredVersion: '',
        bound: false
    },
    getters: {
        currentVersion: (state) => state.currentVersion || state.result?.currentVersion || '',
        hasUpdate: (state) => !!state.result?.hasUpdate && !state.result?.error,
        latestVersion: (state) => state.result?.latestVersion || state.download.latestVersion || '',
        releaseNotes: (state) => state.result?.releaseNotes || state.download.releaseNotes || '',
        releaseDate: (state) => state.result?.releaseDate || '',
        checkError: (state) => state.result?.error || '',
        forceUpdate: (state) => !!state.result?.forceUpdate,
        // 有新版本且未被忽略 —— 徽标红点看这个
        updateVisible: (state, getters) => getters.hasUpdate && state.result?.latestVersion !== state.ignoredVersion,
        downloadStatus: (state) => state.download.status,
        downloadPercent: (state) => state.download.percent,
        downloadReceived: (state) => state.download.received,
        downloadTotal: (state) => state.download.total,
        downloadError: (state) => state.download.error,
        downloading: (state) => state.download.status === 'downloading',
        installing: (state) => state.download.status === 'installing',
        readyToInstall: (state) => state.download.status === 'ready',
        busy: (state) => state.download.status === 'downloading' || state.download.status === 'installing',
        // 徽标状态机：组件只消费这一个值，避免模板里堆条件
        badgeState: (state, getters) => {
            if (getters.installing) return 'installing';
            if (getters.downloading) return 'downloading';
            if (getters.readyToInstall) return 'ready';
            if (getters.updateVisible) return state.result?.forceUpdate ? 'force' : 'available';
            if (getters.checkError) return 'error';
            return 'idle';
        },
        // 可以点「立即更新」：有更新、有安全下载地址、且当前没有任务在跑
        canDownload: (state, getters) => getters.hasUpdate
            && !!state.result?.downloadUrl
            && !getters.busy
            && !getters.readyToInstall
    },
    mutations: {
        SET_VERSION(state, version) {
            state.currentVersion = version || '';
        },
        SET_CHECKING(state, checking) {
            state.checking = !!checking;
        },
        SET_RESULT(state, result) {
            state.result = result || null;
        },
        SET_DOWNLOAD(state, snapshot) {
            state.download = { ...IDLE_DOWNLOAD, ...(snapshot || {}) };
        },
        SET_IGNORED(state, version) {
            state.ignoredVersion = version || '';
        },
        SET_BOUND(state, bound) {
            state.bound = !!bound;
        }
    },
    actions: {
        notify({ dispatch }, notification) {
            return dispatch('notification/showNotification', notification, { root: true });
        },

        /** 拉取当前版本号（设置页与卡片都要显示） */
        async loadVersion({ commit }) {
            try {
                const version = await window.electronAPI?.updateGetVersion?.();
                if (version) commit('SET_VERSION', version);
            } catch (_error) { /* 版本不可用不影响更新流程 */ }
        },

        /** 恢复主进程正在进行的下载（页面刷新/HMR 后不丢进度） */
        async syncDownloadState({ commit }) {
            try {
                const snapshot = await window.electronAPI?.updateGetState?.();
                if (snapshot?.status) commit('SET_DOWNLOAD', snapshot);
            } catch (_error) { /* 状态不可用时保持 idle */ }
        },

        /** 绑定主进程推送（全局只绑一次，由全局更新组件在挂载时调用） */
        bindListeners({ state, commit, dispatch }) {
            if (state.bound) return;
            const api = window.electronAPI;
            if (!api) return;

            listeners.available = api.onUpdateAvailable?.((info) => {
                if (!info) return;
                // 静默检查失败不打扰用户（网络抖动很常见）
                if (info.error) return;
                commit('SET_RESULT', info);
                commit('SET_IGNORED', '');
                if (info.hasUpdate) {
                    dispatch('notify', {
                        type: 'info',
                        title: '发现新版本',
                        message: `v${info.latestVersion} 已发布，点标题栏右上角的更新图标即可升级`,
                        duration: 6000
                    });
                }
            }) || null;

            listeners.progress = api.onUpdateDownloadProgress?.((snapshot) => {
                if (!snapshot?.status) return;
                const previous = state.download.status;
                commit('SET_DOWNLOAD', snapshot);
                if (snapshot.status === 'ready' && previous !== 'ready') {
                    dispatch('notify', {
                        type: 'success',
                        title: '更新已就绪',
                        message: '安装包下载完成，点标题栏更新图标即可重启安装',
                        duration: 6000
                    });
                } else if (snapshot.status === 'error' && previous !== 'error') {
                    dispatch('notify', {
                        type: 'error',
                        title: '更新失败',
                        message: snapshot.error || '下载或安装失败，可稍后重试',
                        duration: 6000
                    });
                }
            }) || null;

            commit('SET_BOUND', true);
        },

        unbindListeners({ commit }) {
            listeners.available?.();
            listeners.progress?.();
            listeners = { available: null, progress: null };
            commit('SET_BOUND', false);
        },

        /** 手动检查（设置页按钮 / 卡片按钮共用） */
        async check({ commit, dispatch }) {
            commit('SET_CHECKING', true);
            try {
                if (!window.electronAPI?.updateCheck) throw new Error('当前版本不支持更新检查');
                const result = await window.electronAPI.updateCheck();
                commit('SET_RESULT', result);
                commit('SET_IGNORED', '');
                if (result?.hasUpdate) {
                    dispatch('notify', {
                        type: 'success',
                        title: '发现新版本',
                        message: `v${result.latestVersion} 已发布`,
                        duration: 5000
                    });
                } else if (!result?.error) {
                    dispatch('notify', {
                        type: 'success',
                        title: '已是最新版本',
                        message: `当前 v${result?.currentVersion || ''}`,
                        duration: 4000
                    });
                }
                return result;
            } catch (error) {
                commit('SET_RESULT', { error: error.message, hasUpdate: false });
                dispatch('notify', {
                    type: 'error',
                    title: '检查更新失败',
                    message: error.message,
                    duration: 6000
                });
                return null;
            } finally {
                commit('SET_CHECKING', false);
            }
        },

        /** 开始下载（主进程托管，完成后停在 ready 等用户确认） */
        async download({ commit, dispatch }, payload) {
            const url = typeof payload === 'string' ? payload : payload?.url;
            const latestVersion = typeof payload === 'string' ? '' : (payload?.latestVersion || '');
            const releaseNotes = typeof payload === 'string' ? '' : (payload?.releaseNotes || '');
            // 摘要由主进程侧的检查结果缓存优先提供；这里仅作为兜底透传
            const sha256 = typeof payload === 'string' ? '' : (payload?.sha256 || '');
            if (!url) {
                dispatch('notify', { type: 'warning', title: '无法更新', message: '更新源未提供安全的下载地址' });
                return null;
            }
            try {
                if (!window.electronAPI?.updateDownload) throw new Error('当前版本不支持应用内更新');
                commit('SET_DOWNLOAD', {
                    status: 'downloading',
                    percent: 0,
                    latestVersion,
                    releaseNotes
                });
                const snapshot = await window.electronAPI.updateDownload({ url, latestVersion, releaseNotes, sha256 });
                if (snapshot?.status) commit('SET_DOWNLOAD', snapshot);
                return snapshot;
            } catch (error) {
                commit('SET_DOWNLOAD', { status: 'error', error: error.message });
                dispatch('notify', { type: 'error', title: '启动更新失败', message: error.message });
                return null;
            }
        },

        /** 用户确认：立即重启安装 */
        async installNow({ commit, dispatch }) {
            try {
                if (!window.electronAPI?.updateInstall) throw new Error('当前版本不支持应用内安装');
                const snapshot = await window.electronAPI.updateInstall();
                if (snapshot?.status) commit('SET_DOWNLOAD', snapshot);
                if (snapshot?.status === 'error') {
                    dispatch('notify', {
                        type: 'error',
                        title: '安装失败',
                        message: snapshot.error || '启动安装程序失败'
                    });
                }
                return snapshot;
            } catch (error) {
                commit('SET_DOWNLOAD', { status: 'error', error: error.message });
                dispatch('notify', { type: 'error', title: '安装失败', message: error.message });
                return null;
            }
        },

        ignoreVersion({ commit, getters }) {
            commit('SET_IGNORED', getters.latestVersion);
        },

        /** 重新检查前清掉上一次的结果（避免旧版本信息残留） */
        clearResult({ commit }) {
            commit('SET_RESULT', null);
            commit('SET_IGNORED', '');
        }
    }
};
