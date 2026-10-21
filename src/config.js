require('dotenv').config();
const path = require('path');

const DEV_SESSION_SECRET = 'dev-secret-change-me';
const MIN_SECRET_LENGTH = 16;
const env = process.env;

function intFromEnv(name, fallback) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer (got "${raw}").`);
  return value;
}

const isRailway = !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID);
const isProduction = isRailway || env.NODE_ENV === 'production';
const port = intFromEnv('PORT', 3000);
const appBaseUrl = (env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
if (isProduction) {
  const publicUrl = new URL(appBaseUrl);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password) {
    throw new Error('APP_BASE_URL must be a public HTTPS URL in production.');
  }
}
const railwayDrainSeconds = intFromEnv('RAILWAY_DEPLOYMENT_DRAINING_SECONDS', 0);
const warnings = [];

const explicitSecret = env.SESSION_SECRET || '';
if (explicitSecret && explicitSecret.length < MIN_SECRET_LENGTH) {
  throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
}
if (!explicitSecret && isProduction) {
  throw new Error('SESSION_SECRET must be set in production; it signs sessions and encrypts stored credentials.');
}
if (!explicitSecret) {
  warnings.push(`SESSION_SECRET is not set; using an insecure development secret. Stored credentials cannot be saved until it is set.`);
}

if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
  warnings.push('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set. OAuth will fail until you create .env (see .env.example).');
}

const dataDir = env.APP_DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
if (isRailway && !env.RAILWAY_VOLUME_MOUNT_PATH && !env.APP_DATA_DIR) {
  warnings.push('No Railway volume path detected. SQLite data in the container may be lost on redeploy.');
}
if (isRailway && railwayDrainSeconds <= 0) {
  warnings.push('RAILWAY_DEPLOYMENT_DRAINING_SECONDS is not set. Railway will SIGKILL this process immediately after SIGTERM, so graceful shutdown cannot complete.');
}

const garminRelayUrl = (env.GARMIN_RELAY_URL || '').trim().replace(/\/+$/, '');
const garminRelaySecret = env.GARMIN_RELAY_SECRET || '';
if (garminRelayUrl) {
  let parsed;
  try { parsed = new URL(garminRelayUrl); } catch { throw new Error('GARMIN_RELAY_URL must be a valid URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  // Garmin passwords travel to the relay, so only loopback may use plain HTTP.
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('GARMIN_RELAY_URL must use https:// (http:// is only allowed for localhost).');
  }
  if (garminRelaySecret.length < 32) {
    throw new Error('GARMIN_RELAY_SECRET must be set (at least 32 characters) when GARMIN_RELAY_URL is set.');
  }
} else if (isRailway) {
  warnings.push('GARMIN_RELAY_URL is not set. Garmin usually blocks logins from cloud servers; see "Garmin login relay" in the README.');
}

module.exports = Object.freeze({
  isRailway,
  isProduction,
  port,
  host: env.HOST || '0.0.0.0',
  appBaseUrl,
  webhookCallbackUrl: `${appBaseUrl}/api/webhook/strava`,
  oauthCallbackUrl: `${appBaseUrl}/auth/callback`,
  sessionSecret: explicitSecret || DEV_SESSION_SECRET,
  // Null when unset so credential encryption refuses to use the public development secret.
  credentialsSecret: explicitSecret || null,
  sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  webhookVerifyToken: env.STRAVA_WEBHOOK_VERIFY_TOKEN || explicitSecret || DEV_SESSION_SECRET,
  strava: Object.freeze({
    clientId: env.STRAVA_CLIENT_ID || '',
    clientSecret: env.STRAVA_CLIENT_SECRET || '',
  }),
  wahoo: Object.freeze({
    clientId: env.WAHOO_CLIENT_ID || '',
    clientSecret: env.WAHOO_CLIENT_SECRET || '',
    callbackUrl: `${appBaseUrl}/auth/wahoo/callback`,
  }),
  garminRelay: Object.freeze({
    url: garminRelayUrl,
    secret: garminRelaySecret,
  }),
  dataDir,
  uploadDir: path.join(__dirname, '..', 'uploads'),
  // Finish shutdown before Railway escalates SIGTERM to SIGKILL.
  shutdownTimeoutMs: railwayDrainSeconds > 0 ? Math.max(1000, railwayDrainSeconds * 1000 - 2000) : 10_000,
  segmentMutationDelayMs: Math.max(250, intFromEnv('SEGMENT_MUTATION_DELAY_MS', 1000)),
  warnings: Object.freeze(warnings),
});
