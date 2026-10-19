const db = require('../db');

const insertStatement = db.prepare(`
  INSERT INTO processed (athlete_id, activity_id, fit_filename, sensors_json, matched_gear_id, matched_gear_name, status, message, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const recentStatement = db.prepare(`
  SELECT id, activity_id, fit_filename, matched_gear_name, status, message, created_at
  FROM processed WHERE athlete_id = ? ORDER BY created_at DESC LIMIT ?
`);

function record({ athleteId, activityId = null, fitFilename = null, sensors = [], match = null, status, message = '' }) {
  insertStatement.run(
    athleteId,
    activityId == null ? null : String(activityId),
    fitFilename || null,
    JSON.stringify(sensors || []),
    match ? match.gear_id : null,
    match ? match.gear_name : null,
    status,
    message || '',
    Math.floor(Date.now() / 1000)
  );
}

function listRecent(athleteId, limit = 50) {
  return recentStatement.all(athleteId, limit);
}

module.exports = { record, listRecent };
