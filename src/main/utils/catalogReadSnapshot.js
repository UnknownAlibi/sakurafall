const Database = require('better-sqlite3');

// Pin a WAL read view while yielding between import batches. Writers keep their
// existing connection; no transaction is held across unrelated application writes.
module.exports = function openCatalogReadSnapshot(db) {
  if (typeof db?.pragma !== 'function') return null;
  if (!db.name || db.name === ':memory:') return new Database(db.serialize());
  if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
    throw new Error('Catalog batch import requires WAL mode');
  }
  const reader = new Database(db.name, { readonly: true, fileMustExist: true });
  try {
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM bangumi_subjects').get();
    return reader;
  } catch (error) {
    reader.close();
    throw error;
  }
};
