// 弹幕源的集数/季映射纯函数。
// B 站等平台常把多季合并成一个条目，单靠“第 N 集”会落到第一季，
// 因此优先用放送日期和季篇名关键词定位；无法可靠映射时返回 null。

function extractEpisodeNumber(value) {
  const raw = typeof value === 'object'
    ? (value?.episodeNumber ?? value?.episode ?? value?.sort ?? value?.title ?? value?.longTitle ?? '')
    : value;
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const text = String(raw || '');
  const patterns = [
    /(?:第\s*)?(\d+(?:\.\d+)?)\s*[集话]/i,
    /(?:S\d+\s*)?E(?:P)?\s*0*(\d+(?:\.\d+)?)/i,
    /(?:EP|episode)\s*0*(\d+(?:\.\d+)?)/i,
    /^\s*0*(\d+(?:\.\d+)?)(?:\s|$)/
  ];
  for (const pattern of patterns) {
    const parsed = Number(text.match(pattern)?.[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function selectEpisode(episodes, episodeNumber) {
  const list = Array.isArray(episodes) ? episodes : [];
  const wanted = Number(episodeNumber) || 0;
  if (wanted > 0) {
    const exact = list.find(item => extractEpisodeNumber(item) === wanted);
    if (exact) return exact;
    if (Number.isInteger(wanted) && list[wanted - 1]) return list[wanted - 1];
  }
  return list[0] || null;
}

function episodeDateMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const number = Number(value);
    if (number > 1e12) return number;
    if (number > 1e9) return number * 1000;
    return 0;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLooseTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function selectEpisodeForContext(episodes, context = {}, candidate = null) {
  const list = Array.isArray(episodes) ? episodes : [];
  if (list.length === 0) return null;
  const wanted = Math.max(0, Number(context?.episodeNumber) || 0);
  const airDate = String(context?.episodeAirDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(airDate)) {
    const target = Date.parse(`${airDate}T00:00:00Z`);
    const matches = list.filter(episode => {
      const timestamp = episodeDateMs(
        episode?.pub_time ?? episode?.pubTime ?? episode?.release_date ?? episode?.air_date ?? episode?.airDate
      );
      if (!timestamp) return false;
      return Math.abs(timestamp - target) <= 2 * 24 * 60 * 60 * 1000;
    });
    if (matches.length === 1) return matches[0];
  }

  const keywords = (Array.isArray(context?.seasonKeywords) ? context.seasonKeywords : [])
    .map(normalizeLooseTitle)
    .filter(keyword => keyword.length >= 2)
    .slice(0, 8);
  for (const keyword of keywords) {
    const matches = list.filter(episode => normalizeLooseTitle(
      `${episode?.long_title || episode?.longTitle || ''} ${episode?.title || ''} ${episode?.index_title || ''}`
    ).includes(keyword));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      if (wanted > 0 && matches[wanted - 1]) return matches[wanted - 1];
      return null;
    }
  }

  // 季号大于 1 且候选本身没有季标识、日期/篇名也对不上时，
  // 不再按“第 N 集”落到合集中的第 N 集（那通常是第一季）。
  const candidateTitle = normalizeLooseTitle(candidate?.title || '');
  const candidateHasSeason = keywords.some(keyword => candidateTitle.includes(keyword))
    || /第\s*[0-9一二三四五六七八九十]+\s*[季期部]|season\s*\d+|s\d+/i.test(String(candidate?.title || ''));
  if ((Number(context?.seasonNumber) || 0) > 1 && !candidateHasSeason) return null;

  return selectEpisode(list, wanted);
}

module.exports = {
  extractEpisodeNumber,
  selectEpisode,
  selectEpisodeForContext
};
