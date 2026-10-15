const db = require('./db');
const settings = require('./settings');
const sync = require('./sync');

const MIN_INTERVAL = 60;       // seconds — don't hammer Strava
const DEFAULT_INTERVAL = 300;  // 5 minutes
const MAX_INTERVAL = 3600;     // 1 hour

// athleteId -> { timer, intervalSeconds, runningPromise, lastRunAt, lastError, lastResults }
const state = new Map();

function getInterval(athleteId) {
  const raw = settings.get(athleteId, 'polling_interval');
  const n = parseInt(raw || '', 10);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
  return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, n));
}

function isEnabled(athleteId) {
  return settings.get(athleteId, 'polling_enabled') === '1';
}

async function tick(athleteId) {
  const s = state.get(athleteId);
  if (!s || s.runningPromise) return; // already running
  s.runningPromise = (async () => {
    try {
      const results = await sync.syncRecent(athleteId, {
        limit: 10,
        respectCooldown: true,
      });
      s.lastResults = results.map(r => ({
        activityId: r.activityId,
        activityName: r.activityName,
        status: r.status,
        message: r.message,
        gear: r.matched && r.matched.gear_name,
        source: r.source,
      }));
      s.lastError = null;
    } catch (e) {
      s.lastError = e.message;
    } finally {
      s.lastRunAt = Math.floor(Date.now() / 1000);
      s.runningPromise = null;
    }
  })();
}

function start(athleteId) {
  stop(athleteId);
  const intervalSeconds = getInterval(athleteId);
  const s = {
    timer: null,
    intervalSeconds,
    runningPromise: null,
    lastRunAt: null,
    lastError: null,
    lastResults: [],
  };
  state.set(athleteId, s);
  // Run immediately, then on interval
  tick(athleteId);
  s.timer = setInterval(() => tick(athleteId), intervalSeconds * 1000);
  s.timer.unref && s.timer.unref();
}

function stop(athleteId) {
  const s = state.get(athleteId);
  if (s && s.timer) clearInterval(s.timer);
  state.delete(athleteId);
}

function status(athleteId) {
  const s = state.get(athleteId);
  return {
    enabled: isEnabled(athleteId),
    intervalSeconds: getInterval(athleteId),
    running: !!s,
    lastRunAt: s ? s.lastRunAt : null,
    lastError: s ? s.lastError : null,
    lastResults: s ? s.lastResults : [],
    inProgress: !!(s && s.runningPromise),
  };
}

function setEnabled(athleteId, enabled) {
  settings.set(athleteId, 'polling_enabled', enabled ? '1' : '');
  if (enabled) start(athleteId);
  else stop(athleteId);
}

function setInterval_(athleteId, seconds) {
  const n = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, parseInt(seconds, 10) || DEFAULT_INTERVAL));
  settings.set(athleteId, 'polling_interval', String(n));
  if (isEnabled(athleteId)) start(athleteId); // restart with new interval
  return n;
}

// Resume polling for any athletes that had it enabled when the server restarts.
function resumeAll() {
  const rows = db.prepare(
    "SELECT DISTINCT athlete_id FROM settings WHERE key = 'polling_enabled' AND value = '1'"
  ).all();
  for (const row of rows) {
    try { start(row.athlete_id); }
    catch (e) { console.warn(`[poller] failed to start for athlete ${row.athlete_id}: ${e.message}`); }
  }
  if (rows.length) console.log(`[poller] resumed for ${rows.length} athlete(s).`);
}

module.exports = { start, stop, status, setEnabled, setInterval: setInterval_, resumeAll, MIN_INTERVAL, DEFAULT_INTERVAL, MAX_INTERVAL };
