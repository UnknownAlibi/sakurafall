const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const YEAR_HINT_RE = /(?:^|\D)((?:19|20)\d{2})(?=\D|$)/g;

function validDateKey(value) {
  const match = String(value || '').trim().match(DATE_KEY_RE);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return '';
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function subjectYearHints(item = {}) {
  const values = [
    item.year,
    item.air_date,
    item.airDate,
    item.date,
    ...(Array.isArray(item.tags) ? item.tags : [])
  ];
  const years = new Set();
  for (const value of values) {
    const text = String(typeof value === 'string' || typeof value === 'number' ? value : value?.name || '');
    YEAR_HINT_RE.lastIndex = 0;
    let match;
    while ((match = YEAR_HINT_RE.exec(text))) years.add(Number(match[1]));
  }
  return [...years].filter(year => year >= 1900 && year <= 2100);
}

function subjectReleaseState(item = {}, todayKey) {
  const today = validDateKey(todayKey);
  const dateKey = validDateKey(item.air_date || item.airDate || item.date);
  if (dateKey) {
    return { state: !today || dateKey <= today ? 'released-dated' : 'future', dateKey };
  }

  const currentYear = Number(String(today || '').slice(0, 4)) || new Date().getFullYear();
  const years = subjectYearHints(item);
  if (years.some(year => year > currentYear)) return { state: 'future', dateKey: '' };
  if (years.some(year => year < currentYear)) return { state: 'released-undated', dateKey: '' };
  return { state: 'unknown', dateKey: '' };
}

function hasSubjectIdentity(item = {}) {
  const id = item.bgm_id || item.bgmId || item.id;
  const name = String(item.name || item.name_cn || item.nameRaw || item.name_raw || '').trim();
  return Boolean(id && name && name !== '未知');
}

function hasQualifiedRating(item = {}) {
  const rating = Number(item.rating?.score ?? item.rating ?? item.score) || 0;
  const votes = Number(item.votes ?? item.rating_total ?? item.rating?.total ?? item.collection_total) || 0;
  const rank = Number(item.rank ?? item.rating?.rank) || 0;
  return rating > 0 && (votes >= 10 || rank > 0);
}

function isSubjectCatalogEligible(item, { sort = 'date', todayKey = '' } = {}) {
  if (!hasSubjectIdentity(item)) return false;
  const release = subjectReleaseState(item, todayKey);
  if (release.state === 'future') return false;

  if (sort === 'date' || sort === 'latest') {
    return release.state === 'released-dated';
  }
  if (sort === 'score' || sort === 'rating') {
    const hasReleaseEvidence = release.state === 'released-dated' || release.state === 'released-undated';
    return hasReleaseEvidence && hasQualifiedRating(item);
  }
  return true;
}

module.exports = {
  hasQualifiedRating,
  hasSubjectIdentity,
  isSubjectCatalogEligible,
  subjectReleaseState,
  subjectYearHints,
  validDateKey
};
