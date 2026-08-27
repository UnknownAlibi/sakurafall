<template>
  <span class="brand-mark" :style="markStyle" aria-hidden="true">
    <span class="brand-mark-art"></span>
  </span>
</template>

<script>
export default {
  name: 'BrandMark',
  props: {
    size: {
      type: Number,
      default: 34
    }
  },
  computed: {
    markStyle() {
      return {
        '--brand-mark-size': `${this.size}px`
      };
    }
  }
};
</script>

<style scoped>
.brand-mark {
  width: var(--brand-mark-size);
  height: var(--brand-mark-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--brand-mark-size);
}

.brand-mark-art {
  width: 100%;
  height: 100%;
  display: block;
  background: var(--sakurafall-mark-image) center / contain no-repeat;
}
</style>
