const resolvedImageUrls = new Map();
const pendingImageUrls = new Map();
const MAX_RESOLVED_IMAGE_URLS = 2000;
const MAX_ACTIVE_IMAGE_CACHE_REQUESTS = 4;
const imageCacheQueue = [];
let activeImageCacheRequests = 0;
let preloadedFlag = false;

function normalizeCacheOptions(options = {}) {
  return options?.variant === 'thumbnail'
    ? { variant: 'thumbnail', width: Math.min(720, Math.max(160, parseInt(options.width, 10) || 360)) }
    : { variant: 'original' };
}

function imageCacheKey(url, options = {}) {
  const normalized = normalizeCacheOptions(options);
  return normalized.variant === 'thumbnail'
    ? `${url}::thumbnail:${normalized.width}`
    : url;
}

function rememberResolvedImageUrl(key, resolvedUrl) {
  if (!resolvedImageUrls.has(key) && resolvedImageUrls.size >= MAX_RESOLVED_IMAGE_URLS) {
    const firstKey = resolvedImageUrls.keys().next().value;
    if (firstKey) resolvedImageUrls.delete(firstKey);
  }
  resolvedImageUrls.set(key, resolvedUrl);
}

export function isCacheableImageUrl(url) {
  const value = String(url || '').trim();
  return /^https?:\/\//i.test(value) || value.startsWith('//');
}

export function getDirectImageFallbackUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (!/\/cover\/?$/i.test(parsed.pathname)) return '';
    const target = new URL(parsed.searchParams.get('url') || '');
    return target.protocol === 'http:' || target.protocol === 'https:' ? target.toString() : '';
  } catch {
    return '';
  }
}

