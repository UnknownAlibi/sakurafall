/** 通知同时展示的上限，超出时移除最旧的，避免刷屏遮住界面 */
const MAX_NOTIFICATIONS = 5;
/** 同一条通知（type+title+message 相同）在该时间窗内重复触发时去重 */
const DEDUP_WINDOW_MS = 1500;

export default {
    namespaced: true,
    state: {
        notifications: []
    },
    getters: {
        notifications: state => state.notifications
    },
    mutations: {
    ADD_NOTIFICATION(state, notification) {
        state.notifications.push({
            id: Date.now() + Math.random(),
            type: 'info',
            title: '通知',
            message: '',
            duration: 4000,
            timestamp: Date.now(),
            ...notification
        });
        // 堆叠上限：超出时移除最旧的
        if (state.notifications.length > MAX_NOTIFICATIONS) {
            state.notifications.splice(0, state.notifications.length - MAX_NOTIFICATIONS);
        }
    },

    REMOVE_NOTIFICATION(state, id) {
        state.notifications = state.notifications.filter(n => n.id !== id);
    },

    CLEAR_NOTIFICATIONS(state) {
        state.notifications = [];
    }
},
    actions: {
        showNotification({ commit, state }, notification) {
            const now = Date.now();
            // 去重：短时间内完全相同的通知不再重复弹出（网络错误连发等场景）
            const dedupKey = `${notification.type}|${notification.title}|${notification.message}`;
            const duplicated = state.notifications.some(n =>
                n.dedupKey === dedupKey && (now - Number(n.timestamp || 0)) < DEDUP_WINDOW_MS
            );
            if (duplicated) return null;

            const id = Date.now() + Math.random();
            const duration = notification.duration !== undefined ? notification.duration : 4000;
            const newNotification = {
                id,
                duration,
                dedupKey,
                ...notification
            };
            // 保证 dedupKey 不被 notification 同名字段覆盖
            newNotification.dedupKey = dedupKey;

            commit('ADD_NOTIFICATION', newNotification);

            // 自动移除通知（duration <= 0 表示常驻，不自动关闭）
            if (duration > 0) {
                setTimeout(() => {
                    commit('REMOVE_NOTIFICATION', id);
                }, duration);
            }

            return id;
        },

        removeNotification({ commit }, id) {
            commit('REMOVE_NOTIFICATION', id);
        },

        clearNotifications({ commit }) {
            commit('CLEAR_NOTIFICATIONS');
        }
    }
};
