const processed = require('./store/processed');
const strava = require('./strava');
const stravaWeb = require('./strava-web');
const garmin = require('./garmin');
const { parseFit } = require('./fit');
const { chooseGear } = require('./matcher');

const SOURCES = ['garmin', 'strava_web'];

/**
 * Resolve an "original" FIT file for a Strava activity. Returns
 * { source, fitPath, cleanup }. Throws if no source produced a FIT.
 */
async function fetchOriginalFit(athleteId, activity, preferredSources = SOURCES) {
  const errors = [];
  for (const src of preferredSources) {
    try {
      if (src === 'garmin') {
        const client = await garmin.getClient(athleteId);
        if (!client) { errors.push('garmin: not configured'); continue; }
        const gActivity = await garmin.findActivityByStartTime(client, activity.start_date);
        if (!gActivity) { errors.push('garmin: no matching activity by start time'); continue; }
        const out = await garmin.downloadOriginalFit(client, gActivity);
        return { source: 'garmin', ...out };
      }
      if (src === 'strava_web') {
        const out = await stravaWeb.downloadOriginalFit(athleteId, activity.id);
        return { source: 'strava_web', ...out };
      }
    } catch (e) {
      errors.push(`${src}: ${e.message}`);
    }
  }
  const err = new Error(`Could not fetch original FIT. Tried: ${errors.join(' | ')}`);
  err.attempts = errors;
  throw err;
}

/**
 * Process a single Strava activity end-to-end: download FIT, parse, match, set gear.
 * Returns a result object describing what happened. Logs to processed table.
 */
async function processActivity(athleteId, activity, options = {}) {
  const { dryRun = false, sources = SOURCES, force = false } = options;
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
    fetched = await fetchOriginalFit(athleteId, activity, sources);
  } catch (e) {
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

module.exports = { processActivity, syncRecent, fetchOriginalFit };
