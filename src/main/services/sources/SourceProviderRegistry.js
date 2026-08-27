const DEFAULT_CONCURRENCY = 4;

function clampConcurrency(value) {
  return Math.max(1, Math.min(Number.parseInt(value, 10) || DEFAULT_CONCURRENCY, 8));
}

function normalizeProviderId(type, sourceId) {
  return `${String(type || '').trim()}:${String(sourceId || '').trim()}`;
}

function groupEpisodes(items = [], sourceId = '') {
  const lines = {};
  for (const episode of Array.isArray(items) ? items : []) {
    const lineName = String(episode?.lineName || '线路1').trim() || '线路1';
    if (!lines[lineName]) lines[lineName] = [];
    lines[lineName].push({
      ...episode,
      sourceId: episode?.sourceId || sourceId
    });
  }
  return lines;
}

class SourceProviderRegistry {
  constructor(options = {}) {
    this.cmsApiService = options.cmsApiService || null;
    this.sourcePluginManager = options.sourcePluginManager || null;
    this.sharePageResolver = options.sharePageResolver || null;
    this.mediaLibraryService = options.mediaLibraryService || null;
    this._playbackHeadersByHost = new Map();
  }

  listProviders(options = {}) {
    const includeDisabled = options.includeDisabled !== false;
    const providers = [];

    for (const source of this.cmsApiService?.getSourceList?.() || []) {
      providers.push({
        providerId: normalizeProviderId('cms', source.id),
        sourceId: source.id,
        id: source.id,
        name: source.name,
        displayName: source.displayName || source.name,
        type: 'cms',
        enabled: source.available !== false,
        builtIn: source.isCustom !== true,
        sourcePackId: source.sourcePackId || '',
        resolverId: source.resolverId || '',
        roles: source.roles || [],
        preference: source.preference || 0,
        fallback: (source.roles || []).includes('fallback-catalog'),
        capabilities: ['search', 'detail', 'catalog', 'categories', 'test', 'playback-report'],
        categories: source.categories || [],
        health: source.health || null
      });
    }

    for (const rule of this.sourcePluginManager?.getAllForManagement?.() || []) {
      if (!includeDisabled && !rule.enabled) continue;
      const providerId = normalizeProviderId('xpath', rule.id);
      providers.push({
        providerId,
        sourceId: rule.id,
        id: rule.id,
        name: rule.name,
        displayName: rule.name,
        type: 'xpath',
        enabled: rule.enabled !== false,
        builtIn: !!rule.isBuiltIn,
        capabilities: rule.hasDetail ? ['search', 'detail', 'test'] : ['search', 'test'],
        categories: [],
        health: this.cmsApiService?._getSourceHealth?.(providerId) || rule.health || null
      });
    }

    for (const library of this.mediaLibraryService?.listLibraries?.() || []) {
      if (!includeDisabled && !library.enabled) continue;
      const providerId = normalizeProviderId('media', library.id);
      providers.push({
        providerId,
        sourceId: library.id,
        id: library.id,
        name: library.name,
        displayName: library.name,
        type: 'media',
        mediaType: library.type,
        enabled: library.enabled !== false,
        builtIn: false,
        sourcePackId: library.sourcePackId || '',
        preference: library.preference || 0,
        capabilities: ['search', 'detail', 'catalog', 'test', 'playback-report'],
        categories: [],
        health: this.cmsApiService?._getSourceHealth?.(providerId) || null
      });
    }

    return providers;
  }

  findProviderByRole(role) {
    return this.listProviders({ includeDisabled: false })
      .find(provider => provider.enabled && provider.roles?.includes(role)) || null;
  }

  getProvider(identifier) {
    const value = String(identifier || '').trim();
    if (!value) return null;
    const exact = this.listProviders().find(provider => provider.providerId === value);
    if (exact) return exact;
    return this.listProviders().find(provider => provider.sourceId === value) || null;
  }

