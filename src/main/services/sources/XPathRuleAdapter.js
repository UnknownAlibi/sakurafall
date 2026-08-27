const crypto = require('crypto');

// 识别外部通用 XPath 网页规则格式（社区订阅的源码规则文档）。
// 与内部 SourceRuleEngine 的 xpath 来源相互独立：这里是"外部规则 → 内部来源"的适配层。
function isXPathRule(raw) {
  return !!raw
    && typeof raw === 'object'
    && typeof raw.baseURL === 'string'
    && typeof raw.searchURL === 'string'
    && typeof raw.searchList === 'string'
    && typeof raw.chapterRoads === 'string';
}

function stableId(name) {
  const value = String(name || 'rule').trim();
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  if (slug) return `xpath-${slug}`;
  const suffix = crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
  return `xpath-${suffix}`;
}

function contextualXpath(expression) {
  const value = String(expression || '').trim();
  if (value.startsWith('//') || value.startsWith('/')) return `.${value}`;
  return value;
}

function hrefXpath(expression) {
  const value = contextualXpath(expression);
  if (!value) return '';
  if (/\/@href\s*$|\/attribute::href\s*$|@href\s*$/i.test(value)) return value;
  return `${value}/@href`;
}

function adaptXPathRule(raw) {
  if (!isXPathRule(raw)) return raw;
  const headers = {};
  if (String(raw.userAgent || '').trim()) headers['User-Agent'] = String(raw.userAgent).trim();
  if (String(raw.referer || '').trim()) headers.Referer = String(raw.referer).trim();

  return {
    id: stableId(raw.name),
    name: String(raw.name || 'XPath Rule').trim(),
    type: 'xpath',
    version: String(raw.version || '1.0'),
    enabled: raw.enabled !== false,
    baseUrl: String(raw.baseURL || '').trim(),
    headers,
    search: {
      url: String(raw.searchURL || '').trim(),
      method: raw.usePost === true ? 'POST' : 'GET',
      list: String(raw.searchList || '').trim(),
      name: contextualXpath(raw.searchName),
      urlPath: hrefXpath(raw.searchResult),
      cover: ''
    },
    detail: {
      episodeGroups: String(raw.chapterRoads || '').trim(),
      episodeList: contextualXpath(raw.chapterResult),
      episodeTitle: '.',
      episodeUrl: './@href'
    },
    adBlocker: raw.adBlocker === true,
    playback: {
      mode: raw.useWebview === false ? 'page' : 'webview-sniff',
      useLegacyParser: raw.useLegacyParser === true
    },
    compatibility: {
      family: 'xpath',
      api: String(raw.api || ''),
      originalName: String(raw.name || '')
    }
  };
}

module.exports = {
  adaptXPathRule,
  contextualXpath,
  hrefXpath,
  isXPathRule,
  stableId
};