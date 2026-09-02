const CHECK_WINDOW_MS = 60 * 1000;
const MAX_CHECKS_PER_WINDOW = 18;
// Give eager covers time to download and decode before starting non-critical
// per-subject episode requests. Cached counts still arrive shortly afterward.
const INITIAL_IDLE_DELAY_MS = 1600;
// Episode metadata is non-critical UI. A single worker avoids competing with
// cover decoding and list rendering while the user is browsing quickly.
const WORKER_COUNT = 1;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function activeOwner(ownerRef, token) {
  const owner = ownerRef.deref();
  if (!owner || token !== owner._episodeAvailabilityToken || !owner.isBangumiMode || owner.detailAnime) {
    return null;
  }
  return owner;
}

async function waitForIdle(ownerRef, token) {
  await new Promise(resolve => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 1600 });
    } else {
      setTimeout(resolve, 360);
    }
  });
  return Boolean(activeOwner(ownerRef, token));
}

async function waitForBudget(ownerRef, token) {
  let owner = activeOwner(ownerRef, token);
  while (owner) {
    const now = Date.now();
    if (!owner._episodeAvailabilityBudgetStartedAt || now - owner._episodeAvailabilityBudgetStartedAt >= CHECK_WINDOW_MS) {
      owner._episodeAvailabilityBudgetStartedAt = now;
      owner._episodeAvailabilityBudgetCount = 0;
    }
    if (owner._episodeAvailabilityBudgetCount < MAX_CHECKS_PER_WINDOW) {
      owner._episodeAvailabilityBudgetCount += 1;
      return true;
    }
    const waitMs = Math.min(1000, Math.max(250, CHECK_WINDOW_MS - (now - owner._episodeAvailabilityBudgetStartedAt)));
    owner = null;
    await delay(waitMs);
    owner = activeOwner(ownerRef, token);
  }
  return false;
}

async function runDetachedEpisodeWorker(ownerRef, token) {
  await delay(INITIAL_IDLE_DELAY_MS);

  let owner = activeOwner(ownerRef, token);
  while (owner) {
    if (owner._episodeAvailabilityQueue.length === 0) return;

    if (owner._isMainScrolling || document.visibilityState === 'hidden') {
      owner = null;
      await delay(240);
      owner = activeOwner(ownerRef, token);
      continue;
    }
    owner = null;

    if (!await waitForIdle(ownerRef, token)) return;
    owner = activeOwner(ownerRef, token);
    if (!owner) return;
    if (owner._isMainScrolling) {
      owner = null;
      owner = activeOwner(ownerRef, token);
      continue;
    }
    owner = null;
    if (!await waitForBudget(ownerRef, token)) return;

    owner = activeOwner(ownerRef, token);
    if (!owner) return;
    const queuedAnime = owner._episodeAvailabilityQueue.shift();
    const id = String(queuedAnime?.id || '');
    owner._episodeAvailabilityQueuedIds.delete(id);
    if (!id) {
      owner = null;
      owner = activeOwner(ownerRef, token);
      continue;
    }

    const anime = owner.findAnimeById(id) || queuedAnime;
    if (anime?._airedEpisodeSynced && !anime?._airedEpisodeSnapshotExpired) {
      owner = null;
      owner = activeOwner(ownerRef, token);
      continue;
    }
    const bgmId = anime?.bgmId || anime?.bgm_id || id.replace(/^bangumi_/, '');
    if (!bgmId) {
      owner = null;
      owner = activeOwner(ownerRef, token);
      continue;
    }

    // Do not keep the component alive while Electron/main is waiting on the
    // network. The response is applied only if the original page still exists.
    owner = null;
    const result = await window.electronAPI.bangumiGetAiredEpisodeCount(bgmId);
    owner = activeOwner(ownerRef, token);
    if (!owner) return;

    const currentAnime = owner.findAnimeById(id) || anime;
    const updates = {
      _airedEpisodeSynced: true,
      _airedEpisodeSnapshotExpired: false,
      _airedEpisodeCheckedAt: Date.now()
    };
    const airedCount = Number(result?.count) || 0;
    const plannedCount = Number(result?.planned || result?.total) || 0;
    if (airedCount > 0) updates.aired_episode_count = airedCount;
    if (plannedCount > 0 && !Number(currentAnime?.planned_episode_count)) {
      updates.planned_episode_count = plannedCount;
      updates.total_episode_count = plannedCount;
    }
    owner.queueAnimeListUpdate(currentAnime.id, updates);
    owner = null;
    await delay(260);
    owner = activeOwner(ownerRef, token);
  }
}

