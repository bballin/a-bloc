const db = require('./db');
const strava = require('./strava');

const BLOCK_START = '----------------------------';
// Not used
const BLOCK_END = '----------------------------';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BLOCK_PATTERN = new RegExp(
  `(?:\\r?\\n)*${escapeRegExp(BLOCK_START)}\\r?\\n[\\s\\S]*?\\r?\\n${escapeRegExp(BLOCK_END)}(?:\\r?\\n)*`,
  'g'
);

function now() {
  return Math.floor(Date.now() / 1000);
}

function setEvent(athleteId, activityId, status, message) {
  db.prepare(`
    INSERT INTO segment_count_events (athlete_id, activity_id, status, message, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(athlete_id, activity_id) DO UPDATE SET
      status=excluded.status,
      message=excluded.message,
      created_at=excluded.created_at
  `).run(athleteId, String(activityId), status, message, now());
}

function updateDescription(description, counts) {
  const original = String(description || '').replace(BLOCK_PATTERN, '').trim();
  const lines = counts.map(item => `${item.name}: ${item.count} completion${item.count === 1 ? '' : 's'}`);
  //const block = [BLOCK_START, ...lines, BLOCK_END].join('\n');
  const block = [BLOCK_START, ...lines].join('\n');
  return original ? `${original}\n\n${block}` : block;
}

async function processActivity(athleteId, activityId) {
  const tracked = db.prepare(`
    SELECT segment_id, name FROM segment_count_tracking
    WHERE athlete_id = ? ORDER BY created_at, segment_id
  `).all(athleteId);
  if (!tracked.length) {
    setEvent(athleteId, activityId, 'ignored', 'No segment IDs are configured.');
    return;
  }

  try {
    const activity = await strava.getActivity(athleteId, activityId);
    const completedIds = new Set((activity.segment_efforts || []).map(effort => String(effort.segment && effort.segment.id)));
    const completed = tracked.filter(segment => completedIds.has(segment.segment_id));
    if (!completed.length) {
      setEvent(athleteId, activityId, 'ignored', 'The activity did not include a tracked segment.');
      return;
    }

    const counts = [];
    for (const configured of completed) {
      const segment = await strava.getSegment(athleteId, configured.segment_id);
      const count = Number(segment.athlete_segment_stats && segment.athlete_segment_stats.effort_count);
      if (!Number.isFinite(count)) throw new Error(`Strava did not return an effort count for segment ${configured.segment_id}.`);
      counts.push({ name: configured.name || segment.name || configured.segment_id, count });
    }

    const description = updateDescription(activity.description, counts);
    if (description !== String(activity.description || '')) {
      await strava.updateActivityDescription(athleteId, activityId, description);
    }
    setEvent(athleteId, activityId, 'updated', counts.map(item => `${item.name}: ${item.count}`).join(', '));
  } catch (error) {
    setEvent(athleteId, activityId, 'error', error.message);
    throw error;
  }
}

module.exports = { processActivity, updateDescription };