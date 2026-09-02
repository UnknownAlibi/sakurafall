const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const AnimeDatabase = require('../src/main/services/AnimeDatabase');
const { registerLibraryIpc } = require('../src/main/ipc/library');

test('viewing notes persist by source-independent episode identity', () => {
  const service = new AnimeDatabase();
  service.db = new Database(':memory:');
  service._createViewingNotesTable();

  const saved = service.addViewingNote({
    episode_key: 'bgm:400602|ep:12',
    work_key: 'bgm:400602',
    bgm_id: 400602,
    anime_name: '葬送的芙莉莲',
    episode_number: 12,
    episode_title: '第12集',
    position: 321.5,
    duration: 1440,
    note: '伏笔',
    source_id: 'source-a'
  });
  assert.ok(saved.id > 0);

  const fromAnotherSource = service.getViewingNotes('bgm:400602|ep:12');
  assert.equal(fromAnotherSource.length, 1);
  assert.equal(fromAnotherSource[0].note, '伏笔');
  assert.equal(service.removeViewingNote(saved.id).changes, 1);
  assert.deepEqual(service.getViewingNotes('bgm:400602|ep:12'), []);
  service.db.close();
});

test('legacy viewing_notes table gains category column via v7 migration helper', () => {
  // 模拟 v6 旧库：viewing_notes 尚无 category 列
  const service = new AnimeDatabase();
  service.db = new Database(':memory:');
  service.db.exec(`
    CREATE TABLE viewing_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_key TEXT NOT NULL,
      note TEXT DEFAULT '',
      source_id TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    )
  `);
  service._addColumnIfNotExists('viewing_notes', 'category', "TEXT DEFAULT ''");
  const columns = service.db.prepare('PRAGMA table_info(viewing_notes)').all().map(c => c.name);
  assert.ok(columns.includes('category'), 'v7 迁移应补充 category 列');
  service.db.close();
});

test('library IPC registers notebook alongside favorites and history', async () => {
  const handlers = new Map();
  const animeDb = {
    addViewingNote: data => ({ id: 1, ...data }),
    getViewingNotes: key => [{ id: 1, episode_key: key }],
    removeViewingNote: id => ({ changes: Number(id === 1) })
  };
  registerLibraryIpc({ handle: (channel, listener) => handlers.set(channel, listener), animeDb });

  assert.ok(handlers.has('favorite-add'));
  assert.ok(handlers.has('history-update'));
  assert.equal((await handlers.get('viewing-note-add')({}, { episode_key: 'x' })).id, 1);
  assert.equal((await handlers.get('viewing-note-list')({}, 'x'))[0].episode_key, 'x');
  assert.equal((await handlers.get('viewing-note-remove')({}, 1)).changes, 1);
});
