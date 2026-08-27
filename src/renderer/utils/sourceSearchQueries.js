const ALIAS_INFOBOX_KEYS = /别名|原名|中文名|日文名|英文名|简称|又名/i;
const SEASON_SUFFIX = /(?:\s+|[-:：])(?:第[一二三四五六七八九十百\d]+(?:季|期|部)|season\s*\d+|s\d+|part\s*\d+)(?:\s+.*)?$/i;
const RELEASE_SUFFIX = /\s*[（(【\x5b].{0,20}(?:TV|动画|字幕|先行|无修|重制|合集).{0,20}[）)】\x5d]\s*$/i;

function collectStrings(value, output) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStrings(item, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of ['v', 'value', 'name', 'title']) {
    if (value[key] !== undefined) collectStrings(value[key], output);
  }
}

function compactTitle(value) {
  return String(value || '').replace(/[\s·・:：~～!！?？'’"“”]/g, '').trim();
}

function addQuery(output, seen, value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > 120) return;
  const key = text.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  output.push(text);
}

export function buildSourceSearchQueries(anime, options = {}) {
  const rawTitles = [];
  collectStrings([
    anime?.name,
    anime?.nameCn,
    anime?.name_cn,
    anime?.nameRaw,
    anime?.name_raw,
    anime?.aliases
  ], rawTitles);

  for (const entry of anime?.infobox || []) {
    if (!ALIAS_INFOBOX_KEYS.test(String(entry?.key || ''))) continue;
    collectStrings(entry?.value, rawTitles);
  }

  const queries = [];
  const seen = new Set();
  rawTitles.forEach(title => addQuery(queries, seen, title));
  rawTitles.forEach(title => {
    addQuery(queries, seen, title.replace(SEASON_SUFFIX, '').trim());
    addQuery(queries, seen, title.replace(RELEASE_SUFFIX, '').trim());
  });
  rawTitles.forEach(title => {
    const compact = compactTitle(title);
    if (compact !== title && compact.length >= 3) addQuery(queries, seen, compact);
  });

  const limit = Math.max(1, Math.min(Number.parseInt(options.limit, 10) || 8, 12));
  return queries.slice(0, limit);
}

function resultKey(result, providerId) {
  return [
    providerId,
    result?.id || result?.url || result?.href || '',
    result?.name || result?.title || '',
    result?.year || ''
  ].join('|').toLocaleLowerCase();
}

export function mergeSourceSearchStatuses(...groups) {
  const providers = new Map();
  const statusPriority = { success: 4, noResult: 3, error: 2, disabled: 1, pending: 0 };

  for (const group of groups.flat()) {
    if (!group) continue;
    const providerId = group.providerId || group.sourceId;
    if (!providerId) continue;
    const previous = providers.get(providerId);
    const results = [];
    const seenResults = new Set();
    for (const result of [...(previous?.results || []), ...(group.results || [])]) {
      const key = resultKey(result, providerId);
      if (seenResults.has(key)) continue;
      seenResults.add(key);
      results.push({ ...result, _matchedQuery: result._matchedQuery || group.keyword || '' });
    }
    const queries = [...new Set([...(previous?.queries || []), group.keyword].filter(Boolean))];
    const preferred = !previous || (statusPriority[group.status] || 0) > (statusPriority[previous.status] || 0)
      ? group
      : previous;
    providers.set(providerId, {
      ...previous,
      ...preferred,
      providerId,
      results,
      count: results.length,
      status: results.length > 0 ? 'success' : preferred.status,
      confidence: Math.max(previous?.confidence || 0, group.confidence || 0),
      elapsedMs: (previous?.elapsedMs || 0) + (group.elapsedMs || 0),
      queries
    });
  }

  const order = { success: 0, noResult: 1, error: 2, disabled: 3, pending: 4 };
  return Array.from(providers.values()).sort((a, b) => (
    (order[a.status] ?? 5) - (order[b.status] ?? 5) || (b.confidence || 0) - (a.confidence || 0)
  ));
}
