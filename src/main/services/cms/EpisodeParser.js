/**
 * CMS 集数解析纯函数模块
 *
 * 从 CmsApiService.js 抽离的无状态工具函数，便于单元测试和复用。
 * 所有方法均为纯函数，不依赖 this 状态。
 */

/**
 * 解析 CMS API 的 vod_play_url 字段
 * 格式: "第01集$url1#第02集$url2$$$线路2名$第01集$url3#第02集$url4"
 */
function parseEpisodes(vodPlayFrom, vodPlayUrl) {
    const episodesByLine = {};
    const lineNames = (vodPlayFrom || '').split('$$$');
    const lineUrls = (vodPlayUrl || '').split('$$$');

    for (let i = 0; i < lineUrls.length; i++) {
        const lineName = lineNames[i] || `线路${i + 1}`;
        const epPairs = lineUrls[i].split('#');
        const episodes = [];

        for (const pair of epPairs) {
            const trimmed = pair.trim();
            if (!trimmed) continue;
            const dollarIdx = trimmed.indexOf('$');
            if (dollarIdx === -1) continue;

            const title = trimmed.substring(0, dollarIdx).trim();
            const url = trimmed.substring(dollarIdx + 1).trim();
            if (!title || !url || !url.startsWith('http')) continue;

            episodes.push({ id: url, title, url, play_url: url });
        }

        if (episodes.length > 0) {
            episodesByLine[lineName] = episodes;
        }
    }

    return episodesByLine;
}

/**
 * 将 CMS vod 数据映射为应用内部格式（轻量）
 */
function mapVodItem(vod, sourceId) {
    return {
        id: String(vod.vod_id),
        name: vod.vod_name || '',
        cover: vod.vod_pic || '',
        source: sourceId,
        year: vod.vod_year || '',
        area: vod.vod_area || '',
        type: vod.vod_class ? vod.vod_class.split(',').map(t => t.trim()).filter(Boolean) : [],
        remarks: vod.vod_remarks || '',
        episode_count: 0,
        _detailLoaded: !!(vod.vod_play_url)
    };
}

/**
 * 轻量列表映射：基于 ac=detail 数据提取封面等展示字段，跳过播放地址解析
 */
function mapVodListItem(vod, sourceId) {
    const intro = (vod.vod_content || '').replace(/<[^>]+>/g, '').trim();
    let episode_count = 0;
    const remarks = vod.vod_remarks || '';
    const epMatch = remarks.match(/第(\d+)集|更新至(\d+)集|(\d+)集全/);
    if (epMatch) {
        episode_count = parseInt(epMatch[1] || epMatch[2] || epMatch[3] || '0', 10);
    }
    // 回退：remarks 未匹配到时，用 vod_total 字段
    if (!episode_count) {
        const total = parseInt(vod.vod_total, 10);
        if (Number.isFinite(total) && total > 0) {
            episode_count = total;
        }
    }
    return {
        id: String(vod.vod_id),
        name: vod.vod_name || '',
        cover: vod.vod_pic || '',
        source: sourceId,
        year: vod.vod_year || '',
        area: vod.vod_area || '',
        type: vod.vod_class ? vod.vod_class.split(',').map(t => t.trim()).filter(Boolean) : [],
        intro,
        remarks: vod.vod_remarks || '',
        episode_count,
        _detailLoaded: false
    };
}

/**
 * 将 CMS vod 详情映射为应用内部格式
 */
function mapVodDetail(vod, sourceId) {
    const episodes = parseEpisodes(vod.vod_play_from, vod.vod_play_url);
    // Different lines are alternate playback routes for the same title. Summing
    // them turns two 12-episode lines into a false 24-episode total.
    const totalEpisodes = Object.values(episodes).reduce((max, arr) => Math.max(max, arr.length), 0);
    const intro = (vod.vod_content || '').replace(/<[^>]+>/g, '').trim();

    return {
        id: String(vod.vod_id),
        name: vod.vod_name || '',
        cover: vod.vod_pic || '',
        source: sourceId,
        year: vod.vod_year || '',
        area: vod.vod_area || '',
        type: vod.vod_class ? vod.vod_class.split(',').map(t => t.trim()).filter(Boolean) : [],
        intro,
        remarks: vod.vod_remarks || '',
        actor: vod.vod_actor || '',
        director: vod.vod_director || '',
        episodes,
        episode_count: totalEpisodes,
        _detailLoaded: true
    };
}

function normalizeEpisodeTitle(title) {
    return String(title || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[第集话話部篇]/g, '')
        .replace(/^0+(\d)/, '$1')
        .toLowerCase();
}

