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

function extractSeasonNumber(value) {
  const text = String(value || '');
  const match = text.match(/(?:第\s*([0-9一二三四五六七八九十]+)\s*[季部期])|(?:(?:season|s)\s*([0-9]+))/i);
  if (!match) return 0;
  const raw = match[1] || match[2];
  const chineseMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return chineseMap[raw] || Number(raw) || 0;
}

/**
 * 智能推荐合集源中本季第 1 集对应的起始集数
 */
export function suggestSourceMappingStart(source, anime = {}) {
  if (!source) return 0;
  const lines = source.rankedLines || [];
  const primaryLine = lines[0] || (source._unmappedRankedLines ? source._unmappedRankedLines[0] : null);
  const episodes = primaryLine?.episodes || [];
  if (!Array.isArray(episodes) || episodes.length === 0) return 0;

  const animeTitles = [
    anime.name_cn,
    anime.name,
    ...(Array.isArray(anime.aliases) ? anime.aliases : [])
  ].filter(Boolean);

  let seasonNumber = 0;
  for (const t of animeTitles) {
    const s = extractSeasonNumber(t);
    if (s > 0) {
      seasonNumber = s;
      break;
    }
  }

  // 1. 尝试匹配篇名关键词（如“慕兰之战”）
  const keywords = [];
  if (Array.isArray(anime.seasonKeywords)) {
    keywords.push(...anime.seasonKeywords);
  }
  for (const t of animeTitles) {
    const cleaned = t.replace(/第\s*[0-9一二三四五六七八九十]+\s*[季部期]/g, '')
      .replace(/(?:season|s)\s*[0-9]+/gi, '')
      .replace(/[【】[\n\]()（）]/g, ' ')
      .trim();
    const parts = cleaned.split(/\s+/).filter(p => p.length >= 2 && p.length <= 12 && !/^\d+$/.test(p));
    keywords.push(...parts);
  }

  if (keywords.length > 0) {
    for (let i = 0; i < episodes.length; i++) {
      const epTitle = String(episodes[i].title || episodes[i].name || '');
      for (const kw of keywords) {
        if (epTitle.includes(kw)) {
          return i + 1;
        }
      }
    }
  }

  // 2. 尝试从单集标题匹配季号 + 第1集标记（例如 "第5季 第1集", "S5E01", "第5季 01", "S05EP01"）
  if (seasonNumber > 0) {
    const seasonFirstEpPatterns = [
      new RegExp(`(?:第\\s*0*${seasonNumber}\\s*[季部期]|S0*${seasonNumber})[\\s-_]*(?:第\\s*0*1\\s*[集话]|E(?:P)?\\s*0*1(?:\\D|$)|0*1$)`, 'i'),
      new RegExp(`(?:第\\s*0*${seasonNumber}\\s*[季部期]|S0*${seasonNumber})`, 'i')
    ];
    for (const pattern of seasonFirstEpPatterns) {
      for (let i = 0; i < episodes.length; i++) {
        const epTitle = String(episodes[i].title || episodes[i].name || '');
        if (pattern.test(epTitle)) {
          return i + 1;
        }
      }
    }
  }

  return 0;
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
