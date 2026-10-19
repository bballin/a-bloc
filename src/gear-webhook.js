const strava = require('./strava');
const sync = require('./sync');

// When `isFinalAttempt` is false and no configured source has the activity yet,
// throws so the webhook queue retries later instead of recording `no_fit`.
async function processActivity(athleteId, activityId, { isFinalAttempt = true } = {}, dependencies = {}) {
  const stravaClient = dependencies.strava || strava;
  const syncService = dependencies.sync || sync;
  const activity = await stravaClient.getActivity(athleteId, activityId);
  return syncService.processActivity(athleteId, activity, { force: true, retryNoMatch: !isFinalAttempt });
}

module.exports = { processActivity };
