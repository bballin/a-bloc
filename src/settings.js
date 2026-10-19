const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

const GLOBAL_SETTINGS_ATHLETE_ID = 0;
const GARMIN_LOGIN_DISABLED_KEY = 'garmin_login_global_retry_after';
const INITIAL_GARMIN_LOGIN_DISABLED_UNTIL = Date.parse('2026-10-20T13:59:28-07:00');

const ENCRYPTED_KEYS = new Set([
  'garmin_password',
  'garmin_oauth1',
  'garmin_oauth2',
  'strava_password',
  'strava_session_cookie',
]);

if (INITIAL_GARMIN_LOGIN_DISABLED_UNTIL > Date.now()) {
  db.prepare(`
    INSERT OR IGNORE INTO settings (athlete_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    GLOBAL_SETTINGS_ATHLETE_ID,
    GARMIN_LOGIN_DISABLED_KEY,
    String(INITIAL_GARMIN_LOGIN_DISABLED_UNTIL),
    Math.floor(Date.now() / 1000)
  );
}

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

function getGarminLoginDisabledUntil() {
  const disabledUntil = Number(get(GLOBAL_SETTINGS_ATHLETE_ID, GARMIN_LOGIN_DISABLED_KEY));
  return Number.isSafeInteger(disabledUntil) && disabledUntil > Date.now() ? disabledUntil : null;
}

function disableGarminLoginUntil(timestamp) {
  db.prepare(`
    INSERT INTO settings (athlete_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(athlete_id, key) DO UPDATE SET
      value=MAX(CAST(settings.value AS INTEGER), CAST(excluded.value AS INTEGER)),
      updated_at=excluded.updated_at
  `).run(
    GLOBAL_SETTINGS_ATHLETE_ID,
    GARMIN_LOGIN_DISABLED_KEY,
    String(timestamp),
    Math.floor(Date.now() / 1000)
  );
}

function summary(athleteId) {
  const rows = db.prepare('SELECT key FROM settings WHERE athlete_id = ?').all(athleteId);
  const keys = new Set(rows.map(r => r.key));
  return {
    garmin: {
      hasUsername: keys.has('garmin_username'),
      hasPassword: keys.has('garmin_password'),
      hasToken: keys.has('garmin_oauth2'),
      loginDisabledUntil: getGarminLoginDisabledUntil(),
    },
    strava_web: {
      hasUsername: keys.has('strava_username'),
      hasPassword: keys.has('strava_password'),
      hasCookie: keys.has('strava_session_cookie'),
    },
  };
}

module.exports = {
  set,
  get,
  remove,
  summary,
  getGarminLoginDisabledUntil,
  disableGarminLoginUntil,
};
