const strava = require('./strava');
const sync = require('./sync');

async function processActivity(athleteId, activityId, dependencies = {}) {
  const stravaClient = dependencies.strava || strava;
  const syncService = dependencies.sync || sync;
  const activity = await stravaClient.getActivity(athleteId, activityId);
  return syncService.processActivity(athleteId, activity, { force: true });
}

module.exports = { processActivity };