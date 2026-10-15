const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

const ENCRYPTED_KEYS = new Set([
  'garmin_password',
  'garmin_oauth1',
  'garmin_oauth2',
  'strava_password',
  'strava_session_cookie',
]);

function set(athleteId, key, value) {
  const stored = ENCRYPTED_KEYS.has(key) && value != null ? encrypt(value) : value;
  db.prepare(`
    INSERT INTO settings (athlete_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(athlete_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(athleteId, key, stored, Math.floor(Date.now() / 1000));
}

function get(athleteId, key) {
  const row = db.prepare('SELECT value FROM settings WHERE athlete_id = ? AND key = ?').get(athleteId, key);
  if (!row) return null;
  if (row.value == null) return null;
  if (ENCRYPTED_KEYS.has(key)) {
    try { return decrypt(row.value); } catch { return null; }
  }
  return row.value;
}

function remove(athleteId, key) {
  db.prepare('DELETE FROM settings WHERE athlete_id = ? AND key = ?').run(athleteId, key);
}

function summary(athleteId) {
  const rows = db.prepare('SELECT key FROM settings WHERE athlete_id = ?').all(athleteId);
  const keys = new Set(rows.map(r => r.key));
  return {
    garmin: {
      hasUsername: keys.has('garmin_username'),
      hasPassword: keys.has('garmin_password'),
      hasToken: keys.has('garmin_oauth2'),
    },
    strava_web: {
      hasUsername: keys.has('strava_username'),
      hasPassword: keys.has('strava_password'),
      hasCookie: keys.has('strava_session_cookie'),
    },
  };
}

module.exports = { set, get, remove, summary };
