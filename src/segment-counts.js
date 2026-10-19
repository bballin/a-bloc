const strava = require('./strava');
const store = require('./store/segment-counts');

const DIVIDER = '-'.repeat(28);
const COUNT_LINE = '[^\\r\\n]*: \\d+ completions?';

// Matches a counts block: the divider followed by one or more count lines. Blocks
// written by older versions also had a closing divider, which is removed too.
const BLOCK_PATTERN = new RegExp(
  `(?:\\r?\\n)*${DIVIDER}(?:\\r?\\n${COUNT_LINE})+(?:\\r?\\n${DIVIDER}(?!\\r?\\n${COUNT_LINE}))?(?=\\r?\\n|$)`,
  'g'
);

function updateDescription(description, counts) {
  const original = String(description || '').replace(BLOCK_PATTERN, '').trim();
  const lines = counts.map(item => `${item.name}: ${item.count} completion${item.count === 1 ? '' : 's'}`);
  const block = [DIVIDER, ...lines].join('\n');
  return original ? `${original}\n\n${block}` : block;
}

async function processActivity(athleteId, activityId) {
  const tracked = store.listTracked(athleteId);
  if (!tracked.length) {
    store.recordEvent(athleteId, activityId, 'ignored', 'No segment IDs are configured.');
    return;
  }

  try {
    const activity = await strava.getActivity(athleteId, activityId);
    const completedIds = new Set((activity.segment_efforts || []).map(effort => String(effort.segment && effort.segment.id)));
    const completed = tracked.filter(segment => completedIds.has(segment.segment_id));
    if (!completed.length) {
      store.recordEvent(athleteId, activityId, 'ignored', 'The activity did not include a tracked segment.');
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
    store.recordEvent(athleteId, activityId, 'updated', counts.map(item => `${item.name}: ${item.count}`).join(', '));
  } catch (error) {
    store.recordEvent(athleteId, activityId, 'error', error.message);
    throw error;
  }
}

module.exports = { processActivity, updateDescription };
