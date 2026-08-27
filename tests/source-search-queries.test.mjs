import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const moduleSource = await readFile(
  new URL('../src/renderer/utils/sourceSearchQueries.js', import.meta.url),
  'utf8'
);
const { buildSourceSearchQueries, mergeSourceSearchStatuses } = await import(
  `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`
);

test('source queries include display name, raw title, aliases and seasonless variants', () => {
  const queries = buildSourceSearchQueries({
    name: '间谍过家家 第二季',
    nameRaw: 'SPY×FAMILY Season 2',
    aliases: ['SPY FAMILY 2'],
    infobox: [{ key: '中文名', value: '间谍过家家2' }]
  });

  assert.equal(queries[0], '间谍过家家 第二季');
  assert.ok(queries.includes('SPY×FAMILY Season 2'));
  assert.ok(queries.includes('SPY FAMILY 2'));
  assert.ok(queries.includes('间谍过家家'));
  assert.ok(queries.includes('SPY×FAMILY'));
});

test('source statuses merge alias results per provider without duplicates', () => {
  const merged = mergeSourceSearchStatuses(
    [{ providerId: 'cms:a', status: 'noResult', keyword: '中文名', results: [], elapsedMs: 10 }],
    [{
      providerId: 'cms:a',
      status: 'success',
      keyword: 'Raw Name',
      results: [{ id: '1', name: '命中' }, { id: '1', name: '命中' }],
      elapsedMs: 20
    }]
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'success');
  assert.equal(merged[0].results.length, 1);
  assert.deepEqual(merged[0].queries, ['中文名', 'Raw Name']);
  assert.equal(merged[0].elapsedMs, 30);
});
