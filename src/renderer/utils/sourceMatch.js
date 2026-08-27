/**
 * 源匹配评分工具（P1：详情页源匹配解耦）
 *
 * 对多源搜索结果按以下维度评分，帮助用户快速找到最佳播放源：
 * 1. 标题相似度：中文名、日文名、别名与搜索关键词的匹配度
 * 2. 年份匹配：番剧播出年份与源结果年份是否一致
 * 3. 集数匹配：Bangumi 集数与源集数是否接近
 * 4. 清晰度关键词：1080/4K/BD/WEB-DL/HEVC 等出现在标题或备注中
 * 5. 源健康度：status=success 加分，有 error 扣分
 *
 * 评分范围 0-1，1 为最佳匹配
 */

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
  // 包含关系：短串被长串包含
  if (s1.includes(s2) || s2.includes(s1)) {
    const shorter = Math.min(s1.length, s2.length);
    const longer = Math.max(s1.length, s2.length);
    return shorter / longer;
  }
  // Levenshtein 距离归一化
  const distance = levenshtein(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return maxLen > 0 ? 1 - distance / maxLen : 0;
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

/**
 * Levenshtein 距离（编辑距离）
 */
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
        dp[j] + 1,           // 删除
        dp[j - 1] + 1,       // 插入
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)  // 替换
      );
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * 从标题/备注中提取清晰度关键词得分
 */
function clarityScore(text) {
  if (!text) return 0;
  const t = String(text).toUpperCase();
  let score = 0;
  if (t.includes('4K')) score += 0.3;
  if (t.includes('1080')) score += 0.25;
  if (t.includes('BD') || t.includes('BLURAY')) score += 0.2;
  if (t.includes('WEB-DL') || t.includes('WEBDL')) score += 0.15;
  if (t.includes('HEVC') || t.includes('H265') || t.includes('H.265')) score += 0.1;
  return Math.min(score, 0.5); // 清晰度最多贡献 0.5
}

/**
 * 从文本中提取年份
 */
function extractYear(text) {
  if (!text) return null;
  const match = String(text).match(/(?:19|20)\d{2}/);
  return match ? parseInt(match[0], 10) : null;
}

/**
 * 对单个源结果计算匹配评分
 * @param {Object} anime - Bangumi 番剧信息（name, nameRaw, aliases, air_date, planned_episode_count）
 * @param {Object} sourceResult - 源搜索结果（sourceId, sourceName, status, results, error, elapsedMs）
 * @returns {Object} { score, reasons } 评分 0-1 和评分原因数组
 */
function candidateEpisodeCount(candidate) {
  const explicit = Number(candidate?.available_episode_count || candidate?.episode_count || candidate?.episodeCount || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const lines = candidate?.episodes && typeof candidate.episodes === 'object'
    ? Object.values(candidate.episodes)
    : [];
  return lines.reduce((max, line) => Math.max(max, Array.isArray(line) ? line.length : 0), 0);
}

function scoreCandidate(anime, candidate) {
  const reasons = [];
  const candidateName = candidate.name || candidate.title || '';
  const candidateYear = extractYear(candidate.year || candidate.air_date || candidate.remarks || candidateName);
  const candidateEps = candidateEpisodeCount(candidate);
  const candidateRemarks = candidate.remarks || candidate.intro || '';

  // 1. 标题相似度（权重 0.45）
  const searchName = anime.name || anime.nameRaw || '';
  const nameCnSim = stringSimilarity(searchName, candidateName);
  const nameRawSim = anime.nameRaw ? stringSimilarity(anime.nameRaw, candidateName) : 0;
  const aliasSim = (anime.aliases || []).reduce((max, alias) => {
    const sim = stringSimilarity(alias, candidateName);
    return Math.max(max, sim);
  }, 0);
  const titleScore = Math.max(nameCnSim, nameRawSim, aliasSim);
  if (titleScore > 0.8) reasons.push('标题高度匹配');
  else if (titleScore > 0.5) reasons.push('标题部分匹配');

  // 2. 年份匹配（权重 0.2）
  const animeYear = anime.air_date ? parseInt(String(anime.air_date).slice(0, 4), 10) : (anime.year || null);
  let yearScore = 0;
  if (animeYear && candidateYear) {
    yearScore = animeYear === candidateYear ? 1 : (Math.abs(animeYear - candidateYear) <= 1 ? 0.5 : 0);
    if (yearScore === 1) reasons.push(`年份匹配 ${candidateYear}`);
  }

  // 3. 集数匹配（权重 0.2）
  let epsScore = 0;
  const animeEps = anime.planned_episode_count || anime.plannedEpisodeCount ||
    anime.total_episode_count || anime.totalEpisodeCount || anime.episode_count || anime.eps || 0;
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

  // 4. 清晰度关键词（权重 0.1）
  const clarity = clarityScore(`${candidateName} ${candidateRemarks}`);

  const score = Math.min(1, titleScore * 0.5 + yearScore * 0.2 + epsScore * 0.2 + clarity * 0.1);
  const reliable = titleScore >= 0.82 || (titleScore >= 0.58 && yearScore >= 0.5);
  return { score, reasons, candidate, titleScore, yearScore, episodeScore: epsScore, reliable };
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

  const rankedCandidates = results
    .map((candidate, originalIndex) => ({ ...scoreCandidate(anime, candidate), originalIndex }))
    .sort((a, b) => (b.score - a.score) || (b.titleScore - a.titleScore) || (a.originalIndex - b.originalIndex));
  return { ...rankedCandidates[0], rankedCandidates };
}

/**
 * 对源结果列表按匹配评分排序
 * @param {Object} anime - Bangumi 番剧信息
 * @param {Array} sourceResults - 源搜索结果列表
 * @returns {Array} 排序后的源列表（附带 score 和 matchReasons）
 */
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
        selectedResultId: match.candidate?.id || '',
        confidence: match.score
      };
    })
    .sort((a, b) => {
      const aPlayable = a.status === 'success' && a.matchReliable && a.episodeCount > 0;
      const bPlayable = b.status === 'success' && b.matchReliable && b.episodeCount > 0;
      if (aPlayable !== bPlayable) return bPlayable ? 1 : -1;
      // 成功的源按匹配评分降序排前面
      if (a.status === 'success' && b.status !== 'success') return -1;
      if (a.status !== 'success' && b.status === 'success') return 1;
      if (a.status === 'success' && b.status === 'success') {
        const matchDiff = (b.matchScore || 0) - (a.matchScore || 0);
        if (Math.abs(matchDiff) > 0.03) return matchDiff;
        const healthDiff = Number(b.healthScore ?? b.health?.score ?? 70)
          - Number(a.healthScore ?? a.health?.score ?? 70);
        if (healthDiff !== 0) return healthDiff;
        return matchDiff;
      }
      // 非成功的源保持原顺序
      return 0;
    });
}
