<template>
  <img
    v-if="hasSource"
    ref="imageEl"
    v-bind="$attrs"
    :src="displaySrc || placeholderSrc"
    @load="onLoad"
    @error="onError"
  />
</template>

<script>
import {
  clearImageCacheMemo,
  getCachedImageUrlSync,
  getRemoteImagePreviewUrl,
  isCacheableImageUrl,
  resolveCachedImageUrl
} from '../../utils/imageCache.js';

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

export default {
  name: 'CachedImage',
  inheritAttrs: false,
  props: {
    src: {
      type: String,
      default: ''
    },
    cacheVariant: {
      type: String,
      default: 'original'
    },
    cacheWidth: {
      type: Number,
      default: 360
    }
  },
  emits: ['load', 'error'],
  data() {
    return {
      displaySrc: '',
      placeholderSrc: TRANSPARENT_PIXEL,
      requestToken: 0,
      triedOriginal: false,
      triedCacheFallback: false,
      lazyObserver: null,
      cachedFallbackSrc: '',
      cacheResolvePending: false,
      pendingErrorEvent: null,
      originalLoaded: false,
      remoteDisplaySrc: '',
      cacheResolveTimer: null
    };
  },
  computed: {
    hasSource() {
      return !!String(this.src || '').trim();
    },
    shouldLazyLoad() {
      return String(this.$attrs.loading || '').toLowerCase() === 'lazy';
    },
    shouldResolveCacheAsync() {
      return this.$attrs['data-cache-resolve'] === true || this.$attrs['data-cache-resolve'] === 'true';
    },
    cacheOptions() {
      return this.cacheVariant === 'thumbnail'
        ? { variant: 'thumbnail', width: this.cacheWidth }
        : { variant: 'original' };
    },
    shouldPreferCachedVariant() {
      return this.cacheVariant === 'thumbnail';
    }
  },
  watch: {
    src: {
      handler() {
        this.queueImageLoad();
      }
    }
  },
  mounted() {
    this.queueImageLoad();
  },
  beforeUnmount() {
    this.stopLazyObserver();
    this.clearCacheResolveTimer();
    this.requestToken++;
    const image = this.$refs.imageEl;
    if (image) {
      // Abort pending network and decode work before Chromium detaches the card.
      image.removeAttribute('srcset');
      image.removeAttribute('src');
    }
  },
  methods: {
    queueImageLoad() {
      const source = String(this.src || '').trim();
      const token = ++this.requestToken;
      this.triedOriginal = false;
      this.triedCacheFallback = false;
      this.displaySrc = '';
      this.cachedFallbackSrc = '';
      this.cacheResolvePending = false;
      this.pendingErrorEvent = null;
      this.originalLoaded = false;
      this.remoteDisplaySrc = '';
      this.clearCacheResolveTimer();
      this.stopLazyObserver();
      if (!source) return;

      if (this.shouldLazyLoad && this.shouldResolveCacheAsync && typeof IntersectionObserver !== 'undefined') {
        this.$nextTick(() => {
          if (token !== this.requestToken) return;
          const element = this.$refs.imageEl;
          if (!element) {
            this.loadImage(source, token);
            return;
          }
          this.lazyObserver = new IntersectionObserver((entries) => {
            if (!entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) return;
            this.stopLazyObserver();
            this.loadImage(source, token);
          }, { rootMargin: '160px 0px' });
          this.lazyObserver.observe(element);
        });
        return;
      }

      this.loadImage(source, token);
    },

    async loadImage(source, token) {
      const canUseCache = isCacheableImageUrl(source) && !!window.electronAPI?.imageCacheGetCover;

      // 1. 同步查内存 memo，命中立即显示本地 file:// URL（零延迟）
      if (canUseCache) {
        const memoized = getCachedImageUrlSync(source, this.cacheOptions);
        if (memoized && memoized !== source) {
          this.displaySrc = memoized;
          return;
        }
      }

      // List thumbnails must avoid decoding the full remote cover first.
      if (canUseCache && this.shouldResolveCacheAsync && this.shouldPreferCachedVariant) {
        this.remoteDisplaySrc = getRemoteImagePreviewUrl(source, this.cacheOptions) || source;
        this.displaySrc = this.remoteDisplaySrc;
        // Chromium already caches successful remote previews. Only persist the
        // first viewport after the user stays on the page; queueing every lazy
        // card keeps IPC downloads and old Vue instances alive across routes.
        if (!this.shouldLazyLoad) this.scheduleCacheResolve(source, token, 12000);
        return;
      }

      // 2. 未命中 memo：立即用原图 URL 显示（不阻塞），后台并行查询缓存
      this.displaySrc = source;

      if (!canUseCache || !this.shouldResolveCacheAsync) return;

      // 3. 后台查询缓存（未命中会触发主进程下载并存储）
      //    期间原图可能加载失败，onError 会暂存 error 事件等这里处理
      this.cacheResolvePending = true;
      const cachedUrl = await resolveCachedImageUrl(source, this.cacheOptions);
      if (token !== this.requestToken) return;
      this.cacheResolvePending = false;
      this.cachedFallbackSrc = cachedUrl || source;

      // 缓存命中本地 file:// URL：若原图尚未加载成功，替换为更快的本地文件
      if (cachedUrl && cachedUrl !== source && /^(?:file:|sakurafall-cache:)/i.test(cachedUrl) && !this.originalLoaded) {
        this.triedCacheFallback = true;
        this.pendingErrorEvent = null;
        this.displaySrc = cachedUrl;
        return;
      }

      // 缓存未命中（或原图已加载成功）：若有暂存的 error，现在 emit
      if (this.pendingErrorEvent) {
        const evt = this.pendingErrorEvent;
        this.pendingErrorEvent = null;
        this.$emit('error', evt);
      }
    },

    scheduleCacheResolve(source, token, delay = 0) {
      this.clearCacheResolveTimer();
      this.cacheResolveTimer = setTimeout(() => {
        this.cacheResolveTimer = null;
        this.resolveCacheFallback(source, token).catch(() => {});
      }, Math.max(0, delay));
    },

    clearCacheResolveTimer() {
      if (!this.cacheResolveTimer) return;
      clearTimeout(this.cacheResolveTimer);
      this.cacheResolveTimer = null;
    },

    async resolveCacheFallback(source, token, errorEvent = null) {
      if (this.cacheResolvePending) {
        if (errorEvent) this.pendingErrorEvent = errorEvent;
        return;
      }
      this.cacheResolvePending = true;
      if (errorEvent) this.pendingErrorEvent = errorEvent;
      const cachedUrl = await resolveCachedImageUrl(source, this.cacheOptions);
      if (token !== this.requestToken) return;
      this.cacheResolvePending = false;
      this.cachedFallbackSrc = cachedUrl || source;

      if (cachedUrl && cachedUrl !== source && /^(?:file:|sakurafall-cache:)/i.test(cachedUrl)) {
        if (!this.originalLoaded || this.pendingErrorEvent) {
          this.triedCacheFallback = true;
          this.pendingErrorEvent = null;
          this.displaySrc = cachedUrl;
        }
        return;
      }

      if (this.pendingErrorEvent) {
        const evt = this.pendingErrorEvent;
        this.pendingErrorEvent = null;
        if (this.displaySrc !== source && !this.triedOriginal) {
          this.triedOriginal = true;
          this.displaySrc = source;
          return;
        }
        this.$emit('error', evt);
      }
    },

    stopLazyObserver() {
      if (!this.lazyObserver) return;
      this.lazyObserver.disconnect();
      this.lazyObserver = null;
    },

    onLoad(event) {
      if (!this.displaySrc) return;
      this.originalLoaded = true;
      this.pendingErrorEvent = null;
      if (this.shouldPreferCachedVariant && this.displaySrc === this.remoteDisplaySrc && !this.shouldLazyLoad) {
        this.scheduleCacheResolve(String(this.src || '').trim(), this.requestToken, 12000);
      }
      this.$emit('load', event);
    },

    onError(event) {
      const source = String(this.src || '').trim();
      if (!this.displaySrc) return;

      // 缓存查询进行中：暂存 error，等缓存结果再决定（避免永久隐藏）
      if (this.cacheResolvePending) {
        this.pendingErrorEvent = event;
        return;
      }

      if (this.shouldPreferCachedVariant && this.displaySrc === this.remoteDisplaySrc) {
        this.clearCacheResolveTimer();
        if (this.remoteDisplaySrc !== source && !this.triedOriginal) {
          this.triedOriginal = true;
          this.displaySrc = source;
          this.resolveCacheFallback(source, this.requestToken).catch(() => {});
        } else {
          this.resolveCacheFallback(source, this.requestToken, event).catch(() => {
            this.$emit('error', event);
          });
        }
        return;
      }

      // 当前显示原图失败 → 尝试缓存 URL（file://，可能已就绪）
      if (this.displaySrc === source && this.cachedFallbackSrc && this.cachedFallbackSrc !== source && !this.triedCacheFallback) {
        this.triedCacheFallback = true;
        this.displaySrc = this.cachedFallbackSrc;
        return;
      }
      // 当前显示缓存 URL 失败 → 清除 memo 并尝试原图
      if (this.displaySrc && source && this.displaySrc !== source && !this.triedOriginal) {
        clearImageCacheMemo(source, this.cacheOptions);
        this.triedOriginal = true;
        this.displaySrc = source;
        return;
      }
      this.$emit('error', event);
    }
  }
};
</script>
