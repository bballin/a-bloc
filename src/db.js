const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.APP_DATA_DIR
  || process.env.RAILWAY_VOLUME_MOUNT_PATH
  || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'app.db');
const isRailway = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID;
if (isRailway && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.APP_DATA_DIR) {
  console.warn('[warn] No Railway volume path detected. SQLite data in the container may be lost on redeploy.');
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

const segmentCacheCount = db.prepare('SELECT COUNT(*) AS count FROM segment_cache').get().count;
if (segmentCacheCount === 0) {
  const insertCachedSegment = db.prepare(`
    INSERT INTO segment_cache (
      segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
      start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  `);
  const migrateCachedSegments = db.transaction(() => {
    const legacySegments = db.prepare(`
      SELECT segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
        start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline, updated_at
      FROM segments ORDER BY updated_at, athlete_id
    `).all();
    for (const segment of legacySegments) {
      insertCachedSegment.run(
        segment.segment_id, segment.name, segment.activity_type, segment.distance,
        segment.average_grade, segment.total_elevation_gain, segment.start_lat,
        segment.start_lng, segment.end_lat, segment.end_lng, segment.city,
        segment.state, segment.country, segment.map_polyline, segment.updated_at
      );
    }
  });
  migrateCachedSegments();
}

module.exports = db;
