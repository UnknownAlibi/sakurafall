const crypto = require('crypto');
const zlib = require('zlib');
const HttpClient = require('../../utils/HttpClient');
const { scoreTitleMatch, normalizeTitle } = require('../cms/TitleMatcher');

const DEFAULT_PROVIDERS = Object.freeze({
  bilibili: true,
  acfun: true,
  dandanplay: true,
  custom: true,
  tencent: true,
  iqiyi: true,
  youku: true
});

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex');
}

// 并发受限地执行分片任务，单个分片失败返回空数组跳过
async function fetchSegmentsWithConcurrency(tasks, { concurrency = 6, limit = 200 } = {}) {
  const results = [];
  const list = tasks.slice(0, limit);
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = await Promise.all(list.slice(i, i + concurrency).map(task => task().catch(() => [])));
    for (const items of batch) results.push(...(Array.isArray(items) ? items : []));
  }
  return results;
}

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

class TencentDanmakuProvider {
  constructor(http) {
    this.id = 'tencent';
    this.name = '腾讯视频';
    this.http = http;
  }

  _headers(referer) {
    return {
      'Content-Type': 'application/json',
      Origin: 'https://v.qq.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: referer,
      Cookie: 'tvfe_boss_uuid=ee8f05103d59226f; pgv_pvid=3155633511; video_platform=2; ptag=v_qq_com; main_login=qq'
    };
  }

