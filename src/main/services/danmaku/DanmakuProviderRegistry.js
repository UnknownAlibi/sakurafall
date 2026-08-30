const HttpClient = require('../../utils/HttpClient');
const { scoreTitleMatch, normalizeTitle } = require('../cms/TitleMatcher');

const DEFAULT_PROVIDERS = Object.freeze({
  bilibili: true,
  acfun: true,
  dandanplay: true,
  custom: true
});

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\+$/g, '')
    .trim();
}

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

function normalizeComment(comment, source) {
  if (!comment) return null;
  const text = String(comment.text ?? comment.body ?? comment.m ?? comment.M ?? '').trim();
  if (!text) return null;
  const time = Number(comment.time ?? comment.position ?? 0);
  if (!Number.isFinite(time) || time < 0) return null;
  const rawType = Number(comment.rawType ?? comment.mode ?? comment.typeCode ?? 1);
  let type = comment.type;
  if (!['scroll', 'top', 'bottom'].includes(type)) {
    type = rawType === 4 ? 'bottom' : rawType === 5 ? 'top' : 'scroll';
  }
  const color = Number(comment.color);
  return {
    time,
    color: Number.isFinite(color) ? color : 0xFFFFFF,
    text,
    type,
    source
  };
}

function parseBilibiliXml(content, source = 'bilibili') {
  const comments = [];
  const regex = /<d\s+[^>]*p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/gi;
  let match;
  while ((match = regex.exec(String(content || ''))) !== null) {
    const p = match[1].split(',');
    const item = normalizeComment({
      time: Number(p[0]),
      rawType: Number(p[1]),
      color: Number(p[3] || p[2]),
      text: stripHtml(match[2])
    }, source);
    if (item) comments.push(item);
  }
  return comments;
}

function titleScore(candidate, context) {
  const titles = [context?.animeName, ...(context?.aliases || [])].filter(Boolean);
  const candidateVariants = [
    candidate,
    String(candidate || '').replace(/^\s*(?:【|\[)[12]\d{3}(?:】|\])\s*/, ''),
    String(candidate || '').replace(/^\s*(?:【|\[)[^】\]]{1,16}(?:】|\])\s*/, '')
  ].filter((item, index, list) => item && list.indexOf(item) === index);
  let best = { score: 0, reliable: false, exact: false };
  for (const title of titles) {
    for (const variant of candidateVariants) {
      const score = scoreTitleMatch(title, variant);
      if (score.score > best.score) best = score;
    }
  }
  const wanted = normalizeTitle(context?.animeName);
  const actual = normalizeTitle(candidate);
  if (wanted && actual && !wanted.includes('中配') && actual.includes('中配')) {
    return { ...best, score: Math.max(0, best.score - 0.2), exact: false };
  }
  return best;
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

class BilibiliDanmakuProvider {
  constructor(http) {
    this.id = 'bilibili';
    this.name = '哔哩哔哩';
    this.http = http;
  }

