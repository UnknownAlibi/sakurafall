/**
 * 番剧更新提醒 Vuex 模块
 *
 * state:
 *   - reminders: 提醒列表（最新的在前，主进程持久化）
 *   - lastCheckTime: 上次检查时间戳（毫秒）
 *   - checking: 是否正在检查
 *
 * 通过主进程 IPC 与 UpdateReminder 服务交互：
 *   - updateReminderCheck / updateReminderList / updateReminderMarkRead / updateReminderClear / updateReminderConfigure
 *   - onUpdateReminder: 主进程推送新提醒事件
 *   - onUpdateReminderOpen: 系统通知点击后跳转事件
 */

// 模块级变量：保存主进程事件监听的解绑函数
let _reminderUnbind = null;
let _openUnbind = null;

export default {
    namespaced: true,

    state: {
        reminders: [],
        lastCheckTime: 0,
        checking: false
    },

    getters: {
        reminders: state => state.reminders,
        lastCheckTime: state => state.lastCheckTime,
        checking: state => state.checking,

        /**
         * 未读提醒数（用于 TabNavigation 角标）
         */
        unreadCount: state => {
            return state.reminders.filter(r => !r.read).length;
        },

        /**
         * 按 id 索引提醒
         */
        reminderById: state => id => state.reminders.find(r => r.id === id) || null
    },

    mutations: {
        SET_REMINDERS(state, reminders) {
            state.reminders = Array.isArray(reminders) ? reminders : [];
        },

        SET_LAST_CHECK_TIME(state, ts) {
            state.lastCheckTime = Number(ts) || 0;
        },

        SET_CHECKING(state, checking) {
            state.checking = !!checking;
        },

        /**
         * 主进程推送新提醒时，合并到列表头部
         * 同 id 的提醒会被替换，保持最新的在前
         */
        PREPEND_REMINDERS(state, newReminders) {
            if (!Array.isArray(newReminders) || newReminders.length === 0) return;
            const existingIds = new Set(state.reminders.map(r => r.id));
            const merged = [...newReminders.filter(r => !existingIds.has(r.id)), ...state.reminders];
            // 限制长度，与主进程保持一致
            state.reminders = merged.slice(0, 200);
        },

        /**
         * 标记指定番剧的提醒为已读（本地同步更新）
         */
        MARK_AS_READ(state, { animeId, source }) {
            const aid = String(animeId);
            const src = String(source || 'legacy');
            state.reminders = state.reminders.map(r => {
                if (String(r.animeId) === aid && String(r.source) === src && !r.read) {
                    return { ...r, read: true };
                }
                return r;
            });
        },

        CLEAR_ALL(state) {
            state.reminders = [];
        }
    },

    actions: {
        /**
         * 拉取一次提醒列表与上次检查时间
         */
        async loadReminders({ commit }) {
            try {
                const result = await window.electronAPI.updateReminderList();
                commit('SET_REMINDERS', result?.reminders || []);
                commit('SET_LAST_CHECK_TIME', result?.lastCheckTime || 0);
                return result;
            } catch (error) {
                console.error('[Reminder] 加载提醒列表失败:', error);
                return null;
            }
        },

        /**
         * 手动触发一次检查
         */
        async checkUpdates({ commit, dispatch }) {
            commit('SET_CHECKING', true);
            try {
                const result = await window.electronAPI.updateReminderCheck();
                // 检查完成后重新拉取完整列表，确保状态一致
                await dispatch('loadReminders');
                return result;
            } catch (error) {
                console.error('[Reminder] 检查更新失败:', error);
                return { error: error.message };
            } finally {
                commit('SET_CHECKING', false);
            }
        },

        /**
         * 标记指定番剧的提醒为已读
         */
        async markAsRead({ commit }, { animeId, source }) {
            // 本地先更新 UI，再通知主进程持久化
            commit('MARK_AS_READ', { animeId, source });
            try {
                await window.electronAPI.updateReminderMarkRead(animeId, source);
            } catch (error) {
                console.error('[Reminder] 标记已读失败:', error);
            }
        },

        /**
         * 清空所有提醒
         */
        async clearReminders({ commit }) {
            commit('CLEAR_ALL');
            try {
                await window.electronAPI.updateReminderClear();
            } catch (error) {
                console.error('[Reminder] 清空提醒失败:', error);
            }
        },

        /**
         * 同步设置到主进程（启用/禁用、检查间隔）
         */
        async configure(_, options) {
            try {
                await window.electronAPI.updateReminderConfigure(options);
            } catch (error) {
                console.error('[Reminder] 配置失败:', error);
            }
        },

        /**
         * 绑定主进程推送的新提醒事件
         * 应在应用启动时（App.vue mounted）调用一次
         */
        bindListener({ commit }) {
            if (!window.electronAPI || !window.electronAPI.onUpdateReminder) return;
            // 重复绑定时先解绑
            if (_reminderUnbind) {
                try { _reminderUnbind(); } catch (_) { /* ignore */ }
            }
            _reminderUnbind = window.electronAPI.onUpdateReminder((newReminders) => {
                commit('PREPEND_REMINDERS', newReminders);
            });
        },

        /**
         * 解绑提醒监听（应用卸载时调用）
         */
        unbindListener() {
            if (_reminderUnbind) {
                try { _reminderUnbind(); } catch (_) { /* ignore */ }
                _reminderUnbind = null;
            }
            if (_openUnbind) {
                try { _openUnbind(); } catch (_) { /* ignore */ }
                _openUnbind = null;
            }
        },

        /**
         * 绑定系统通知点击后的跳转事件
         * @param {Function} handler - 收到 { animeId, source, name } 后的路由处理函数
         */
        bindOpenListener(handler) {
            if (typeof handler !== 'function') return;
            if (!window.electronAPI || !window.electronAPI.onUpdateReminderOpen) return;
            if (_openUnbind) {
                try { _openUnbind(); } catch (_) { /* ignore */ }
            }
            _openUnbind = window.electronAPI.onUpdateReminderOpen((info) => {
                try {
                    handler(info);
                } catch (e) {
                    console.error('[Reminder] 跳转处理失败:', e);
                }
            });
        }
    }
};
