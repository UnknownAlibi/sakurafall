import { extractEpisodeNumber, rankEpisodeLines } from './episodeList.js';

function normalizedId(value) {
  return String(value || '').trim().toLowerCase();
}

function idVariants(value) {
  const id = normalizedId(value);
  if (!id) return [];
  const separator = id.indexOf(':');
  return separator > 0 ? [id, id.slice(separator + 1)] : [id];
}

function normalizedTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\s]/g, '')
    .toLocaleLowerCase();
}

export function continueWatchingKey(item = {}) {
  return `${item.source || 'legacy'}:${String(item.anime_id ?? item.id ?? '')}`;
}

export function findHistoryProvider(providers = [], history = {}) {
  const animeData = history.anime_data && typeof history.anime_data === 'object'
    ? history.anime_data
    : {};
  const wanted = new Set([
    ...idVariants(animeData.providerId),
    ...idVariants(animeData.sourceId),
    ...idVariants(animeData.source),
    ...idVariants(history.source)
  ]);
  if (wanted.size === 0) return null;

  return (Array.isArray(providers) ? providers : []).find(provider => {
    if (!provider || provider.enabled === false) return false;
    const candidates = [provider.providerId, provider.sourceId, provider.id]
      .flatMap(idVariants);
    return candidates.some(candidate => wanted.has(candidate));
  }) || null;
}

export function findHistoryEpisode(episodes = {}, history = {}) {
  const lines = rankEpisodeLines(episodes);
  if (lines.length === 0) return null;

  const wantedTitle = normalizedTitle(history.episode_title);
  if (wantedTitle) {
    for (const line of lines) {
      const index = line.episodes.findIndex(episode => (
        normalizedTitle(episode?.title || episode?.name) === wantedTitle
      ));
      if (index >= 0) return { lineId: line.lineId, episode: line.episodes[index], episodeIndex: index };
    }
  }

  const wantedNumber = extractEpisodeNumber({ title: history.episode_title || '' });
  if (wantedNumber > 0) {
    for (const line of lines) {
      const index = line.episodes.findIndex(episode => extractEpisodeNumber(episode) === wantedNumber);
      if (index >= 0) return { lineId: line.lineId, episode: line.episodes[index], episodeIndex: index };
    }
  }

  const savedIndex = Number(history.episode_index);
  if (Number.isInteger(savedIndex) && savedIndex >= 0) {
    const line = lines.find(candidate => candidate.episodes[savedIndex]);
    if (line) return { lineId: line.lineId, episode: line.episodes[savedIndex], episodeIndex: savedIndex };
  }

  return null;
}

export function historyAnimeReference(history = {}) {
  const animeData = history.anime_data && typeof history.anime_data === 'object'
    ? history.anime_data
    : {};
  return {
    id: animeData.id || animeData.anime_id || history.anime_id,
    url: animeData.url || animeData.href || '',
    href: animeData.href || animeData.url || '',
    name: animeData.name || history.name || ''
  };
}

export async function resolveContinueWatching({ history, api, loadCmsSources, fetchCmsDetail }) {
  const animeData = history?.anime_data && typeof history.anime_data === 'object'
    ? history.anime_data
    : {};
  const animeForDetail = {
    ...animeData,
    id: animeData.id || history?.anime_id,
    source: animeData.source || history?.source || 'legacy',
    name: animeData.name || history?.name || '',
    cover: animeData.cover || history?.cover || '',
    bgm_id: animeData.bgm_id || history?.bgm_id || null,
    episodes: animeData.episodes || null
  };
  const providers = api?.sourceProviderList
    ? await api.sourceProviderList({ includeDisabled: true })
    : await loadCmsSources();
  const provider = findHistoryProvider(providers, history);
  if (!provider) return { status: 'provider-missing', animeForDetail };

  let sourceAnime = animeData?.episodes ? animeData : null;
  if (!sourceAnime?.episodes || Object.keys(sourceAnime.episodes).length === 0) {
    const reference = historyAnimeReference(history);
    sourceAnime = api?.sourceProviderDetail
      ? await api.sourceProviderDetail(provider.providerId || provider.sourceId, reference, { refresh: false })
      : await fetchCmsDetail({ id: reference.id, sourceId: provider.sourceId || provider.id, silent: true });
  }
  const matched = findHistoryEpisode(sourceAnime?.episodes, history);
  if (!sourceAnime || !matched) return { status: 'episode-missing', animeForDetail };

  return {
    status: 'ready',
    animeForDetail,
    matched,
    anime: {
      ...sourceAnime,
      source: sourceAnime.source || provider.sourceId || history.source,
      sourceId: sourceAnime.sourceId || provider.sourceId || history.source,
      providerId: sourceAnime.providerId || provider.providerId || '',
      sourceType: sourceAnime.sourceType || provider.type || 'cms',
      sourceName: sourceAnime.sourceName || provider.displayName || provider.name || '',
      bgm_id: sourceAnime.bgm_id || history.bgm_id || animeData.bgm_id || null,
      cover: sourceAnime.cover || history.cover || animeData.cover || ''
    }
  };
}
