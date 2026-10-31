import { buildSeasonSearchContext } from './sourceMatch.js';

function aliasValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return value ? [value] : [];
}

function seasonlessTitle(value) {
  return String(value || '')
    .replace(/(?:\s+|[-:：])(?:第\s*[一二三四五六七八九十百\d]+\s*[季期部]|season\s*\d+|s\d+|part\s*\d+)(?:\s+.*)?$/i, '')
    .trim();
}

/**
 * 构造弹幕搜索上下文。除标题/别名外，还要带上季号和季篇名关键词：
 * B 站等平台常把多季合并成一个条目，只传 episodeNumber 会匹配到第一季。
 */
export function buildDanmakuContext({ anime = {}, episodeNumber = 0, providerIds = [] } = {}) {
  const season = buildSeasonSearchContext(anime);
  const wantedNumber = Number(episodeNumber) || 0;
  const officialEpisodes = Array.isArray(anime.official_episodes) ? anime.official_episodes : [];
  const official = officialEpisodes.find(item => (
    Number(item.episode_number || item.episodeNumber || item.sort || 0) === wantedNumber
  ));
  const titles = [
    anime.name_cn,
    anime.nameCn,
    anime.original_name,
    anime.originalName,
    anime.rawName,
    ...aliasValues(anime.aliases),
    ...aliasValues(anime.alias)
  ].filter(Boolean);
  // 弹幕平台通常只收录基础标题（如“凡人修仙传”），
  // 只传“第五季”会因标题相似度不足而匹配失败。
  const seasonlessTitles = [anime.name, anime.name_cn, anime.nameCn]
    .map(seasonlessTitle)
    .filter(Boolean);
  return {
    animeName: anime.name || '',
    aliases: [...new Set([...seasonlessTitles, ...titles])],
    bgmId: anime.bgmId || anime.bgm_id || anime.subjectId || anime.id || '',
    episodeNumber: wantedNumber,
    episodeAirDate: official?.air_date || official?.airDate || '',
    episodeTitle: official?.title || '',
    seasonNumber: season.seasonNumber,
    seasonKeywords: season.keywords,
    providerIds
  };
}