function extractEpisodeNumber(title) {
    const match = String(title || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

function findMatchingEpisode(episodesByLine, targetTitle, targetIndex = -1) {
    return findMatchingEpisodeLines(episodesByLine, targetTitle, targetIndex)[0] || null;
}

/**
 * 与 findMatchingEpisode 相同的匹配规则，但每条线路各返回一个匹配结果。
 * 同一源的多条线路是互备的播放路由（线路1 的 CDN 挂了线路2 常常仍可用），
 * 只取第一条线路会让换源/自动回退错过可用的备用线路。
 * 返回数组按线路声明顺序排列；无匹配返回 []。
 */
function findMatchingEpisodeLines(episodesByLine, targetTitle, targetIndex = -1) {
    if (!episodesByLine || typeof episodesByLine !== 'object') return [];
    const targetNormalized = normalizeEpisodeTitle(targetTitle);
    const targetNum = extractEpisodeNumber(targetTitle);
    const matches = [];

    for (const [lineId, episodes] of Object.entries(episodesByLine)) {
        if (!Array.isArray(episodes)) continue;
        let lineMatch = null;
        for (let index = 0; index < episodes.length; index++) {
            const ep = episodes[index];
            if (!ep) continue;
            const epIndex = ep.index ?? index;
            const epNormalized = normalizeEpisodeTitle(ep.title || ep.name);
            const epNum = extractEpisodeNumber(ep.title || ep.name);

            if (targetIndex >= 0 && epIndex === targetIndex) {
                // index 匹配是最强匹配，直接锁定本线路结果
                lineMatch = { episode: { ...ep, index: epIndex }, lineId, matchType: 'index', matchScore: 4 };
                break;
            }
            if (!lineMatch && targetNormalized && epNormalized && targetNormalized === epNormalized) {
                lineMatch = { episode: { ...ep, index: epIndex }, lineId, matchType: 'title', matchScore: 3 };
                continue;
            }
            if (!lineMatch && targetNum !== null && epNum !== null && targetNum === epNum) {
                lineMatch = { episode: { ...ep, index: epIndex }, lineId, matchType: 'number', matchScore: 2 };
            }
        }
        if (lineMatch) matches.push(lineMatch);
    }

    return matches;
}

function firstPlayableEpisode(episodesByLine) {
    if (!episodesByLine || typeof episodesByLine !== 'object') return null;
    for (const [lineId, episodes] of Object.entries(episodesByLine)) {
        if (!Array.isArray(episodes)) continue;
        for (let index = 0; index < episodes.length; index++) {
            const ep = episodes[index];
            if (ep && (ep.url || ep.play_url)) {
                return { episode: { ...ep, index: ep.index ?? index }, lineId, matchType: 'first', matchScore: 1 };
            }
        }
    }
    return null;
}

function parseM3u8Quality(text, playlistUrl = '') {
    const lines = String(text || '').split(/\r?\n/);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        const resolution = line.match(/RESOLUTION=(\d+)x(\d+)/i);
        const bandwidth = line.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
        const nextUrl = (lines[i + 1] || '').trim();
        variants.push({
            width: resolution ? parseInt(resolution[1], 10) : 0,
            height: resolution ? parseInt(resolution[2], 10) : 0,
            bitrate: bandwidth ? parseInt(bandwidth[1], 10) : 0,
            url: nextUrl && !nextUrl.startsWith('#') ? resolveUrl(nextUrl, playlistUrl) : ''
        });
    }

    if (variants.length > 0) {
        variants.sort((a, b) => (b.height - a.height) || (b.bitrate - a.bitrate) || (b.width - a.width));
        return { ...variants[0], variants: variants.length, source: 'm3u8-master' };
    }

    const guessedHeight = guessQualityFromUrl(playlistUrl);
    return {
        width: 0,
        height: guessedHeight,
        bitrate: 0,
        url: playlistUrl,
        variants: 0,
        source: guessedHeight ? 'url' : 'single'
    };
}

function guessQualityFromUrl(url) {
    const text = String(url || '').toLowerCase();
    if (/2160|4k|uhd/.test(text)) return 2160;
    if (/1440|2k/.test(text)) return 1440;
    if (/1080|fhd|fullhd/.test(text)) return 1080;
    if (/720|hd/.test(text)) return 720;
    if (/480|sd/.test(text)) return 480;
    if (/360/.test(text)) return 360;
    return 0;
}

function resolveUrl(value, baseUrl) {
    try {
        return new URL(value, baseUrl).toString();
    } catch (e) {
        return value;
    }
}

function qualityScore(quality) {
    return (quality?.height || 0) * 1e5 + (quality?.bitrate || 0);
}

module.exports = {
    parseEpisodes,
    mapVodItem,
    mapVodListItem,
    mapVodDetail,
    normalizeEpisodeTitle,
    extractEpisodeNumber,
    findMatchingEpisode,
    findMatchingEpisodeLines,
    firstPlayableEpisode,
    parseM3u8Quality,
    guessQualityFromUrl,
    resolveUrl,
    qualityScore
};
