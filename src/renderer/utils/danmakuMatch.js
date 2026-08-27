const EPISODE_PATTERNS = [
  /第\s*(\d+(?:\.\d+)?)\s*[集话]/i,
  /(?:EP|E|episode)\s*0*(\d+(?:\.\d+)?)/i,
  /^\s*0*(\d+(?:\.\d+)?)(?:\s|$)/,
  /(?:^|\D)0*(\d+(?:\.\d+)?)(?:\D|$)/
];

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s·・:：!！?？'"“”‘’()（）\u005b\u005d【】._-]+/g, '');
}

export function extractDanmakuEpisodeNumber(value) {
  const raw = typeof value === 'object'
    ? (value?.episodeNumber ?? value?.episode ?? value?.sort ?? value?.title ?? value?.episodeTitle ?? '')
    : value;
  const direct = Number(raw);
  if (Number.isFinite(direct) && direct > 0) return direct;

  for (const pattern of EPISODE_PATTERNS) {
    const match = String(raw || '').match(pattern);
    const parsed = Number(match?.[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function animeTitleScore(candidate, wantedTitle) {
  const actual = normalizeTitle(candidate?.title || candidate?.animeTitle);
  const wanted = normalizeTitle(wantedTitle);
  if (!wanted || !actual) return 0;
  if (actual === wanted) return 100;
  if (actual.includes(wanted) || wanted.includes(actual)) return 70;
  return 0;
}

export function selectDanmakuEpisode(candidates, animeName, episodeNumber) {
  const wantedNumber = Number(episodeNumber) || 0;
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map((anime, index) => ({ anime, index, score: animeTitleScore(anime, animeName) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  for (const { anime } of ranked) {
    const episodes = Array.isArray(anime?.episodes) ? anime.episodes : [];
    if (episodes.length === 0) continue;

    let episode = null;
    if (wantedNumber > 0) {
      episode = episodes.find(item => extractDanmakuEpisodeNumber(item) === wantedNumber) || null;
      if (!episode && Number.isInteger(wantedNumber)) {
        episode = episodes[wantedNumber - 1] || null;
      }
    } else {
      episode = episodes[0];
    }

    const episodeId = episode?.episodeId ?? episode?.id;
    if (episode && episodeId !== undefined && episodeId !== null && String(episodeId).trim()) {
      return {
        animeId: anime?.animeId ?? anime?.id ?? '',
        animeTitle: anime?.title || anime?.animeTitle || '',
        episodeId,
        episodeTitle: episode?.episodeTitle || episode?.title || '',
        episodeNumber: extractDanmakuEpisodeNumber(episode) || wantedNumber
      };
    }
  }

  return null;
}
