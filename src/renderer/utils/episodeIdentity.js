import { extractEpisodeNumber } from './episodeList.js';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeIdentityText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function resolveEpisodeNumber(video) {
  const episode = video?.episode || {};
  const parsed = extractEpisodeNumber(episode);
  if (parsed > 0) return parsed;
  const index = Number(episode.index);
  return Number.isInteger(index) && index >= 0 ? index + 1 : 0;
}

/**
 * Build a source-independent identity for a work and episode.
 * Bangumi id is authoritative; normalized title is the offline fallback.
 */
export function createEpisodeIdentity(video = {}) {
  const explicit = video.episodeIdentity;
  if (explicit?.version === 1 && explicit.key && explicit.workKey && explicit.episodeKey) {
    return { ...explicit };
  }
  const anime = video.anime || {};
  const episode = video.episode || {};
  const bgmId = positiveInteger(
    anime.bgm_id || anime.bgmId || anime.subject_id || anime.subjectId || video.bgm_id
  );
  const animeTitle = anime.name_cn || anime.name || video.animeName || video.title || '';
  const normalizedTitle = normalizeIdentityText(animeTitle);
  const workKey = bgmId ? `bgm:${bgmId}` : (normalizedTitle ? `title:${normalizedTitle}` : 'work:unknown');
  const episodeNumber = resolveEpisodeNumber(video);
  const episodeTitle = episode.title || video.episodeTitle || '';
  const episodeFallback = normalizeIdentityText(episodeTitle)
    || normalizeIdentityText(episode.id || video.episodeId)
    || 'unknown';
  const episodeKey = episodeNumber > 0 ? `ep:${episodeNumber}` : `episode:${episodeFallback}`;

  return {
    version: 1,
    key: `${workKey}|${episodeKey}`,
    workKey,
    episodeKey,
    bgmId: bgmId || null,
    animeTitle,
    episodeTitle,
    episodeNumber: episodeNumber || null
  };
}

export function createTimelineAnchor(currentTime = 0, duration = 0) {
  const seconds = Math.max(0, Number(currentTime) || 0);
  const sourceDuration = Math.max(0, Number(duration) || 0);
  return {
    version: 1,
    seconds,
    progress: sourceDuration > 0 ? Math.min(1, seconds / sourceDuration) : null,
    sourceDuration,
    capturedAt: Date.now()
  };
}

/**
 * Prefer exact seconds for near-identical encodes. For materially different
 * durations, normalized progress gives a better cross-source approximation.
 */
export function resolveTimelineAnchor(anchor, targetDuration = 0) {
  const seconds = Math.max(0, Number(anchor?.seconds) || 0);
  const sourceDuration = Math.max(0, Number(anchor?.sourceDuration) || 0);
  const duration = Math.max(0, Number(targetDuration) || 0);
  const progress = Number(anchor?.progress);
  const durationDelta = sourceDuration > 0 && duration > 0
    ? Math.abs(duration - sourceDuration) / sourceDuration
    : 0;
  const resolved = duration > 0 && Number.isFinite(progress) && progress >= 0 && durationDelta > 0.04
    ? progress * duration
    : seconds;
  return duration > 0 ? Math.min(duration, Math.max(0, resolved)) : Math.max(0, resolved);
}

export { normalizeIdentityText };
