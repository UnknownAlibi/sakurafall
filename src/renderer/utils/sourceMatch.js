/**
 * 源匹配评分工具
 *
 * 除了标题相似度，还要解决番剧最常见的两类错配：
 * 1. 同名真人版/剧版/预告/解说被当成动画；
 * 2. 同一作品的不同季（如“凡人修仙传 第五季”与“外海风云”“慕兰之战”）
 *    因为都包含基础标题而被当成同一部。
 *
 * 因此先建立“作品 + 季”的轻量身份，再做候选评分。只有季信息明确匹配时
 * 才允许自动采用；基础标题命中但季未知的连续剧集只作为候选，交给用户确认。
 */

const CN_NUMERALS = Object.freeze({
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9, 拾: 10, 百: 100
});

const SEASON_PATTERNS = [
  /第\s*([0-9零一二三四五六七八九十百壹贰叁肆伍陆柒捌玖拾]+)\s*[季期部篇]/i,
  /(?:season|series)\s*([0-9]+)/i,
  /(?:^|[^a-z0-9])s\s*([0-9]{1,2})(?![0-9])/i,
  /\bpart\s*([0-9]+)\b/i
];

const SPECIAL_PATTERN = /(?:特别篇|剧场版|电影版|电影|预告|总集篇|重制版|重置版|合集|解说|幕后|花絮|特典|番外|舞台剧)/i;
const LIVE_ACTION_NAME_PATTERN = /(?:真人版?|剧版|电视剧|网络剧|真人秀|电影|预告|解说)/i;
const LIVE_ACTION_TYPE_PATTERN = /(?:内地剧|国产剧|电视剧|真人秀|网剧|美剧|韩剧|日剧|港剧|台剧|海外剧|剧情片|爱情片)/i;
const ANIMATION_TYPE_PATTERN = /(?:动画|动漫|番剧|国漫|日漫|国产动漫|中国动漫|日本动漫|欧美动漫|AI漫)/i;
const ALIAS_INFOBOX_KEYS = /别名|原名|中文名|日文名|英文名|简称|又名/i;

function parseChineseNumber(value) {
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let current = 0;
  for (const char of text) {
    const digit = CN_NUMERALS[char];
    if (digit === undefined) continue;
    if (digit === 100) {
      total = (total || 1) * 100;
    } else if (digit === 10) {
      total += (current || 1) * 10;
      current = 0;
    } else {
      current = current * 10 + digit;
    }
  }
  return total + current;
}

function extractSeasonNumber(value) {
  const text = String(value || '');
  for (const pattern of SEASON_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const parsed = parseChineseNumber(match[1]);
      if (parsed > 0) return parsed;
    }
  }
  return 0;
}

function collectStrings(value, output) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStrings(item, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of ['v', 'value', 'name', 'title', 'name_cn', 'nameCn', 'nameRaw', 'name_raw']) {
    if (value[key] !== undefined) collectStrings(value[key], output);
  }
}

function animeTitles(anime = {}) {
  const titles = [];
  collectStrings([
    anime.name,
    anime.name_cn,
    anime.nameCn,
    anime.nameRaw,
    anime.name_raw,
    anime.aliases,
    anime.alias
  ], titles);
  for (const entry of anime.infobox || []) {
    if (!ALIAS_INFOBOX_KEYS.test(String(entry?.key || ''))) continue;
    collectStrings(entry?.value, titles);
  }
  return [...new Set(titles.map(item => String(item).replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function normalizeTitleForMatch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[【[(（][^】\])）]{0,48}(?:1080|720|2160|4k|bd|blu-?ray|web-?dl|hevc|h\.?265|字幕|中字|简繁|无修|先行|合集)[^】\])）]{0,48}[】\])）]/gi, '')
    .replace(/(?:更新至|更新到|更至|第)\s*\d+\s*(?:集|话)(?:完|全)?$/g, '')
    .replace(/\b(?:1080p?|720p?|2160p?|4k|bd|blu-?ray|web-?dl|hevc|h\.?265)\b/gi, '')
    .replace(/(?:全集|已?完结)$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function stripSeasonMarkers(value) {
  let text = String(value || '')
    .normalize('NFKC')
    .replace(/[【[(（][^】\])）]{0,60}[】\])）]/g, ' ');
  for (const pattern of SEASON_PATTERNS) {
    text = text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), ' ');
  }
  return normalizeTitleForMatch(text);
}