  async search(identifier, keyword, options = {}) {
    const provider = this.getProvider(identifier);
    if (!provider) throw new Error(`片源不存在: ${identifier}`);
    if (!provider.enabled) throw new Error(`片源已禁用: ${provider.name}`);

    const page = Number.parseInt(options.page, 10) || 1;
    const startedAt = Date.now();
    let result;
    if (provider.type === 'cms') {
      result = await this.cmsApiService.searchInSource(provider.sourceId, keyword, page, options);
      result = await this._hydrateCmsResults(provider, keyword, result, options);
    } else if (provider.type === 'xpath') {
      result = await this.sourcePluginManager.search(provider.sourceId, keyword, options);
      result = this._rankSearchResults(keyword, result);
      result = await this._hydrateXpathResults(provider, result, options);
    } else if (provider.type === 'media') {
      result = await this.mediaLibraryService.search(provider.sourceId, keyword, options);
    } else {
      throw new Error(`不支持的片源类型: ${provider.type}`);
    }

    const data = (result?.data || [])
      .map(item => this._normalizeAnime(provider, item))
      .map(item => ({ ...item, matchConfidence: this._confidence(keyword, item) }))
      .sort((a, b) => b.matchConfidence - a.matchConfidence);
    return {
      success: result?.success !== false,
      provider,
      providerId: provider.providerId,
      sourceId: provider.sourceId,
      sourceName: provider.name,
      sourceType: provider.type,
      data,
      page: result?.page || page,
      total: result?.total || data.length,
      totalPages: result?.totalPages || 1,
      elapsedMs: result?.elapsedMs || (Date.now() - startedAt),
      error: result?.error || ''
    };
  }

