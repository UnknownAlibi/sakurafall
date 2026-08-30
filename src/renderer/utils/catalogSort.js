export const bangumiRegionOptions = Object.freeze([
  { id: 'all', name: '全部', tag: '' },
  { id: 'jp', name: '日漫', tag: '日本' },
  { id: 'cn', name: '国漫', tag: '中国' },
  { id: 'western', name: '欧美', tag: '欧美' },
  { id: 'kr', name: '韩国', tag: '韩国' }
]);

export function supportsCatalogSort(type = {}, sortId = 'date') {
  const mode = type?.mode || 'browse';
  return ['catalog', 'season', 'browse'].includes(mode) && ['date', 'score'].includes(sortId);
}

export function normalizeCatalogSort(type = {}, sortId = 'date') {
  return supportsCatalogSort(type, sortId) ? sortId : 'date';
}

export function filterCatalogSortOptions(type = {}, options = []) {
  return options.filter(option => supportsCatalogSort(type, option?.id));
}
