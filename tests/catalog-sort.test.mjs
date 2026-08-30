import test from 'node:test';
import assert from 'node:assert/strict';

const {
  bangumiRegionOptions,
  filterCatalogSortOptions,
  normalizeCatalogSort,
  supportsCatalogSort
} = await import('../src/renderer/utils/catalogSort.js');

const options = [
  { id: 'date', name: '最新' },
  { id: 'score', name: '评分最高' }
];

test('catalog types expose date and score sorting', () => {
  const type = { mode: 'catalog' };
  assert.equal(supportsCatalogSort(type, 'date'), true);
  assert.deepEqual(filterCatalogSortOptions(type, options).map(item => item.id), ['date', 'score']);
  assert.equal(normalizeCatalogSort(type, 'date'), 'date');
});

test('tag browsing exposes service-backed date and score sorting', () => {
  const type = { mode: 'browse', tag: '原创' };
  assert.equal(supportsCatalogSort(type, 'date'), true);
  assert.deepEqual(filterCatalogSortOptions(type, options).map(item => item.id), ['date', 'score']);
  assert.equal(normalizeCatalogSort(type, 'date'), 'date');
});

test('region filters use broad Bangumi tags instead of sparse animation aliases', () => {
  assert.deepEqual(
    Object.fromEntries(bangumiRegionOptions.map(option => [option.id, option.tag])),
    { all: '', jp: '日本', cn: '中国', western: '欧美', kr: '韩国' }
  );
});