  async _json(url, options = {}) {
    const text = await this.http.fetch(url, {
      ...options,
      referer: 'https://www.bilibili.com/',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.bilibili.com',
        ...(options.headers || {})
      }
    });
    const data = JSON.parse(text);
    if (Number(data?.code) !== 0) throw new Error(data?.message || `B站接口错误 ${data?.code}`);
    return data;
  }

  async search(context) {
    const queries = [context.animeName, ...(context.aliases || [])]
      .map(stripHtml)
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 3);
    const candidates = [];
    for (const query of queries) {
      const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(query)}&page=1`;
      const data = await this._json(url);
      const groups = Array.isArray(data?.data?.result) ? data.data.result : [];
      const media = groups.find(group => group.result_type === 'media_bangumi');
      for (const item of (media?.data || [])) {
        const title = stripHtml(item.title || item.org_title);
        const match = titleScore(title, context);
        candidates.push({
          id: String(item.season_id || item.pgc_season_id || ''),
          title,
          seasonId: item.season_id || item.pgc_season_id,
          episodes: item.eps || [],
          score: match.score,
          reliable: match.reliable,
          providerId: this.id
        });
      }
      if (candidates.some(item => item.reliable)) break;
    }
    return candidates
      .filter((item, index, list) => item.id && list.findIndex(other => other.id === item.id) === index)
      .sort((a, b) => b.score - a.score);
  }

  async resolve(context) {
    const override = context?.overrides?.bilibili || {};
    if (override.cid) {
      return this._commentsForCid(override.cid, {
        title: override.title || context.animeName,
        episodeNumber: context.episodeNumber,
        cid: override.cid,
        manual: true
      });
    }

    let candidate = null;
    if (override.seasonId || override.epId) {
      candidate = {
        title: override.title || context.animeName,
        seasonId: override.seasonId,
        epId: override.epId,
        score: 1,
        reliable: true
      };
    } else {
      candidate = (await this.search(context)).find(item => item.reliable) || null;
    }
    if (!candidate) return { comments: [], match: null, candidates: await this.search(context) };

    const seasonQuery = candidate.epId
      ? `ep_id=${encodeURIComponent(candidate.epId)}`
      : `season_id=${encodeURIComponent(candidate.seasonId)}`;
    const detail = await this._json(`https://api.bilibili.com/pgc/view/web/season?${seasonQuery}`);
    const episodes = detail?.result?.episodes || [];
    const episode = selectEpisode(episodes, context.episodeNumber);
    if (!episode?.cid) {
      return { comments: [], match: { ...candidate, episodeNumber: context.episodeNumber }, candidates: [candidate] };
    }
    return this._commentsForCid(episode.cid, {
      title: candidate.title,
      seasonId: candidate.seasonId || detail?.result?.season_id,
      epId: episode.id,
      cid: episode.cid,
      episodeNumber: extractEpisodeNumber(episode) || Number(context.episodeNumber) || 0,
      score: candidate.score
    });
  }

  async _commentsForCid(cid, match) {
    const xml = await this.http.fetch(`https://comment.bilibili.com/${encodeURIComponent(cid)}.xml`, {
      referer: 'https://www.bilibili.com/',
      headers: { Accept: 'application/xml,text/xml,*/*' },
      maxResponseBytes: 20 * 1024 * 1024
    });
    return { comments: parseBilibiliXml(xml, this.id), match, candidates: [] };
  }
}

class AcfunDanmakuProvider {
  constructor(http) {
    this.id = 'acfun';
    this.name = 'AcFun';
    this.http = http;
  }

  async search(context) {
    const queries = [context.animeName, ...(context.aliases || [])]
      .map(stripHtml)
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 2);
    const candidates = [];
    for (const query of queries) {
      const html = await this.http.fetch(`https://www.acfun.cn/search?keyword=${encodeURIComponent(query)}`, {
        referer: 'https://www.acfun.cn/',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        maxResponseBytes: 5 * 1024 * 1024
      });
      const regex = /href=\\?"\/a\/aa(\d+)\\?"[^>]*>[\s\S]{0,400}?<img[^>]+alt=\\?"([^"]+)\\?"/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        const title = stripHtml(match[2].replace(/\\"/g, '"'));
        const scored = titleScore(title, context);
        candidates.push({
          id: match[1],
          albumId: match[1],
          title,
          score: scored.score,
          reliable: scored.reliable,
          providerId: this.id
        });
      }
      if (candidates.some(item => item.reliable)) break;
    }
    return candidates
      .filter((item, index, list) => list.findIndex(other => other.id === item.id) === index)
      .sort((a, b) => b.score - a.score);
  }

  async _loadAlbum(albumId) {
    const url = `https://www.acfun.cn/rest/pc-direct/arubamu/content/list?arubamuId=${encodeURIComponent(albumId)}&page=1&pageSize=100`;
    const text = await this.http.fetch(url, {
      referer: 'https://www.acfun.cn/',
      headers: { Accept: 'application/json, text/plain, */*' },
      maxResponseBytes: 8 * 1024 * 1024
    });
    const data = JSON.parse(text);
    if (Number(data?.result) !== 0) throw new Error(data?.error_msg || 'AcFun 合集接口错误');
    return { albumContent: { contentList: data.contents || [] } };
  }

  async resolve(context) {
    const override = context?.overrides?.acfun || {};
    if (override.videoId) {
      return this._commentsForVideo(override.videoId, {
        title: override.title || context.animeName,
        videoId: override.videoId,
        albumId: override.albumId || '',
        episodeNumber: context.episodeNumber,
        manual: true
      });
    }
    const candidate = override.albumId
      ? { albumId: override.albumId, title: override.title || context.animeName, score: 1, reliable: true }
      : (await this.search(context)).find(item => item.reliable);
    if (!candidate) return { comments: [], match: null, candidates: await this.search(context) };

    const album = await this._loadAlbum(candidate.albumId);
    const content = album?.albumContent?.contentList || [];
    const episode = selectEpisode(content.map(item => ({
      ...item,
      episodeNumber: extractEpisodeNumber(item.title)
    })), context.episodeNumber);
    const video = (episode?.videoList || []).sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0))[0];
    if (!video?.id) {
      return { comments: [], match: { ...candidate, episodeNumber: context.episodeNumber }, candidates: [candidate] };
    }
    return this._commentsForVideo(video.id, {
      title: candidate.title,
      albumId: candidate.albumId,
      videoId: video.id,
      episodeNumber: extractEpisodeNumber(episode) || Number(context.episodeNumber) || 0,
      score: candidate.score
    });
  }

  async _commentsForVideo(videoId, match) {
    const comments = [];
    let cursor = '1';
    for (let page = 0; page < 20 && cursor !== 'no_more'; page += 1) {
      const body = new URLSearchParams({
        resourceId: String(videoId), resourceType: '9', enableAdvanced: 'true',
        pcursor: cursor, count: '1000', sortType: '1', asc: 'true'
      }).toString();
      const text = await this.http.fetch('https://www.acfun.cn/rest/pc-direct/new-danmaku/list', {
        method: 'POST', body,
        referer: match.albumId ? `https://www.acfun.cn/a/aa${match.albumId}` : 'https://www.acfun.cn/',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        maxResponseBytes: 10 * 1024 * 1024
      });
      const data = JSON.parse(text);
      if (Number(data?.result) !== 0) throw new Error(data?.error_msg || 'AcFun 弹幕接口错误');
      for (const item of (data.danmakus || [])) {
        const comment = normalizeComment({
          time: Number(item.position || 0) / 1000,
          rawType: Number(item.mode),
          color: item.color,
          text: item.body
        }, this.id);
        if (comment) comments.push(comment);
      }
      cursor = String(data.pcursor || 'no_more');
    }
    return { comments, match, candidates: [] };
  }
}

