const test = require('node:test');
const assert = require('node:assert/strict');
const subjectIndexService = require('../src/main/services/SubjectIndexService');

test('local rank sorting puts unranked subjects after ranked subjects', () => {
  const order = subjectIndexService._resolveOrderBy('rank');
  assert.match(order, /CASE WHEN s\.rank > 0 THEN 0 ELSE 1 END ASC/);
  assert.match(order, /s\.rank ASC/);
});

test('local latest sorting puts valid dates first and remains deterministic', () => {
  const order = subjectIndexService._resolveOrderBy('latest');
  assert.match(order, /air_date GLOB/);
  assert.match(order, /s\.air_date DESC/);
  assert.match(order, /s\.bgm_id DESC/);
});

test('local numeric rating sorting keeps unrated subjects at the end', () => {
  const order = subjectIndexService._resolveOrderBy('rating');
  assert.match(order, /CASE WHEN s\.rating > 0 THEN 0 ELSE 1 END ASC/);
  assert.match(order, /s\.rating DESC, s\.votes DESC/);
});
