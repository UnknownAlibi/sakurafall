import {
  airedEpisodeCount,
  availableEpisodeCount,
  countPlayableEpisodes,
  plannedEpisodeCount
} from '../utils/episodeMetadata.js';

function episodeLineCount(episodes) {
  if (!episodes || typeof episodes !== 'object') return 0;
  return Object.values(episodes).reduce((max, line) => Math.max(max, Array.isArray(line) ? line.length : 0), 0);
}

function providerIdForAnime(anime) {
  // 元数据来源（Bangumi/AniList）没有可搜索的播放源 providerId，直接返回空
  if (anime?.source === 'bangumi' || anime?.source === 'anilist') return '';
  if (anime?.providerId) return anime.providerId;
  if (anime?.source && !String(anime.source).includes(':')) return `cms:${anime.source}`;
  return anime?.source || '';
}

const detailSnapshotCache = new Map();
const DETAIL_SNAPSHOT_LIMIT = 64;

function detailCacheKeys(anime = {}) {
  return [
    anime.id ? `${anime.source || 'unknown'}:${anime.id}` : '',
    anime.bgm_id || anime.bgmId ? `bangumi:${anime.bgm_id || anime.bgmId}` : ''
  ].filter(Boolean);
}

function readDetailSnapshot(anime) {
  for (const key of detailCacheKeys(anime)) {
    const snapshot = detailSnapshotCache.get(key);
    if (snapshot) return snapshot;
  }
  return null;
}

function writeDetailSnapshot(anime, detail) {
  for (const key of new Set([...detailCacheKeys(anime), ...detailCacheKeys(detail)])) {
    detailSnapshotCache.delete(key);
    detailSnapshotCache.set(key, detail);
  }
  while (detailSnapshotCache.size > DETAIL_SNAPSHOT_LIMIT) {
    detailSnapshotCache.delete(detailSnapshotCache.keys().next().value);
  }
}

async function loadSourceDetail(anime, api, loadLegacyDetail) {
  // 元数据来源（Bangumi/AniList）直接由 subjectDetail 提供，不加载片源详情
  if (anime.source === 'bangumi' || anime.source === 'anilist' || countPlayableEpisodes(anime) > 0) return null;
  let sourceDetail = null;
  const providerId = providerIdForAnime(anime);
  if (providerId && api?.sourceProviderDetail) {
    try {
      sourceDetail = await api.sourceProviderDetail(providerId, {
        id: anime.id,
        url: anime.url || anime.href,
        name: anime.name
      });
    } catch (_) {
      // The legacy loader keeps old favorites and history records compatible.
    }
  }
  if (!sourceDetail && typeof loadLegacyDetail === 'function') {
    sourceDetail = await loadLegacyDetail(anime);
  }
  return sourceDetail;
}

async function resolveBgmId(anime, api) {
  // AniList 条目带独立 ID 空间，直接路由到 anilist: 前缀
  const anilistId = anime?.anilistId || anime?.anilist_id;
  if (anilistId) return `anilist:${anilistId}`;
  const knownId = anime.bgm_id || anime.bgmId;
  if (knownId) return knownId;
  if (!anime.name || !api?.subjectSearch) return null;
  try {
    const search = await api.subjectSearch(anime.name, 1);
    const hit = search?.data?.[0];
    return hit?.bgmId || hit?.bgm_id || null;
  } catch (_) {
    return null;
  }
}

function mergeSubjectMetadata(sourceStage, subject, context, isComplete) {
  const { anime, sourceDetail, sourceEpisodes, available, planned, bgmId } = context;
  const subjectPlanned = plannedEpisodeCount({ ...subject, source: 'bangumi' }) || planned;
  const officialEpisodes = subject.official_episodes || subject.episodes?.line_1 || sourceStage.official_episodes || [];
  const subjectAired = airedEpisodeCount({ ...subject, official_episodes: officialEpisodes });
  return {
    ...sourceStage,
    ...subject,
    bgm_id: bgmId,
    bgmId,
    episodes: sourceEpisodes || sourceStage.episodes || {},
    official_episodes: officialEpisodes,
    episode_count: available,
    available_episode_count: available,
    planned_episode_count: subjectPlanned,
    total_episode_count: subjectPlanned,
    aired_episode_count: subjectAired,
    cover: anime.cover || subject.cover || sourceDetail?.cover || '',
    source: anime.source,
    providerId: anime.providerId || sourceDetail?.providerId || '',
    sourceId: anime.sourceId || sourceDetail?.sourceId || anime.source,
    sourceType: anime.sourceType || sourceDetail?.sourceType || '',
    _bgmMetaLoading: !isComplete,
    _sourceDetailLoading: false
  };
}

export function isSettledDetailStage(context = {}) {
  return context.phase === 'complete';
}

export function createDetailPlaceholder(anime) {
  const snapshot = readDetailSnapshot(anime);
  const initial = snapshot ? { ...anime, ...snapshot } : anime;
  const planned = plannedEpisodeCount(initial);
  const available = availableEpisodeCount(initial);
  return {
    ...initial,
    id: anime.id || initial.id,
    name: anime.name || initial.name,
    bgm_id: initial.bgm_id || initial.bgmId || null,
    bgmId: initial.bgmId || initial.bgm_id || null,
    episodes: countPlayableEpisodes(anime) > 0 ? anime.episodes : (initial.episodes || {}),
    episode_count: available,
    available_episode_count: available,
    planned_episode_count: planned,
    total_episode_count: planned,
    cover: anime.cover || initial.cover || '',
    source: anime.source || initial.source,
    _bgmMetaLoading: true,
    _sourceDetailLoading: !snapshot
  };
}

