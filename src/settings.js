const db = require('./db');
const config = require('./config');
const { encrypt, decrypt } = require('./crypto');

const GARMIN_LOGIN_DISABLED_KEY = 'garmin_login_disabled_until';

const ENCRYPTED_KEYS = new Set([
  'garmin_password',
  'garmin_oauth1',
  'garmin_oauth2',
  'wahoo_access_token',
  'wahoo_refresh_token',
  'hammerhead_password',
  'hammerhead_token',
  'coros_password',
  'coros_token',
  'strava_password',
  'strava_session_cookie',
]);

const nowSeconds = () => Math.floor(Date.now() / 1000);

const setStatement = db.prepare(`
  INSERT INTO settings (athlete_id, key, value, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(athlete_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);
const getStatement = db.prepare('SELECT value FROM settings WHERE athlete_id = ? AND key = ?');
const removeStatement = db.prepare('DELETE FROM settings WHERE athlete_id = ? AND key = ?');
const keysStatement = db.prepare('SELECT key FROM settings WHERE athlete_id = ?');
const getAppStatement = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const extendAppTimestampStatement = db.prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value=MAX(CAST(app_settings.value AS INTEGER), CAST(excluded.value AS INTEGER)),
    updated_at=excluded.updated_at
`);

function set(athleteId, key, value) {
  const stored = ENCRYPTED_KEYS.has(key) && value != null ? encrypt(value) : value;
  setStatement.run(athleteId, key, stored, nowSeconds());
}

function get(athleteId, key) {
  const row = getStatement.get(athleteId, key);
  if (!row || row.value == null) return null;
  if (ENCRYPTED_KEYS.has(key)) {
    try { return decrypt(row.value); } catch { return null; }
  }
  return row.value;
}

function remove(athleteId, key) {
  removeStatement.run(athleteId, key);
}

// The Garmin login pause is app-wide: Garmin throttles by account/IP, not per Strava athlete.
function getGarminLoginDisabledUntil() {
  const row = getAppStatement.get(GARMIN_LOGIN_DISABLED_KEY);
  const disabledUntil = Number(row && row.value);
  return Number.isSafeInteger(disabledUntil) && disabledUntil > Date.now() ? disabledUntil : null;
}

// Only ever extends an existing pause.
function disableGarminLoginUntil(timestamp) {
  extendAppTimestampStatement.run(GARMIN_LOGIN_DISABLED_KEY, String(timestamp), nowSeconds());
}

function summary(athleteId) {
  const keys = new Set(keysStatement.all(athleteId).map(r => r.key));
  return {
    garmin: {
      hasUsername: keys.has('garmin_username'),
      hasPassword: keys.has('garmin_password'),
      hasToken: keys.has('garmin_oauth2'),
      loginDisabledUntil: getGarminLoginDisabledUntil(),
    },
    wahoo: {
      appConfigured: !!(config.wahoo.clientId && config.wahoo.clientSecret),
      connected: keys.has('wahoo_refresh_token'),
    },
    hammerhead: {
      hasUsername: keys.has('hammerhead_username'),
      hasPassword: keys.has('hammerhead_password'),
      hasToken: keys.has('hammerhead_token'),
    },
    coros: {
      hasUsername: keys.has('coros_username'),
      hasPassword: keys.has('coros_password'),
      hasToken: keys.has('coros_token'),
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
