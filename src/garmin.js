const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { GarminConnect } = require('garmin-connect');
const config = require('./config');
const settings = require('./settings');

const LOGIN_RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RELAY_TIMEOUT_MS = 90 * 1000;

class GarminLoginPausedError extends Error {
  constructor(message, disabledUntil) {
    super(message);
    this.name = 'GarminLoginPausedError';
    this.status = 429;
    this.disabledUntil = disabledUntil;
  }
}

function isRateLimited(error) {
  return !!error && (
    (error.response && error.response.status === 429) ||
    /\b429\b|rate.?limited/i.test(error.message || '')
  );
}

function assertLoginAllowed() {
  const disabledUntil = settings.getGarminLoginDisabledUntil();
  if (disabledUntil) {
    throw new GarminLoginPausedError(
      `Garmin access is temporarily disabled until ${new Date(disabledUntil).toLocaleString()}.`,
      disabledUntil
    );
  }
}

function isRelayConfigured() {
  return !!config.garminRelay.url;
}

async function getLoginStatus() {
  const relayConfigured = isRelayConfigured();
  let relayAvailable = null;
  let loginDisabledUntil = settings.getGarminLoginDisabledUntil();
  if (relayConfigured) {
    try {
      const response = await fetch(`${config.garminRelay.url}/health`, {
        headers: { Authorization: `Bearer ${config.garminRelay.secret}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.ok !== true || !(data.pausedUntil === null || Number.isSafeInteger(data.pausedUntil))) {
        throw new Error('Invalid relay health response');
      }
      relayAvailable = true;
      if (data.pausedUntil > Date.now()) {
        loginDisabledUntil = Math.max(loginDisabledUntil || 0, data.pausedUntil);
      }
    } catch (error) {
      console.warn('[garmin] Relay health check failed:', error.message);
      relayAvailable = false;
    }
  }
  return {
    relayConfigured,
    relayAvailable,
    loginDisabledUntil,
    loginAvailable: relayAvailable !== false && !loginDisabledUntil,
  };
}

async function relayRequest(path, body) {
  let response;
  try {
    response = await fetch(`${config.garminRelay.url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.garminRelay.secret}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Garmin login relay is unreachable (${error.message}).`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Garmin login relay: ${data.error || `HTTP ${response.status}`}`);
    // Lets isRateLimited() apply the normal cooldown when Garmin throttles the relay.
    error.response = { status: response.status };
    throw error;
  }
  return data;
}

async function loginForTokens(username, password) {
  if (isRelayConfigured()) {
    const { oauth1, oauth2 } = await relayRequest('/login', { username, password });
    if (!oauth1 || !oauth2) throw new Error('Garmin login relay returned no OAuth tokens.');
    return { oauth1, oauth2 };
  }
  const client = new GarminConnect({ username, password });
  await client.login();
  return { oauth1: client.client.oauth1Token, oauth2: client.client.oauth2Token };
}

function storeTokens(athleteId, oauth1, oauth2) {
  settings.set(athleteId, 'garmin_oauth1', JSON.stringify(oauth1));
  settings.set(athleteId, 'garmin_oauth2', JSON.stringify(oauth2));
}

// The library refreshes expired OAuth2 tokens itself (before requests and on 401s).
// Persist the result, and fall back to the relay if Garmin rejects this server.
function attachTokenRefresh(athleteId, client) {
  const http = client.client;
  const refreshDirect = http.refreshOauth2Token.bind(http);
  http.refreshOauth2Token = async () => {
    try {
      await refreshDirect();
    } catch (error) {
      if (!isRelayConfigured()) throw error;
      const { oauth2 } = await relayRequest('/refresh', { oauth1: http.oauth1Token });
      if (!oauth2) throw new Error('Garmin login relay returned no OAuth2 token.');
      http.oauth2Token = oauth2;
    }
    storeTokens(athleteId, http.oauth1Token, http.oauth2Token);
  };
}

/**
 * Returns a logged-in GarminConnect client for the athlete, or null if
 * Garmin is not configured. Reuses stored OAuth tokens when possible; a fresh
 * login goes through the Garmin login relay when GARMIN_RELAY_URL is set.
 */
async function getClient(athleteId) {
  const username = settings.get(athleteId, 'garmin_username');
  const password = settings.get(athleteId, 'garmin_password');
  if (!username || !password) return null;

  const client = new GarminConnect({ username, password });
  attachTokenRefresh(athleteId, client);

  const oauth1Raw = settings.get(athleteId, 'garmin_oauth1');
  const oauth2Raw = settings.get(athleteId, 'garmin_oauth2');
  let restored = false;
  if (oauth1Raw && oauth2Raw) {
    try {
      client.loadToken(JSON.parse(oauth1Raw), JSON.parse(oauth2Raw));
      restored = true;
    } catch (e) {
      restored = false;
    }
  }
  if (!restored) {
    assertLoginAllowed();
    let tokens;
    try {
      tokens = await loginForTokens(username, password);
    } catch (error) {
      if (!isRateLimited(error)) throw error;
      const disabledUntil = Date.now() + LOGIN_RATE_LIMIT_COOLDOWN_MS;
      settings.disableGarminLoginUntil(disabledUntil);
      throw new GarminLoginPausedError(
        `Garmin rate-limited login attempts. Further login attempts are paused until ${new Date(disabledUntil).toLocaleString()}.`,
        disabledUntil
      );
    }

    if (!tokens.oauth1 || !tokens.oauth2) throw new Error('Garmin login completed without returning reusable OAuth tokens.');
    client.loadToken(tokens.oauth1, tokens.oauth2);
    storeTokens(athleteId, tokens.oauth1, tokens.oauth2);
  }
  return client;
}

/**
 * Find the Garmin activity whose startTimeLocal/startTimeGMT is within
 * `windowMs` of `startTime`. Searches the most recent `limit` activities.
 */
// Garmin returns startTimeGMT like "2024-05-08 14:14:00" (UTC, but no zone marker).
// JS Date() would parse that as local time. Normalize to ISO-UTC.
function parseGarminGmt(s) {
  if (!s) return NaN;
  // Already has timezone info?
  if (/[zZ]|[+\-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

async function findActivityByStartTime(client, startTime, { limit = 30, windowMs = 5 * 60 * 1000 } = {}) {
  const activities = await client.getActivities(0, limit);
  const target = new Date(startTime).getTime();
  return activities.find(a => {
    const t = parseGarminGmt(a.startTimeGMT) || parseGarminGmt(a.startTimeLocal) || 0;
    return Math.abs(t - target) <= windowMs;
  }) || null;
}

/**
 * Download the original activity (FIT) for the given Garmin activity.
 * Returns { fitPath, cleanup() } where fitPath is a real .fit file on disk.
 *
 * Garmin's "original" download is a zip; we extract the first .fit inside.
 */
async function downloadOriginalFit(client, activity) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-gc-'));
  await client.downloadOriginalActivityData(activity, tmpDir);

  const files = fs.readdirSync(tmpDir).map(f => path.join(tmpDir, f));
  let fitPath = files.find(f => f.toLowerCase().endsWith('.fit'));
  if (!fitPath) {
    const zipPath = files.find(f => f.toLowerCase().endsWith('.zip'));
    if (!zipPath) {
      cleanupDir(tmpDir);
      throw new Error(`Garmin original download did not contain a FIT or ZIP. Got: ${files.map(f => path.basename(f)).join(', ')}`);
    }
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const fitEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.fit'));
    if (!fitEntry) {
      cleanupDir(tmpDir);
      throw new Error(`Garmin original zip did not contain a .fit file. Entries: ${entries.map(e => e.entryName).join(', ')}`);
    }
    fitPath = path.join(tmpDir, fitEntry.entryName);
    zip.extractEntryTo(fitEntry, tmpDir, false, true);
  }

  return {
    fitPath,
    cleanup: () => cleanupDir(tmpDir),
  };
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = {
  getClient,
  isRelayConfigured,
  getLoginStatus,
  assertLoginAllowed,
  isRateLimited,
  GarminLoginPausedError,
  parseGarminGmt,
  findActivityByStartTime,
  downloadOriginalFit,
};
