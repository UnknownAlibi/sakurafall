import {
  findDownloadedTask,
  wrapEpisodeWithLocalDownload
} from '../utils/downloadedEpisodeMatch.js';
import {
  applySourceEpisodeMapping,
  getSourceMapping,
  saveSourceMapping,
  sourceMappingKey,
  suggestSourceMappingStart
} from '../utils/sourceEpisodeMapping.js';

export default {
  computed: {
    mappingCandidates() {
      return (this.playSources || [])
        .map((source, index) => ({ source, index }))
        .filter(({ source }) => (
          source.status === 'success'
          && source.requiresEpisodeMapping
          && source.playableEpisodeCount > 0
        ))
        .map(({ source, index }) => {
          const top = source.animeList?.[0] || source.results?.[0] || {};
          return {
            index,
            key: sourceMappingKey(this.anime, source),
            sourceName: source.sourceName || source.sourceId || '片源',
            title: top.name || '',
            totalEpisodes: source.playableEpisodeCount,
            lineCount: source.rankedLines?.length || 0,
            suggestedStart: suggestSourceMappingStart(source, this.anime)
          };
        });
    }
  },
  methods: {
    applySavedSourceMappings() {
      for (const source of this.playSources || []) {
        if (source.manualMapped || !source.requiresEpisodeMapping) continue;
        const mapping = getSourceMapping(sourceMappingKey(this.anime, source));
        if (Number(mapping?.start) >= 1) {
          applySourceEpisodeMapping(source, Number(mapping.start), this.anime);
        }
      }
    },

    applyManualSourceMapping({ key, index, start }) {
      const source = this.playSources[index];
      if (!source) return;
      const total = Number(source.playableEpisodeCount) || 0;
      const value = Number(start);
      if (!Number.isInteger(value) || value < 1 || value > total) return;
      saveSourceMapping(key || sourceMappingKey(this.anime, source), value);
      applySourceEpisodeMapping(source, value, this.anime);
      this.playSources = [...this.playSources];
      this.expandedSource = index;
    },

    getDownloadedTaskForEpisode(episode, epIndex) {
      const downloadList = this.$store?.getters?.['download/downloadList'] || [];
      return findDownloadedTask(downloadList, this.anime, episode, epIndex);
    },

    isEpisodeDownloaded(episode, epIndex) {
      return !!this.getDownloadedTaskForEpisode(episode, epIndex);
    },

    /**
     * 点击某源的具体剧集：合并 Bangumi 元数据 + CMS 源播放信息后 emit。
     * 手动映射过的合集源此时 episode.title 已经是季内编号。
     * 若已完成本地离线下载，自动切换为本地安全媒体流秒开。
     */
    onSourceEpisodeClick(sourceIdx, epIdx) {
      if (this.openingEpisodeKey) return;
      const source = this.playSources[sourceIdx];
      if (!source || !source.animeList || source.animeList.length === 0) return;
      const sourceAnime = source.animeList[0];
      const lineId = this.sourceEpisodeLineId(sourceIdx);
      const ep = this.currentSourceEpisodes(sourceIdx)[epIdx];
      if (!ep) return;
      this.stopBackgroundSourceSearch();

      const downloadedTask = this.getDownloadedTaskForEpisode(ep, epIdx);
      const playableEp = wrapEpisodeWithLocalDownload(ep, downloadedTask);

      const mergedAnime = {
        ...this.anime,
        source: downloadedTask ? 'downloads' : sourceAnime.source,
        sourceId: downloadedTask ? 'downloads' : (sourceAnime.sourceId || source.sourceId),
        sourceName: downloadedTask ? `${sourceAnime.sourceName || '本地'} (离线就绪)` : (sourceAnime.sourceName || source.sourceName),
        sourceType: downloadedTask ? 'local' : (sourceAnime.sourceType || source.sourceType || source.type),
        providerId: downloadedTask ? 'downloads' : (sourceAnime.providerId || source.providerId),
        id: sourceAnime.id,
        episodes: sourceAnime.episodes,
        episode_count: sourceAnime.episode_count,
        available_episode_count: sourceAnime.episode_count || this.playableEpisodeCount,
        planned_episode_count: this.plannedEpisodeCount,
        total_episode_count: this.plannedEpisodeCount,
        bgm_id: this.anime.bgm_id,
        remarks: sourceAnime.remarks || this.anime.remarks
      };

      this.$emit('play-episode', {
        anime: mergedAnime,
        episode: playableEp,
        episodeIndex: epIdx,
        lineIndex: this.sourceLineOptions(sourceIdx).findIndex(line => line.lineId === lineId),
        lineId,
        requestKey: this.episodeRequestKey(playableEp, lineId, epIdx)
      });
    }
  }
};
