const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTitle, scoreTitleMatch } = require('../src/main/services/cms/TitleMatcher');

test('title matcher removes release metadata without changing the work title', () => {
    assert.equal(normalizeTitle('One Piece [1080P WEB-DL]'), 'onepiece');
    assert.equal(scoreTitleMatch('One Piece', 'One Piece [1080P WEB-DL]').exact, true);
});

test('title matcher rejects a movie subtitle when looking for the series', () => {
    const match = scoreTitleMatch('One Piece', 'One Piece Film Red');
    assert.equal(match.reliable, false);
});

test('title matcher accepts small spelling differences', () => {
    const match = scoreTitleMatch('Bocchi the Rock', 'Bocchi the Rok');
    assert.equal(match.reliable, true);
    assert.ok(match.score > 0.9);
});
