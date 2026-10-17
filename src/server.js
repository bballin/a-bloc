require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const db = require('./db');
const strava = require('./strava');
const { parseFit } = require('./fit');
const { chooseGear } = require('./matcher');
const settings = require('./settings');
const sync = require('./sync');
const segmentCounts = require('./segment-counts');
const gearWebhook = require('./gear-webhook');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const WEBHOOK_VERIFY_TOKEN = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN || SESSION_SECRET;

if (!CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
  console.warn('[warn] STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are not set. OAuth will fail until you create .env (see .env.example).');
}

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAuth(req, res, next) {
  if (!req.session.athleteId) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

// --- Strava webhook (public callback) ---

app.get('/api/webhook/strava', (req, res) => {
  if (req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== WEBHOOK_VERIFY_TOKEN) {
    return res.status(403).json({ error: 'webhook_verification_failed' });
  }
  res.json({ 'hub.challenge': req.query['hub.challenge'] });
});

app.post('/api/webhook/strava', (req, res) => {
  const event = req.body || {};
  res.status(200).json({ received: true });
  if (event.object_type !== 'activity' || event.aspect_type !== 'create') return;
  if (!/^\d+$/.test(String(event.owner_id)) || !/^\d+$/.test(String(event.object_id))) return;
  if (!strava.getAthlete(event.owner_id)) return;
  setImmediate(() => {
    if (settings.get(event.owner_id, 'gear_webhook_enabled') === '1') {
      gearWebhook.processActivity(event.owner_id, event.object_id)
        .then(result => console.log(`[gear-webhook] Activity ${event.object_id}: ${result.status} - ${result.message}`))
        .catch(error => console.error(`[gear-webhook] Activity ${event.object_id}:`, error.message));
    }
    segmentCounts.processActivity(event.owner_id, event.object_id)
      .catch(error => console.error(`[segment-counts] Activity ${event.object_id}:`, error.message));
  });
});

// --- OAuth ---

app.get('/auth/login', (req, res) => {
  const redirect = encodeURIComponent(`${APP_BASE_URL}/auth/callback`);
  const scope = encodeURIComponent('read,activity:read_all,activity:write,profile:read_all,profile:write');
  const url = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${redirect}&approval_prompt=auto&scope=${scope}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Strava auth error: ${error}`);
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokens = await strava.exchangeCodeForToken(code);
    strava.saveAthlete(tokens.athlete, tokens);
    req.session.athleteId = tokens.athlete.id;
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- Session/info ---

app.get('/api/me', (req, res) => {
  if (!req.session.athleteId) return res.json({ authenticated: false });
  const a = strava.getAthlete(req.session.athleteId);
  if (!a) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    athlete: { id: a.id, firstname: a.firstname, lastname: a.lastname },
  });
});

// --- Gear ---

app.get('/api/gear', requireAuth, async (req, res) => {
  try {
    const gear = await strava.listGear(req.session.athleteId);
    res.json({ gear });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Mappings ---

app.get('/api/mappings', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM mappings WHERE athlete_id = ? ORDER BY priority ASC, created_at DESC'
  ).all(req.session.athleteId);
  res.json({ mappings: rows });
});

app.post('/api/mappings', requireAuth, (req, res) => {
  const { sensor_key, sensor_label, gear_id, gear_name, priority } = req.body || {};
  if (!sensor_key || !gear_id) return res.status(400).json({ error: 'sensor_key and gear_id required' });
  try {
    db.prepare(`
      INSERT INTO mappings (athlete_id, sensor_key, sensor_label, gear_id, gear_name, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(athlete_id, sensor_key) DO UPDATE SET
        sensor_label=excluded.sensor_label,
        gear_id=excluded.gear_id,
        gear_name=excluded.gear_name,
        priority=excluded.priority
    `).run(
      req.session.athleteId,
      String(sensor_key).toLowerCase(),
      sensor_label || '',
      gear_id,
      gear_name || '',
      Number.isFinite(+priority) ? +priority : 0,
      Math.floor(Date.now() / 1000)
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/mappings/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM mappings WHERE id = ? AND athlete_id = ?').run(req.params.id, req.session.athleteId);
  res.json({ ok: true });
});

// --- FIT inspect (no Strava action; useful for building mappings) ---

app.post('/api/fit/inspect', requireAuth, upload.single('fit'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    const parsed = await parseFit(req.file.path);
    res.json({
      filename: req.file.originalname,
      startTime: parsed.startTime,
      sport: parsed.sport,
      sensors: parsed.sensors,
    });
  } catch (e) {
    res.status(400).json({ error: `Failed to parse FIT: ${e.message}` });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// --- Apply: parse FIT, find matching activity by start time, set gear ---

app.post('/api/fit/apply', requireAuth, upload.single('fit'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const athleteId = req.session.athleteId;
  let parsed;
  try {
    parsed = await parseFit(req.file.path);
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: `Failed to parse FIT: ${e.message}` });
  }
  fs.unlink(req.file.path, () => {});

  const log = {
    filename: req.file.originalname,
    startTime: parsed.startTime,
    sport: parsed.sport,
    sensors: parsed.sensors,
  };

  const match = chooseGear(athleteId, parsed.sensors);
  if (!match) {
    db.prepare(`INSERT INTO processed (athlete_id, fit_filename, sensors_json, status, message, created_at)
      VALUES (?, ?, ?, 'no_mapping', ?, ?)`).run(
      athleteId, log.filename, JSON.stringify(parsed.sensors), 'No sensor mapping matched.', Math.floor(Date.now() / 1000)
    );
    return res.json({ ...log, matched: null, message: 'No mapping matched the sensors in this file.' });
  }

  // Find matching activity by start time (+/- 5 minutes window)
  if (!parsed.startTime) {
    return res.status(400).json({ ...log, error: 'Could not determine start time from FIT file.' });
  }
  let activity = null;
  try {
    const activities = await strava.listRecentActivities(athleteId, 30, 1);
    const target = parsed.startTime.getTime();
    activity = activities.find(a => {
      const t = new Date(a.start_date).getTime();
      return Math.abs(t - target) <= 5 * 60 * 1000;
    }) || null;
  } catch (e) {
    return res.status(500).json({ ...log, error: `Failed to list activities: ${e.message}` });
  }

  if (!activity) {
    db.prepare(`INSERT INTO processed (athlete_id, fit_filename, sensors_json, matched_gear_id, matched_gear_name, status, message, created_at)
      VALUES (?, ?, ?, ?, ?, 'no_activity', ?, ?)`).run(
      athleteId, log.filename, JSON.stringify(parsed.sensors), match.gear_id, match.gear_name,
      'No Strava activity found near that start time. Upload to Strava first, then retry.',
      Math.floor(Date.now() / 1000)
    );
    return res.json({
      ...log,
      matched: { gear_id: match.gear_id, gear_name: match.gear_name, sensor_key: match.sensor_key },
      message: 'No Strava activity found near that start time. Upload it to Strava first, then re-run apply.',
    });
  }

  try {
    await strava.updateActivityGear(athleteId, activity.id, match.gear_id);
  } catch (e) {
    db.prepare(`INSERT INTO processed (athlete_id, activity_id, fit_filename, sensors_json, matched_gear_id, matched_gear_name, status, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?)`).run(
      athleteId, String(activity.id), log.filename, JSON.stringify(parsed.sensors),
      match.gear_id, match.gear_name, e.message, Math.floor(Date.now() / 1000)
    );
    return res.status(500).json({ ...log, error: e.message });
  }

  db.prepare(`INSERT INTO processed (athlete_id, activity_id, fit_filename, sensors_json, matched_gear_id, matched_gear_name, status, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)`).run(
    athleteId, String(activity.id), log.filename, JSON.stringify(parsed.sensors),
    match.gear_id, match.gear_name, `Set gear on activity ${activity.id}`, Math.floor(Date.now() / 1000)
  );

  res.json({
    ...log,
    matched: { gear_id: match.gear_id, gear_name: match.gear_name, sensor_key: match.sensor_key },
    activity: { id: activity.id, name: activity.name, start_date: activity.start_date },
    message: `Set gear "${match.gear_name}" on activity "${activity.name}".`,
  });
});

// --- Recent processed log ---

app.get('/api/log', requireAuth, (req, res) => {
  const rows = db.prepare(
    'SELECT id, activity_id, fit_filename, matched_gear_name, status, message, created_at FROM processed WHERE athlete_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.session.athleteId);
  res.json({ entries: rows });
});

// --- Settings (Garmin / Strava-web credentials & cookies) ---

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(settings.summary(req.session.athleteId));
});

// Save Garmin credentials. Body: { username, password } — both optional;
// passing empty string clears. Saving clears any cached oauth tokens so the next
// call re-logs-in with the new creds.
app.post('/api/settings/garmin', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  const a = req.session.athleteId;
  if (typeof username === 'string') {
    if (username) settings.set(a, 'garmin_username', username);
    else settings.remove(a, 'garmin_username');
  }
  if (typeof password === 'string') {
    if (password) settings.set(a, 'garmin_password', password);
    else settings.remove(a, 'garmin_password');
  }
  settings.remove(a, 'garmin_oauth1');
  settings.remove(a, 'garmin_oauth2');
  if (req.is('application/x-www-form-urlencoded')) {
    return res.redirect(303, '/#configurationPanel');
  }
  res.json({ ok: true, ...settings.summary(a).garmin });
});

app.post('/api/settings/garmin/test', requireAuth, async (req, res) => {
  try {
    const garmin = require('./garmin');
    const client = await garmin.getClient(req.session.athleteId);
    if (!client) return res.status(400).json({ ok: false, error: 'Garmin is not configured.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Save Strava-web credentials and/or session cookie. Body: { username, password, session_cookie }.
// Cookie can be either bare value or "_strava4_session=..." or full "name=val; ..." string.
app.post('/api/settings/strava-web', requireAuth, (req, res) => {
  const { username, password, session_cookie } = req.body || {};
  const a = req.session.athleteId;
  if (typeof username === 'string') {
    if (username) settings.set(a, 'strava_username', username);
    else settings.remove(a, 'strava_username');
  }
  if (typeof password === 'string') {
    if (password) settings.set(a, 'strava_password', password);
    else settings.remove(a, 'strava_password');
  }
  if (typeof session_cookie === 'string') {
    if (session_cookie) settings.set(a, 'strava_session_cookie', session_cookie.trim());
    else settings.remove(a, 'strava_session_cookie');
  }
  res.json({ ok: true, ...settings.summary(a).strava_web });
});

// --- Sync: pull recent Strava activities and tag them automatically ---

app.post('/api/sync', requireAuth, async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.body && req.body.limit, 10) || 10, 30));
  const dryRun = !!(req.body && req.body.dryRun);
  const force = !!(req.body && req.body.force);
  const sources = Array.isArray(req.body && req.body.sources) && req.body.sources.length
    ? req.body.sources : ['garmin', 'strava_web'];
  try {
    const results = await sync.syncRecent(req.session.athleteId, { limit, dryRun, force, sources });
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Process a single Strava activity by ID
app.post('/api/activities/:id/process', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid activity ID' });
  const dryRun = !!(req.body && req.body.dryRun);
  const force = !!(req.body && req.body.force);
  const sources = Array.isArray(req.body && req.body.sources) && req.body.sources.length
    ? req.body.sources : ['garmin', 'strava_web'];
  try {
    const activity = await strava.getActivity(req.session.athleteId, id);
    const result = await sync.processActivity(req.session.athleteId, activity, { dryRun, force, sources });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List recent Strava activities (for the UI list)
app.get('/api/activities', requireAuth, async (req, res) => {
  const pageValue = req.query.page === undefined ? '1' : String(req.query.page);
  if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue))) {
    return res.status(400).json({ error: 'page must be a positive integer' });
  }
  try {
    const list = await strava.listRecentActivities(req.session.athleteId, 10, Number(pageValue));
    res.json({
      activities: list.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        sport_type: a.sport_type,
        start_date: a.start_date,
        distance: a.distance,
        gear_id: a.gear_id,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Starred segments ---

function segmentIdsFromBody(body) {
  const ids = Array.isArray(body && body.segmentIds) ? body.segmentIds : [];
  return [...new Set(ids.map(id => String(id).trim()).filter(id => /^\d+$/.test(id) && Number(id) > 0))];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const SEGMENT_MUTATION_DELAY_MS = Math.max(250, parseInt(process.env.SEGMENT_MUTATION_DELAY_MS || '1000', 10));
const SEGMENT_RATE_LIMIT_RETRIES = 3;

async function mutateSegmentWithRetry(athleteId, id, starred) {
  for (let attempt = 0; attempt <= SEGMENT_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await strava.setSegmentStarred(athleteId, id, starred);
    } catch (e) {
      if (e.status !== 429 || attempt === SEGMENT_RATE_LIMIT_RETRIES) throw e;
      const backoffMs = e.retryAfterMs || (2000 * (attempt + 1));
      await delay(Math.min(backoffMs, 30000));
    }
  }
}

async function mutateSegments(athleteId, segmentIds, starred) {
  const results = [];
  for (const id of segmentIds) {
    try {
      if (results.length) await delay(SEGMENT_MUTATION_DELAY_MS);
      const segment = await mutateSegmentWithRetry(athleteId, id, starred);
      results.push({ id, ok: true, segment });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

app.get('/api/segments/starred', requireAuth, async (req, res) => {
  try {
    const segments = await strava.listStarredSegments(req.session.athleteId);
    res.json({ segments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function saveSegment(athleteId, segment) {
  const start = Array.isArray(segment.start_latlng) ? segment.start_latlng : [];
  const end = Array.isArray(segment.end_latlng) ? segment.end_latlng : [];
  const values = [
    String(segment.id),
    segment.name || String(segment.id),
    segment.activity_type || '',
    segment.distance ?? null,
    segment.average_grade ?? null,
    segment.total_elevation_gain ?? null,
    Number.isFinite(start[0]) ? start[0] : null,
    Number.isFinite(start[1]) ? start[1] : null,
    Number.isFinite(end[0]) ? end[0] : null,
    Number.isFinite(end[1]) ? end[1] : null,
    segment.city || '',
    segment.state || '',
    segment.country || '',
    segment.map && segment.map.polyline ? segment.map.polyline : '',
    Math.floor(Date.now() / 1000),
  ];
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO segment_cache (
        segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
        start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(segment_id) DO UPDATE SET
        name=excluded.name,
        activity_type=excluded.activity_type,
        distance=excluded.distance,
        average_grade=excluded.average_grade,
        total_elevation_gain=excluded.total_elevation_gain,
        start_lat=excluded.start_lat,
        start_lng=excluded.start_lng,
        end_lat=excluded.end_lat,
        end_lng=excluded.end_lng,
        city=excluded.city,
        state=excluded.state,
        country=excluded.country,
        map_polyline=excluded.map_polyline,
        updated_at=excluded.updated_at
    `).run(...values);
    db.prepare(`
      INSERT INTO segments (
        athlete_id, segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
        start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(athlete_id, segment_id) DO UPDATE SET
        name=excluded.name,
        activity_type=excluded.activity_type,
        distance=excluded.distance,
        average_grade=excluded.average_grade,
        total_elevation_gain=excluded.total_elevation_gain,
        start_lat=excluded.start_lat,
        start_lng=excluded.start_lng,
        end_lat=excluded.end_lat,
        end_lng=excluded.end_lng,
        city=excluded.city,
        state=excluded.state,
        country=excluded.country,
        map_polyline=excluded.map_polyline,
        updated_at=excluded.updated_at
    `).run(athleteId, ...values);
  });
  save();
}

