const test = require('node:test');
const assert = require('node:assert/strict');

const {
    dedupePlayHistoryRows,
    getPlayHistoryIdentity,
    normalizeHistoryTitle
} = require('../src/main/utils/playHistoryIdentity');

test('history rows from different sources share one Bangumi identity', () => {
    const rows = [
        { id: 4, anime_id: '60723', source: 'ffzy-api', name: '葬送的芙莉莲', bgm_id: 400602 },
        { id: 3, anime_id: '48126', source: 'subo', name: '葬送的芙莉莲', bgm_id: 400602 },
        { id: 2, anime_id: '99', source: 'ffzy-api', name: '另一部番剧', bgm_id: 123 }
    ];

    const result = dedupePlayHistoryRows(rows, 10);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 4);
    assert.equal(result[1].id, 2);
});

test('history identity reads Bangumi id from serialized anime data', () => {
    const identity = getPlayHistoryIdentity({
        anime_id: 'source-id',
        source: 'source-a',
        anime_data: JSON.stringify({ bgm_id: 400602, name: '葬送的芙莉莲' })
    });
    assert.equal(identity, 'bgm:400602');
});

test('legacy rows without Bangumi id use a conservative normalized title', () => {
    assert.equal(normalizeHistoryTitle(' 欢迎来到 实力至上主义的教室 '), '欢迎来到实力至上主义的教室');
    const rows = [
        { id: 2, anime_id: 'a', source: 'one', name: '欢迎来到 实力至上主义的教室' },
        { id: 1, anime_id: 'b', source: 'two', name: '欢迎来到实力至上主义的教室' }
    ];
    assert.equal(dedupePlayHistoryRows(rows).length, 1);
});

test('same title with different Bangumi ids remains distinct', () => {
    const rows = [
        { id: 2, name: '同名作品', bgm_id: 100 },
        { id: 1, name: '同名作品', bgm_id: 101 }
    ];
    assert.equal(dedupePlayHistoryRows(rows).length, 2);
});
