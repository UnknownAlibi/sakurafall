<template>
  <div
    ref="cursor"
    class="anime-cursor"
    :class="{
      'is-visible': visible && enabled,
      'is-pointer': state === 'pointer',
      'is-text': state === 'text',
      'is-disabled': state === 'disabled',
      'is-pressed': pressed
    }"
    aria-hidden="true"
  >
    <span class="anime-cursor-core"></span>
    <span class="anime-cursor-trail trail-one"></span>
    <span class="anime-cursor-trail trail-two"></span>
  </div>
</template>

<script>
const TEXT_SELECTOR = [
  'textarea',
  '[contenteditable="true"]',
  'input:not([type])',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="password"]',
  'input[type="email"]',
  'input[type="number"]',
  'input[type="url"]'
].join(',');

const DISABLED_SELECTOR = [
  ':disabled',
  '[disabled]',
  '[aria-disabled="true"]'
].join(',');

const INTERACTIVE_CLASS_PARTS = ['btn', 'card', 'tab', 'option', 'episode'];
const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'SUMMARY', 'SELECT', 'LABEL']);
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'password', 'email', 'number', 'url']);
const POINTER_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range']);
const HEAVY_SURFACE_SELECTOR = [
  '.schedule-grid',
  '.anime-grid',
  '.hot-list',
  '.continue-list',
  '.episodes-list',
  '.official-eps-list'
].join(',');

export default {
  name: 'AnimeCursor',
  data() {
    return {
      enabled: false,
      visible: false,
      pressed: false,
      state: 'default',
      surfaceSuspended: false
    };
  },
  mounted() {
    this.x = -80;
    this.y = -80;
    this.targetX = -80;
    this.targetY = -80;
    this.rafId = null;
    this.lastTarget = null;
    this.mediaQuery = window.matchMedia?.('(pointer: coarse)');
    this.reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.cursorEl = this.$refs.cursor;

    this.syncMode();
    this.modeObserver = new MutationObserver(this.syncMode);
    this.modeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-effects', 'data-scroll-state', 'data-performance-pressure', 'data-software-rendering']
    });

    document.addEventListener('mousemove', this.handleMove, { passive: true });
    document.addEventListener('mousedown', this.handleDown, true);
    document.addEventListener('mouseup', this.handleUp, true);
    document.addEventListener('mouseleave', this.handleLeave);
    document.addEventListener('mouseenter', this.handleEnter);

    this.mediaQuery?.addEventListener?.('change', this.syncMode);
    this.reducedMotionQuery?.addEventListener?.('change', this.syncMode);
  },
  beforeUnmount() {
    document.documentElement.classList.remove('anime-cursor-ready');
    this.modeObserver?.disconnect();
    if (this.rafId) cancelAnimationFrame(this.rafId);

    document.removeEventListener('mousemove', this.handleMove);
    document.removeEventListener('mousedown', this.handleDown, true);
    document.removeEventListener('mouseup', this.handleUp, true);
    document.removeEventListener('mouseleave', this.handleLeave);
    document.removeEventListener('mouseenter', this.handleEnter);

    this.mediaQuery?.removeEventListener?.('change', this.syncMode);
    this.reducedMotionQuery?.removeEventListener?.('change', this.syncMode);
  },
  methods: {
    syncMode() {
      const effectsMode = document.documentElement.getAttribute('data-ui-effects') || 'anime';
      const coarsePointer = this.mediaQuery?.matches === true;
      const reducedMotion = this.reducedMotionQuery?.matches === true;
      const scrolling = document.documentElement.getAttribute('data-scroll-state') === 'scrolling';
      const pressure = document.documentElement.getAttribute('data-performance-pressure') === 'high';
      // 软件渲染下逐帧移动 DOM 光标开销过大，直接禁用回退原生指针
      const softwareRendering = document.documentElement.getAttribute('data-software-rendering') === 'true';
      this.enabled = effectsMode === 'anime' && !coarsePointer && !reducedMotion && !scrolling && !pressure && !softwareRendering && !this.surfaceSuspended;
      document.documentElement.classList.toggle('anime-cursor-ready', this.enabled);

      if (!this.enabled) {
        this.visible = false;
        this.lastTarget = null;
        if (this.rafId) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
      } else if (this.visible) {
        this.startAnimation();
      }
    },

    handleMove(event) {
      if (event.target !== this.lastTarget) {
        this.lastTarget = event.target;
        this.updateSurfaceSuspension(event.target);
        if (this.enabled) this.updateState(event.target);
      }
      if (!this.enabled) return;

      this.targetX = event.clientX;
      this.targetY = event.clientY;
      this.x = this.targetX;
      this.y = this.targetY;
      this.visible = true;
      if (this.cursorEl) {
        this.cursorEl.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
      }
    },

    handleDown() {
      if (this.enabled) this.pressed = true;
    },

    handleUp() {
      this.pressed = false;
    },

    handleLeave() {
      this.visible = false;
    },

    handleEnter() {
      if (this.enabled) this.visible = true;
    },

    updateState(target) {
      const nextState = this.resolveTargetState(target);
      if (nextState !== this.state) {
        this.state = nextState;
      }
    },

    updateSurfaceSuspension(target) {
      const suspended = target instanceof Element && !!target.closest(HEAVY_SURFACE_SELECTOR);
      if (suspended === this.surfaceSuspended) return;
      this.surfaceSuspended = suspended;
      this.syncMode();
    },

    resolveTargetState(target) {
      if (!(target instanceof Element)) return 'default';

      let node = target;
      let depth = 0;
      while (node && node instanceof Element && depth < 8) {
        if (this.isDisabledElement(node)) return 'disabled';
        if (this.isTextElement(node)) return 'text';
        if (this.isInteractiveElement(node)) return 'pointer';
        node = node.parentElement;
        depth += 1;
      }

      return 'default';
    },

    isDisabledElement(element) {
      return element.matches?.(DISABLED_SELECTOR);
    },

    isTextElement(element) {
      if (element.matches?.(TEXT_SELECTOR)) return true;
      if (element.tagName !== 'INPUT') return false;
      return TEXT_INPUT_TYPES.has(String(element.getAttribute('type') || '').toLowerCase());
    },

    isInteractiveElement(element) {
      if (INTERACTIVE_TAGS.has(element.tagName)) return true;
      if (element.getAttribute('role') === 'button') return true;
      if (element.tagName === 'INPUT') {
        return POINTER_INPUT_TYPES.has(String(element.getAttribute('type') || '').toLowerCase());
      }
      const className = typeof element.className === 'string'
        ? element.className
        : (element.className?.baseVal || '');
      return INTERACTIVE_CLASS_PARTS.some(part => className.includes(part)) ||
        element.classList?.contains('video-player-container') ||
        element.classList?.contains('video-element');
    },

    startAnimation() {
      if (this.rafId || !this.enabled) return;

      const tick = () => {
        if (!this.enabled || !this.visible) {
          this.rafId = null;
          return;
        }

        const deltaX = this.targetX - this.x;
        const deltaY = this.targetY - this.y;

        if (Math.abs(deltaX) < 0.1 && Math.abs(deltaY) < 0.1) {
          this.x = this.targetX;
          this.y = this.targetY;
        } else {
          this.x += deltaX * 0.42;
          this.y += deltaY * 0.42;
        }

        if (this.cursorEl) {
          this.cursorEl.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
        }

        if (this.x === this.targetX && this.y === this.targetY) {
          this.rafId = null;
          return;
        }

        this.rafId = requestAnimationFrame(tick);
      };

      this.rafId = requestAnimationFrame(tick);
    }
  }
};
</script>

