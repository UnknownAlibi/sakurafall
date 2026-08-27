/**
 * 全局确认弹窗服务
 * 用 Promise 化的 $confirm 取代原生 window.confirm（原生弹窗不跟随主题、阻塞渲染、按钮不可定制）。
 * ConfirmDialog.vue 消费这里的响应式状态；main.js 把 openConfirm 挂到 $confirm。
 */
import { reactive } from 'vue';

const state = reactive({
  visible: false,
  title: '确认操作',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
  resolver: null
});

/**
 * 打开确认弹窗
 * @param {{ title?: string, message?: string, confirmText?: string, cancelText?: string, danger?: boolean }} options
 * @returns {Promise<boolean>} 点击确认 resolve(true)，取消/ESC/遮罩点击 resolve(false)
 */
export function openConfirm(options = {}) {
  // 已有弹窗未关闭时，先取消旧的，避免 Promise 悬挂
  if (state.visible && typeof state.resolver === 'function') {
    state.resolver(false);
  }
  return new Promise((resolve) => {
    state.title = options.title || '确认操作';
    state.message = options.message || '';
    state.confirmText = options.confirmText || '确定';
    state.cancelText = options.cancelText || '取消';
    state.danger = !!options.danger;
    state.resolver = resolve;
    state.visible = true;
  });
}

/** 供 ConfirmDialog 按钮回调：结束当前会话 */
export function settleConfirm(result) {
  if (!state.visible) return;
  state.visible = false;
  const resolver = state.resolver;
  state.resolver = null;
  if (typeof resolver === 'function') resolver(result);
}

export default state;