  async _postJson(url, payload, referer) {
    const text = await this.http.fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: this._headers(referer),
      maxResponseBytes: 5 * 1024 * 1024
    });
    const data = JSON.parse(text);
    if (Number(data?.ret) !== 0) throw new Error(`腾讯视频接口错误 ret=${data?.ret}`);
    return data;
  }

  async search(context) {
    const queries = [context.animeName, ...(context.aliases || [])]
      .map(stripHtml)
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 2);
    const candidates = [];
    for (const query of queries) {
      let data;
      try {
        data = await this._postJson(
          'https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2',
          {
            version: '25071701', clientType: 1, filterValue: '',
            uuid: '0379274D-05A0-4EB6-A89C-878C9A460426',
            query, retry: 0, pagenum: 0, isPrefetch: true, pagesize: 30,
            queryFrom: 0, searchDatakey: '', transInfo: '', isneedQc: true,
            preQid: '', adClientInfo: '',
            extraInfo: { multi_terminal_pc: '1', themeType: '1', sugRelatedIds: '{}', appVersion: '' }
          },
          `https://v.qq.com/x/search/?q=${encodeURIComponent(query)}&stag=&smartbox_ab=`
        );
      } catch (_) {
        continue;
      }
      const boxes = data?.data?.areaBoxList || [];
      let itemList = [];
      for (const box of boxes) {
        if (box.boxId === 'MainNeed' && Array.isArray(box.itemList)) {
          itemList = box.itemList;
          break;
        }
      }
      if (!itemList.length) itemList = data?.data?.normalList?.itemList || [];
      for (const box of boxes) {
        const titles = Array.isArray(box?.boxTitle?.boxTitles) ? box.boxTitle.boxTitles : [];
        if (titles.includes('相关影视') && Array.isArray(box.itemList)) {
          itemList = [...itemList, ...box.itemList.filter(item =>
            item?.videoInfo?.title && item.videoInfo.title.includes(query))];
          break;
        }
      }
      for (const item of itemList) {
        const videoInfo = item?.videoInfo;
        const cid = item?.doc?.id;
        if (!videoInfo || !cid) continue;
        if (!videoInfo.year || videoInfo.subTitle === '全网搜' || videoInfo.playFlag === 2) continue;
        const contentType = String(videoInfo.typeName || '');
        if (!['电视剧', '动漫', '电影', '纪录片', '综艺', '综艺节目'].includes(contentType) || contentType.includes('短剧')) continue;
        const title = stripHtml(videoInfo.title);
        if (!title) continue;
        const scored = titleScore(title, context);
        candidates.push({
          id: String(cid),
          title,
          year: Number(videoInfo.year) || 0,
          episodeCount: Number(videoInfo?.subjectDoc?.videoNum) || 0,
          score: scored.score,
          reliable: scored.reliable,
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
    const override = context?.overrides?.tencent || {};
    if (override.vid) {
      return this._commentsForVid(override.vid, {
        title: override.title || context.animeName,
        cid: override.cid || '',
        vid: override.vid,
        episodeNumber: context.episodeNumber,
        manual: true
      });
    }
    const candidate = override.cid
      ? { id: String(override.cid), title: override.title || context.animeName, score: 1, reliable: true }
      : (await this.search(context)).find(item => item.reliable);
    if (!candidate) return { comments: [], match: null, candidates: await this.search(context) };

    const episodes = await this._loadEpisodes(candidate.id);
    const episode = selectEpisode(episodes, context.episodeNumber);
    if (!episode?.vid) {
      return { comments: [], match: { ...candidate, episodeNumber: context.episodeNumber }, candidates: [candidate] };
    }
    return this._commentsForVid(episode.vid, {
      title: candidate.title,
      cid: candidate.id,
      vid: episode.vid,
      episodeNumber: extractEpisodeNumber(episode) || Number(context.episodeNumber) || 0,
      score: candidate.score,
      manual: !!override.cid
    });
  }

  async _loadEpisodes(cid) {
    const episodesUrl = 'https://pbaccess.video.qq.com/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?video_appid=3000010&vversion_name=8.2.96&vversion_platform=2';
    const referer = `https://v.qq.com/x/cover/${cid}.html`;
    const payload = {
      has_cache: 1,
      page_params: {
        req_from: 'web_vsite',
        page_id: 'vsite_episode_list',
        page_type: 'detail_operation',
        id_type: '1',
        page_size: '',
        cid,
        vid: '',
        lid: '',
        page_num: '',
        page_context: `cid=${cid}&detail_page_type=1&req_from=web_vsite&req_from_second_type=&req_type=0`,
        detail_page_type: '1'
      }
    };
    const data = await this._postJson(episodesUrl, payload, referer);
    const episodes = [];
    const seen = new Set();
    const pushItems = (pageData) => {
      for (const moduleList of pageData?.data?.module_list_datas || []) {
        for (const module of moduleList.module_datas || []) {
          for (const item of module?.item_data_lists?.item_datas || []) {
            const params = item.item_params || {};
            if (!params.vid || params.is_trailer === '1' || seen.has(params.vid)) continue;
            seen.add(params.vid);
            episodes.push({ vid: params.vid, title: stripHtml(params.union_title || params.title || '') });
          }
        }
      }
    };
    pushItems(data);
    // 分页 tabs（正片/花絮/更多）逐页补全
    let tabs = [];
    for (const moduleList of data?.data?.module_list_datas || []) {
      for (const module of moduleList.module_datas || []) {
        if (module.module_params?.tabs) {
          try { tabs = JSON.parse(module.module_params.tabs); } catch (_) { tabs = []; }
          break;
        }
      }
      if (tabs.length) break;
    }
    for (const tab of tabs) {
      if (!tab.page_context) continue;
      try {
        const tabData = await this._postJson(episodesUrl, {
          ...payload,
          page_params: { ...payload.page_params, page_context: tab.page_context }
        }, referer);
        pushItems(tabData);
      } catch (_) { /* 单个分页失败跳过 */ }
    }
    return episodes;
  }

  async _commentsForVid(vid, match) {
    const base = JSON.parse(await this.http.fetch(`https://dm.video.qq.com/barrage/base/${encodeURIComponent(vid)}`, {
      headers: { Accept: 'application/json' }
    }));
    const segments = Object.values(base?.segment_index || {})
      .slice(0, 200)
      .map(item => `https://dm.video.qq.com/barrage/segment/${vid}/${item.segment_name}`);
    const comments = await fetchSegmentsWithConcurrency(segments.map(url => async () => {
      const data = JSON.parse(await this.http.fetch(url, { headers: { Accept: 'application/json' } }));
      return (data?.barrage_list || []).map(item => {
        let color = 0xFFFFFF;
        let rawType = 1;
        if (item.content_style) {
          try {
            const style = JSON.parse(item.content_style);
            const hex = String(style.gradient_colors?.[0] || style.color || '').replace('#', '');
            if (hex && hex !== 'ffffff') color = parseInt(hex, 16) || 0xFFFFFF;
            if (style.position === 2) rawType = 5;
            else if (style.position === 3) rawType = 4;
          } catch (_) { /* 保留默认样式 */ }
        }
        return normalizeComment({
          time: Number(item.time_offset || 0) / 1000,
          rawType,
          color,
          text: item.content
        }, this.id);
      }).filter(Boolean);
    }));
    return { comments, match, candidates: [] };
  }
}

class IqiyiDanmakuProvider {
  constructor(http) {
    this.id = 'iqiyi';
    this.name = '爱奇艺';
    this.http = http;
  }

  // 桌面客户端接口签名：参数按 key 排序后拼接 secret_key 再 md5 大写
  _signParams(params) {
    const parts = Object.keys(params).sort()
      .filter(key => key !== 'sign')
      .map(key => `${key}=${params[key] ?? ''}`);
    return md5(`${parts.join('&')}&secret_key=howcuteitis`).toUpperCase();
  }

  // link_id → entity_id：base36 解码后与固定 key 异或（48 位，超出位运算范围需分段处理）
  _entityId(linkId) {
    const base36 = parseInt(linkId, 36);
    if (!Number.isFinite(base36) || base36 <= 0) return null;
    const key = 0x75706971676c;
    const low = base36 ^ (key % 0x100000000);
    const high = Math.floor(base36 / 0x100000000) ^ Math.floor(key / 0x100000000);
    const xor = high * 0x100000000 + low;
    return String(xor < 900000 ? 100 * (xor + 900000) : xor);
  }

  async search(context) {
    const queries = [context.animeName, ...(context.aliases || [])]
      .map(stripHtml)
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 2);
    const candidates = [];
    for (const query of queries) {
      const params = {
        key: query, current_page: '1', mode: '1', source: 'input', suggest: '',
        pcv: '13.074.22699', version: '13.074.22699', pageNum: '1', pageSize: '25',
        pu: '', u: 'f6440fc5d919dca1aea12b6aff56e1c7', scale: '200', token: '',
        userVip: '0', conduit: '', vipType: '-1', os: '', osShortName: 'win10',
        dataType: '', appMode: '',
        ad: JSON.stringify({ lm: 3, azd: 1000000000951, azt: 733, position: 'feed' }),
        adExt: JSON.stringify({ r: '2.1.5-ares6-pure' })
      };
      const url = `https://mesh.if.iqiyi.com/portal/lw/search/homePageV3?${new URLSearchParams(params)}`;
      // code === "-1" 为风控，延时后重试（最多 2 次）
      let data = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          data = JSON.parse(await this.http.fetch(url, {
            referer: 'https://www.iqiyi.com/',
            headers: { Accept: '*/*', Origin: 'https://www.iqiyi.com' }
          }));
        } catch (_) {
          data = null;
        }
        if (data && data.code !== '-1') break;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 3000));
      }
      if (!data || data.code === '-1' || !data?.data?.templates) continue;
      for (const template of data.data.templates) {
        // 意图聚合卡片（112）与普通结果卡片（101/102/103）
        const albums = template.template === 112
          ? (template.intentAlbumInfos || [])
          : [101, 102, 103].includes(template.template) && template.albumInfo ? [template.albumInfo] : [];
        for (const album of albums) {
          if (!album?.title || album.btnText === '外站付费播放') continue;
          const channel = String(album.channel || '');
          // 只保留支持的类型；电影无分集 tvid，动画番剧场景直接跳过
          if (!['动漫', '电视剧', '综艺', '纪录片'].some(type => channel.includes(type))) continue;
          const linkId = String(album.pageUrl || '').match(/v_(\w+?)\.html/)?.[1];
          if (!linkId) continue;
          const title = stripHtml(album.title).replace(/:/g, '：');
          const scored = titleScore(title, context);
          candidates.push({
            id: linkId,
            title,
            year: Number(String(album?.year?.value || album?.year?.name || album?.superscript || '').match(/^\d{4}$/)?.[0]) || 0,
            score: scored.score,
            reliable: scored.reliable,
            providerId: this.id
          });
        }
      }
      if (candidates.some(item => item.reliable)) break;
    }
    return candidates
      .filter((item, index, list) => item.id && list.findIndex(other => other.id === item.id) === index)
      .sort((a, b) => b.score - a.score);
  }

  async resolve(context) {
    const override = context?.overrides?.iqiyi || {};
    if (override.tvid) {
      return this._commentsForTvid(override.tvid, {
        title: override.title || context.animeName,
        linkId: override.linkId || '',
        tvid: override.tvid,
        episodeNumber: context.episodeNumber,
        manual: true
      });
    }
    const candidate = override.linkId
      ? { id: String(override.linkId), title: override.title || context.animeName, score: 1, reliable: true }
      : (await this.search(context)).find(item => item.reliable);
    if (!candidate) return { comments: [], match: null, candidates: await this.search(context) };

    const episodes = await this._loadEpisodes(candidate.id);
    const episode = selectEpisode(episodes, context.episodeNumber);
    if (!episode?.vid) {
      return { comments: [], match: { ...candidate, episodeNumber: context.episodeNumber }, candidates: [candidate] };
    }
    return this._commentsForTvid(episode.vid, {
      title: candidate.title,
      linkId: candidate.id,
      tvid: episode.vid,
      episodeNumber: extractEpisodeNumber(episode) || Number(context.episodeNumber) || 0,
      score: candidate.score
    });
  }

  async _loadEpisodes(linkId) {
    const entityId = /^\d+$/.test(linkId) ? linkId : this._entityId(linkId);
    if (!entityId) return [];
    const params = {
      entity_id: entityId,
      device_id: 'qd5fwuaj4hunxxdgzwkcqmefeb3ww5hx',
      auth_cookie: '',
      user_id: '0',
      vip_type: '-1',
      vip_status: '0',
      conduit_id: '',
      pcv: '13.082.22866',
      app_version: '13.082.22866',
      ext: '',
      app_mode: 'standard',
      scale: '100',
      timestamp: String(Date.now()),
      src: 'pca_tvg',
      os: '',
      ad_ext: '{"r":"2.2.0-ares6-pure"}'
    };
    params.sign = this._signParams(params);
    const url = `https://www.iqiyi.com/prelw/tvg/v2/lw/base_info?${new URLSearchParams(params)}`;
    // 接口偶发空响应/结构残缺，延时重试（最多 2 次）
    let data = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        data = JSON.parse(await this.http.fetch(url, {
          referer: 'https://www.iqiyi.com/',
          headers: { Accept: '*/*', Origin: 'https://www.iqiyi.com' }
        }));
      } catch (_) {
        data = null;
      }
      if (data?.status_code === 0 && data?.data?.template) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 3000));
    }
    if (data?.status_code !== 0) return [];
    const episodes = [];
    const seen = new Set();
    const pushEpisode = (epData) => {
      if (epData?.content_type !== 1) return;
      const tvid = String(epData.play_url || '').match(/tvid=(\d+)/)?.[1];
      if (!tvid || seen.has(tvid)) return;
      seen.add(tvid);
      episodes.push({
        vid: tvid,
        title: stripHtml(epData.short_display_name || epData.title || '') || `第${episodes.length + 1}集`,
        order: Number(epData.album_order) || episodes.length + 1
      });
    };
    const tabs = data?.data?.template?.tabs || [];
    for (const block of tabs[0]?.blocks || []) {
      if (block.bk_type === 'video_list' && Array.isArray(block.data?.data) && String(block.tag || '').includes('episodes')) {
        for (const group of block.data.data) {
          for (const videoGroup of group.videos || []) {
            for (const ep of videoGroup.data || []) pushEpisode(ep);
          }
        }
      } else if (block.bk_type === 'album_episodes' && Array.isArray(block.data?.data)) {
        for (const group of block.data.data) {
          const videos = group.videos;
          if (!videos || typeof videos !== 'object' || !videos.feature_paged) continue;
          for (const pageKey in videos.feature_paged) {
            for (const ep of videos.feature_paged[pageKey] || []) pushEpisode(ep);
          }
        }
      }
    }
    return episodes.sort((a, b) => a.order - b.order);
  }

  async _commentsForTvid(tvid, match) {
    let duration = 0;
    try {
      const data = JSON.parse(await this.http.fetch(`https://pcw-api.iqiyi.com/video/video/baseinfo/${encodeURIComponent(tvid)}`, {
        headers: { Accept: 'application/json' }
      }));
      duration = Number(data?.data?.durationSec) || 0;
    } catch (_) {
      duration = 0;
    }
    if (!duration) return { comments: [], match, candidates: [] };
    const pages = Math.min(200, Math.ceil(duration / 60));
    const padded = `0000${tvid}`;
    const dir = `${padded.slice(-4, -2)}/${padded.slice(-2)}`;
    const tasks = [];
    for (let page = 1; page <= pages; page += 1) {
      const sign = md5(`${tvid}_60_${page}cbzuw1259a`).slice(-8);
      tasks.push(async () => {
        let buffer;
        try {
          // 响应为 brotli 压缩内容，HttpClient 会自动解压后返回原始 Buffer
          buffer = await this.http.fetch(`https://cmts.iqiyi.com/bullet/${dir}/${tvid}_60_${page}_${sign}.br`, {
            responseType: 'buffer',
            headers: { Accept: 'application/octet-stream' },
            maxResponseBytes: 5 * 1024 * 1024
          });
        } catch (error) {
          if (error?.statusCode === 404) return [];
          throw error;
        }
        return this._parseBullets(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ''));
      });
    }
    const comments = await fetchSegmentsWithConcurrency(tasks);
    return { comments, match, candidates: [] };
  }

  _parseBullets(buffer) {
    if (!buffer || !buffer.length) return [];
    let bytes = buffer;
    // .br 文件为原始 brotli 流（响应头无 Content-Encoding），需显式解压；解压后可能为 XML 或 protobuf
    if (bytes[0] !== 60) {
      try {
        const decompressed = zlib.brotliDecompressSync(bytes);
        if (decompressed.length) bytes = decompressed;
      } catch (_) { /* 非 brotli 流，保持原始字节 */ }
    }
    // 0x3C 为 '<'：XML 格式；否则为 protobuf 格式
    if (bytes[0] === 60) return this._parseXmlBullets(bytes.toString('utf8'));
    return this._parseProtoBullets(bytes);
  }

  _parseXmlBullets(xml) {
    const pick = (tag) => {
      const reg = new RegExp(`<${tag}>(.*?)</${tag}>`, 'g');
      return xml.match(reg)?.map(item => item.substring(tag.length + 2, item.length - tag.length - 3)) || [];
    };
    const content = pick('content');
    const showTime = pick('showTime');
    const color = pick('color');
    return content.map((text, index) => normalizeComment({
      time: parseFloat(showTime[index]) || 0,
      color: parseInt(color[index], 16) || 0xFFFFFF,
      text
    }, this.id)).filter(Boolean);
  }

  _parseProtoBullets(bytes) {
    const comments = [];
    for (const field of this._protoFields(bytes)) {
      if (field.number !== 6 || !field.bytes) continue;
      const block = this._protoFields(field.bytes);
      const blockShowTime = this._protoString(block, 1);
      for (const itemField of block) {
        if (itemField.number !== 2 || !itemField.bytes) continue;
        const item = this._protoFields(itemField.bytes);
        const text = this._protoString(item, 2);
        if (!text) continue;
        const comment = normalizeComment({
          time: parseFloat(this._protoString(item, 6) || blockShowTime) || 0,
          color: parseInt(this._protoString(item, 8), 16) || 0xFFFFFF,
          text
        }, this.id);
        if (comment) comments.push(comment);
      }
    }
    return comments;
  }

  _protoFields(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const keyResult = this._readVarint(bytes, offset);
      const key = keyResult.value;
      offset = keyResult.offset;
      const number = Number(key >> 3n);
      const wireType = Number(key & 7n);
      if (number === 0) break;
      if (wireType === 0) {
        const valueResult = this._readVarint(bytes, offset);
        fields.push({ number, wireType, value: valueResult.value.toString() });
        offset = valueResult.offset;
      } else if (wireType === 1) {
        fields.push({ number, wireType });
        offset += 8;
      } else if (wireType === 2) {
        const lengthResult = this._readVarint(bytes, offset);
        const length = Number(lengthResult.value);
        offset = lengthResult.offset;
        const end = offset + length;
        if (end > bytes.length) break;
        const raw = bytes.subarray(offset, end);
        fields.push({ number, wireType, bytes: raw, value: raw.toString('utf8') });
        offset = end;
      } else if (wireType === 5) {
        fields.push({ number, wireType });
        offset += 4;
      } else {
        break;
      }
    }
    return fields;
  }

  _readVarint(bytes, offset) {
    let value = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < bytes.length) {
      const byte = bytes[pos++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value, offset: pos };
      shift += 7n;
    }
    throw new Error('爱奇艺弹幕 protobuf varint 不完整');
  }

  _protoString(fields, number) {
    return fields.find(field => field.number === number)?.value || '';
  }
}

