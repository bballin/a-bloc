const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate, LATEST_VERSION } = require('../src/migrations');

function legacyDatabase() {
  const db = new Database(':memory:');
  // Schema as created by versions before migrations existed (user_version 0).
  migrate(db, [require('../src/migrations').MIGRATIONS[0]]);
  db.pragma('user_version = 0');
  const insertSegment = db.prepare(`
    INSERT INTO segments (athlete_id, segment_id, name, distance, start_lat, start_lng, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertSegment.run(1, '100', 'Old name', 1000, 1.5, 2.5, 10);
  insertSegment.run(2, '100', 'Newer name', 1100, 1.5, 2.5, 20);
  insertSegment.run(1, '200', 'Only in segments', 500, null, null, 15);
  db.prepare(`INSERT INTO segment_cache (segment_id, name, updated_at) VALUES ('100', 'Cached', 15)`).run();
  const insertSetting = db.prepare('INSERT INTO settings (athlete_id, key, value, updated_at) VALUES (?, ?, ?, 1)');
  insertSetting.run(0, 'garmin_login_global_retry_after', '4102444800000');
  insertSetting.run(1, 'garmin_login_retry_after', '123');
  insertSetting.run(1, 'garmin_username', 'rider@example.com');
  return db;
}

test('fresh database migrates to the latest version', () => {
  const db = new Database(':memory:');
  const applied = migrate(db);
  assert.equal(applied.length, LATEST_VERSION);
  assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
  assert.deepEqual(migrate(db), [], 'second run is a no-op');
});

test('legacy segments move into the shared cache, keeping the newest copy', () => {
  const db = legacyDatabase();
  migrate(db);
  const cache = db.prepare('SELECT segment_id, name FROM segment_cache ORDER BY segment_id').all();
  assert.deepEqual(cache, [{ segment_id: '100', name: 'Newer name' }, { segment_id: '200', name: 'Only in segments' }]);
  const links = db.prepare('SELECT athlete_id, segment_id FROM athlete_segments ORDER BY athlete_id, segment_id').all();
  assert.deepEqual(links, [
    { athlete_id: 1, segment_id: '100' },
    { athlete_id: 1, segment_id: '200' },
    { athlete_id: 2, segment_id: '100' },
  ]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'segments'`).get().n, 0);
});

test('global settings move out of the per-athlete table', () => {
  const db = legacyDatabase();
  migrate(db);
  assert.equal(
    db.prepare(`SELECT value FROM app_settings WHERE key = 'garmin_login_disabled_until'`).get().value,
    '4102444800000'
  );
  const remaining = db.prepare('SELECT athlete_id, key FROM settings ORDER BY key').all();
  assert.deepEqual(remaining, [{ athlete_id: 1, key: 'garmin_username' }]);
});
