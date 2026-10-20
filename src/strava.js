const config = require('./config');
const athletes = require('./store/athletes');

const STRAVA_OAUTH_TOKEN = 'https://www.strava.com/oauth/token';
const STRAVA_API = 'https://www.strava.com/api/v3';

function now() { return Math.floor(Date.now() / 1000); }

async function exchangeCodeForToken(code) {
  const res = await fetch(STRAVA_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshToken(refresh_token) {
  const res = await fetch(STRAVA_OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function saveAthlete(athlete, tokens) {
  athletes.save(athlete, tokens);
}

function getAthlete(id) {
  return athletes.get(id);
}

async function getValidAccessToken(athleteId) {
  const a = getAthlete(athleteId);
  if (!a) throw new Error('Athlete not found, re-authenticate.');
  if (a.expires_at - 60 > now()) return a.access_token;
  const refreshed = await refreshToken(a.refresh_token);
  athletes.updateTokens(athleteId, refreshed);
  return refreshed.access_token;
}

async function api(athleteId, path, options = {}) {
  const token = await getValidAccessToken(athleteId);
  const res = await fetch(`${STRAVA_API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  return res;
}

async function getAthleteProfile(athleteId) {
  const res = await api(athleteId, '/athlete');
  if (!res.ok) throw new Error(`Failed to fetch athlete: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listGear(athleteId) {
  // Strava returns gear inside the athlete object
  const a = await getAthleteProfile(athleteId);
  const bikes = (a.bikes || []).map(b => ({ ...b, type: 'bike' }));
  const shoes = (a.shoes || []).map(s => ({ ...s, type: 'shoes' }));
  return [...bikes, ...shoes];
}

async function listRecentActivities(athleteId, perPage = 30, page = 1) {
  const res = await api(athleteId, `/athlete/activities?per_page=${perPage}&page=${page}`);
  if (!res.ok) throw new Error(`Failed to list activities: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateActivityGear(athleteId, activityId, gearId) {
  const params = new URLSearchParams({ gear_id: gearId }).toString();
  const res = await api(athleteId, `/activities/${activityId}?${params}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Failed to update activity: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getActivity(athleteId, activityId, includeAllEfforts = false) {
  const res = await api(athleteId, `/activities/${encodeURIComponent(activityId)}?include_all_efforts=${includeAllEfforts}`);
  if (!res.ok) throw new Error(`Failed to fetch activity ${activityId}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateActivityDescription(athleteId, activityId, description) {
  const res = await api(athleteId, `/activities/${encodeURIComponent(activityId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ description }).toString(),
  });
  if (!res.ok) throw new Error(`Failed to update activity ${activityId}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listWebhookSubscriptions() {
  const params = new URLSearchParams({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
  });
  const res = await fetch(`${STRAVA_API}/push_subscriptions?${params}`);
  if (!res.ok) throw new Error(`Failed to list webhook subscriptions: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createWebhookSubscription(callbackUrl, verifyToken) {
  const res = await fetch(`${STRAVA_API}/push_subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.strava.clientId,
      client_secret: config.strava.clientSecret,
      callback_url: callbackUrl,
      verify_token: verifyToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Failed to create webhook subscription: ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteWebhookSubscription(subscriptionId) {
  const params = new URLSearchParams({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
  });
  const res = await fetch(`${STRAVA_API}/push_subscriptions/${encodeURIComponent(subscriptionId)}?${params}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete webhook subscription: ${res.status} ${await res.text()}`);
}

async function listStarredSegments(athleteId, perPage = 100) {
  const segments = [];
  let page = 1;
  while (true) {
    const res = await api(athleteId, `/segments/starred?per_page=${perPage}&page=${page}`);
    if (!res.ok) throw new Error(`Failed to list starred segments: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    segments.push(...batch);
    if (batch.length < perPage) return segments;
    page += 1;
  }
}

async function getSegment(athleteId, segmentId) {
  const res = await api(athleteId, `/segments/${encodeURIComponent(segmentId)}`);
  if (!res.ok) throw new Error(`Failed to fetch segment ${segmentId}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function setSegmentStarred(athleteId, segmentId, starred) {
  const res = await api(athleteId, `/segments/${encodeURIComponent(segmentId)}/starred`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ starred: starred ? 'true' : 'false' }).toString(),
  });
  if (!res.ok) {
    const error = new Error(`Failed to ${starred ? 'star' : 'unstar'} segment ${segmentId}: ${res.status} ${await res.text()}`);
    error.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = retryAfter * 1000;
    throw error;
  }
  return res.json();
}

module.exports = {
  exchangeCodeForToken,
  saveAthlete,
  getAthlete,
  getAthleteProfile,
  getValidAccessToken,
  listGear,
  listRecentActivities,
  updateActivityGear,
  getActivity,
  updateActivityDescription,
  listWebhookSubscriptions,
  createWebhookSubscription,
  deleteWebhookSubscription,
  listStarredSegments,
  getSegment,
  setSegmentStarred,
};
