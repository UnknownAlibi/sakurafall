function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isOfficialLine(lineId, episodes) {
  if (!Array.isArray(episodes)) return false;
  const name = String(episodes._lineName || '');
  if (String(lineId).includes('bangumi_official') || name.includes('官方')) return true;
  return episodes.length > 0 && episodes.every(episode => String(episode?.id || '').startsWith('bangumi_eps_'));
}

// 导出供组件判断"官方线路"复用（如详情页线路过滤）
export function isOfficialEpisodeLine(lineId, episodes) {
  return isOfficialLine(lineId, episodes);
}

export function countPlayableEpisodes(anime) {
  if (!anime?.episodes || typeof anime.episodes !== 'object') return 0;
  return Object.entries(anime.episodes).reduce((max, [lineId, episodes]) => {
    if (!Array.isArray(episodes) || isOfficialLine(lineId, episodes)) return max;
    return Math.max(max, episodes.length);
  }, 0);
}

export function plannedEpisodeCount(anime) {
  const explicit = positiveNumber(
    anime?.planned_episode_count || anime?.plannedEpisodeCount ||
    anime?.total_episode_count || anime?.totalEpisodeCount
  );
  if (explicit > 0) return explicit;
  if (anime?.source === 'bangumi' || anime?.bgm_id || anime?.bgmId) {
    return positiveNumber(anime?.episode_count || anime?.episodeCount || anime?.eps);
  }
  return 0;
}

export function availableEpisodeCount(anime) {
  const explicit = positiveNumber(
    anime?.available_episode_count || anime?.availableEpisodeCount ||
    anime?.playable_episode_count || anime?.playableEpisodeCount
  );
  if (explicit > 0) return explicit;
  const playable = countPlayableEpisodes(anime);
  if (playable > 0) return playable;
  if (anime?.source && anime.source !== 'bangumi') {
    return positiveNumber(anime?.episode_count || anime?.episodeCount || anime?.eps);
  }
  return 0;
}

export function airedEpisodeCount(anime) {
  const explicit = positiveNumber(
    anime?.aired_episode_count || anime?.airedEpisodeCount ||
    anime?.updated_episode_count || anime?.updatedEpisodeCount
  );
  if (explicit > 0) return explicit;
  const official = Array.isArray(anime?.official_episodes)
    ? anime.official_episodes
    : (anime?.episodes?.line_1 || []);
  const today = new Date();
  const todayKey = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return official.reduce((count, episode) => {
    const airDate = String(episode?.air_date || episode?.airdate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(airDate)) return count;
    const timestamp = new Date(`${airDate}T00:00:00`).getTime();
    return Number.isFinite(timestamp) && timestamp <= todayKey ? count + 1 : count;
  }, 0);
}

export function totalEpisodeBadge(anime) {
  const count = plannedEpisodeCount(anime) || availableEpisodeCount(anime);
  return count > 0 ? `共${count}集` : '';
}

export function updatedEpisodeBadge(anime) {
  // 列表上的“更新至”描述播出进度，优先采用 Bangumi 的官方放送日期。
  // 资源站可播放数量只在官方数据缺失时兜底，避免某个片源仅有 1 集时覆盖真实进度。
  const count = airedEpisodeCount(anime) || availableEpisodeCount(anime);
  return count > 0 ? `更新至${count}集` : '';
}
