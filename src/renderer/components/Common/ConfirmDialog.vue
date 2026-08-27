<template>
  <Transition name="cf-fade">
    <div v-if="state.visible" class="cf-overlay" @click.self="onCancel">
      <div class="cf-dialog" role="alertdialog" aria-modal="true" :aria-label="state.title">
        <h3 class="cf-title">{{ state.title }}</h3>
        <p class="cf-message">{{ state.message }}</p>
        <div class="cf-actions">
          <button class="cf-btn cf-btn-cancel" @click="onCancel">{{ state.cancelText }}</button>
          <button
            ref="confirmBtn"
            class="cf-btn cf-btn-confirm"
            :class="{ 'cf-btn-danger': state.danger }"
            @click="onConfirm"
          >{{ state.confirmText }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script>
import state, { settleConfirm } from '../../services/confirmService.js';

export default {
  name: 'ConfirmDialog',
  data() {
    return { state };
  },
  watch: {
    'state.visible'(visible) {
      if (visible) {
        this.$nextTick(() => this.$refs.confirmBtn?.focus());
      }
    }
  },
  mounted() {
    this._onKey = (event) => {
      if (!state.visible) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        settleConfirm(false);
      } else if (event.key === 'Enter') {
        event.stopPropagation();
        settleConfirm(true);
      }
    };
    document.addEventListener('keydown', this._onKey, true);
  },
  beforeUnmount() {
    if (this._onKey) {
      document.removeEventListener('keydown', this._onKey, true);
      this._onKey = null;
    }
  },
  methods: {
    onConfirm() {
      settleConfirm(true);
    },
    onCancel() {
      settleConfirm(false);
    }
  }
};
</script>

<style scoped>
.cf-overlay {
  position: fixed;
  inset: 0;
  z-index: 12000;
  background: var(--bg-overlay, rgba(0, 0, 0, 0.45));
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cf-dialog {
  width: min(400px, calc(100vw - 48px));
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 22px 24px 18px;
  box-shadow: var(--shadow-lg);
}

.cf-title {
  margin: 0 0 10px;
  font-size: 16px;
  color: var(--text-primary);
}

.cf-message {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}

.cf-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cf-btn {
  padding: 7px 20px;
  border-radius: 999px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-primary);
  transition: transform 0.15s var(--ease-smooth), opacity 0.15s var(--ease-smooth), background-color 0.15s var(--ease-smooth), border-color 0.15s var(--ease-smooth);
}

.cf-btn:active {
  transform: scale(0.96);
  transition-duration: 0.1s;
}

.cf-btn:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

.cf-btn-confirm {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: var(--text-inverse);
}

.cf-btn-confirm:hover {
  opacity: 0.9;
}

.cf-btn-danger {
  background: var(--error-color);
  border-color: var(--error-color);
}

.cf-btn-cancel:hover {
  border-color: var(--text-tertiary);
}

/* 进出场动画 */
.cf-fade-enter-active,
.cf-fade-leave-active {
  transition: opacity 0.18s var(--ease-smooth);
}

.cf-fade-enter-active .cf-dialog,
.cf-fade-leave-active .cf-dialog {
  transition: transform 0.18s var(--ease-smooth);
}

.cf-fade-enter-from,
.cf-fade-leave-to {
  opacity: 0;
}

.cf-fade-enter-from .cf-dialog {
  transform: scale(0.94);
}
</style>
