<template>
  <div class="empty-state" :class="{ 'empty-state--compact': compact }">
    <div class="empty-illustration">
      <div class="sakurane-empty-art" aria-hidden="true"></div>
    </div>
    <h3 v-if="title" class="empty-title">{{ title }}</h3>
    <p v-if="message" class="empty-message">{{ message }}</p>
    <div v-if="$slots.action" class="empty-action">
      <slot name="action" />
    </div>
  </div>
</template>

<script>
export default {
  name: 'EmptyState',
  props: {
    title: {
      type: String,
      default: '这里空空的呢 (´･ω･`)'
    },
    message: {
      type: String,
      default: ''
    },
    compact: {
      type: Boolean,
      default: false
    }
  }
};
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-state--compact {
  padding: 24px 16px;
}

.empty-illustration {
  margin-bottom: 16px;
  opacity: 0.7;
}

.sakurane-empty-art {
  width: 148px;
  height: 170px;
  margin: 0 auto;
  background: var(--sakurafall-empty-state-image) center / contain no-repeat;
  filter: drop-shadow(0 12px 18px rgba(29, 37, 84, 0.12));
}

.empty-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #333);
}

.empty-message {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary, #999);
  line-height: 1.5;
  max-width: 280px;
}

.empty-action {
  margin-top: 16px;
}
</style>
