const db = require('./db');

/**
 * Given a list of sensors found in a FIT file and the athlete's mappings,
 * return the best gear match. Strategy:
 *   1. Find all mappings whose sensor_key matches any sensor in the file.
 *   2. Choose the one with the highest priority (lowest number = highest).
 *   3. Tie-break by most recently created mapping.
 */
function chooseGear(athleteId, sensors) {
  if (!sensors || !sensors.length) return null;
  const keys = sensors.map(s => s.key);
  const placeholders = keys.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM mappings
    WHERE athlete_id = ?
      AND sensor_key IN (${placeholders})
    ORDER BY priority ASC, created_at DESC
  `).all(athleteId, ...keys);
  if (!rows.length) return null;
  return rows[0];
}

module.exports = { chooseGear };