class CustomDanmakuProvider {
  constructor(http, getConfig) {
    this.id = 'custom';
    this.name = '自定义接口';
    this.http = http;
    this.getConfig = getConfig;
  }

  async resolve(context) {
    const config = this.getConfig();
    const endpoint = String(config.customEndpoint || '').trim();
    if (!endpoint) {
      const error = new Error('未配置自定义弹幕接口');
      error.code = 'DANMAKU_NOT_CONFIGURED';
      throw error;
    }
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('自定义弹幕接口仅支持 HTTP/HTTPS');
    const hasPlaceholders = /\{(?:name|episode|bgmId)\}/.test(endpoint);
    const url = hasPlaceholders
      ? endpoint
        .replace(/\{name\}/g, encodeURIComponent(context.animeName || ''))
        .replace(/\{episode\}/g, encodeURIComponent(context.episodeNumber || ''))
        .replace(/\{bgmId\}/g, encodeURIComponent(context.bgmId || ''))
      : endpoint;
    const headers = { Accept: 'application/json, application/xml, text/xml, */*' };
    if (config.customToken) headers.Authorization = `Bearer ${config.customToken}`;
    const options = hasPlaceholders
      ? { headers }
      : { method: 'POST', body: JSON.stringify(context), headers: { ...headers, 'Content-Type': 'application/json' } };
    const text = await this.http.fetch(url, { ...options, maxResponseBytes: 20 * 1024 * 1024 });
    if (/^\s*</.test(text)) {
      return { comments: parseBilibiliXml(text, this.id), match: { endpoint }, candidates: [] };
    }
    const data = JSON.parse(text);
    const raw = Array.isArray(data) ? data : (data.comments || data.data?.comments || []);
    const comments = raw.map(item => {
      if (item.p || item.P) {
        const p = String(item.p || item.P).split(',');
        return normalizeComment({ time: p[0], rawType: p[1], color: p[2], text: item.m || item.M }, this.id);
      }
      return normalizeComment(item, this.id);
    }).filter(Boolean);
    return { comments, match: data.match || { endpoint }, candidates: data.candidates || [] };
  }
}

class DanmakuProviderRegistry {
  constructor(options = {}) {
    this.http = options.http || new HttpClient({ timeout: 12000 });
    this.db = null;
    this.config = {
      providers: { ...DEFAULT_PROVIDERS },
      customEndpoint: '',
      customToken: ''
    };
    this.dandanplay = null;
    this.providers = new Map();
    this.register(new BilibiliDanmakuProvider(this.http));
    this.register(new AcfunDanmakuProvider(this.http));
    this.register(new CustomDanmakuProvider(this.http, () => this.config));
  }

