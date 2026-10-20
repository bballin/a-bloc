// Each migration runs once, in order, inside a transaction; PRAGMA user_version
// records the last applied version. Never edit an applied migration — add a new one.

const SEGMENT_COLUMNS = `segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
  start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline, updated_at`;

// Garmin locked out this deployment's login on 2026-10-19; carry that pause into
// databases that predate the app_settings table.
const KNOWN_GARMIN_LOCKOUT_UNTIL = Date.parse('2026-10-20T13:59:28-07:00');

const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS athletes (
          id INTEGER PRIMARY KEY,
          firstname TEXT,
          lastname TEXT,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          athlete_id INTEGER NOT NULL,
          sensor_key TEXT NOT NULL,
          sensor_label TEXT,
          gear_id TEXT NOT NULL,
          gear_name TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          UNIQUE(athlete_id, sensor_key)
        );

        CREATE TABLE IF NOT EXISTS settings (
          athlete_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (athlete_id, key)
        );

        CREATE TABLE IF NOT EXISTS sessions (
          sid TEXT PRIMARY KEY,
          sess TEXT NOT NULL,
          expires INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);

        CREATE TABLE IF NOT EXISTS processed (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          athlete_id INTEGER NOT NULL,
          activity_id TEXT,
          fit_filename TEXT,
          sensors_json TEXT,
          matched_gear_id TEXT,
          matched_gear_name TEXT,
          status TEXT NOT NULL,
          message TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS segments (
          athlete_id INTEGER NOT NULL,
          segment_id TEXT NOT NULL,
          name TEXT NOT NULL,
          activity_type TEXT,
          distance REAL,
          average_grade REAL,
          total_elevation_gain REAL,
          start_lat REAL,
          start_lng REAL,
          end_lat REAL,
          end_lng REAL,
          city TEXT,
          state TEXT,
          country TEXT,
          map_polyline TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (athlete_id, segment_id)
        );

        CREATE TABLE IF NOT EXISTS segment_cache (
          segment_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          activity_type TEXT,
          distance REAL,
          average_grade REAL,
          total_elevation_gain REAL,
          start_lat REAL,
          start_lng REAL,
          end_lat REAL,
          end_lng REAL,
          city TEXT,
          state TEXT,
          country TEXT,
          map_polyline TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS segment_count_tracking (
          athlete_id INTEGER NOT NULL,
          segment_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (athlete_id, segment_id)
        );

        CREATE TABLE IF NOT EXISTS segment_count_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          athlete_id INTEGER NOT NULL,
          activity_id TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(athlete_id, activity_id)
        );
      `);
    },
  },
  {
    version: 2,
    name: 'athlete segments reference the shared segment cache',
    up(db) {
      db.exec(`
        INSERT INTO segment_cache (${SEGMENT_COLUMNS})
        SELECT ${SEGMENT_COLUMNS} FROM segments WHERE true
        ON CONFLICT(segment_id) DO UPDATE SET
          name=excluded.name,
          activity_type=excluded.activity_type,
          distance=excluded.distance,
          average_grade=excluded.average_grade,
          total_elevation_gain=excluded.total_elevation_gain,
          start_lat=excluded.start_lat,
          start_lng=excluded.start_lng,
          end_lat=excluded.end_lat,
          end_lng=excluded.end_lng,
          city=excluded.city,
          state=excluded.state,
          country=excluded.country,
          map_polyline=excluded.map_polyline,
          updated_at=excluded.updated_at
        WHERE excluded.updated_at > segment_cache.updated_at;

        CREATE TABLE athlete_segments (
          athlete_id INTEGER NOT NULL,
          segment_id TEXT NOT NULL REFERENCES segment_cache(segment_id),
          added_at INTEGER NOT NULL,
          PRIMARY KEY (athlete_id, segment_id)
        );

        INSERT INTO athlete_segments (athlete_id, segment_id, added_at)
        SELECT athlete_id, segment_id, updated_at FROM segments;

        DROP TABLE segments;
      `);
    },
  },
  {
    version: 3,
    name: 'app-wide settings table',
    up(db) {
      db.exec(`
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at INTEGER NOT NULL
        );

        -- Global values were previously stored as athlete 0 in the per-athlete table.
        INSERT INTO app_settings (key, value, updated_at)
        SELECT CASE key WHEN 'garmin_login_global_retry_after' THEN 'garmin_login_disabled_until' ELSE key END,
          value, updated_at
        FROM settings WHERE athlete_id = 0;
        DELETE FROM settings WHERE athlete_id = 0;

        -- Superseded by the global Garmin login pause.
        DELETE FROM settings WHERE key = 'garmin_login_retry_after';
      `);
      if (KNOWN_GARMIN_LOCKOUT_UNTIL > Date.now()) {
        db.prepare(`
          INSERT INTO app_settings (key, value, updated_at) VALUES ('garmin_login_disabled_until', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(app_settings.value AS INTEGER), CAST(excluded.value AS INTEGER))
        `).run(String(KNOWN_GARMIN_LOCKOUT_UNTIL), Math.floor(Date.now() / 1000));
      }
    },
  },
  {
    version: 4,
    name: 'persistent webhook job queue',
    up(db) {
      db.exec(`
        CREATE TABLE webhook_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          athlete_id INTEGER NOT NULL,
          activity_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          run_after_ms INTEGER NOT NULL,
          locked_until_ms INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(kind, athlete_id, activity_id)
        );

        CREATE INDEX webhook_jobs_status_idx ON webhook_jobs(status, run_after_ms);
      `);
    },
  },
  {
    version: 5,
    name: 'remember the segment-count block written to each activity',
    up(db) {
      // Custom description templates can produce any text, so the exact block is
      // stored to find and replace it when the activity is processed again.
      db.exec('ALTER TABLE segment_count_events ADD COLUMN description_block TEXT');
    },
  },
];

function migrate(db, migrations = MIGRATIONS) {
  const current = db.pragma('user_version', { simple: true });
  const applied = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
    applied.push(migration);
  }
  return applied;
}

module.exports = { migrate, MIGRATIONS, LATEST_VERSION: MIGRATIONS[MIGRATIONS.length - 1].version };