export default {
  data() {
    return {
      _episodeAvailabilityQueue: [],
      _episodeAvailabilityQueuedIds: new Set(),
      _episodeAvailabilityWorkerRunning: false,
      _episodeAvailabilityToken: 0,
      _episodeAvailabilityBudgetStartedAt: 0,
      _episodeAvailabilityBudgetCount: 0
    };
  },

  methods: {
    onAnimeCardVisible(anime) {
      if (!this.isBangumiMode || anime?.source !== 'bangumi') return;
      if (this.detailAnime || (anime?._airedEpisodeSynced && !anime?._airedEpisodeSnapshotExpired)) return;
      if (!window.electronAPI?.bangumiGetAiredEpisodeCount) return;

      const id = String(anime.id || '');
      if (!id || this._episodeAvailabilityQueuedIds.has(id)) return;
      this._episodeAvailabilityQueuedIds.add(id);
      this._episodeAvailabilityQueue.push(anime);
      this.startEpisodeAvailabilityWorker();
    },

    startEpisodeAvailabilityWorker() {
      if (this.detailAnime || this._episodeAvailabilityWorkerRunning || this._episodeAvailabilityQueue.length === 0) return;
      const token = this._episodeAvailabilityToken;
      const ownerRef = new WeakRef(this);
      this._episodeAvailabilityWorkerRunning = true;
      Promise.all(Array.from({ length: WORKER_COUNT }, () => runDetachedEpisodeWorker(ownerRef, token)))
        .catch(error => {
          const owner = ownerRef.deref();
          if (owner && token === owner._episodeAvailabilityToken) {
            console.warn('[AnimeZone] 官方更新集数补全失败:', error?.message || error);
          }
        })
        .finally(() => {
          const owner = ownerRef.deref();
          if (owner && token === owner._episodeAvailabilityToken) {
            owner._episodeAvailabilityWorkerRunning = false;
            if (owner._episodeAvailabilityQueue.length > 0) owner.startEpisodeAvailabilityWorker();
          }
        });
    },

    cancelEpisodeAvailabilityEnrichment() {
      this._episodeAvailabilityToken += 1;
      this._episodeAvailabilityQueue = [];
      this._episodeAvailabilityQueuedIds.clear();
      this._episodeAvailabilityWorkerRunning = false;
      this._episodeAvailabilityBudgetStartedAt = 0;
      this._episodeAvailabilityBudgetCount = 0;
    },

    pauseEpisodeAvailabilityEnrichment() {
      this._episodeAvailabilityToken += 1;
      this._episodeAvailabilityWorkerRunning = false;
    },

    onSourceAvailability({ id, count } = {}) {
      const episodeCount = this.toPositiveEpisodeNumber(count);
      if (!id || episodeCount <= 0) return;
      const updates = {
        available_episode_count: episodeCount,
        playable_episode_count: episodeCount,
        _sourceAvailabilityChecked: true,
        _sourceAvailabilityCheckedAt: Date.now()
      };
      this.queueAnimeListUpdate(id, updates);
      if (this.detailAnime && String(this.detailAnime.id) === String(id)) {
        this.detailAnime = { ...this.detailAnime, ...updates };
      }
    }
  }
};