function normalizeExtra(value) {
  return normalizeTitleForMatch(String(value || '').replace(/^之/, '').replace(/[篇部]$/, ''));
}

function classifyCandidate(candidate = {}) {
  const name = String(candidate.name || candidate.title || '');
  const tags = [
    ...(Array.isArray(candidate.type) ? candidate.type : []),
    candidate.remarks || ''
  ].join(' ');
  const animation = ANIMATION_TYPE_PATTERN.test(tags);
  const liveByName = LIVE_ACTION_NAME_PATTERN.test(name);
  const liveByType = LIVE_ACTION_TYPE_PATTERN.test(tags);
  return {
    animation,
    liveAction: liveByType || (liveByName && !animation),
    special: SPECIAL_PATTERN.test(name) || /(?:预告|解说|花絮|幕后)/.test(String(candidate.remarks || '')),
    typeKnown: animation || liveByType
  };
}

function buildAnimeProfile(anime = {}) {
  const titles = animeTitles(anime);
  const primaryTitle = anime.name_cn || anime.nameCn || anime.name || anime.nameRaw || titles[0] || '';
  const primaryBase = stripSeasonMarkers(primaryTitle) || normalizeTitleForMatch(primaryTitle);
  const normalizedTitles = [...new Set(titles.map(normalizeTitleForMatch).filter(Boolean))];
  const seasons = [...new Set(titles.map(extractSeasonNumber).filter(Boolean))];
  const animeSeason = seasons.length === 1 ? seasons[0] : (extractSeasonNumber(primaryTitle) || 0);
  const extraAliases = new Set();
  for (const title of titles) {
    const normalized = normalizeTitleForMatch(title);
    if (!normalized) continue;
    // 去掉与基础标题相同的前缀后，剩下的篇名（如“慕兰之战”）就是
    // 该季在合并条目里的定位关键词。别名可能省略部分基础标题
    // （“凡人慕兰之战”），因此按最长公共前缀处理，而不是整串相等。
    let commonPrefix = 0;
    while (commonPrefix < normalized.length
      && commonPrefix < primaryBase.length
      && normalized[commonPrefix] === primaryBase[commonPrefix]) {
      commonPrefix += 1;
    }
    if (commonPrefix >= 2 && normalized.length > commonPrefix) {
      const extra = normalizeExtra(normalized.slice(commonPrefix));
      if (extra.length >= 2) extraAliases.add(extra);
    }
    // 完全不同的别名（英文名等）也保留，后续只用于标题相似度。
    if (!normalized.startsWith(primaryBase) && normalized !== primaryBase) {
      extraAliases.add(normalized);
    }
  }
  const typeValues = Array.isArray(anime.type) ? anime.type : (anime.type ? [anime.type] : []);
  const typeText = typeValues.filter(Boolean).join(' ');
  const isAnime = typeof anime.type === 'number'
    ? anime.type === 2
    : !/(?:真人|电视剧|剧集|三次元)/.test(typeText);
  const rawYear = anime.air_date
    ? String(anime.air_date).slice(0, 4)
    : (anime.year ?? anime.airYear ?? null);
  return {
    titles,
    normalizedTitles,
    primaryTitle,
    primaryBase,
    animeSeason,
    extraAliases,
    isSpecial: titles.some(title => SPECIAL_PATTERN.test(title)),
    isAnime,
    year: Number(rawYear) || null
  };
}

