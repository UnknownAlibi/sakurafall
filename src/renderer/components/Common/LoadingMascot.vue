<template>
  <div class="loading-mascot" :class="{ 'loading-mascot--small': size === 'small' }">
    <div class="sakurane-loading-art" aria-hidden="true">
      <span class="loading-petal p1"></span>
      <span class="loading-petal p2"></span>
      <span class="loading-petal p3"></span>
    </div>
    <div v-if="text" class="loading-text">{{ text }}</div>
  </div>
</template>

<script>
export default {
  name: 'LoadingMascot',
  props: {
    text: {
      type: String,
      default: '加载中...'
    },
    size: {
      type: String,
      default: 'normal',
      validator: v => ['normal', 'small'].includes(v)
    }
  }
};
</script>

<style scoped>
.loading-mascot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
}

.sakurane-loading-art {
  position: relative;
  width: 77px;
  height: 108px;
  background: var(--sakura-mascot-image) center / contain no-repeat;
  filter: drop-shadow(0 10px 16px rgba(29, 37, 84, 0.12));
  animation: mascot-breathe 3.2s ease-in-out infinite;
}

.loading-mascot--small .sakurane-loading-art {
  width: 47px;
  height: 66px;
}

/* 花瓣基础样式与漂移关键帧由 main.css 全局提供（.loading-petal / petal-drift） */
.sakurane-loading-art .loading-petal {
  top: -8px;
}

@keyframes mascot-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}

.loading-text {
  font-size: 13px;
  color: var(--text-secondary, #888);
  letter-spacing: 0;
}

.loading-mascot--small .loading-text {
  font-size: 11px;
}

/* 小尺寸下花瓣太多显挤，隐藏第三片 */
.loading-mascot--small .loading-petal.p3 {
  display: none;
}
</style>