export async function coordinateSubjectDetail(options) {
  const {
    anime,
    api = window.electronAPI,
    isActive = () => true,
    loadLegacyDetail,
    onStage = () => {}
  } = options;

  const sourceDetailPromise = loadSourceDetail(anime, api, loadLegacyDetail);
  const metadataBundlePromise = resolveBgmId(anime, api).then((bgmId) => ({
    bgmId,
    indexPromise: bgmId && api?.subjectIndexGet
      ? Promise.resolve(api.subjectIndexGet(bgmId)).catch(() => null)
      : Promise.resolve(null),
    subjectPromise: bgmId && api?.subjectDetail
      ? Promise.resolve(api.subjectDetail(bgmId)).catch(() => null)
      : Promise.resolve(null)
  }));

  const sourceDetail = await sourceDetailPromise;
  let sourceEpisodes = countPlayableEpisodes(anime) > 0 ? anime.episodes : null;
  if (sourceDetail?.episodes && Object.keys(sourceDetail.episodes).length > 0) {
    sourceEpisodes = sourceDetail.episodes;
  }

  if (!isActive()) return null;
  const sourceCount = episodeLineCount(sourceEpisodes);
  const available = sourceCount || availableEpisodeCount({
    ...anime,
    ...(sourceDetail || {}),
    episodes: sourceEpisodes || sourceDetail?.episodes || anime.episodes || {}
  });
  const planned = plannedEpisodeCount({ ...anime, ...(sourceDetail || {}) }) || plannedEpisodeCount(anime);
  const aired = airedEpisodeCount({ ...anime, ...(sourceDetail || {}) });
  const sourceStage = {
    ...anime,
    ...(sourceDetail || {}),
    bgm_id: anime.bgm_id || anime.bgmId || sourceDetail?.bgm_id || sourceDetail?.bgmId || null,
    bgmId: anime.bgmId || anime.bgm_id || sourceDetail?.bgmId || sourceDetail?.bgm_id || null,
    episodes: sourceEpisodes || {},
    episode_count: available,
    available_episode_count: available,
    planned_episode_count: planned,
    total_episode_count: planned,
    aired_episode_count: aired,
    official_episodes: anime.official_episodes || [],
    cover: anime.cover || sourceDetail?.cover || '',
    source: anime.source,
    _bgmMetaLoading: true,
    _sourceDetailLoading: false
  };
  onStage(sourceStage, {
    phase: 'source',
    sourceDetail,
    listUpdates: sourceDetail ? {
      _detailLoaded: true,
      ...(sourceDetail.cover ? { cover: sourceDetail.cover } : {}),
      ...(available > 0 ? { episode_count: available, available_episode_count: available } : {}),
      ...(sourceDetail.type?.length ? { type: sourceDetail.type } : {}),
      ...(sourceDetail.intro ? { intro: sourceDetail.intro } : {}),
      ...(sourceDetail.year ? { year: sourceDetail.year } : {})
    } : null
  });

  const { bgmId, indexPromise, subjectPromise } = await metadataBundlePromise;
  if (!isActive()) return null;
  if (!bgmId) {
    const completed = { ...sourceStage, _bgmMetaLoading: false };
    writeDetailSnapshot(anime, completed);
    onStage(completed, { phase: 'complete', sourceDetail, subject: null, listUpdates: null });
    return completed;
  }

  const metadataContext = { anime, sourceDetail, sourceEpisodes, available, planned, bgmId };
  const firstMetadata = await Promise.race([
    indexPromise.then(subject => ({ kind: 'index', subject })),
    subjectPromise.then(subject => ({ kind: 'subject', subject }))
  ]);
  if (!isActive()) return null;
  if (firstMetadata.kind === 'index' && firstMetadata.subject) {
    const cachedStage = mergeSubjectMetadata(sourceStage, firstMetadata.subject, metadataContext, false);
    onStage(cachedStage, { phase: 'metadata-cache', sourceDetail, subject: firstMetadata.subject, listUpdates: null });
  }

  const subject = firstMetadata.kind === 'subject' ? firstMetadata.subject : await subjectPromise;
  if (!isActive()) return null;
  if (!subject) {
    const completed = { ...sourceStage, _bgmMetaLoading: false };
    writeDetailSnapshot(anime, completed);
    onStage(completed, { phase: 'complete', sourceDetail, subject: null, listUpdates: null });
    return completed;
  }

  const merged = mergeSubjectMetadata(sourceStage, subject, metadataContext, true);
  const subjectPlanned = merged.planned_episode_count;
  const subjectAired = merged.aired_episode_count;
  writeDetailSnapshot(anime, merged);
  onStage(merged, {
    phase: 'complete',
    sourceDetail,
    subject,
    listUpdates: {
      bgm_id: bgmId,
      planned_episode_count: subjectPlanned,
      total_episode_count: subjectPlanned,
      aired_episode_count: subjectAired,
      _episodeProgressChecked: true,
      ...(subject.cover ? { cover: subject.cover } : {})
    }
  });
  return merged;
}
