import { extractEpisodeNumber, rankEpisodeLines } from './episodeList.js';

const STORAGE_KEY = 'sakurafall-source-mappings:v1';

function readMappings() {
  try {
    if (typeof localStorage === 'undefined') return {};
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (_) {
    return {};
  }
}

export function sourceMappingKey(anime = {}, source = {}) {
  const work = anime.bgm_id || anime.bgmId || anime.id || anime.name || '';
  const provider = source.providerId || source.sourceId || source.sourceName || '';
  const result = source.selectedResultId
    || source.animeList?.[0]?.id
    || source.results?.[0]?.id
    || '';
  return `${work}|${provider}|${result}`.toLowerCase();
}

export function getSourceMapping(key) {
  return readMappings()[key] || null;
}

export function saveSourceMapping(key, start) {
  if (!key) return;
  const all = readMappings();
  all[key] = { start, updatedAt: Date.now() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (_) {
    /* storage unavailable: keep the in-memory transform only */
  }
}

function cloneRankedLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(line => ({
    ...line,
    episodes: Array.isArray(line.episodes) ? line.episodes.slice() : []
  }));
}

/**
 * 将合集源从第 start 集开始截取为本季集数，并把标题改成季内编号。
 * 原始线路保存在 _unmappedRankedLines，用户改起始集时可以重新映射。
 */
export function applySourceEpisodeMapping(source, start, anime = {}) {
  if (!source) return source;
  const startIndex = Math.max(0, (Number(start) || 1) - 1);
  const planned = Number(
    anime.planned_episode_count || anime.plannedEpisodeCount ||
    anime.total_episode_count || anime.totalEpisodeCount || 0
  );
  const top = source.animeList?.[0] || source.results?.[0] || {};
  if (!source._unmappedRankedLines) {
    source._unmappedRankedLines = cloneRankedLines(
      source.rankedLines || rankEpisodeLines(top.episodes || {})
    );
  }
  const limit = planned > 0 ? planned : Infinity;
  const mappedLines = source._unmappedRankedLines.map(line => {
    const episodes = line.episodes.slice(startIndex, startIndex + limit).map((episode, index) => ({
      ...episode,
      title: `第${index + 1}集`,
      sourceTitle: episode.title || episode.name || '',
      bangumiEpisodeNumber: index + 1,
      sourceEpisodeNumber: extractEpisodeNumber(episode) || startIndex + index + 1
    }));
    return { ...line, episodes };
  });
  const mappedEpisodes = {};
  for (const line of mappedLines) mappedEpisodes[line.lineId] = line.episodes;
  const episodeCount = mappedLines.reduce((max, line) => Math.max(max, line.episodes.length), 0);
  const mappedTop = {
    ...top,
    episodes: mappedEpisodes,
    episode_count: episodeCount,
    available_episode_count: episodeCount
  };
  source.animeList = [mappedTop, ...(source.animeList || []).slice(1)];
  source.results = [mappedTop, ...(source.results || []).slice(1)];
  source.rankedLines = mappedLines;
  source.playableEpisodeCount = episodeCount;
  source.requiresEpisodeMapping = false;
  source.manualMapped = true;
  source.matchReliable = true;
  source.matchReasons = ['手动确认合集映射'];
  source.confidence = 1;
  return source;
}
