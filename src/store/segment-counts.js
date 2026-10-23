const db = require('../db');
const settings = require('../settings');
const segmentTemplate = require('../../public/segment-template');

const TEMPLATE_KEY = 'segment_count_template';

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
  INSERT INTO segment_count_events (athlete_id, activity_id, status, message, description_block, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(athlete_id, activity_id) DO UPDATE SET
    status=excluded.status,
    message=excluded.message,
    description_block=COALESCE(excluded.description_block, segment_count_events.description_block),
    created_at=excluded.created_at
`);
const descriptionBlockStatement = db.prepare(`
  SELECT description_block FROM segment_count_events WHERE athlete_id = ? AND activity_id = ?
`);
// Webhook deliveries that have not produced a result yet (or are being retried after an error).
const queuedJobsStatement = db.prepare(`
  SELECT activity_id, status, attempts, last_error, created_at FROM webhook_jobs
  WHERE kind = 'segment_counts' AND athlete_id = ? AND status IN ('pending', 'running')
  ORDER BY created_at DESC LIMIT ?
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

// Processed events plus webhook deliveries still waiting in the queue, newest first.
function listRecentEvents(athleteId, limit = 20) {
  const events = recentEventsStatement.all(athleteId, limit);
  const queued = queuedJobsStatement.all(athleteId, limit).map(job => {
    const previous = events.find(event => event.activity_id === job.activity_id);
    return {
      activity_id: job.activity_id,
      status: job.status === 'running' ? 'processing' : 'queued',
      message: job.status === 'running'
        ? 'Updating segment counts...'
        : job.last_error
          ? `Retrying after error: ${job.last_error}`
          : 'Waiting to be processed.',
      created_at: previous ? Math.max(previous.created_at, job.created_at) : job.created_at,
    };
  });
  const queuedIds = new Set(queued.map(event => event.activity_id));
  return [...queued, ...events.filter(event => !queuedIds.has(event.activity_id))]
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, limit);
}

// descriptionBlock is the exact text written to Strava; null keeps the previously stored block.
function recordEvent(athleteId, activityId, status, message, descriptionBlock = null) {
  recordEventStatement.run(athleteId, String(activityId), status, message, descriptionBlock, nowSeconds());
}

function getDescriptionBlock(athleteId, activityId) {
  const row = descriptionBlockStatement.get(athleteId, String(activityId));
  return row ? row.description_block : null;
}

// The athlete's saved template, or null when they use the default.
function getTemplate(athleteId) {
  return settings.get(athleteId, TEMPLATE_KEY);
}

function setTemplate(athleteId, template) {
  const value = String(template || '').replace(/\r\n?/g, '\n').trim();
  if (!value || value === segmentTemplate.DEFAULT_TEMPLATE) settings.remove(athleteId, TEMPLATE_KEY);
  else settings.set(athleteId, TEMPLATE_KEY, value);
  return getTemplate(athleteId);
}

module.exports = {
  listTracked,
  replaceTracked,
  listRecentEvents,
  recordEvent,
  getDescriptionBlock,
  getTemplate,
  setTemplate,
};