export function getRemoteImagePreviewUrl(url, options = {}) {
  const originalUrl = String(url || '').trim();
  if (!isCacheableImageUrl(originalUrl) || options?.variant !== 'thumbnail') return originalUrl;

  try {
    const parsed = new URL(originalUrl.startsWith('//') ? `https:${originalUrl}` : originalUrl);
    // The shared cover service wraps the real Bangumi image in ?url=. Resize
    // that embedded URL as well; otherwise list cards download the full cover
    // even though they only render at roughly 360px wide.
    if (/\/cover\/?$/i.test(parsed.pathname)) {
      const embedded = parsed.searchParams.get('url');
      if (embedded) {
        const resizedEmbedded = getRemoteImagePreviewUrl(embedded, options);
        if (resizedEmbedded && resizedEmbedded !== embedded) {
          parsed.searchParams.set('url', resizedEmbedded);
          return parsed.toString();
        }
      }
    }
    const host = parsed.hostname.toLowerCase();
    const width = Math.min(720, Math.max(160, parseInt(options.width, 10) || 360));
    const resizeWidth = width <= 160 ? 200 : (width <= 360 ? 400 : (width <= 600 ? 600 : 800));
    const supportsBangumiResize = host === 'lain.bgm.tv' ||
      host.endsWith('.lain.bgm.tv') ||
      host === 'lain.bangumi.lol' ||
      host === 'bgmimg.anibt.net';

    if (supportsBangumiResize && parsed.pathname.includes('/pic/')) {
      parsed.protocol = 'https:';
      const originalPath = parsed.pathname
        .replace(/^\/r\/\d+\//, '/')
        .replace(/\/pic\/cover\/[gscm]\//i, '/pic/cover/l/');
      parsed.pathname = `/r/${resizeWidth}${originalPath}`;
      return parsed.toString();
    }

    if (host === 'wsrv.nl' || host === 'images.weserv.nl') {
      if (!parsed.searchParams.has('w')) parsed.searchParams.set('w', String(resizeWidth));
      if (!parsed.searchParams.has('q')) parsed.searchParams.set('q', '82');
      if (!parsed.searchParams.has('output')) parsed.searchParams.set('output', 'webp');
      return parsed.toString();
    }
  } catch {
    return originalUrl;
  }

  return originalUrl;
}

/**
 * 同步查询内存缓存的封面 URL（不排队、不发 IPC）
 * 命中返回 file:// URL 或原图 URL，未命中返回 null
 */
export function getCachedImageUrlSync(url, options = {}) {
  const originalUrl = String(url || '').trim();
  if (!originalUrl || !isCacheableImageUrl(originalUrl)) return null;
  const key = imageCacheKey(originalUrl, options);
  if (resolvedImageUrls.has(key)) {
    return resolvedImageUrls.get(key);
  }
  return null;
}

export function clearImageCacheMemo(url, options = null) {
  if (url) {
    const originalUrl = String(url || '').trim();
    if (options) {
      const key = imageCacheKey(originalUrl, options);
      resolvedImageUrls.delete(key);
      pendingImageUrls.delete(key);
      return;
    }
    for (const key of resolvedImageUrls.keys()) {
      if (key === originalUrl || key.startsWith(`${originalUrl}::`)) resolvedImageUrls.delete(key);
    }
    for (const key of pendingImageUrls.keys()) {
      if (key === originalUrl || key.startsWith(`${originalUrl}::`)) pendingImageUrls.delete(key);
    }
    return;
  }
  resolvedImageUrls.clear();
  pendingImageUrls.clear();
}

function runQueuedImageCacheTask(task) {
  imageCacheQueue.push(task);
  drainImageCacheQueue();
}

function drainImageCacheQueue() {
  while (activeImageCacheRequests < MAX_ACTIVE_IMAGE_CACHE_REQUESTS && imageCacheQueue.length > 0) {
    const task = imageCacheQueue.shift();
    activeImageCacheRequests += 1;
    task()
      .catch(() => {})
      .finally(() => {
        activeImageCacheRequests -= 1;
        drainImageCacheQueue();
      });
  }
}

export async function resolveCachedImageUrl(url, options = {}) {
  const originalUrl = String(url || '').trim();
  if (!originalUrl || !isCacheableImageUrl(originalUrl)) return originalUrl;
  if (!window.electronAPI?.imageCacheGetCover) return originalUrl;
  const normalizedOptions = normalizeCacheOptions(options);
  const key = imageCacheKey(originalUrl, normalizedOptions);
  if (resolvedImageUrls.has(key)) return resolvedImageUrls.get(key);
  if (pendingImageUrls.has(key)) return pendingImageUrls.get(key);

  const pending = new Promise((resolve) => {
    runQueuedImageCacheTask(async () => {
      try {
        const result = await window.electronAPI.imageCacheGetCover(originalUrl, normalizedOptions);
        const resolvedUrl = result?.success && result.url ? result.url : originalUrl;
        rememberResolvedImageUrl(key, resolvedUrl);
        resolve(resolvedUrl);
      } catch {
        rememberResolvedImageUrl(key, originalUrl);
        resolve(originalUrl);
      } finally {
        pendingImageUrls.delete(key);
      }
    });
  });

  pendingImageUrls.set(key, pending);
  return pending;
}

/**
 * 后台预取封面到缓存（不返回结果，仅触发下载）
 */
export function prefetchImageCache(url) {
  const originalUrl = String(url || '').trim();
  if (!originalUrl || !isCacheableImageUrl(originalUrl)) return;
  if (!window.electronAPI?.imageCacheGetCover) return;
  if (resolvedImageUrls.has(originalUrl) || pendingImageUrls.has(originalUrl)) return;
  resolveCachedImageUrl(originalUrl).catch(() => {});
}

/**
 * 启动时一次性预加载所有已缓存封面到内存
 * 预加载后 getCachedImageUrlSync 同步命中，实现毫秒级显示
 */
export async function preloadImageCache() {
  if (preloadedFlag) return;
  if (!window.electronAPI?.imageCacheGetAll) return;
  try {
    const allCached = await window.electronAPI.imageCacheGetAll();
    if (allCached && typeof allCached === 'object') {
      for (const [url, fileUrl] of Object.entries(allCached)) {
        rememberResolvedImageUrl(url, fileUrl);
      }
    }
    preloadedFlag = true;
  } catch (e) {
    // 静默失败，不影响正常加载
  }
}

/**
 * 批量预加载指定 URL 列表（列表数据到达时调用）
 */
export async function batchPreloadImageCache(urls, options = {}) {
  if (!window.electronAPI?.imageCacheBatchLookup) return;
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (list.length === 0) return;
  try {
    const cached = await window.electronAPI.imageCacheBatchLookup(list, normalizeCacheOptions(options));
    if (cached && typeof cached === 'object') {
      for (const [key, fileUrl] of Object.entries(cached)) {
        rememberResolvedImageUrl(key, fileUrl);
      }
    }
  } catch (e) {
    // 静默失败
  }
}
