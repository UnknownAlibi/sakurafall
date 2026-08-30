const PLAYABLE_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'data:', 'file:', 'sakurafall-media:']);

function toIpcPlainObject(value, fallback = {}) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch (_error) {
    return fallback;
  }
}

function getDefaultElectronAPI() {
  return typeof window !== 'undefined' ? window.electronAPI : null;
}

export function normalizeVideoUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

export function isSharePageUrl(url) {
  return normalizeVideoUrl(url).includes('/share/');
}

export function isPlayableVideoUrl(url) {
  const normalizedUrl = normalizeVideoUrl(url);
  if (!normalizedUrl || isSharePageUrl(normalizedUrl)) return false;

  try {
    const parsed = new URL(normalizedUrl);
    return PLAYABLE_PROTOCOLS.has(parsed.protocol);
  } catch (_error) {
    return false;
  }
}

async function resolveMaybeShareUrl(url, episode, electronAPI) {
  const normalizedUrl = normalizeVideoUrl(url);
  if (!normalizedUrl) return '';
  if (!electronAPI?.playbackResolve) return normalizedUrl;

  try {
    const safeEpisode = toIpcPlainObject({ ...episode, url: normalizedUrl }, {});
    const info = await electronAPI.playbackResolve({
      providerId: episode.providerId || '',
      sourceId: episode.sourceId || '',
      sourceType: episode.sourceType || '',
      episode: safeEpisode
    });
    const resolvedUrl = normalizeVideoUrl(info?.url);
    if (info?.success !== false && resolvedUrl) {
      // 注意：不写回 episode.realUrl——episode 可能来自 Vuex state，
      // 直接修改会绕过 mutation 污染 store；主进程已有解析缓存，重复调用无额外开销
      return resolvedUrl;
    }
    // electronAPI 存在但解析失败：远端直链也返回给播放器（其内部还有换源/重试）
    if (!isSharePageUrl(normalizedUrl)) {
      // 主进程可用时请求代理包装（避免跨域污染 canvas），失败则回退原地址
      if (electronAPI?.buildVideoProxyUrl) {
        try {
          const proxied = await electronAPI.buildVideoProxyUrl(normalizedUrl);
          if (proxied?.success && proxied?.url) return proxied.url;
        } catch (_proxyError) { /* 回退原地址 */ }
      }
      return normalizedUrl;
    }
  } catch (_error) {
    // Caller decides how to surface a failed episode resolution.
  }

  return '';
}

export async function resolveEpisodeVideoUrl(episode, electronAPI = getDefaultElectronAPI()) {
  if (!episode) return '';

  const candidates = [
    episode.realUrl,
    episode.real_video_url,
    episode.url,
    episode.play_url
  ];

  for (const candidate of candidates) {
    const videoUrl = await resolveMaybeShareUrl(candidate, episode, electronAPI);
    if (isPlayableVideoUrl(videoUrl)) {
      return videoUrl;
    }
  }

  return '';
}
