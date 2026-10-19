const processed = require('./store/processed');
const strava = require('./strava');
const stravaWeb = require('./strava-web');
const settings = require('./settings');
const garmin = require('./garmin');
const wahoo = require('./wahoo');
const hammerhead = require('./hammerhead');
const coros = require('./coros');
const { parseFit } = require('./fit');
const { chooseGear } = require('./matcher');

// Device sources are searched for an activity starting at the Strava start
// time; Strava's own export of the uploaded file is the generic fallback.
const SOURCES = ['garmin', 'wahoo', 'hammerhead', 'coros', 'strava_web'];

// Matched against the Strava activity's device_name/external_id to try the
// most likely source first.
const DEVICE_HINTS = {
  garmin: /garmin/i,
  wahoo: /wahoo|elemnt/i,
  hammerhead: /hammerhead|karoo/i,
  coros: /coros/i,
};

// fetch() resolves to { fitPath, cleanup } or null when the source has no matching activity.
const PROVIDERS = {
  garmin: {
    isConfigured: athleteId => !!(settings.get(athleteId, 'garmin_username') && settings.get(athleteId, 'garmin_password')),
    async fetch(athleteId, activity) {
      const client = await garmin.getClient(athleteId);
      if (!client) return null;
      const match = await garmin.findActivityByStartTime(client, activity.start_date);
      return match ? garmin.downloadOriginalFit(client, match) : null;
    },
  },
  wahoo: {
    isConfigured: athleteId => wahoo.isAppConfigured() && wahoo.isConnected(athleteId),
    async fetch(athleteId, activity) {
      const match = await wahoo.findWorkoutByStartTime(athleteId, activity.start_date);
      return match ? wahoo.downloadOriginalFit(athleteId, match) : null;
    },
  },
  hammerhead: {
    isConfigured: athleteId => hammerhead.isConfigured(athleteId),
    async fetch(athleteId, activity) {
      const client = await hammerhead.getClient(athleteId);
      const match = await hammerhead.findActivityByStartTime(client, activity.start_date);
      return match ? hammerhead.downloadOriginalFit(client, match) : null;
    },
  },
  coros: {
    isConfigured: athleteId => coros.isConfigured(athleteId),
    async fetch(athleteId, activity) {
      const client = await coros.getClient(athleteId);
      const match = await coros.findActivityByStartTime(client, activity.start_date);
      return match ? coros.downloadOriginalFit(client, match) : null;
    },
  },
  strava_web: {
    isConfigured: athleteId => !!(settings.get(athleteId, 'strava_session_cookie')
      || (settings.get(athleteId, 'strava_username') && settings.get(athleteId, 'strava_password'))),
    fetch: (athleteId, activity) => stravaWeb.downloadOriginalFit(athleteId, activity.id),
  },
};

// Moves the source named by the activity's recording device (if any) to the front.
function orderSources(sources, activity) {
  const hint = `${activity.device_name || ''} ${activity.external_id || ''}`;
  const preferred = sources.filter(src => DEVICE_HINTS[src] && DEVICE_HINTS[src].test(hint));
  return [...preferred, ...sources.filter(src => !preferred.includes(src))];
}

/**
 * Resolve an "original" FIT file for a Strava activity by checking each
 * configured source for an activity with the same start time. Returns
 * { source, fitPath, cleanup }. Throws if no source produced a FIT; the error's
 * `noMatchOnly` flag is set when every configured source was reachable but had
 * no matching activity yet (worth retrying later).
 */
async function fetchOriginalFit(athleteId, activity, preferredSources = SOURCES, { providers = PROVIDERS } = {}) {
  const attempts = [];
  let failed = false;
  for (const src of orderSources(preferredSources, activity)) {
    const provider = providers[src];
    if (!provider) { attempts.push(`${src}: unknown source`); continue; }
    if (!provider.isConfigured(athleteId)) continue;
    try {
      const out = await provider.fetch(athleteId, activity);
      if (out) return { source: src, ...out };
      attempts.push(`${src}: no matching activity by start time`);
    } catch (e) {
      failed = true;
      attempts.push(`${src}: ${e.message}`);
    }
  }
  const err = new Error(attempts.length
    ? `Could not fetch original FIT. Tried: ${attempts.join(' | ')}`
    : 'Could not fetch original FIT: no original activity file source is configured.');
  err.attempts = attempts;
  err.noMatchOnly = attempts.length > 0 && !failed;
  throw err;
}

