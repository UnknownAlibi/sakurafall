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

test('local rating sorting prefers the official rank and discounts tiny samples', () => {
  const order = subjectIndexService._resolveOrderBy('rating');
  assert.match(order, /WHEN s\.rank > 0 THEN 0/);
  assert.match(order, /WHEN s\.rating > 0 AND s\.votes >= 10 THEN 1/);
  assert.match(order, /CASE WHEN s\.rank > 0 THEN s\.rank/);
  assert.match(order, /s\.rating \* s\.votes/);
});

test('local rating results do not let one-vote tens outrank trusted subjects', () => {
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
    INSERT INTO bangumi_subjects (bgm_id, name_cn, rating, rank, votes, air_date, year, platform)
      VALUES (1, 'Official first', 9.2, 1, 30000, '2008-10-02', 2008, 'TV'),
             (2, 'Official second', 9.1, 2, 10000, '2004-01-01', 2004, 'TV'),
             (3, 'Tiny perfect score', 10, 0, 1, '2024-01-01', 2024, 'TV'),
             (4, 'Small high score', 9.3, 0, 20, '2005-04-23', 2005, 'TV'),
             (5, 'Established score', 8.8, 0, 1000, '2011-04-06', 2011, 'TV'),
             (6, 'Unrated', 0, 0, 0, '2020-01-01', 2020, 'TV');
  `);
  subjectIndexService.db = db;
  try {
    const result = subjectIndexService.querySubjects({
      sort: 'rating',
      releasedOnly: true,
      platform: 'TV',
      pageSize: 20
    });
    assert.deepEqual(result.data.map(item => item.bgm_id), [1, 2, 5, 4, 3, 6]);
    assert.equal(result.total, 6);
  } finally {
    subjectIndexService.db = originalDb;
    db.close();
  }
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

test('local latest and rating sorts preserve the same filtered total', () => {
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
    INSERT INTO bangumi_subjects (bgm_id, name_cn, rating, rank, votes, air_date, year, platform)
      VALUES (1, 'Rated', 8.5, 12, 500, '2020-01-01', 2020, 'TV'),
             (2, 'Unrated', 0, 0, 0, '2021-01-01', 2021, 'TV'),
             (3, 'Undated old', 7.2, 300, 20, '', 2019, 'TV'),
             (4, 'Future', 9.9, 1, 900, '2099-01-01', 2099, 'TV');
  `);
  subjectIndexService.db = db;
  try {
    const latest = subjectIndexService.querySubjects({ sort: 'latest', releasedOnly: true, platform: 'TV' });
    const rating = subjectIndexService.querySubjects({ sort: 'rating', releasedOnly: true, platform: 'TV' });
    assert.equal(latest.total, 3);
    assert.equal(rating.total, latest.total);
    assert.deepEqual(new Set(rating.data.map(item => item.bgm_id)), new Set(latest.data.map(item => item.bgm_id)));
    assert.equal(rating.data.at(-1).bgm_id, 2);
  } finally {
    subjectIndexService.db = originalDb;
    db.close();
  }
});
