// COROS Training Hub API. COROS only offers its official API to approved
// partners, so this uses the same login as the Training Hub web app
// (https://t.coros.com). Tokens are cached (encrypted) per athlete.
const crypto = require('crypto');
const settings = require('./settings');
const { downloadFit, closestByStartTime, DEFAULT_MATCH_WINDOW_MS } = require('./original-file');

const LOGIN_HOST = 'https://teamapi.coros.com';
const REGION_HOSTS = {
  1: 'https://teamapi.coros.com',
  2: 'https://teamcnapi.coros.com',
  3: 'https://teameuapi.coros.com',
};
const FIT_FILE_TYPE = 4;
const TOKEN_KEY = 'coros_token';
const TOKEN_KEYS = [TOKEN_KEY];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': UA,
  Origin: 'https://t.coros.com',
  Referer: 'https://t.coros.com/',
};

class CorosApiError extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'CorosApiError';
    this.result = result;
  }
}

function isConfigured(athleteId) {
  return !!(settings.get(athleteId, 'coros_username') && settings.get(athleteId, 'coros_password'));
}

async function parseEnvelope(res, action) {
  if (!res.ok) throw new CorosApiError(`COROS ${action} failed: HTTP ${res.status}`, null);
  const body = await res.json();
  if (!body || body.result !== '0000') {
    throw new CorosApiError(`COROS ${action} failed: ${(body && body.message) || 'unexpected response'} (${body && body.result})`, body && body.result);
  }
  return body.data || {};
}

async function login(athleteId) {
  const account = settings.get(athleteId, 'coros_username');
  const password = settings.get(athleteId, 'coros_password');
  if (!account || !password) throw new Error('COROS is not configured.');
  const res = await fetch(`${LOGIN_HOST}/account/login`, {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({
      account,
      accountType: 2,
      pwd: crypto.createHash('md5').update(password, 'utf8').digest('hex'),
    }),
  });
  const data = await parseEnvelope(res, 'login');
  if (!data.accessToken) throw new Error('COROS login did not return an access token.');
  const token = {
    accessToken: data.accessToken,
    userId: data.userId == null ? null : String(data.userId),
    regionId: Number(data.regionId) || 1,
  };
  settings.set(athleteId, TOKEN_KEY, JSON.stringify(token));
  return token;
}

function loadToken(athleteId) {
  try { return JSON.parse(settings.get(athleteId, TOKEN_KEY) || 'null'); } catch { return null; }
}

/** Returns a client { athleteId, token }, logging in when no token is cached. */
async function getClient(athleteId) {
  const cached = loadToken(athleteId);
  if (cached && cached.accessToken) return { athleteId, token: cached, fresh: false };
  return { athleteId, token: await login(athleteId), fresh: true };
}

function apiHost(token) {
  return REGION_HOSTS[token.regionId] || REGION_HOSTS[1];
}

function authHeaders(token) {
  const headers = { ...BASE_HEADERS, accesstoken: token.accessToken };
  if (token.userId) headers.yfheader = JSON.stringify({ userId: token.userId });
  return headers;
}

// The token lifetime is undocumented, so any rejected call re-logs in once and retries.
async function call(client, apiPath, { method = 'GET', action = apiPath } = {}) {
  const send = async () => parseEnvelope(
    await fetch(`${apiHost(client.token)}${apiPath}`, { method, headers: authHeaders(client.token) }),
    action
  );
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof CorosApiError) || client.fresh) throw error;
    client.token = await login(client.athleteId);
    client.fresh = true;
    return send();
  }
}

async function listActivities(client, { size = 20 } = {}) {
  const data = await call(client, `/activity/query?size=${size}&pageNumber=1`, { action: 'activity list' });
  return data.dataList || data.list || [];
}

function activityStartMs(activity) {
  const value = Number(activity.startTime);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return value < 1e12 ? value * 1000 : value;
}

async function findActivityByStartTime(client, startTime, { size = 20, windowMs = DEFAULT_MATCH_WINDOW_MS } = {}) {
  return closestByStartTime(await listActivities(client, { size }), activityStartMs, startTime, windowMs);
}

async function downloadOriginalFit(client, activity) {
  const params = new URLSearchParams({
    labelId: String(activity.labelId),
    sportType: String(activity.sportType),
    fileType: String(FIT_FILE_TYPE),
  });
  const data = await call(client, `/activity/detail/download?${params}`, { method: 'POST', action: 'FIT export' });
  if (!data.fileUrl) throw new Error(`COROS activity ${activity.labelId} has no FIT file.`);
  return downloadFit(data.fileUrl, { prefix: 'sgt-coros-', label: 'COROS', filename: `coros-${activity.labelId}.fit` });
}

async function testConnection(athleteId) {
  const client = await getClient(athleteId);
  await listActivities(client, { size: 1 });
  return { userId: client.token.userId };
}

module.exports = {
  TOKEN_KEYS,
  REGION_HOSTS,
  isConfigured,
  getClient,
  testConnection,
  listActivities,
  findActivityByStartTime,
  downloadOriginalFit,
  activityStartMs,
};
