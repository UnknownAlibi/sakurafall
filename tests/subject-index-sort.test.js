const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
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

test('local catalog eligibility SQL does not let undated titles into latest', () => {
  const originalDb = subjectIndexService.db;
  const statements = [];
  subjectIndexService.db = {
    prepare(sql) {
      statements.push(sql);
      return {
        get: () => ({ n: 0 }),
        all: () => []
      };
    }
  };
  try {
    subjectIndexService.querySubjects({ sort: 'latest', releasedOnly: true, requireDated: true });
    const countSql = statements.find(sql => sql.includes('COUNT(*)')) || '';
    assert.match(countSql, /air_date GLOB '....-..-..'/);
    assert.doesNotMatch(countSql, /air_date IS NULL/);
  } finally {
    subjectIndexService.db = originalDb;
  }
});

test('local score eligibility requires a meaningful rating sample or official rank', () => {
  const originalDb = subjectIndexService.db;
  const statements = [];
  subjectIndexService.db = {
    prepare(sql) {
      statements.push(sql);
      return {
        get: () => ({ n: 0 }),
        all: () => []
      };
    }
  };
  try {
    subjectIndexService.querySubjects({ sort: 'rating', releasedOnly: true, requireRated: true });
    const countSql = statements.find(sql => sql.includes('COUNT(*)')) || '';
    assert.match(countSql, /s\.rating > 0/);
    assert.match(countSql, /s\.votes >= 10 OR s\.rank > 0/);
    assert.match(countSql, /s\.year IS NOT NULL AND s\.year <= \?/);
  } finally {
    subjectIndexService.db = originalDb;
  }
});

test('local region and genre tags use AND semantics alongside platform', () => {
  const originalDb = subjectIndexService.db;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bangumi_subjects (
      bgm_id INTEGER PRIMARY KEY, name TEXT, name_cn TEXT, aliases TEXT, summary TEXT,
      cover_url TEXT, cover_local TEXT, rating REAL, rank INTEGER, votes INTEGER,
      eps INTEGER, air_date TEXT, air_weekday INTEGER, year INTEGER, month INTEGER,
      type INTEGER, nsfw INTEGER, popularity INTEGER, updated_at INTEGER, raw_json TEXT,
      platform TEXT
    );
    CREATE TABLE bangumi_subject_tags (bgm_id INTEGER, tag TEXT, count INTEGER);
    INSERT INTO bangumi_subjects (bgm_id, name_cn, rating, rank, votes, popularity, platform)
      VALUES (1, 'Both', 8, 1, 100, 10, 'WEB'), (2, 'Region only', 8, 2, 100, 9, 'WEB'),
             (3, 'Wrong platform', 8, 3, 100, 8, 'TV');
    INSERT INTO bangumi_subject_tags (bgm_id, tag, count)
      VALUES (1, '国漫', 1), (1, '战斗', 1), (2, '国漫', 1),
             (3, '国漫', 1), (3, '战斗', 1);
  `);
  subjectIndexService.db = db;
  try {
    const result = subjectIndexService.querySubjects({ tags: ['国漫', '战斗'], platform: 'WEB' });
    assert.deepEqual(result.data.map(item => item.bgm_id), [1]);
    assert.equal(result.total, 1);
  } finally {
    subjectIndexService.db = originalDb;
    db.close();
  }
});