// 优酷弹幕业务参数 base64 前需将非 Latin1 字符转义，等价于参考实现中的 utf8ToLatin1
function latin1Escape(str) {
  let result = '';
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    result += code > 255 ? encodeURIComponent(str[i]) : str[i];
  }
  return result;
}

class YoukuDanmakuProvider {
  constructor(http) {
    this.id = 'youku';
    this.name = '优酷';
    this.http = http;
    this.appKey = '24679788';
    this.clientId = '53e6cc67237fc59a';
  }

  async search(context) {
    const queries = [context.animeName, ...(context.aliases || [])]
      .map(stripHtml)
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .slice(0, 2);
    const candidates = [];
    for (const query of queries) {
      const url = `https://search.youku.com/api/search?keyword=${encodeURIComponent(query)}&userAgent=${encodeURIComponent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36')}&site=1&categories=0&ftype=0&ob=0&pg=1`;
      let data;
      try {
        data = JSON.parse(await this.http.fetch(url, {
          referer: 'https://www.youku.com/',
          headers: { Accept: 'application/json' }
        }));
      } catch (_) {
        continue;
      }
      for (const component of data?.pageComponentList || []) {
        const common = component.commonData;
        if (!common?.titleDTO || (common.isYouku !== 1 && common.hasYouku !== 1)) continue;
        const title = stripHtml(common.titleDTO.displayName || '').replace(/【.+?】/g, '').trim();
        if (!title || !common.showId) continue;
        if (['中配版', '抢先看', '非正片', '解读', '揭秘', '赏析', '《'].some(keyword => title.includes(keyword))) continue;
        const yearMatch = String(common.feature || '').match(/[12][890][0-9][0-9]/);
        const scored = titleScore(title, context);
        candidates.push({
          id: String(common.showId),
          title,
          year: yearMatch ? Number(yearMatch[0]) : 0,
          episodeCount: Number(common.episodeTotal) || 0,
          score: scored.score,
          reliable: scored.reliable,
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
    const override = context?.overrides?.youku || {};
    if (override.vid) {
      return this._commentsForVid(override.vid, {
        title: override.title || context.animeName,
        showId: override.showId || '',
        vid: override.vid,
        episodeNumber: context.episodeNumber,
        manual: true
      });
    }
    const candidate = override.showId
      ? { id: String(override.showId), title: override.title || context.animeName, score: 1, reliable: true }
      : (await this.search(context)).find(item => item.reliable);
    if (!candidate) return { comments: [], match: null, candidates: await this.search(context) };

    const episodes = await this._loadEpisodes(candidate.id);
    const episode = selectEpisode(episodes, context.episodeNumber);
    if (!episode?.vid) {
      return { comments: [], match: { ...candidate, episodeNumber: context.episodeNumber }, candidates: [candidate] };
    }
    return this._commentsForVid(episode.vid, {
      title: candidate.title,
      showId: candidate.id,
      vid: episode.vid,
      episodeNumber: extractEpisodeNumber(episode) || Number(context.episodeNumber) || 0,
      score: candidate.score
    });
  }

  async _loadEpisodes(showId) {
    const fetchPage = async (page) => JSON.parse(await this.http.fetch(
      `https://openapi.youku.com/v2/shows/videos.json?client_id=${this.clientId}&package=com.huawei.hwvplayer.youku&ext=show&show_id=${encodeURIComponent(showId)}&page=${page}&count=100`,
      { headers: { Accept: 'application/json' } }
    ));
    const first = await fetchPage(1);
    const videos = [...(first?.videos || [])];
    const total = Number(first?.total) || videos.length;
    if (total > 100) {
      const pages = Math.min(10, Math.ceil(total / 100));
      const rest = await Promise.allSettled(Array.from({ length: pages - 1 }, (_, index) => fetchPage(index + 2)));
      for (const result of rest) {
        if (result.status === 'fulfilled') videos.push(...(result.value?.videos || []));
      }
    }
    return videos
      .map((video, index) => ({
        vid: String(video.id || video.vid || ''),
        title: stripHtml(video.displayName || video.title || `第${index + 1}集`)
      }))
      .filter(item => item.vid);
  }

  async _commentsForVid(vid, match) {
    const info = JSON.parse(await this.http.fetch(
      `https://openapi.youku.com/v2/videos/show.json?client_id=${this.clientId}&video_id=${encodeURIComponent(vid)}&package=com.huawei.hwvplayer.youku&ext=show`,
      { headers: { Accept: 'application/json' } }
    ));
    const duration = Number(info?.duration) || 0;
    if (!duration) return { comments: [], match, candidates: [] };
    const auth = await this._mtopAuth();
    if (!auth) throw new Error('优酷 mtop 鉴权失败：未获取到 _m_h5_tk');
    const mats = Math.min(200, Math.floor(duration / 60) + 1);
    const tasks = Array.from({ length: mats }, (_, mat) => () => this._fetchMat(vid, mat, auth));
    const comments = await fetchSegmentsWithConcurrency(tasks);
    return { comments, match, candidates: [] };
  }

  // mtop 鉴权：cna 取 log.mmstat.com 的 ETag；token 经 acs.youku.com 首次请求的 Set-Cookie 下发
  async _mtopAuth() {
    let cna = '';
    try {
      const cnaRes = await this.http.fetch('https://log.mmstat.com/eg.js', {
        returnHeaders: true,
        headers: { Accept: '*/*' }
      });
      cna = String(cnaRes?.headers?.etag || '').replace(/^"|"$/g, '');
    } catch (_) {
      cna = '';
    }
    const tkRes = await this.http.fetch(
      `https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=${this.appKey}`,
      { returnHeaders: true, headers: { Accept: 'application/json' } }
    );
    const setCookie = tkRes?.headers?.['set-cookie'];
    const cookieText = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie || '');
    const token = cookieText.match(/_m_h5_tk=([^;]+)/)?.[1] || '';
    const tokenEnc = cookieText.match(/_m_h5_tk_enc=([^;]+)/)?.[1] || '';
    if (!token) return null;
    return { cna, token, tokenEnc };
  }

  // 拉取单个 60 秒分片（mat）的弹幕：业务 sign + mtop sign 双重签名
  async _fetchMat(vid, mat, auth) {
    const msg = {
      ctime: Date.now(),
      ctype: 10004,
      cver: 'v1.0',
      guid: auth.cna,
      mat,
      mcount: 1,
      pid: 0,
      sver: '3.1.0',
      type: 1,
      vid
    };
    const b64 = Buffer.from(latin1Escape(JSON.stringify(msg)), 'latin1').toString('base64');
    msg.msg = b64;
    msg.sign = md5(`${b64}MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr`).toLowerCase();
    const data = JSON.stringify(msg);
    const t = Date.now();
    const params = new URLSearchParams({
      jsv: '2.5.6',
      appKey: this.appKey,
      t: String(t),
      sign: md5([auth.token.slice(0, 32), t, this.appKey, data].join('&')).toLowerCase(),
      api: 'mopen.youku.danmu.list',
      v: '1.0',
      type: 'originaljson',
      dataType: 'jsonp',
      timeout: '20000',
      jsonpIncPrefix: 'utility'
    });
    const text = await this.http.fetch(`https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/?${params}`, {
      method: 'POST',
      body: `data=${encodeURIComponent(data)}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `_m_h5_tk=${auth.token};_m_h5_tk_enc=${auth.tokenEnc};`,
        Referer: 'https://v.youku.com'
      }
    });
    const parsed = JSON.parse(text);
    const result = JSON.parse(parsed?.data?.result || '{}');
    if (result.code === '-1') return [];
    return (result?.data?.result || []).map(item => {
      let color = 0xFFFFFF;
      let rawType = 1;
      try {
        const prop = JSON.parse(item.propertis || '{}');
        if (prop.color) color = typeof prop.color === 'string' ? parseInt(prop.color, 10) : Number(prop.color);
        if (prop.pos === 1) rawType = 5;
        else if (prop.pos === 2) rawType = 4;
      } catch (_) { /* 保留默认样式 */ }
      return normalizeComment({
        time: Number(item.playat || 0) / 1000,
        rawType,
        color,
        text: item.content
      }, this.id);
    }).filter(Boolean);
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
    this.register(new TencentDanmakuProvider(this.http));
    this.register(new IqiyiDanmakuProvider(this.http));
    this.register(new YoukuDanmakuProvider(this.http));
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
      { id: 'tencent', name: '腾讯视频', configured: true, zeroConfig: true },
      { id: 'iqiyi', name: '爱奇艺', configured: true, zeroConfig: true },
      { id: 'youku', name: '优酷', configured: true, zeroConfig: true },
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
      : ['bilibili', 'acfun', 'tencent', 'iqiyi', 'youku', 'dandanplay', 'custom'];
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
    const SEARCHABLE_IDS = ['bilibili', 'acfun', 'tencent', 'iqiyi', 'youku'];
    const ids = (normalized.providerIds || SEARCHABLE_IDS).filter(id => SEARCHABLE_IDS.includes(id));
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
    // 腾讯/爱奇艺/优酷分片请求多（单集约 25~50 个），单独放宽到 15 秒
    const timeoutMs = id === 'custom' ? 10000
      : ['tencent', 'iqiyi', 'youku'].includes(id) ? 15000
        : 8000;
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
    const priority = { dandanplay: 0, bilibili: 1, acfun: 2, tencent: 3, iqiyi: 4, youku: 5, custom: 6, local: 7 };
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
  TencentDanmakuProvider,
  IqiyiDanmakuProvider,
  YoukuDanmakuProvider,
  CustomDanmakuProvider,
  parseBilibiliXml,
  normalizeComment,
  extractEpisodeNumber,
  selectEpisode
};