/**
 * 计算两个字符串的相似度（0-1）
 * 使用包含匹配 + Levenshtein 距离混合策略
 */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  const s1 = normalizeTitleForMatch(a);
  const s2 = normalizeTitleForMatch(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) {
    const shorter = Math.min(s1.length, s2.length);
    const longer = Math.max(s1.length, s2.length);
    return shorter / longer;
  }
  const distance = levenshtein(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen > 0 ? 1 - distance / maxLen : 0;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = temp;
    }
  }
  return dp[n];
}

function clarityScore(text) {
  if (!text) return 0;
  const t = String(text).toUpperCase();
  let score = 0;
  if (t.includes('4K')) score += 0.3;
  if (t.includes('1080')) score += 0.25;
  if (t.includes('BD') || t.includes('BLURAY')) score += 0.2;
  if (t.includes('WEB-DL') || t.includes('WEBDL')) score += 0.15;
  if (t.includes('HEVC') || t.includes('H265') || t.includes('H.265')) score += 0.1;
  return Math.min(score, 0.5);
}

function extractYear(text) {
  if (!text) return null;
  const match = String(text).match(/(?:19|20)\d{2}/);
  return match ? parseInt(match[0], 10) : null;
}

function candidateEpisodeCount(candidate) {
  const explicit = Number(candidate?.available_episode_count || candidate?.episode_count || candidate?.episodeCount || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const lines = candidate?.episodes && typeof candidate.episodes === 'object'
    ? Object.values(candidate.episodes)
    : [];
  return lines.reduce((max, line) => Math.max(max, Array.isArray(line) ? line.length : 0), 0);
}

function candidateExtraTitle(profile, candidateName) {
  const candidateBase = stripSeasonMarkers(candidateName);
  if (!candidateBase || !profile.primaryBase) return '';
  let extra = '';
  if (candidateBase.startsWith(profile.primaryBase)) {
    extra = candidateBase.slice(profile.primaryBase.length);
  } else if (candidateBase.includes(profile.primaryBase)) {
    extra = candidateBase.replace(profile.primaryBase, '');
  }
  // 年份只用于年份评分，不应当成“不同篇名”。
  return normalizeExtra(extra.replace(/(?:19|20)\d{2}$/, ''));
}

function extraMatchesAlias(profile, extra) {
  if (!extra) return false;
  return profile.extraAliases.has(extra)
    || [...profile.extraAliases].some(alias => alias.length >= 2 && (alias.includes(extra) || extra.includes(alias)))
    || profile.normalizedTitles.some(title => title !== profile.primaryBase && title.includes(extra));
}

function scoreCandidate(anime, candidate, profile = buildAnimeProfile(anime)) {
  const reasons = [];
  const candidateName = candidate.name || candidate.title || '';
  const candidateYear = extractYear(candidate.year || candidate.air_date || candidate.remarks || candidateName);
  const candidateEps = candidateEpisodeCount(candidate);
  const candidateRemarks = candidate.remarks || candidate.intro || '';
  const classification = classifyCandidate(candidate);

  if (classification.liveAction && profile.isAnime) {
    return {
      score: 0,
      reasons: ['真人版/剧版，已排除'],
      candidate,
      titleScore: 0,
      yearScore: 0,
      episodeScore: 0,
      seasonScore: 0,
      seasonMatch: -1,
      contentType: 'live-action',
      conflictingSubtitle: false,
      requiresMapping: false,
      reliable: false
    };
  }

  const titleScore = profile.titles.reduce((best, title) => (
    Math.max(best, stringSimilarity(title, candidateName))
  ), 0);
  if (titleScore > 0.8) reasons.push('标题高度匹配');
  else if (titleScore > 0.5) reasons.push('标题部分匹配');

  const animeYear = profile.year;
  let yearScore = 0;
  if (animeYear && candidateYear) {
    yearScore = animeYear === candidateYear ? 1 : (Math.abs(animeYear - candidateYear) <= 1 ? 0.5 : 0);
    if (yearScore === 1) reasons.push(`年份匹配 ${candidateYear}`);
  }

  const animeEps = Number(
    anime.planned_episode_count || anime.plannedEpisodeCount ||
    anime.total_episode_count || anime.totalEpisodeCount || anime.episode_count || anime.eps || 0
  );
  let epsScore = 0;
  if (animeEps > 0 && candidateEps > 0) {
    const diff = Math.abs(animeEps - candidateEps);
    if (diff === 0) {
      epsScore = 1;
      reasons.push(`集数完全匹配 ${candidateEps}集`);
    } else if (diff <= 2) {
      epsScore = 0.7;
    } else if (diff <= animeEps * 0.1) {
      epsScore = 0.4;
    }
  }

  const candidateSeason = extractSeasonNumber(candidateName);
  const extra = candidateExtraTitle(profile, candidateName);
  const aliasMatch = extraMatchesAlias(profile, extra);
  let seasonMatch = 0.5;
  if (candidateSeason && profile.animeSeason) {
    seasonMatch = candidateSeason === profile.animeSeason ? 1 : -1;
  } else if (!candidateSeason && profile.animeSeason) {
    seasonMatch = aliasMatch ? 1 : 0;
  } else if (candidateSeason && !profile.animeSeason) {
    seasonMatch = candidateSeason === 1 ? 0.5 : -1;
  }
  if (seasonMatch === 1 && (titleScore >= 0.5 || aliasMatch)) reasons.push('季信息匹配');
  if (seasonMatch === -1) reasons.push('不同季，已排除');
  if (!profile.animeSeason && !candidateSeason && aliasMatch) reasons.push('篇名匹配');

  const specialConflict = classification.special && !profile.isSpecial;
  if (specialConflict) reasons.push('特别篇/预告/解说，未自动采用');

  const conflictingSubtitle = !!extra && !aliasMatch
    && !classification.liveAction && !classification.special;
  if (conflictingSubtitle) reasons.push('篇名不一致，未自动采用');

  if (seasonMatch !== 1 && profile.animeSeason && !candidateSeason && !conflictingSubtitle) {
    reasons.push('缺少季信息，需人工确认');
  }

  const clarity = clarityScore(`${candidateName} ${candidateRemarks}`);
  const typeScore = classification.animation ? 1 : (classification.liveAction ? 0 : 0.5);
  const normalizedSeasonScore = seasonMatch === 1 ? 1 : (seasonMatch === 0.5 ? 0.6 : 0.2);
  const score = Math.min(1,
    titleScore * 0.45 +
    normalizedSeasonScore * 0.25 +
    typeScore * 0.1 +
    yearScore * 0.1 +
    epsScore * 0.1 +
    clarity * 0.05
  );

  const reliable = !specialConflict
    && !conflictingSubtitle
    && seasonMatch !== -1
    && titleScore >= (profile.animeSeason ? 0.62 : 0.58)
    && (
      seasonMatch === 1 ||
      (!profile.animeSeason && titleScore >= 0.82)
    );

  const requiresMapping = !reliable
    && !conflictingSubtitle
    && !specialConflict
    && seasonMatch === 0
    && !!profile.animeSeason
    && !extra
    && titleScore >= 0.5;

  return {
    score,
    reasons,
    candidate,
    titleScore,
    yearScore,
    episodeScore: epsScore,
    seasonScore: normalizedSeasonScore,
    seasonMatch,
    candidateSeason,
    extra,
    contentType: classification.liveAction ? 'live-action' : (classification.animation ? 'animation' : 'unknown'),
    conflictingSubtitle,
    requiresMapping,
    reliable
  };
}

export function scoreSourceMatch(anime, sourceResult) {
  if (!sourceResult) return { score: 0, reasons: [], candidate: null, reliable: false };
  if (sourceResult.status !== 'success') {
    return { score: 0, reasons: [`状态: ${sourceResult.status}`], candidate: null, reliable: false };
  }

  const results = sourceResult.results || sourceResult.animeList || [];
  if (results.length === 0) {
    return { score: 0, reasons: ['无搜索结果'], candidate: null, reliable: false };
  }

  const profile = buildAnimeProfile(anime);
  const rankedCandidates = results
    .map((candidate, originalIndex) => ({ ...scoreCandidate(anime, candidate, profile), originalIndex }))
    .sort((a, b) => (b.score - a.score) || (b.titleScore - a.titleScore) || (a.originalIndex - b.originalIndex));
  return { ...rankedCandidates[0], rankedCandidates };
}

export function rankSourcesByMatch(anime, sourceResults) {
  if (!Array.isArray(sourceResults)) return [];
  return sourceResults
    .map(source => {
      const match = scoreSourceMatch(anime, source);
      const rankedResults = (match.rankedCandidates || []).map(item => item.candidate);
      const originalResults = source.results || source.animeList || [];
      const results = rankedResults.length > 0 ? rankedResults : originalResults;
      const episodeCount = results.length > 0 ? candidateEpisodeCount(results[0]) : 0;
      return {
        ...source,
        results,
        animeList: results,
        episodeCount,
        matchScore: match.score,
        matchReasons: match.reasons,
        matchReliable: !!match.reliable,
        requiresEpisodeMapping: !!match.requiresMapping,
        contentType: match.contentType || '',
        selectedResultId: match.candidate?.id || '',
        confidence: match.score
      };
    })
    .sort((a, b) => {
      const aPlayable = a.status === 'success' && a.matchReliable && a.episodeCount > 0;
      const bPlayable = b.status === 'success' && b.matchReliable && b.episodeCount > 0;
      if (aPlayable !== bPlayable) return bPlayable ? 1 : -1;
      if (a.status === 'success' && b.status !== 'success') return -1;
      if (a.status !== 'success' && b.status === 'success') return 1;
      if (a.status === 'success' && b.status === 'success') {
        const matchDiff = (b.matchScore || 0) - (a.matchScore || 0);
        if (Math.abs(matchDiff) > 0.03) return matchDiff;
        const healthDiff = Number(b.healthScore ?? b.health?.score ?? 70)
          - Number(a.healthScore ?? a.health?.score ?? 70);
        if (healthDiff !== 0) return healthDiff;
        const orderDiff = Number(a.providerOrder ?? Number.MAX_SAFE_INTEGER)
          - Number(b.providerOrder ?? Number.MAX_SAFE_INTEGER);
        if (orderDiff !== 0) return orderDiff;
        return String(a.providerId || a.sourceId || '').localeCompare(String(b.providerId || b.sourceId || ''));
      }
      return 0;
    });
}

/**
 * 供弹幕匹配使用：取出当前季号和可用于定位合集的篇名关键词。
 * 例如“凡人修仙传 第五季”的别名会产出“慕兰之战”，用于在 B 站
 * 合并了多季的条目中筛出正确的一段。
 */
export function buildSeasonSearchContext(anime = {}) {
  const profile = buildAnimeProfile(anime);
  if (!profile.animeSeason) return { seasonNumber: 0, keywords: [] };
  const keywords = [...profile.extraAliases]
    .filter(keyword => /[\u3400-\u9fff]/.test(keyword))
    .filter(keyword => !extractSeasonNumber(keyword))
    .filter(keyword => keyword.length >= 2 && keyword.length <= 16)
    .sort((a, b) => a.length - b.length)
    .slice(0, 8);
  return { seasonNumber: profile.animeSeason, keywords };
}

export const __sourceMatchInternals = {
  extractSeasonNumber,
  stripSeasonMarkers,
  classifyCandidate,
  buildAnimeProfile
};
