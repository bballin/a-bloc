// Wahoo Cloud API (official OAuth2): https://cloud-api.wahooligan.com/
const config = require('./config');
const settings = require('./settings');
const { downloadFit, closestByStartTime, DEFAULT_MATCH_WINDOW_MS } = require('./original-file');

const WAHOO_BASE = 'https://api.wahooligan.com';
const SCOPES = 'user_read workouts_read offline_data';
const TOKEN_KEYS = ['wahoo_access_token', 'wahoo_refresh_token', 'wahoo_token_expires_at'];

const refreshes = new Map();

function isAppConfigured() {
  return !!(config.wahoo.clientId && config.wahoo.clientSecret);
}

function isConnected(athleteId) {
  return !!settings.get(athleteId, 'wahoo_refresh_token');
}

function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.wahoo.clientId,
    redirect_uri: config.wahoo.callbackUrl,
    scope: SCOPES,
    response_type: 'code',
    state,
  });
  return `${WAHOO_BASE}/oauth/authorize?${params}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${WAHOO_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.wahoo.clientId,
      client_secret: config.wahoo.clientSecret,
      ...params,
    }).toString(),
  });
  if (!res.ok) {
    const error = new Error(`Wahoo token request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function saveTokens(athleteId, tokens) {
  if (!tokens || !tokens.access_token || !tokens.refresh_token) {
    throw new Error('Wahoo did not return an access and refresh token.');
  }
  const expiresIn = Number(tokens.expires_in) || 7200;
  settings.set(athleteId, 'wahoo_access_token', tokens.access_token);
  settings.set(athleteId, 'wahoo_refresh_token', tokens.refresh_token);
  settings.set(athleteId, 'wahoo_token_expires_at', String(Math.floor(Date.now() / 1000) + expiresIn));
}

function clearTokens(athleteId) {
  for (const key of TOKEN_KEYS) settings.remove(athleteId, key);
}

async function exchangeCode(athleteId, code) {
  const tokens = await tokenRequest({
    code,
    redirect_uri: config.wahoo.callbackUrl,
    grant_type: 'authorization_code',
  });
  saveTokens(athleteId, tokens);
}

// Wahoo revokes the previous tokens once a refreshed token is used and caps
// unrevoked tokens per user, so refresh only when needed and never concurrently.
function refresh(athleteId) {
  if (refreshes.has(athleteId)) return refreshes.get(athleteId);
  const promise = (async () => {
    const refreshToken = settings.get(athleteId, 'wahoo_refresh_token');
    if (!refreshToken) throw new Error('Wahoo is not connected.');
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    saveTokens(athleteId, tokens);
    return tokens.access_token;
  })().finally(() => refreshes.delete(athleteId));
  refreshes.set(athleteId, promise);
  return promise;
}

async function getAccessToken(athleteId) {
  const accessToken = settings.get(athleteId, 'wahoo_access_token');
  const expiresAt = Number(settings.get(athleteId, 'wahoo_token_expires_at')) || 0;
  if (accessToken && expiresAt - 60 > Math.floor(Date.now() / 1000)) return accessToken;
  return refresh(athleteId);
}

async function api(athleteId, apiPath, options = {}) {
  if (!isAppConfigured()) throw new Error('Wahoo integration is not configured on this server (WAHOO_CLIENT_ID / WAHOO_CLIENT_SECRET).');
  const send = token => fetch(`${WAHOO_BASE}${apiPath}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  let res = await send(await getAccessToken(athleteId));
  if (res.status === 401) res = await send(await refresh(athleteId));
  if (!res.ok) {
    const error = new Error(`Wahoo API ${apiPath} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

async function getUser(athleteId) {
  return api(athleteId, '/v1/user');
}

async function disconnect(athleteId) {
  try {
    if (isConnected(athleteId) && isAppConfigured()) await api(athleteId, '/v1/permissions', { method: 'DELETE' });
  } finally {
    clearTokens(athleteId);
  }
}

function summaryFileUrl(workout) {
  const summary = workout && workout.workout_summary;
  return (summary && summary.file && summary.file.url) || null;
}

/**
 * Find the Wahoo workout starting closest to `startTime` (within `windowMs`)
 * among the most recent `perPage` workouts.
 */
async function findWorkoutByStartTime(athleteId, startTime, { perPage = 30, windowMs = DEFAULT_MATCH_WINDOW_MS } = {}) {
  const body = await api(athleteId, `/v1/workouts?page=1&per_page=${perPage}`);
  const workouts = (body && body.workouts) || [];
  return closestByStartTime(workouts, w => new Date(w.starts).getTime(), startTime, windowMs);
}

async function downloadOriginalFit(athleteId, workout) {
  let url = summaryFileUrl(workout);
  if (!url) {
    const summary = await api(athleteId, `/v1/workouts/${encodeURIComponent(workout.id)}/workout_summary`);
    url = summary && summary.file && summary.file.url;
  }
  if (!url) throw new Error(`Wahoo workout ${workout.id} has no FIT file.`);
  // CDN downloads are unauthenticated and do not count as API calls.
  return downloadFit(url, { prefix: 'sgt-wahoo-', label: 'Wahoo', filename: `wahoo-${workout.id}.fit` });
}

module.exports = {
  isAppConfigured,
  isConnected,
  authorizeUrl,
  exchangeCode,
  getUser,
  disconnect,
  clearTokens,
  findWorkoutByStartTime,
  downloadOriginalFit,
};
