<template>
  <div v-if="totalPages > 1" class="pagination">
    <!-- 首页 -->
    <button
      v-if="showFirstLast"
      @click="$emit('change', 1)"
      :disabled="currentPage <= 1"
      class="page-btn page-btn--edge"
      title="首页"
    >
      «
    </button>
    <!-- 上一页 -->
    <button
      @click="$emit('change', currentPage - 1)"
      :disabled="currentPage <= 1"
      class="page-btn"
      title="上一页"
    >
      ‹
    </button>

    <div class="page-numbers">
      <template v-for="(item, idx) in pageItems" :key="idx">
        <!-- 省略号 -->
        <span v-if="item === '...'" class="page-ellipsis">…</span>
        <!-- 页码 -->
        <button
          v-else
          @click="$emit('change', item)"
          :class="['page-number', { active: item === currentPage }]"
        >
          {{ item }}
        </button>
      </template>
    </div>

    <!-- 下一页 -->
    <button
      @click="$emit('change', currentPage + 1)"
      :disabled="currentPage >= totalPages"
      class="page-btn"
      title="下一页"
    >
      ›
    </button>
    <!-- 末页 -->
    <button
      v-if="showFirstLast"
      @click="$emit('change', totalPages)"
      :disabled="currentPage >= totalPages"
      class="page-btn page-btn--edge"
      title="末页"
    >
      »
    </button>

    <!-- 跳页输入框（页数较多时才显示） -->
    <div v-if="showJumper" class="page-jumper">
      <span>跳至</span>
      <input
        type="number"
        v-model.number="jumpValue"
        min="1"
        :max="totalPages"
        class="jumper-input"
        @keyup.enter="handleJump"
        @blur="handleJump"
      />
      <span>页</span>
    </div>
  </div>
</template>

<script>
export default {
  name: 'Pagination',
  props: {
    currentPage: {
      type: Number,
      required: true
    },
    totalPages: {
      type: Number,
      required: true
    }
  },
  emits: ['change'],
  data() {
    return {
      jumpValue: ''
    };
  },
  computed: {
    // 总页数超过阈值时才显示首页/末页按钮和跳页输入框
    showFirstLast() {
      return this.totalPages > 7;
    },
    showJumper() {
      return this.totalPages > 10;
    },
    /**
     * 生成带省略号的页码序列
     * 例：totalPages=20, currentPage=10 → [1, '...', 8, 9, 10, 11, 12, '...', 20]
     */
    pageItems() {
      const total = this.totalPages;
      const cur = this.currentPage;
      const items = [];

      // 页数少时全部显示，不需要省略号
      if (total <= 7) {
        for (let i = 1; i <= total; i++) items.push(i);
        return items;
      }

      // 当前页附近显示 5 个：cur-2 .. cur+2
      const left = Math.max(2, cur - 2);
      const right = Math.min(total - 1, cur + 2);

      items.push(1);

      // 左侧省略号：第 1 页和 left 之间有间隔
      if (left > 2) items.push('...');

      for (let i = left; i <= right; i++) items.push(i);

      // 右侧省略号：right 和末页之间有间隔
      if (right < total - 1) items.push('...');

      items.push(total);
      return items;
    }
  },
  watch: {
    currentPage() {
      // 页码变化时清空跳页输入框，避免显示旧值
      this.jumpValue = '';
    }
  },
  methods: {
    handleJump() {
      const v = parseInt(this.jumpValue, 10);
      if (isNaN(v)) return;
      const target = Math.max(1, Math.min(this.totalPages, v));
      if (target !== this.currentPage) {
        this.$emit('change', target);
      }
      this.jumpValue = '';
    }
  }
};
</script>

<style scoped>
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  margin-top: 32px;
  padding-bottom: 20px;
  flex-wrap: wrap;
}

.page-btn {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth);
  padding: 0;
}

.page-btn:hover:not(:disabled) {
  background: var(--primary-color);
  color: var(--text-inverse);
  border-color: var(--primary-color);
}

.page-btn:active:not(:disabled) {
  transform: scale(0.94);
  transition-duration: 0.1s;
}

.page-btn:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-numbers {
  display: flex;
  gap: 4px;
  align-items: center;
}

.page-number {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth), border-color 0.2s var(--ease-smooth);
  padding: 0;
}

.page-number:hover {
  background: var(--primary-light);
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.page-number:active {
  transform: scale(0.94);
  transition-duration: 0.1s;
}

.page-number:focus-visible {
  outline: 2px solid var(--primary-color);
  outline-offset: 2px;
}

.page-number.active {
  background: var(--primary-color);
  color: var(--text-inverse);
  border-color: var(--primary-color);
}

.page-ellipsis {
  width: 28px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 14px;
  user-select: none;
}

/* 跳页输入框 */
.page-jumper {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 12px;
  color: var(--text-secondary);
  font-size: 13px;
}

.jumper-input {
  width: 52px;
  height: 32px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 6px;
  text-align: center;
  font-size: 13px;
  padding: 0;
  /* 隐藏 number input 的上下箭头 */
  -moz-appearance: textfield;
}

.jumper-input::-webkit-outer-spin-button,
.jumper-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.jumper-input:focus {
  outline: none;
  border-color: var(--primary-color);
}

@media (max-width: 768px) {
  .pagination {
    gap: 4px;
    margin-top: 20px;
    padding-bottom: 16px;
  }

  .page-btn,
  .page-number {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }

  .page-jumper {
    margin-left: 8px;
  }

  .jumper-input {
    width: 44px;
    height: 28px;
  }
}
</style>
