const db = require('../db');

const nowSeconds = () => Math.floor(Date.now() / 1000);

const listTrackedStatement = db.prepare(`
  SELECT segment_id, name, created_at FROM segment_count_tracking
  WHERE athlete_id = ? ORDER BY created_at, segment_id
`);
const clearTrackedStatement = db.prepare('DELETE FROM segment_count_tracking WHERE athlete_id = ?');
const insertTrackedStatement = db.prepare(`
  INSERT INTO segment_count_tracking (athlete_id, segment_id, name, created_at) VALUES (?, ?, ?, ?)
`);
const recentEventsStatement = db.prepare(`
  SELECT activity_id, status, message, created_at FROM segment_count_events
  WHERE athlete_id = ? ORDER BY created_at DESC LIMIT ?
`);
const recordEventStatement = db.prepare(`
  INSERT INTO segment_count_events (athlete_id, activity_id, status, message, created_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(athlete_id, activity_id) DO UPDATE SET
    status=excluded.status,
    message=excluded.message,
    created_at=excluded.created_at
`);

function listTracked(athleteId) {
  return listTrackedStatement.all(athleteId);
}

const replaceTracked = db.transaction((athleteId, segments) => {
  clearTrackedStatement.run(athleteId);
  const createdAt = nowSeconds();
  for (const segment of segments) {
    insertTrackedStatement.run(athleteId, String(segment.id), segment.name || String(segment.id), createdAt);
  }
});

function listRecentEvents(athleteId, limit = 20) {
  return recentEventsStatement.all(athleteId, limit);
}

function recordEvent(athleteId, activityId, status, message) {
  recordEventStatement.run(athleteId, String(activityId), status, message, nowSeconds());
}

module.exports = { listTracked, replaceTracked, listRecentEvents, recordEvent };
