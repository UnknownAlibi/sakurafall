const test = require('node:test');
const assert = require('node:assert/strict');
const bangumiApi = require('../src/main/services/BangumiApi');

test('Bangumi detail keeps raw title and extracts searchable aliases from infobox', () => {
  const detail = bangumiApi._normalizeDetail({
    id: 42,
    name: 'Original Title',
    name_cn: '中文标题',
    infobox: [
      { key: '别名', value: [{ v: 'Alias One' }, { v: 'Alias Two' }] },
      { key: '英文名', value: 'English Title' },
      { key: '放送开始', value: '2026-01-01' }
    ],
    eps: []
  });

  assert.equal(detail.nameRaw, 'Original Title');
  assert.equal(detail.name_raw, 'Original Title');
  assert.deepEqual(detail.aliases, ['Alias One', 'Alias Two', 'English Title']);
});
