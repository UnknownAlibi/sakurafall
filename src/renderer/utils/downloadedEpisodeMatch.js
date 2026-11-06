import { extractEpisodeNumber } from './episodeList.js';

function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 在已下载任务列表中查找匹配当前番剧与剧集的已完成下载任务
 */
export function findDownloadedTask(downloadList, anime = {}, episode = {}, episodeIndex = -1) {
  if (!Array.isArray(downloadList) || downloadList.length === 0) return null;

  const animeIds = new Set([
    String(anime?.bgm_id || ''),
    String(anime?.bgmId || ''),
    String(anime?.id || '')
  ].filter(Boolean));

  const targetTitles = [
    anime?.name_cn,
    anime?.name,
    ...(Array.isArray(anime?.aliases) ? anime.aliases : [])
  ].filter(Boolean).map(normalizeTitle).filter(Boolean);

  const epNumber = Number(episode?.bangumiEpisodeNumber || episode?.sourceEpisodeNumber || extractEpisodeNumber(episode) || 0)
    || (episodeIndex >= 0 ? episodeIndex + 1 : 0);

  const epTitleClean = normalizeTitle(episode?.title || episode?.name || '');

  for (const task of downloadList) {
    if (!task || task.status !== 'completed' || !task.playUrl) continue;

    // 1. 番剧身份匹配
    const taskId = String(task.anime?.id || '');
    const taskNameClean = normalizeTitle(task.anime?.name || '');

    const idMatched = taskId && animeIds.has(taskId);
    const titleMatched = taskNameClean && targetTitles.some(t => t.includes(taskNameClean) || taskNameClean.includes(t));

    if (!idMatched && !titleMatched) continue;

    // 2. 剧集集数匹配
    const taskEpIndex = typeof task.episode?.index === 'number' ? task.episode.index : -1;
    const taskEpNumber = extractEpisodeNumber(task.episode) || (taskEpIndex >= 0 ? taskEpIndex + 1 : 0);
    const taskEpTitleClean = normalizeTitle(task.episode?.title || '');

    const numberMatched = epNumber > 0 && taskEpNumber > 0 && epNumber === taskEpNumber;
    const indexMatched = episodeIndex >= 0 && taskEpIndex >= 0 && episodeIndex === taskEpIndex;
    const titleExactMatched = epTitleClean && taskEpTitleClean && epTitleClean === taskEpTitleClean;

    if (numberMatched || indexMatched || titleExactMatched) {
      return task;
    }
  }

  return null;
}

/**
 * 如果存在本地完成的下载任务，使用其 playUrl 包装剧集对象，供播放器秒开
 */
export function wrapEpisodeWithLocalDownload(episode = {}, downloadedTask = null) {
  if (!downloadedTask || !downloadedTask.playUrl) {
    return { ...episode, isLocalDownload: false };
  }
  return {
    ...episode,
    url: downloadedTask.playUrl,
    originalOnlineUrl: episode.url || episode.play_url || '',
    isLocalDownload: true,
    localTask: downloadedTask
  };
}