function cachedSegment(segmentId) {
  const segment = db.prepare(`
    SELECT segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
      start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline
    FROM segment_cache WHERE segment_id = ?
  `).get(segmentId);
  if (!segment) return null;
  return {
    id: segment.segment_id,
    name: segment.name,
    activity_type: segment.activity_type,
    distance: segment.distance,
    average_grade: segment.average_grade,
    total_elevation_gain: segment.total_elevation_gain,
    start_latlng: segment.start_lat == null || segment.start_lng == null ? null : [segment.start_lat, segment.start_lng],
    end_latlng: segment.end_lat == null || segment.end_lng == null ? null : [segment.end_lat, segment.end_lng],
    city: segment.city,
    state: segment.state,
    country: segment.country,
    map: { polyline: segment.map_polyline },
  };
}

async function getCachedOrRemoteSegment(athleteId, segmentId) {
  const cached = cachedSegment(segmentId);
  if (cached) {
    saveSegment(athleteId, cached);
    return cached;
  }
  const segment = await strava.getSegment(athleteId, segmentId);
  saveSegment(athleteId, segment);
  return segment;
}

app.get('/api/segments/local', requireAuth, (req, res) => {
  const segments = db.prepare(`
    SELECT segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
      start_lat, start_lng, end_lat, end_lng, city, state, country, updated_at
    FROM segments WHERE athlete_id = ? ORDER BY name COLLATE NOCASE, segment_id
  `).all(req.session.athleteId);
  res.json({ segments });
});

