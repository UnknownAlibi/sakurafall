<template>
  <header class="page-header">
    <h2 class="page-header-title">
      <span class="page-heading-icon" aria-hidden="true">
        <slot name="icon" />
      </span>
      <span class="page-heading-copy">
        <span>{{ title }}<i v-if="kawaiiMark" class="page-header-note" aria-hidden="true">♪</i></span>
        <small v-if="subtitle">{{ subtitle }}</small>
      </span>
    </h2>
    <div v-if="$slots.default" class="page-header-lead">
      <slot />
    </div>
    <div v-if="$slots.actions" class="page-header-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script>
/**
 * 统一页面头部：图标 + 标题/副标题 + 左侧补充 + 右侧操作区。
 * 所有二级页面（追番/下载/发现/片源管理）共用，保证排版节奏一致。
 * 装饰效果（icon blob、渐变下划线、hover 旋转、音符标记）由 kawaii.css 按动效档位统一提供。
 */
export default {
  name: 'PageHeader',
  props: {
    title: {
      type: String,
      required: true
    },
    subtitle: {
      type: String,
      default: ''
    },
    // 标题旁的音符装饰（仅完整演出档显示，其余档位 CSS 隐藏）
    kawaiiMark: {
      type: Boolean,
      default: true
    }
  }
};
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px 0 14px;
  border-bottom: 1px solid rgba(var(--primary-rgb), 0.12);
}

.page-header-title {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

/* 尺寸与 main.css 全局 .page-heading-icon 保持一致，装饰层由 kawaii.css 提供 */
.page-heading-icon {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  border: 1px solid var(--brand-ink);
}

.page-heading-icon :deep(svg) {
  width: 18px;
  height: 18px;
}

/* 标题旁音符装饰：默认隐藏，完整演出档由 kawaii.css 点亮 */
.page-header-note {
  display: none;
  font-style: normal;
  font-size: 14px;
  color: var(--primary-color);
}

.page-header-lead {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.page-header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
