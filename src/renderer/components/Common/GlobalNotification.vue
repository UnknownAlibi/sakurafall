<!-- filepath: c:\Users\44691\Desktop\webVideo\anime-downloader-electron\src\renderer\components\Common\GlobalNotification.vue -->
<template>
  <div class="notification-container" role="status" aria-live="polite">
    <transition-group name="notification" tag="div">
      <div
        v-for="notification in notifications"
        :key="notification.id"
        :class="['notification', `notification-${notification.type}`]"
        @click="removeNotification(notification.id)"
      >
        <div class="notification-icon" :class="`notification-icon-${notification.type}`">
          <!-- 语义 SVG 图标（替代平台差异明显的 emoji） -->
          <svg v-if="notification.type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
          <svg v-else-if="notification.type === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>
          <svg v-else-if="notification.type === 'warning'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        </div>
        <div class="notification-content">
          <div class="notification-title">{{ notification.title }}</div>
          <div v-if="notification.message" class="notification-message">
            {{ notification.message }}
          </div>
        </div>
        <button class="notification-close" aria-label="关闭通知" @click.stop="removeNotification(notification.id)">
          ✕
        </button>
      </div>
    </transition-group>
  </div>
</template>

<script>
import { mapGetters, mapActions } from 'vuex';

export default {
  name: 'GlobalNotification',
  computed: {
    ...mapGetters('notification', ['notifications'])
  },
  methods: {
    ...mapActions('notification', ['removeNotification', 'clearNotifications'])
  }
};
</script>

<style scoped>
.notification-container {
  position: fixed;
  top: 60px;
  right: 20px;
  z-index: 10000;
  pointer-events: none;
  /* 极端情况下也不会顶出视口 */
  max-height: calc(100vh - 100px);
  overflow-y: auto;
  scrollbar-width: none;
}

.notification-container::-webkit-scrollbar {
  display: none;
}

.notification {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--bg-card);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
  box-shadow: var(--shadow-lg);
  border-left: 4px solid var(--border-color);
  min-width: 320px;
  max-width: 400px;
  pointer-events: auto;
  cursor: pointer;
  transition: transform 0.3s var(--ease-smooth), box-shadow 0.3s var(--ease-smooth);
}

.notification:hover {
  transform: translateX(-5px);
  box-shadow: var(--shadow-lg);
}

.notification-success {
  border-left-color: var(--success-color);
}

.notification-error {
  border-left-color: var(--error-color);
}

.notification-warning {
  border-left-color: var(--warning-color);
}

.notification-info {
  border-left-color: var(--primary-color);
}

.notification-icon {
  flex-shrink: 0;
  margin-top: 2px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notification-icon svg {
  width: 20px;
  height: 20px;
}

.notification-icon-success { color: var(--success-color); }
.notification-icon-error { color: var(--error-color); }
.notification-icon-warning { color: var(--warning-color); }
.notification-icon-info { color: var(--primary-color); }

.notification-content {
  flex: 1;
  min-width: 0;
}

.notification-title {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
  margin-bottom: 4px;
}

.notification-message {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.4;
  word-wrap: break-word;
}

.notification-close {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: background-color 0.3s var(--ease-smooth), color 0.3s var(--ease-smooth);
  flex-shrink: 0;
}

.notification-close:hover {
  background: var(--primary-light);
  color: var(--text-primary);
}

.notification-close:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

/* 动画效果 */
.notification-enter-active,
.notification-leave-active {
  transition: opacity 0.3s var(--ease-smooth), transform 0.3s var(--ease-smooth);
}

.notification-enter-from {
  transform: translateX(100%);
  opacity: 0;
}

.notification-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

.notification-move {
  transition: transform 0.3s var(--ease-smooth);
}

@media (max-width: 768px) {
  .notification-container {
    top: 50px;
    right: 10px;
    left: 10px;
  }

  .notification {
    min-width: auto;
    max-width: none;
  }
}
</style>
