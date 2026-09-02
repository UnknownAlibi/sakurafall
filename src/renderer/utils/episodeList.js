const EPISODE_NUMBER_PATTERNS = [
  /第(\d+)集/,
  /第(\d+)话/,
  /EP(\d+)/i,
  /episode\s*(\d+)/i,
  /(\d+)$/,
  /(\d+)/
];

const DIRECT_MEDIA_URL = /\.(?:m3u8|mp4|m4v|webm|ogv|ogg)(?:[?#]|$)|\/hls(?:[/?#]|$)|[?&](?:format|type|ext)=m3u8(?:&|$)/i;
const WEB_URL = /^https?:\/\//i;

function episodeUrl(episode) {
  return String(episode?.realUrl || episode?.real_video_url || episode?.url || episode?.play_url || '').trim();
}

export function normalizeEpisodes(episodes) {
  return episodes && typeof episodes === 'object' && episodes !== null ? episodes : {};
}

export function hasEpisodeLines(episodes) {
  return Object.keys(normalizeEpisodes(episodes)).length > 0;
}

export function formatLineName(lineId) {
  let name = String(lineId || '');
  if (name.startsWith('ul_playlist_')) {
    name = name.replace('ul_playlist_', '');
  }
  return /^\d+$/.test(name) ? `线路${name}` : name;
}

export function formatLineNames(episodes) {
  const names = {};
  Object.keys(normalizeEpisodes(episodes)).forEach(lineId => {
    names[lineId] = formatLineName(lineId);
  });
  return names;
}

export function extractEpisodeNumber(episode) {
  if (!episode) return 0;
  const title = episode.title || episode.name || '';
  for (const pattern of EPISODE_NUMBER_PATTERNS) {
    const match = String(title).match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return 0;
}

export function sortEpisodes(episodes) {
  return Array.isArray(episodes)
    ? [...episodes].sort((a, b) => extractEpisodeNumber(a) - extractEpisodeNumber(b))
    : [];
}

export function getLineEpisodes(episodes, lineId) {
  return sortEpisodes(normalizeEpisodes(episodes)[lineId]);
}

/**
 * Scores playback lines without issuing network requests. Direct HLS/media lines
 * are preferred over page-based or proprietary lines, then episode coverage is
 * used as a stable tie-breaker.
 */
export function scoreEpisodeLine(lineId, episodes) {
  const list = Array.isArray(episodes) ? episodes.filter(Boolean) : [];
  if (list.length === 0) return -Infinity;

  const lineName = String(lineId || '').toLowerCase();
  const urls = list.map(episodeUrl).filter(Boolean);
  const directCount = urls.filter(url => DIRECT_MEDIA_URL.test(url)).length;
  const webCount = urls.filter(url => WEB_URL.test(url)).length;
  const invalidCount = urls.length - webCount;
  const sampleCount = Math.max(1, urls.length);
  let score = 0;

  if (/(?:m3u8|hls)/i.test(lineName)) score += 36;
  else if (/(?:mp4|webm)/i.test(lineName)) score += 28;
  score += (directCount / sampleCount) * 70;
  score += (webCount / sampleCount) * 12;
  score -= (invalidCount / sampleCount) * 60;
  score += Math.min(list.length, 24) / 4;

  return score;
}

export function rankEpisodeLines(episodes) {
  const normalized = normalizeEpisodes(episodes);
  return Object.keys(normalized)
    .map((lineId, originalIndex) => ({
      lineId,
      episodes: getLineEpisodes(normalized, lineId),
      score: scoreEpisodeLine(lineId, normalized[lineId]),
      originalIndex
    }))
    .filter(line => line.episodes.length > 0)
    .sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex));
}

export function getPreferredEpisodeLine(episodes) {
  return rankEpisodeLines(episodes)[0]?.lineId || '';
}

function normalizedIdentityPart(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isSameEpisode(candidate, currentEpisode) {
  if (!candidate || !currentEpisode) return false;

  const candidateId = normalizedIdentityPart(candidate.id);
  const currentId = normalizedIdentityPart(currentEpisode.id);
  if (candidateId && currentId && candidateId === currentId) return true;

  const candidateTitle = normalizedIdentityPart(candidate.title || candidate.name);
  const currentTitle = normalizedIdentityPart(currentEpisode.title || currentEpisode.name);
  if (candidateTitle && currentTitle && candidateTitle === currentTitle) return true;

  const candidateNumber = extractEpisodeNumber(candidate);
  const currentNumber = extractEpisodeNumber(currentEpisode);
  return candidateNumber > 0 && currentNumber > 0 && candidateNumber === currentNumber;
}

export function findEpisodeIndex(episodes, currentEpisode) {
  if (!Array.isArray(episodes) || !currentEpisode) return -1;
  const matchedIndex = episodes.findIndex(ep => isSameEpisode(ep, currentEpisode));
  if (matchedIndex >= 0) return matchedIndex;

  const storedIndex = Number(currentEpisode.index);
  return Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < episodes.length
    ? storedIndex
    : -1;
}

export function findLineForEpisode(episodes, currentEpisode) {
  if (!currentEpisode) return null;
  const normalized = normalizeEpisodes(episodes);
  for (const lineId of Object.keys(normalized)) {
    if (Array.isArray(normalized[lineId]) && normalized[lineId].some(ep => isSameEpisode(ep, currentEpisode))) {
      return lineId;
    }
  }
  return null;
}

/**
 * Resolve the equivalent episode on another playback line. Episode ids often
 * differ between lines, so identity matching is attempted before the stable
 * list position fallback used by legacy CMS payloads.
 */
export function findCorrespondingEpisode(episodes, lineId, currentEpisode, currentIndex = -1) {
  const lineEpisodes = getLineEpisodes(episodes, lineId);
  if (lineEpisodes.length === 0) return null;

  const matchedIndex = findEpisodeIndex(lineEpisodes, currentEpisode);
  if (matchedIndex >= 0) return lineEpisodes[matchedIndex];

  const fallbackIndex = Number(currentIndex);
  return Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < lineEpisodes.length
    ? lineEpisodes[fallbackIndex]
    : null;
}

export function getAdjacentEpisode(episodes, currentIndex, offset) {
  if (!Array.isArray(episodes)) return null;
  const nextIndex = currentIndex + offset;
  return nextIndex >= 0 && nextIndex < episodes.length ? episodes[nextIndex] : null;
}
