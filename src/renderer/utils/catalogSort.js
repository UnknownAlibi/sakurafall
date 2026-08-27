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
