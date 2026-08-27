import test from 'node:test';
import assert from 'node:assert/strict';

const {
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
