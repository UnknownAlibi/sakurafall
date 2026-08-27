// BT 资源搜索服务
// 聚合公开 BT 索引站（蜜柑计划 RSS / 动漫花园 dmhy），检索压制组资源并解析为结构化条目。
// 只做"搜索 + 展示 + 提供磁力链接"，下载动作由用户在外部工具完成，应用不托管内容。
//
// 用法：
//   const svc = new BtSearchService({ httpClient });
//   const results = await svc.search('孤独摇滚');

const { parseAnimeFilename } = require('./FilenameParser');

const PROVIDERS = {
  mikan: {
    name: '蜜柑计划',
    searchUrl: (kw) => `https://mikanani.me/RSS/Search?searchstr=${encodeURIComponent(kw)}`,
    referer: 'https://mikanani.me/'
  },
  dmhy: {
    name: '动漫花园',
    searchUrl: (kw) => `https://share.dmhy.org/topics/list?keyword=${encodeURIComponent(kw)}`,
    referer: 'https://share.dmhy.org/'
  }
};

const DEFAULT_TIMEOUT = 12000;
const DEFAULT_LIMIT = 40;

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeXmlEntities(String(html || '').replace(/<[^>]+>/g, ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- 蜜柑计划：RSS XML 解析 ----
// 注意：蜜柑 RSS 不直接提供 magnet 链接，而是 episode hash（40 位 hex，即 BT info hash）。
// 从 guid/link/enclosure 中提取 hash 后自行构造磁力链（与网页端"复制磁力链"行为一致）。
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

function parseMikanRss(xml) {
  const items = [];
  const itemBlocks = String(xml || '').match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = stripTags(block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || '');
    if (!title) continue;
    // info hash 出现于 episode 链接与 .torrent 下载链接中
    const hash = (block.match(/(?:Episode|Download\/\d{4}\d{2}\d{2})\/([0-9a-fA-F]{40})/)?.[1]
      || block.match(/urn:btih:([a-zA-Z0-9]{32,40})/)?.[1]
      || '').toLowerCase();
    if (!hash) continue;
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const contentLength = block.match(/<contentLength>(\d+)<\/contentLength>/)?.[1] || '';
    const size = contentLength ? formatBytes(contentLength) : (block.match(/\[([\d.]+\s*[KMGT]B)\]/)?.[1] || '');
    const pubDate = stripTags(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '');
    items.push({
      provider: 'mikan',
      title,
      magnet,
      size,
      publishDate: pubDate,
      seedCount: null
    });
  }
  return items;
}

// ---- 动漫花园：HTML 表格解析 ----
function parseDmhyHtml(html) {
  const items = [];
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    if (!row.includes('arrow-magnet')) continue; // 资源行标志（避开页面内嵌 JS 的伪 tr）
    // 标题链接形如 /topics/view/720587_7_ACG_xxx.html（数字_slug，非纯数字）
    const titleMatch = row.match(/<a[^>]+href="\/topics\/view\/[\w.-]+\.html"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';
    // arrow-magnet 的 href 携带完整 tracker 列表（btih 为 base32），复制即可用
    const magnet = decodeXmlEntities(row.match(/class="download-arrow arrow-magnet"[^>]*href="(magnet:\?xt=urn:btih:[^"]+)"/i)?.[1]
      || row.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i)?.[1] || '');
    if (!title || !magnet.startsWith('magnet:')) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    // dmhy 列顺序：时间 / 分类 / 标题 / 磁力 / 大小 / ...（顺序宽松匹配）
    const timeCell = cells.find(c => /\d{4}\/\d{1,2}\/\d{1,2}/.test(stripTags(c)));
    const sizeCell = cells.find(c => /^\d+(\.\d+)?\s*(GB|MB|KB|TB)$/i.test(stripTags(c)));
    const category = stripTags(cells.find(c => /sort-\d+/.test(c)) || '');
    items.push({
      provider: 'dmhy',
      title,
      magnet,
      size: sizeCell ? stripTags(sizeCell) : '',
      publishDate: timeCell ? stripTags(timeCell) : '',
      category: category || null,
      seedCount: null
    });
  }
  return items;
}

function toSearchResult(item, index) {
  const parsed = parseAnimeFilename(item.title);
  const hash = item.magnet.match(/urn:btih:([a-zA-Z0-9]+)/)?.[1] || `${item.provider}-${index}`;
  return {
    id: `${item.provider}-${hash}`,
    provider: item.provider,
    providerName: PROVIDERS[item.provider]?.name || item.provider,
    title: item.title,
    magnet: item.magnet,
    size: item.size || null,
    publishDate: item.publishDate || null,
    seedCount: item.seedCount ?? null,
    category: item.category || null,
    parsed: {
      group: parsed.group,
      title: parsed.title,
      episode: parsed.episode,
      season: parsed.season,
      resolution: parsed.resolution,
      videoCodec: parsed.videoCodec,
      audioCodec: parsed.audioCodec,
      bitDepth: parsed.bitDepth,
      special: parsed.special,
      isComplete: parsed.isComplete,
      isUncensored: parsed.isUncensored,
      subtitleLang: parsed.subtitleLang
    }
  };
}

class BtSearchService {
  constructor(options = {}) {
    this.httpClient = options.httpClient || null;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  setHttpClient(client) {
    this.httpClient = client;
  }

  setProxy(proxyUrl) {
    // HttpClient 自身管理代理；此方法用于与全局网络策略联动
    if (this.httpClient && typeof this.httpClient.setProxy === 'function') {
      this.httpClient.setProxy(proxyUrl);
    }
  }

  async fetchProvider(providerKey, keyword) {
    const provider = PROVIDERS[providerKey];
    if (!provider) throw new Error(`Unknown BT provider: ${providerKey}`);
    if (!this.httpClient) throw new Error('BtSearchService requires an HttpClient instance');
    if (!keyword || !String(keyword).trim()) return [];

    const url = provider.searchUrl(String(keyword).trim());
    const text = await this.httpClient.fetch(url, {
      referer: provider.referer,
      charset: 'utf8',
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml' }
    });
    const raw = providerKey === 'mikan' ? parseMikanRss(text) : parseDmhyHtml(text);
    return raw.map(toSearchResult);
  }

  /**
   * 聚合搜索
   * @param {string} keyword - 搜索关键词
   * @param {{providers?: string[], limit?: number}} [options]
   * @returns {Promise<{items: Array, errors: Array}>} 单个源失败不影响其余源
   */
  async search(keyword, options = {}) {
    const providers = options.providers && options.providers.length > 0
      ? options.providers
      : Object.keys(PROVIDERS);
    const limit = Math.max(5, options.limit || DEFAULT_LIMIT);

    const settled = await Promise.allSettled(
      providers.map(key => this.fetchProvider(key, keyword))
    );

    const items = [];
    const errors = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        errors.push({
          provider: providers[i],
          providerName: PROVIDERS[providers[i]]?.name || providers[i],
          message: result.reason?.message || '请求失败'
        });
      }
    });

    // 排序：有解析出集数的优先（正片 > 垃圾条目），再按发布时间新→旧
    items.sort((a, b) => {
      const aScore = a.parsed.episode != null ? 0 : (a.parsed.isComplete ? 1 : 2);
      const bScore = b.parsed.episode != null ? 0 : (b.parsed.isComplete ? 1 : 2);
      if (aScore !== bScore) return aScore - bScore;
      return String(b.publishDate || '').localeCompare(String(a.publishDate || ''));
    });

    return { items: items.slice(0, limit), errors };
  }
}

module.exports = { BtSearchService, parseMikanRss, parseDmhyHtml, PROVIDERS };
