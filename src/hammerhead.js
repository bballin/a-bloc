// Hammerhead (Karoo) dashboard API. Hammerhead's official OAuth API requires a
// registered developer client, so this uses the same password grant as the
// Hammerhead web dashboard. Tokens are cached (encrypted) and refreshed.
const settings = require('./settings');
const { saveFit, closestByStartTime, DEFAULT_MATCH_WINDOW_MS } = require('./original-file');

const HAMMERHEAD_BASE = 'https://dashboard.hammerhead.io/v1';
const TOKEN_KEY = 'hammerhead_token';
const TOKEN_KEYS = [TOKEN_KEY];

function isConfigured(athleteId) {
  return !!(settings.get(athleteId, 'hammerhead_username') && settings.get(athleteId, 'hammerhead_password'));
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

async function tokenRequest(params) {
  const res = await fetch(`${HAMMERHEAD_BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    const error = new Error(`Hammerhead login failed: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const body = await res.json();
  if (!body.access_token) throw new Error('Hammerhead login did not return an access token.');
  const payload = decodeJwtPayload(body.access_token);
  const userId = body.user_id || body.userId || payload.sub;
  if (!userId) throw new Error('Hammerhead login did not identify the user.');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    userId: String(userId),
    expiresAt: Number.isFinite(payload.exp) ? payload.exp * 1000
      : Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
}

function saveToken(athleteId, token) {
  settings.set(athleteId, TOKEN_KEY, JSON.stringify(token));
  return token;
}

function loadToken(athleteId) {
  try { return JSON.parse(settings.get(athleteId, TOKEN_KEY) || 'null'); } catch { return null; }
}

async function login(athleteId) {
  const username = settings.get(athleteId, 'hammerhead_username');
  const password = settings.get(athleteId, 'hammerhead_password');
  if (!username || !password) throw new Error('Hammerhead is not configured.');
  return saveToken(athleteId, await tokenRequest({ grant_type: 'password', username, password }));
}

async function renew(athleteId, token) {
  if (token && token.refreshToken) {
    try {
      return saveToken(athleteId, await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken }));
    } catch { /* fall back to a password login */ }
  }
  return login(athleteId);
}

/** Returns a client { athleteId, token } with a valid access token. */
async function getClient(athleteId) {
  let token = loadToken(athleteId);
  if (!token || !token.accessToken || !token.userId) token = await login(athleteId);
  else if (!(token.expiresAt - 60_000 > Date.now())) token = await renew(athleteId, token);
  return { athleteId, token };
}

async function request(client, apiPath, headers = {}) {
  const send = () => fetch(`${HAMMERHEAD_BASE}${apiPath}`, {
    headers: { Accept: 'application/json', ...headers, Authorization: `Bearer ${client.token.accessToken}` },
  });
  let res = await send();
  if (res.status === 401) {
    client.token = await renew(client.athleteId, client.token);
    res = await send();
  }
  return res;
}

async function listActivities(client, { perPage = 30 } = {}) {
  const params = new URLSearchParams({ page: '1', perPage: String(perPage), orderBy: 'NEWEST' });
  const res = await request(client, `/users/${encodeURIComponent(client.token.userId)}/activities?${params}`);
  if (!res.ok) throw new Error(`Hammerhead activity list failed: HTTP ${res.status}`);
  const body = await res.json();
  if (Array.isArray(body)) return body;
  return body.data || body.activities || body.items || [];
}

function activityStartMs(activity) {
  const value = activity.startTime || activity.start_time || activity.startDate || activity.createdAt || activity.created_at;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return new Date(value).getTime();
}

async function findActivityByStartTime(client, startTime, { perPage = 30, windowMs = DEFAULT_MATCH_WINDOW_MS } = {}) {
  return closestByStartTime(await listActivities(client, { perPage }), activityStartMs, startTime, windowMs);
}

async function downloadOriginalFit(client, activity) {
  const activityPath = `/users/${encodeURIComponent(client.token.userId)}/activities/${encodeURIComponent(activity.id)}/file?format=fit`;
  const res = await request(client, activityPath, { Accept: 'application/vnd.ant.fit, application/octet-stream' });
  if (res.status === 404 || res.status === 422) throw new Error(`Hammerhead activity ${activity.id} has no FIT file.`);
  if (!res.ok) throw new Error(`Hammerhead FIT download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return saveFit(buffer, { filename: `hammerhead-${activity.id}.fit`, prefix: 'sgt-hh-', label: 'Hammerhead' });
}

async function testConnection(athleteId) {
  const client = await getClient(athleteId);
  await listActivities(client, { perPage: 1 });
  return { userId: client.token.userId };
}

module.exports = {
  TOKEN_KEYS,
  isConfigured,
  getClient,
  testConnection,
  listActivities,
  findActivityByStartTime,
  downloadOriginalFit,
  activityStartMs,
  decodeJwtPayload,
};