  async searchAll(keyword, options = {}) {
    const excluded = new Set(options.excludeProviderIds || options.excludeSourceIds || []);
    let providers = this.listProviders({ includeDisabled: true }).filter(provider => {
      if (!provider.capabilities.includes('search')) return false;
      if (excluded.has(provider.providerId) || excluded.has(provider.sourceId)) return false;
      if (provider.fallback && options.includeFallback === false) return false;
      return true;
    });
    const providerLimit = Math.max(0, Number.parseInt(options.providerLimit, 10) || 0);
    if (providerLimit > 0) {
      providers = providers
        .filter(provider => provider.enabled)
        .sort((a, b) => {
          const scoreA = Number(a.health?.score ?? 70) + (a.fallback ? 3 : 0);
          const scoreB = Number(b.health?.score ?? 70) + (b.fallback ? 3 : 0);
          return scoreB - scoreA;
        })
        .slice(0, providerLimit);
    }

    const statuses = providers.map(provider => ({
      providerId: provider.providerId,
      sourceId: provider.sourceId,
      sourceName: provider.name,
      sourceType: provider.type,
      type: provider.type,
      status: provider.enabled ? 'pending' : 'disabled',
      keyword,
      count: 0,
      results: [],
      confidence: 0,
      health: provider.health || null,
      healthScore: Number(provider.health?.score ?? 70),
      elapsedMs: 0,
      error: provider.enabled ? '' : '源已禁用'
    }));

    let resolveEarly;
    let earlyResolved = false;
    const returnOnFirstSuccess = options.returnOnFirstSuccess === true;
    const providerTimeoutMs = Math.max(0, Number.parseInt(options.providerTimeoutMs, 10) || 0);
    const snapshot = () => {
      const order = { success: 0, noResult: 1, error: 2, disabled: 3, pending: 4 };
      return statuses
        .map(entry => ({ ...entry, results: Array.isArray(entry.results) ? entry.results.slice() : [] }))
        .sort((a, b) => {
          if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
          return (b.confidence || 0) - (a.confidence || 0);
        });
    };
    const earlyResult = returnOnFirstSuccess
      ? new Promise(resolve => { resolveEarly = resolve; })
      : null;

    const completion = this._mapWithConcurrency(providers, clampConcurrency(options.concurrency), async provider => {
      const entry = statuses.find(item => item.providerId === provider.providerId);
      if (!entry || entry.status === 'disabled') return;
      // An early success already satisfied the caller. Do not start more provider
      // requests; only the providers that were already in flight may finish.
      if (returnOnFirstSuccess && earlyResolved) return;
      const startedAt = Date.now();
      let timeoutId = null;
      try {
        const searchPromise = this.search(provider.providerId, keyword, {
          ...options,
          page: 1,
          hydrateLimit: options.hydrateLimit ?? 1
        });
        const result = providerTimeoutMs > 0
          ? await Promise.race([
              searchPromise,
              new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`片源响应超过 ${providerTimeoutMs}ms`)), providerTimeoutMs);
              })
            ])
          : await searchPromise;
        entry.elapsedMs = result.elapsedMs || (Date.now() - startedAt);
        entry.results = result.data || [];
        entry.count = entry.results.length;
        entry.status = entry.count > 0 ? 'success' : 'noResult';
        entry.confidence = entry.count > 0 ? this._confidence(keyword, entry.results[0]) : 0;
        entry.error = result.error || '';
      } catch (error) {
        entry.elapsedMs = Date.now() - startedAt;
        entry.status = 'error';
        entry.error = error?.message || String(error);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      if (returnOnFirstSuccess && !earlyResolved && entry.status === 'success') {
        earlyResolved = true;
        resolveEarly(snapshot());
      }
    });
    completion.then(() => {
      if (returnOnFirstSuccess && !earlyResolved) {
        earlyResolved = true;
        resolveEarly(snapshot());
      }
    });

    if (returnOnFirstSuccess) return earlyResult;
    await completion;
    return snapshot();
  }

  async selectBestEpisodeSource(keyword, target = {}) {
    const excluded = new Set(target.excludeSourceIds || []);
    const alternateProviders = this.listProviders({ includeDisabled: false }).filter(provider => (
      (provider.type === 'media' || provider.type === 'xpath')
      && provider.enabled
      && !excluded.has(provider.sourceId)
      && !excluded.has(provider.providerId)
    ));
    const [cmsResult, mediaResults] = await Promise.all([
      this.cmsApiService?.selectBestEpisodeSource?.(keyword, target)
        || Promise.resolve({ best: null, candidates: [], skipped: [] }),
      this._mapWithConcurrency(alternateProviders, 3, async provider => {
        try {
          const searchResult = await this.search(provider.providerId, keyword, { limit: 5 });
          const candidates = [];
          for (const summary of (searchResult.data || []).slice(0, 3)) {
            let anime = summary;
            if (!anime.episodes || Object.keys(anime.episodes).length === 0) {
              anime = await this.getDetail(provider.providerId, summary);
            }
            const matched = this.cmsApiService?.findMatchingEpisode?.(
              anime.episodes,
              target.episodeTitle || '',
              target.episodeIndex ?? -1
            );
            const mayUseFirst = target.allowFirstFallback !== false
              && (!Number.isFinite(Number(target.episodeIndex)) || Number(target.episodeIndex) <= 0);
            const selected = matched || (mayUseFirst
              ? this.cmsApiService?.firstPlayableEpisode?.(anime.episodes)
              : null);
            const url = selected?.episode?.url || selected?.episode?.play_url || '';
            if (!selected || !url) continue;
            const confidence = this._confidence(keyword, anime);
            const health = provider.health || { score: 70 };
            const quality = selected.episode.quality || {};
            const matchScore = Number(selected.matchScore) || 1;
            const preference = (Number(provider.preference) || 0) + (provider.type === 'media' ? 15 : 0);
            candidates.push({
              providerId: provider.providerId,
              sourceId: provider.sourceId,
              sourceName: provider.name,
              sourceType: provider.type,
              mediaType: provider.mediaType,
              anime,
              episode: selected.episode,
              episodeTitle: selected.episode.title || '',
              lineId: selected.lineId,
              matchType: selected.matchType || 'index',
              matchScore,
              titleMatchScore: confidence,
              titleMatchExact: confidence >= 0.97,
              url,
              quality,
              health,
              healthScore: Number(health.score ?? 70),
              preference,
              score: confidence * 1000000000000
                + matchScore * 1000000000
                + (Number(health.score ?? 70) + preference) * 1000000
                + ((quality.height || 0) * 100000 + (quality.bitrate || 0))
            });
            break;
          }
          return candidates;
        } catch (error) {
          return [{ skipped: true, sourceId: provider.sourceId, sourceName: provider.name, reason: error.message }];
        }
      })
    ]);

    const cmsCandidates = Array.isArray(cmsResult?.candidates) ? cmsResult.candidates.slice() : [];
    if (cmsCandidates.length === 0 && cmsResult?.best) {
      cmsCandidates.push(this.cmsApiService.serializeEpisodeCandidate(cmsResult.best));
    }
    const flattenedMedia = (mediaResults || []).flat();
    const mediaCandidates = flattenedMedia.filter(candidate => !candidate.skipped);
    const skipped = [
      ...(cmsResult?.skipped || []),
      ...flattenedMedia.filter(candidate => candidate.skipped)
    ];
    const candidates = [...cmsCandidates, ...mediaCandidates]
      .filter(candidate => candidate?.url && candidate?.anime && candidate?.episode)
      .filter((candidate, index, items) => items.findIndex(item => (
        item.sourceId === candidate.sourceId && item.url === candidate.url
      )) === index)
      .sort((a, b) => (
        Number(b.titleMatchExact) - Number(a.titleMatchExact)
        || Number(b.titleMatchScore || 0) - Number(a.titleMatchScore || 0)
        || Number(b.matchScore || 0) - Number(a.matchScore || 0)
        || Number(b.score || 0) - Number(a.score || 0)
      ));
    return { best: candidates[0] || null, candidates: candidates.slice(0, 12), skipped };
  }

  async getDetail(identifier, reference = {}, options = {}) {
    const provider = this.getProvider(identifier);
    if (!provider) throw new Error(`片源不存在: ${identifier}`);
    const ref = typeof reference === 'object' && reference !== null ? reference : { id: reference };
    let detail;
    if (provider.type === 'cms') {
      detail = await this.cmsApiService.getDetail(ref.id, { ...options, sourceId: provider.sourceId });
    } else if (provider.type === 'xpath') {
      detail = await this.sourcePluginManager.parseDetail(provider.sourceId, ref.url || ref.href, options);
      detail = this._normalizeXpathDetail(provider, detail, ref);
    } else if (provider.type === 'media') {
      detail = await this.mediaLibraryService.getDetail(provider.sourceId, ref, options);
    }
    return this._normalizeAnime(provider, detail || ref);
  }

  async getCategories(identifier) {
    const provider = this.getProvider(identifier);
    if (!provider) throw new Error(`片源不存在: ${identifier}`);
    if (provider.type === 'cms') {
      return this.cmsApiService.getCategories({ sourceId: provider.sourceId });
    }
    if (provider.type === 'media') return [];
    return provider.categories || [];
  }

  async getCatalog(identifier, options = {}) {
    const provider = this.getProvider(identifier);
    if (!provider) throw new Error(`片源不存在: ${identifier}`);
    const page = Number.parseInt(options.page, 10) || 1;
    if (provider.type === 'cms') {
      return this.cmsApiService.getList(options.categoryId, page, { ...options, sourceId: provider.sourceId });
    }
    if (provider.type === 'media') return this.mediaLibraryService.getCatalog(provider.sourceId, options);
    throw new Error(`${provider.name} 不支持目录浏览`);
  }

  async test(identifier) {
    const provider = this.getProvider(identifier);
    if (!provider) throw new Error(`片源不存在: ${identifier}`);
    if (provider.type === 'cms') {
      const selected = this.cmsApiService.currentSourceId;
      this.cmsApiService.setSource(provider.sourceId);
      try {
        return await this.cmsApiService.test();
      } finally {
        if (selected) this.cmsApiService.setSource(selected);
      }
    }
    if (provider.type === 'xpath') return this.sourcePluginManager.test(provider.sourceId);
    if (provider.type === 'media') return this.mediaLibraryService.test(provider.sourceId);
    throw new Error(`${provider.name} 不支持连通性测试`);
  }

  reportPlayback(identifier, result = {}) {
    const provider = this.getProvider(identifier);
    if (!provider) return { success: false, error: 'provider not found' };
    if (provider.type === 'cms') return this.cmsApiService.recordPlaybackResult(provider.sourceId, result);
    if (provider.type === 'media') return this.cmsApiService.recordPlaybackResult(provider.providerId, result);
    if (provider.type === 'xpath') return this.cmsApiService.recordPlaybackResult(provider.providerId, result);
    return { success: true, ignored: true };
  }

  async resolveEpisode(identifier, episode = {}) {
    const provider = this.getProvider(identifier);
    if (provider?.type === 'media') {
      return this.mediaLibraryService.resolveEpisode(provider.sourceId, episode);
    }
    const url = episode.realUrl || episode.real_video_url || episode.url || episode.play_url || '';
    const sourceConfig = provider?.type === 'cms'
      ? this.cmsApiService?.getSourceConfig?.(provider.sourceId)
      : null;
    const resolverId = episode.resolverId || sourceConfig?.resolverId || provider?.resolverId || '';
    if (this.sharePageResolver?.canResolve?.(url, resolverId)) {
      return this.sharePageResolver.resolve(url, { resolverId });
    }
    return { url, providerId: provider?.providerId || '' };
  }

  canResolveUrl(identifier, url) {
    const provider = this.getProvider(identifier);
    const sourceConfig = provider?.type === 'cms'
      ? this.cmsApiService?.getSourceConfig?.(provider.sourceId)
      : null;
    return this.sharePageResolver?.canResolve?.(url, sourceConfig?.resolverId || provider?.resolverId || '') === true;
  }

  getPlaybackHeaders(identifier, url = '') {
    const provider = this.getProvider(identifier);
    if (provider?.type === 'media') return this.mediaLibraryService.getPlaybackHeaders(provider.sourceId, url);
    if (provider?.type === 'xpath') return this.sourcePluginManager?.getPlaybackHeaders?.(provider.sourceId, url) || {};
    const sourceConfig = provider?.type === 'cms'
      ? this.cmsApiService?.getSourceConfig?.(provider.sourceId)
      : null;
    const configured = sourceConfig?.playbackHeaders || {};
    let fallback = {};
    try {
      if (sourceConfig?.api) fallback = { Referer: `${new URL(sourceConfig.api).origin}/` };
    } catch (_) {
      fallback = {};
    }
    const resolverHeaders = this.sharePageResolver?.getPlaybackHeaders?.(
      url,
      sourceConfig?.resolverId || provider?.resolverId || ''
    ) || {};
    return { ...fallback, ...configured, ...resolverHeaders };
  }

  rememberPlaybackHeaders(identifier, url, headers = {}) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!host) return;
      const values = Object.keys(headers || {}).length > 0
        ? headers
        : this.getPlaybackHeaders(identifier, url);
      this._playbackHeadersByHost.set(host, {
        headers: { ...values },
        expiresAt: Date.now() + 30 * 60 * 1000
      });
      if (this._playbackHeadersByHost.size > 100) {
        const oldest = this._playbackHeadersByHost.keys().next().value;
        if (oldest) this._playbackHeadersByHost.delete(oldest);
      }
    } catch (_) {
      // Ignore malformed third-party URLs.
    }
  }

  getRequestHeadersForUrl(url) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const remembered = this._playbackHeadersByHost.get(host);
      if (remembered) {
        if (remembered.expiresAt > Date.now()) return { ...remembered.headers };
        this._playbackHeadersByHost.delete(host);
      }
    } catch (_) {
      return {};
    }
    const resolverHeaders = this.sharePageResolver?.getRequestHeaders?.(url) || {};
    if (Object.keys(resolverHeaders).length > 0) return resolverHeaders;
    const mediaProvider = this.listProviders({ includeDisabled: false }).find(provider => {
      if (provider.type !== 'media') return false;
      const library = this.mediaLibraryService?.getLibrary?.(provider.sourceId);
      return library?.baseUrl && String(url || '').startsWith(library.baseUrl);
    });
    if (mediaProvider) return this.mediaLibraryService.getPlaybackHeaders(mediaProvider.sourceId, url);
    const source = (this.cmsApiService?.getSourceList?.() || [])
      .map(item => this.cmsApiService?.getSourceConfig?.(item.id))
      .find(item => item?.api && String(url || '').startsWith(new URL(item.api).origin));
    return source?.requestHeaders || {};
  }

  async _hydrateXpathResults(provider, result, options = {}) {
    if (!result?.success || !Array.isArray(result.data) || !provider.capabilities.includes('detail')) return result;
    const limit = Math.max(0, Math.min(Number.parseInt(options.hydrateLimit, 10) || 1, 3));
    const data = result.data.slice();
    await this._mapWithConcurrency(data.slice(0, limit), 2, async item => {
      if (!item.url) return;
      const detail = await this.sourcePluginManager.parseDetail(provider.sourceId, item.url, options);
      if (detail?.success) Object.assign(item, this._normalizeXpathDetail(provider, detail, item));
    });
    return { ...result, data };
  }

  async _hydrateCmsResults(provider, keyword, result, options = {}) {
    if (!Array.isArray(result?.data) || !this.cmsApiService?.getDetail) return result;
    const limit = Math.max(0, Math.min(Number.parseInt(options.hydrateLimit, 10) || 1, 3));
    if (limit === 0) return result;

    const data = result.data.slice();
    const needsDetail = data
      .map((item, index) => ({
        item,
        index,
        confidence: this._confidence(keyword, item)
      }))
      .filter(({ item }) => {
        const lines = item?.episodes && typeof item.episodes === 'object'
          ? Object.values(item.episodes)
          : [];
        return lines.every(line => !Array.isArray(line) || line.length === 0);
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit);

    await this._mapWithConcurrency(needsDetail, 2, async ({ item, index }) => {
      if (!item?.id) return;
      try {
        const detail = await this.cmsApiService.getDetail(item.id, {
          ...options,
          sourceId: provider.sourceId
        });
        if (detail) data[index] = { ...item, ...detail };
      } catch (_) {
        // Keep the search summary; per-source status remains usable.
      }
    });
    return { ...result, data };
  }

  _normalizeXpathDetail(provider, detail = {}, reference = {}) {
    const episodes = groupEpisodes(detail.episodes, provider.providerId);
    return {
      ...reference,
      ...detail,
      id: reference.id || reference.url || `${provider.sourceId}:${detail.name || 'detail'}`,
      name: detail.name || reference.name || '',
      episodes,
      episode_count: Object.values(episodes).reduce((max, list) => Math.max(max, list.length), 0)
    };
  }

  _normalizeAnime(provider, item = {}) {
    const episodes = Array.isArray(item.episodes)
      ? groupEpisodes(item.episodes, provider.providerId)
      : (item.episodes || {});
    return {
      ...item,
      source: provider.type === 'xpath' ? provider.providerId : (item.source || provider.sourceId),
      sourceId: provider.sourceId,
      providerId: provider.providerId,
      sourceName: provider.name,
      sourceType: provider.type,
      episodes
    };
  }

  _rankSearchResults(keyword, result) {
    if (!Array.isArray(result?.data)) return result;
    return {
      ...result,
      data: result.data.slice().sort((a, b) => this._confidence(keyword, b) - this._confidence(keyword, a))
    };
  }

  _confidence(keyword, anime) {
    const query = String(keyword || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const name = String(anime?.name || anime?.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!query || !name) return 0.5;
    if (query === name) return 0.98;
    if (name.includes(query) || query.includes(name)) return 0.86;
    const queryTokens = new Set(query.split(/[\s:：·・\-_]+/).filter(Boolean));
    const nameTokens = name.split(/[\s:：·・\-_]+/).filter(Boolean);
    const matches = nameTokens.filter(token => queryTokens.has(token)).length;
    return Math.max(0.35, Math.min(0.8, matches / Math.max(queryTokens.size, nameTokens.length, 1)));
  }

  async _mapWithConcurrency(items, concurrency, worker) {
    let cursor = 0;
    const results = new Array(items.length);
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }
}

module.exports = {
  SourceProviderRegistry,
  normalizeProviderId,
  groupEpisodes
};