<style scoped>
.anime-cursor {
  position: fixed;
  top: 0;
  left: 0;
  width: 40px;
  height: 40px;
  pointer-events: none;
  z-index: 2147483647;
  opacity: 0;
  transform: translate3d(-80px, -80px, 0);
  transition: opacity 0.12s ease;
  will-change: transform;
}

.anime-cursor.is-visible {
  opacity: 1;
}

.anime-cursor-core {
  position: absolute;
  z-index: 2;
  top: 0;
  left: 0;
  width: 40px;
  height: 40px;
  background: var(--sakura-cursor-default-image) left top / contain no-repeat;
  transform-origin: 0 0;
  animation: cursor-idle 0.9s ease-in-out infinite;
}

.anime-cursor.is-pointer .anime-cursor-core {
  top: 0;
  left: 0;
  width: 40px;
  height: 40px;
  background-image: var(--sakura-cursor-pointer-image);
  animation: cursor-wave 0.62s ease-in-out infinite;
}

.anime-cursor.is-text .anime-cursor-core {
  top: -10px;
  left: -1px;
  width: 2px;
  height: 24px;
  border-radius: 2px;
  background: linear-gradient(180deg, #ff8ab0, #7ef3e8);
  animation: cursor-text-blink 0.72s steps(2, end) infinite;
}

.anime-cursor.is-disabled .anime-cursor-core {
  /* 用 opacity 代替 filter:grayscale，避免合成层在动画期间持续重绘 */
  opacity: 0.5;
  animation: cursor-disabled 0.9s ease-in-out infinite;
}

.anime-cursor.is-pressed .anime-cursor-core {
  animation: none;
  filter: brightness(0.94);
  transform: translate3d(0, 1px, 0);
}

.anime-cursor-trail {
  position: absolute;
  z-index: 1;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 138, 176, 0.42);
  opacity: 0;
  transform: scale(0.2);
}

.trail-one {
  top: 27px;
  left: 6px;
  animation: cursor-trail 0.5s ease-out infinite;
}

.trail-two {
  top: 33px;
  left: 2px;
  width: 4px;
  height: 4px;
  background: rgba(126, 243, 232, 0.36);
  animation: cursor-trail 0.5s ease-out 0.1s infinite;
}

.anime-cursor.is-text .anime-cursor-trail,
.anime-cursor.is-disabled .anime-cursor-trail {
  display: none;
}

@keyframes cursor-idle {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(0, -1px, 0); }
}

@keyframes cursor-wave {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(0, -1px, 0); }
}

@keyframes cursor-disabled {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(2px); }
}

@keyframes cursor-text-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.38; }
}

@keyframes cursor-trail {
  0% {
    opacity: 0;
    transform: translate3d(0, 0, 0) scale(0.25);
  }
  20% {
    opacity: 0.55;
    transform: translate3d(-2px, 2px, 0) scale(0.9);
  }
  100% {
    opacity: 0;
    transform: translate3d(-7px, 7px, 0) scale(0.2);
  }
}
</style>