/**
 * Process a single Strava activity end-to-end: download FIT, parse, match, set gear.
 * Returns a result object describing what happened. Logs to processed table.
 */
async function processActivity(athleteId, activity, options = {}) {
  const { dryRun = false, sources = SOURCES, force = false, retryNoMatch = false, providers } = options;
  const result = {
    activityId: activity.id,
    activityName: activity.name,
    startDate: activity.start_date,
    source: null,
    sensors: [],
    matched: null,
    status: 'skipped',
    message: '',
  };

  if (!force && activity.gear_id) {
    result.status = 'skipped';
    result.message = `Already has gear (${activity.gear_id}).`;
    logProcessed(athleteId, activity.id, null, [], null, 'skipped', result.message);
    return result;
  }

  let fetched;
  try {
    fetched = await fetchOriginalFit(athleteId, activity, sources, providers ? { providers } : undefined);
  } catch (e) {
    // The device may not have synced to its own cloud yet; let the caller retry before logging a failure.
    if (retryNoMatch && e.noMatchOnly) {
      const retry = new Error(`${e.message} (will retry)`);
      retry.retryable = true;
      throw retry;
    }
    result.status = 'no_fit';
    result.message = e.message;
    logProcessed(athleteId, activity.id, null, [], null, 'no_fit', e.message);
    return result;
  }
  result.source = fetched.source;

  let parsed;
  try {
    parsed = await parseFit(fetched.fitPath);
  } catch (e) {
    result.status = 'parse_error';
    result.message = `Parse failed: ${e.message}`;
    logProcessed(athleteId, activity.id, null, [], null, 'parse_error', result.message);
    return result;
  } finally {
    fetched.cleanup();
  }

  result.sensors = parsed.sensors;
  const match = chooseGear(athleteId, parsed.sensors);
  if (!match) {
    result.status = 'no_mapping';
    result.message = 'No sensor mapping matched.';
    logProcessed(athleteId, activity.id, null, parsed.sensors, null, 'no_mapping', result.message);
    return result;
  }
  result.matched = { gear_id: match.gear_id, gear_name: match.gear_name, sensor_key: match.sensor_key };

  if (dryRun) {
    result.status = 'dry_run';
    result.message = `Would set gear "${match.gear_name}".`;
    return result;
  }

  try {
    await strava.updateActivityGear(athleteId, activity.id, match.gear_id);
  } catch (e) {
    result.status = 'error';
    result.message = `Strava update failed: ${e.message}`;
    logProcessed(athleteId, activity.id, null, parsed.sensors, match, 'error', result.message);
    return result;
  }

  result.status = 'ok';
  result.message = `Set gear "${match.gear_name}" (via ${fetched.source}).`;
  logProcessed(athleteId, activity.id, null, parsed.sensors, match, 'ok', result.message);
  return result;
}

function logProcessed(athleteId, activityId, fitFilename, sensors, match, status, message) {
  processed.record({ athleteId, activityId, fitFilename, sensors, match, status, message });
}

async function syncRecent(athleteId, { limit = 10, dryRun = false, sources = SOURCES, force = false } = {}) {
  const activities = await strava.listRecentActivities(athleteId, Math.min(limit, 30), 1);
  const results = [];
  for (const a of activities.slice(0, limit)) {
    try {
      const r = await processActivity(athleteId, a, { dryRun, sources, force });
      results.push(r);
    } catch (e) {
      results.push({
        activityId: a.id,
        activityName: a.name,
        status: 'error',
        message: e.message,
      });
    }
  }
  return results;
}

module.exports = { SOURCES, processActivity, syncRecent, fetchOriginalFit, orderSources };
