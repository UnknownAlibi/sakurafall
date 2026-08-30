const MEDIA_ACTIONS = [
  'play',
  'pause',
  'stop',
  'seekbackward',
  'seekforward',
  'seekto',
  'nexttrack'
];

function firstText(...values) {
  const value = values.find(item => typeof item === 'string' && item.trim());
  return value ? value.trim() : '';
}

function normalizeArtworkUrl(value) {
  const url = firstText(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

export function buildPlayerMediaMetadata(video) {
  const anime = video?.anime || {};
  const episode = video?.episode || {};
  const animeName = firstText(anime.name, anime.title, video?.animeName);
  const episodeTitle = firstText(episode.title, episode.name);
  const title = episodeTitle || firstText(video?.title, animeName, 'SakuraFall');
  const artworkUrl = normalizeArtworkUrl(
    anime.cover || anime.image || anime.coverUrl || anime.cover_url || video?.cover
  );

  return {
    title,
    artist: animeName && animeName !== title ? animeName : 'SakuraFall',
    album: firstText(anime.sourceName, video?.sourceName, 'SakuraFall'),
    artwork: artworkUrl ? [{ src: artworkUrl }] : []
  };
}

export function buildPositionState(video) {
  const duration = Number(video?.duration);
  const playbackRate = Number(video?.playbackRate);
  const currentTime = Number(video?.currentTime);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  return {
    duration,
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
    position: Math.min(duration, Math.max(0, Number.isFinite(currentTime) ? currentTime : 0))
  };
}

function resolveMediaSession() {
  if (typeof navigator === 'undefined') return null;
  return navigator.mediaSession || null;
}

export function createPlayerMediaSession(options = {}) {
  const mediaSession = resolveMediaSession();
  let mounted = false;
  let nextEnabled = false;
  let lastPositionUpdateAt = 0;
  let lastNextActionAt = 0;

  const setHandler = (action, handler) => {
    if (!mediaSession?.setActionHandler) return;
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      // Chromium versions may expose Media Session without every action type.
    }
  };

  const handleNext = () => {
    const now = Date.now();
    if (!nextEnabled || now - lastNextActionAt < 650) return;
    lastNextActionAt = now;
    options.onNext?.();
  };

  const setNextEnabled = enabled => {
    nextEnabled = !!enabled;
    if (mounted) setHandler('nexttrack', nextEnabled ? handleNext : null);
  };

  const mount = () => {
    if (!mediaSession || mounted) return false;
    mounted = true;
    setHandler('play', () => options.onPlay?.());
    setHandler('pause', () => options.onPause?.());
    setHandler('stop', () => options.onStop?.());
    setHandler('seekbackward', details => {
      const amount = Number(details?.seekOffset) || Number(options.getSeekStep?.()) || 10;
      options.onSeekBy?.(-amount);
    });
    setHandler('seekforward', details => {
      const amount = Number(details?.seekOffset) || Number(options.getSeekStep?.()) || 10;
      options.onSeekBy?.(amount);
    });
    setHandler('seekto', details => {
      const time = Number(details?.seekTime);
      if (Number.isFinite(time)) options.onSeekTo?.(time, !!details?.fastSeek);
    });
    setHandler('nexttrack', nextEnabled ? handleNext : null);
    return true;
  };

  const updateMetadata = metadata => {
    if (!mediaSession) return;
    const Metadata = globalThis.MediaMetadata;
    if (typeof Metadata !== 'function') return;
    try {
      mediaSession.metadata = new Metadata(metadata || {});
    } catch {
      try {
        mediaSession.metadata = new Metadata({
          title: metadata?.title || 'SakuraFall',
          artist: metadata?.artist || 'SakuraFall',
          album: metadata?.album || 'SakuraFall'
        });
      } catch {
        // Invalid remote artwork should never break playback controls.
      }
    }
  };

  const setPlaybackState = state => {
    if (!mediaSession) return;
    try {
      mediaSession.playbackState = ['playing', 'paused', 'none'].includes(state) ? state : 'none';
    } catch {
      // Some platforms expose playbackState as read-only.
    }
  };

  const updatePosition = (video, force = false) => {
    if (!mediaSession?.setPositionState) return;
    const now = Date.now();
    if (!force && now - lastPositionUpdateAt < 1000) return;
    const state = buildPositionState(video);
    if (!state) return;
    try {
      mediaSession.setPositionState(state);
      lastPositionUpdateAt = now;
    } catch {
      // Live streams and incomplete metadata can temporarily reject position state.
    }
  };

  const destroy = () => {
    if (!mediaSession || !mounted) return;
    MEDIA_ACTIONS.forEach(action => setHandler(action, null));
    setPlaybackState('none');
    try {
      mediaSession.metadata = null;
    } catch {
      // Ignore platform cleanup differences.
    }
    mounted = false;
  };

  return {
    supported: !!mediaSession,
    mount,
    destroy,
    setNextEnabled,
    setPlaybackState,
    updateMetadata,
    updatePosition
  };
}
