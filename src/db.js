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

module.exports = db;
