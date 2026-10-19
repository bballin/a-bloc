const db = require('../db');

const listStatement = db.prepare(
  'SELECT * FROM mappings WHERE athlete_id = ? ORDER BY priority ASC, created_at DESC'
);
const upsertStatement = db.prepare(`
  INSERT INTO mappings (athlete_id, sensor_key, sensor_label, gear_id, gear_name, priority, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(athlete_id, sensor_key) DO UPDATE SET
    sensor_label=excluded.sensor_label,
    gear_id=excluded.gear_id,
    gear_name=excluded.gear_name,
    priority=excluded.priority
`);
const removeStatement = db.prepare('DELETE FROM mappings WHERE id = ? AND athlete_id = ?');
const bestMatchStatement = db.prepare(`
  SELECT * FROM mappings
  WHERE athlete_id = ? AND sensor_key IN (SELECT value FROM json_each(?))
  ORDER BY priority ASC, created_at DESC
  LIMIT 1
`);

function list(athleteId) {
  return listStatement.all(athleteId);
}

function upsert(athleteId, { sensorKey, sensorLabel, gearId, gearName, priority }) {
  upsertStatement.run(
    athleteId,
    String(sensorKey).toLowerCase(),
    sensorLabel || '',
    gearId,
    gearName || '',
    Number.isFinite(+priority) ? +priority : 0,
    Math.floor(Date.now() / 1000)
  );
}

function remove(athleteId, id) {
  removeStatement.run(id, athleteId);
}

// Lowest priority number wins; ties go to the most recently created mapping.
function findBestMatch(athleteId, sensorKeys) {
  if (!sensorKeys.length) return null;
  return bestMatchStatement.get(athleteId, JSON.stringify(sensorKeys)) || null;
}

module.exports = { list, upsert, remove, findBestMatch };