app.get('/api/segments/local/:id/details', requireAuth, async (req, res) => {
  const segmentId = String(req.params.id);
  const exists = db.prepare(`
    SELECT 1 FROM segments WHERE athlete_id = ? AND segment_id = ?
  `).get(req.session.athleteId, segmentId);
  if (!exists) return res.status(404).json({ error: 'Segment not found.' });

  try {
    const segment = await strava.getSegment(req.session.athleteId, segmentId);
    const athleteStats = segment.athlete_segment_stats || {};
    const asNumber = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const athleteIsKom = athleteStats.is_kom === true;
    let komRank = athleteIsKom ? 1 : asNumber(athleteStats.kom_rank ?? segment.kom_rank);
    let rank = komRank;
    const prActivityId = athleteStats.pr_activity_id_str
      || athleteStats.pr_activity_id
      || segment.athlete_pr_effort?.pr_activity_id
      || athleteStats.activity_id;
    if (prActivityId && !athleteIsKom) {
      try {
        const activity = await strava.getActivity(req.session.athleteId, prActivityId, true);
        const effort = (activity.segment_efforts || []).find(item => String(item.segment && item.segment.id) === segmentId);
        if (effort) {
          komRank = asNumber(effort.kom_rank) ?? komRank;
          rank = komRank;
        }
      } catch {
        // Rank is optional; keep the segment details available if its PR activity cannot be read.
      }
    }
    res.json({
      details: {
        average_grade: asNumber(segment.average_grade),
        total_elevation_gain: asNumber(segment.total_elevation_gain),
        climb_category: asNumber(segment.climb_category),
        athlete_effort_count: asNumber(athleteStats.effort_count),
        rank,
      },
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/segments/local', requireAuth, async (req, res) => {
  const segmentIds = segmentIdsFromBody(req.body);
  const results = [];
  for (const id of segmentIds) {
    try {
      const segment = await getCachedOrRemoteSegment(req.session.athleteId, id);
      results.push({ id, ok: true, segment });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  res.json({ results, succeeded: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length });
});

app.delete('/api/segments/local/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM segments WHERE athlete_id = ? AND segment_id = ?')
    .run(req.session.athleteId, req.params.id);
  res.json({ ok: true });
});

app.post('/api/segments/preview', requireAuth, async (req, res) => {
  const requestedIds = Array.isArray(req.body && req.body.segmentIds) ? req.body.segmentIds : [];
  const ids = [...new Set(requestedIds.map(id => String(id).trim()).filter(id => /^\d+$/.test(id) && Number(id) > 0))];
  const segments = [];
  const errors = requestedIds.filter(id => !ids.includes(String(id).trim())).map(id => ({ id: String(id), error: 'Invalid segment ID' }));
  for (const id of ids) {
    try {
      segments.push(await getCachedOrRemoteSegment(req.session.athleteId, id));
    } catch (e) {
      errors.push({ id, error: e.message });
    }
  }
  res.json({ segments, errors });
});

app.get('/api/segments/export', requireAuth, async (req, res) => {
  try {
    const segments = await strava.listStarredSegments(req.session.athleteId);
    const payload = {
      format: 'strava-extened-segment-ids',
      version: 1,
      exportedAt: new Date().toISOString(),
      segmentIds: segments.map(segment => segment.id),
    };
    res.set('Content-Disposition', 'attachment; filename="strava-extened-segments.json"');
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/segments/star', requireAuth, async (req, res) => {
  const segmentIds = segmentIdsFromBody(req.body);
  const results = await mutateSegments(req.session.athleteId, segmentIds, true);
  res.json({ results, succeeded: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length });
});

app.post('/api/segments/unstar', requireAuth, async (req, res) => {
  const segmentIds = segmentIdsFromBody(req.body);
  const results = await mutateSegments(req.session.athleteId, segmentIds, false);
  res.json({ results, succeeded: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length });
});

app.post('/api/segments/unstar-all', requireAuth, async (req, res) => {
  try {
    const segments = await strava.listStarredSegments(req.session.athleteId);
    const results = await mutateSegments(req.session.athleteId, segments.map(segment => String(segment.id)), false);
    res.json({ results, succeeded: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Segment completion counts ---

function segmentCountDetails(segment) {
  const effortCount = Number(segment.athlete_segment_stats && segment.athlete_segment_stats.effort_count);
  return {
    segment_id: String(segment.id),
    name: segment.name || String(segment.id),
    distance: Number.isFinite(Number(segment.distance)) ? Number(segment.distance) : null,
    average_grade: Number.isFinite(Number(segment.average_grade)) ? Number(segment.average_grade) : null,
    total_elevation_gain: Number.isFinite(Number(segment.total_elevation_gain)) ? Number(segment.total_elevation_gain) : null,
    effort_count: Number.isFinite(effortCount) ? effortCount : null,
  };
}

app.get('/api/segment-counts', requireAuth, async (req, res) => {
  const athleteId = req.session.athleteId;
  const tracked = db.prepare(`
    SELECT segment_id, name, created_at FROM segment_count_tracking
    WHERE athlete_id = ? ORDER BY created_at, segment_id
  `).all(athleteId);
  const events = db.prepare(`
    SELECT activity_id, status, message, created_at FROM segment_count_events
    WHERE athlete_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(athleteId);
  try {
    const segments = await Promise.all(tracked.map(async configured => {
      const segment = await strava.getSegment(athleteId, configured.segment_id);
      return segmentCountDetails(segment);
    }));
    res.json({
      segments,
      events,
      callbackUrl: `${APP_BASE_URL.replace(/\/$/, '')}/api/webhook/strava`,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/segment-counts/refresh', requireAuth, async (req, res) => {
  try {
    const activities = await strava.listRecentActivities(req.session.athleteId, 1);
    const activity = activities[0];
    if (activity) await segmentCounts.processActivity(req.session.athleteId, activity.id);
    res.json({ refreshedActivityId: activity ? String(activity.id) : null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.put('/api/segment-counts', requireAuth, async (req, res) => {
  const segmentIds = segmentIdsFromBody(req.body);
  if (segmentIds.length > 5) return res.status(400).json({ error: 'A maximum of 5 segment IDs can be tracked.' });
  const requested = Array.isArray(req.body && req.body.segmentIds) ? req.body.segmentIds.filter(id => String(id).trim()) : [];
  if (segmentIds.length !== requested.length) return res.status(400).json({ error: 'Every segment ID must be a positive number.' });

  try {
    const segments = [];
    for (const id of segmentIds) segments.push(await strava.getSegment(req.session.athleteId, id));
    const replace = db.transaction(() => {
      db.prepare('DELETE FROM segment_count_tracking WHERE athlete_id = ?').run(req.session.athleteId);
      const insert = db.prepare(`
        INSERT INTO segment_count_tracking (athlete_id, segment_id, name, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const createdAt = Math.floor(Date.now() / 1000);
      segments.forEach(segment => insert.run(req.session.athleteId, String(segment.id), segment.name || String(segment.id), createdAt));
    });
    replace();
    res.json({ segments: segments.map(segmentCountDetails) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/segment-counts/subscription', requireAuth, async (req, res) => {
  try {
    const subscriptions = await strava.listWebhookSubscriptions();
    res.json({ subscriptions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/segment-counts/subscription', requireAuth, async (req, res) => {
  const callbackUrl = `${APP_BASE_URL.replace(/\/$/, '')}/api/webhook/strava`;
  if (!/^https:\/\//i.test(callbackUrl)) {
    return res.status(400).json({ error: 'APP_BASE_URL must be a public HTTPS URL before Strava can create a webhook subscription.' });
  }
  try {
    const existing = await strava.listWebhookSubscriptions();
    if (existing.length) return res.status(409).json({ error: 'This Strava application already has a webhook subscription.' });
    res.json(await strava.createWebhookSubscription(callbackUrl, WEBHOOK_VERIFY_TOKEN));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/segment-counts/subscription/:id', requireAuth, async (req, res) => {
  try {
    await strava.deleteWebhookSubscription(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/gear-webhook', requireAuth, (req, res) => {
  res.json({
    enabled: settings.get(req.session.athleteId, 'gear_webhook_enabled') === '1',
    callbackUrl: `${APP_BASE_URL.replace(/\/$/, '')}/api/webhook/strava`,
  });
});

app.post('/api/gear-webhook', requireAuth, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  settings.set(req.session.athleteId, 'gear_webhook_enabled', enabled ? '1' : '');
  res.json({ enabled });
});

app.listen(PORT, HOST, () => {
  console.log(`Strava Extened listening on ${HOST}:${PORT}`);
  console.log(`  Local:   ${APP_BASE_URL}`);
  if (HOST === '0.0.0.0') {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          console.log(`  Network: http://${ni.address}:${PORT}  (${name})`);
        }
      }
    }
  }
  console.log('  OAuth callback (must match Strava app + APP_BASE_URL): ' + APP_BASE_URL + '/auth/callback');
});