  register(provider) {
    if (!provider?.id || typeof provider.resolve !== 'function') throw new Error('无效的弹幕源适配器');
    this.providers.set(provider.id, provider);
  }

  setDandanplay(api) { this.dandanplay = api; }
  setDatabase(db) { this.db = db; }
  setProxy(proxy) { this.http.setProxy(proxy || ''); }
  setTimeout(timeout) { this.http.setTimeout(timeout); }

  configure(config = {}) {
    this.config = {
      ...this.config,
      providers: { ...DEFAULT_PROVIDERS, ...this.config.providers, ...(config.providers || {}) },
      customEndpoint: String(config.customEndpoint ?? this.config.customEndpoint ?? '').trim(),
      customToken: String(config.customToken ?? this.config.customToken ?? '').trim()
    };
    return this.listProviders();
  }

  listProviders() {
    const rows = [
      { id: 'bilibili', name: '哔哩哔哩', configured: true, zeroConfig: true },
      { id: 'acfun', name: 'AcFun', configured: true, zeroConfig: true },
      { id: 'dandanplay', name: '弹弹play 聚合', configured: !!this.dandanplay?.isReady?.(), zeroConfig: false },
      { id: 'custom', name: '自定义接口', configured: !!this.config.customEndpoint, zeroConfig: false },
      { id: 'local', name: '本地 XML', configured: true, zeroConfig: true, manual: true }
    ];
    return rows.map(item => ({ ...item, enabled: item.id === 'local' || this.config.providers[item.id] !== false }));
  }

  async resolve(context = {}) {
    const normalized = this._normalizeContext(context);
    if (!normalized.animeName && !normalized.overrides) throw new Error('缺少番剧名称，无法匹配弹幕');
    const cacheKey = this._cacheKey(normalized);
    if (!normalized.forceRefresh) {
      const cached = this._readCache(cacheKey);
      if (cached) return { ...cached, cached: true };
    }
    const requested = Array.isArray(normalized.providerIds) && normalized.providerIds.length
      ? normalized.providerIds
      : ['bilibili', 'acfun', 'dandanplay', 'custom'];
    const providerIds = requested.filter(id => this.config.providers[id] !== false);
    const statuses = await Promise.all(providerIds.map(id => this._resolveProviderWithTimeout(id, normalized)));
    const comments = this._mergeComments(statuses.flatMap(item => item.comments || []));
    const result = {
      success: comments.length > 0,
      comments,
      total: comments.length,
      sources: statuses.map(({ comments: _comments, ...status }) => status),
      cached: false,
      resolvedAt: Date.now()
    };
    this._writeCache(cacheKey, result, 6 * 60 * 60 * 1000);
    return result;
  }

  async search(context = {}) {
    const normalized = this._normalizeContext(context);
    const ids = (normalized.providerIds || ['bilibili', 'acfun']).filter(id => ['bilibili', 'acfun'].includes(id));
    return Promise.all(ids.map(async id => {
      const provider = this.providers.get(id);
      const startedAt = Date.now();
      try {
        const candidates = await provider.search(normalized);
        return { id, name: provider.name, status: candidates.length ? 'ok' : 'empty', candidates, elapsedMs: Date.now() - startedAt };
      } catch (error) {
        return { id, name: provider.name, status: 'error', candidates: [], message: error.message, elapsedMs: Date.now() - startedAt };
      }
    }));
  }

  async _resolveProvider(id, context) {
    const startedAt = Date.now();
    let name = id;
    try {
      let result;
      if (id === 'dandanplay') {
        name = '弹弹play 聚合';
        if (!this.dandanplay?.isReady?.()) {
          const error = new Error('未配置 AppID/AppSecret');
          error.code = 'DANMAKU_NOT_CONFIGURED';
          throw error;
        }
        const override = context?.overrides?.dandanplay || {};
        let match = override.episodeId ? { episodeId: override.episodeId, manual: true } : null;
        let candidates = [];
        if (!match) {
          candidates = await this.dandanplay.searchAnime(context.animeName);
          match = this._selectDandanEpisode(candidates, context);
        }
        const comments = match?.episodeId ? await this.dandanplay.getComments(match.episodeId) : [];
        result = { comments: comments.map(item => normalizeComment(item, id)).filter(Boolean), match, candidates };
      } else {
        const provider = this.providers.get(id);
        if (!provider) throw new Error('弹幕源不存在');
        name = provider.name;
        result = await provider.resolve(context);
      }
      const comments = Array.isArray(result?.comments) ? result.comments : [];
      return {
        id, name, status: comments.length ? 'ok' : 'empty', count: comments.length,
        comments, match: result?.match || null, candidates: result?.candidates || [],
        elapsedMs: Date.now() - startedAt,
        message: comments.length ? '' : '没有匹配到当前分集的弹幕'
      };
    } catch (error) {
      return {
        id, name, status: error?.code === 'DANMAKU_NOT_CONFIGURED' ? 'needs-config' : 'error',
        count: 0, comments: [], match: null, candidates: [], elapsedMs: Date.now() - startedAt,
        message: error?.message || String(error)
      };
    }
  }

  async _resolveProviderWithTimeout(id, context) {
    const timeoutMs = id === 'custom' ? 10000 : 8000;
    let timeoutId;
    try {
      return await Promise.race([
        this._resolveProvider(id, context),
        new Promise(resolve => {
          timeoutId = setTimeout(() => resolve({
            id,
            name: this.providers.get(id)?.name || (id === 'dandanplay' ? '弹弹play 聚合' : id),
            status: 'error',
            count: 0,
            comments: [],
            match: null,
            candidates: [],
            elapsedMs: timeoutMs,
            message: `响应超过 ${timeoutMs / 1000} 秒`
          }), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  _selectDandanEpisode(candidates, context) {
    const ranked = (candidates || []).map(item => ({ item, ...titleScore(item.title || item.animeTitle, context) }))
      .sort((a, b) => b.score - a.score);
    for (const entry of ranked) {
      const episode = selectEpisode(entry.item.episodes, context.episodeNumber);
      const episodeId = episode?.episodeId ?? episode?.id;
      if (episodeId) {
        return {
          animeId: entry.item.animeId ?? entry.item.id,
          animeTitle: entry.item.title || entry.item.animeTitle,
          episodeId,
          episodeTitle: episode.episodeTitle || episode.title || '',
          episodeNumber: extractEpisodeNumber(episode) || context.episodeNumber,
          score: entry.score
        };
      }
    }
    return null;
  }

  _normalizeContext(context) {
    const plain = JSON.parse(JSON.stringify(context || {}));
    const aliases = [plain.animeName, ...(plain.aliases || [])]
      .map(stripHtml).filter((item, index, list) => item && list.indexOf(item) === index).slice(0, 12);
    return {
      ...plain,
      animeName: stripHtml(plain.animeName || aliases[0]),
      aliases,
      episodeNumber: Math.max(0, Number(plain.episodeNumber) || 0),
      bgmId: plain.bgmId ? String(plain.bgmId) : ''
    };
  }

  _mergeComments(comments) {
    const priority = { dandanplay: 0, bilibili: 1, acfun: 2, custom: 3, local: 4 };
    const sorted = comments.slice().sort((a, b) => (a.time - b.time) || ((priority[a.source] ?? 9) - (priority[b.source] ?? 9)));
    const seen = new Map();
    const result = [];
    for (const raw of sorted) {
      const item = normalizeComment(raw, raw.source || 'unknown');
      if (!item) continue;
      const textKey = item.text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
      const bucket = Math.round(item.time / 1.5);
      const keys = [`${textKey}|${item.type}|${bucket - 1}`, `${textKey}|${item.type}|${bucket}`, `${textKey}|${item.type}|${bucket + 1}`];
      if (keys.some(key => seen.has(key) && Math.abs(seen.get(key) - item.time) <= 2)) continue;
      seen.set(`${textKey}|${item.type}|${bucket}`, item.time);
      result.push(item);
    }
    return result;
  }

  _cacheKey(context) {
    const overrideKey = JSON.stringify(context.overrides || {});
    const providerKey = (context.providerIds || []).join(',');
    return `danmaku:merged:v2:${normalizeTitle(context.animeName)}:${context.episodeNumber}:${context.bgmId}:${providerKey}:${overrideKey}`;
  }

  _readCache(key) {
    try { return this.db?.getCache(key) || null; } catch (_) { return null; }
  }

  _writeCache(key, value, ttl) {
    try { this.db?.setCache(key, 'danmaku', 'merged', value, ttl); } catch (_) { /* cache is optional */ }
  }
}

module.exports = {
  DanmakuProviderRegistry,
  BilibiliDanmakuProvider,
  AcfunDanmakuProvider,
  CustomDanmakuProvider,
  parseBilibiliXml,
  normalizeComment,
  extractEpisodeNumber,
  selectEpisode
};
