const strava = require('./strava');
const store = require('./store/segment-counts');
const segmentTemplate = require('../public/segment-template');

const DIVIDER = '-'.repeat(28);
const COUNT_LINE = '[^\\r\\n]*: \\d+ completions?';

// Matches a default-format counts block: the divider followed by one or more count
// lines. Blocks written by older versions also had a closing divider, which is removed too.
const BLOCK_PATTERN = new RegExp(
  `(?:\\r?\\n)*${DIVIDER}(?:\\r?\\n${COUNT_LINE})+(?:\\r?\\n${DIVIDER}(?!\\r?\\n${COUNT_LINE}))?(?=\\r?\\n|$)`,
  'g'
);

const normalizeNewlines = value => String(value || '').replace(/\r\n?/g, '\n');

function buildBlock(lines) {
  const content = lines.map(line => normalizeNewlines(line).trim()).filter(Boolean);
  return content.length ? [DIVIDER, ...content].join('\n') : '';
}

// Removes the last whole-line occurrence of block, joining the text around it with a blank line.
function removeBlock(text, block) {
  if (!block) return text;
  let index = text.lastIndexOf(block);
  while (index !== -1) {
    const end = index + block.length;
    if ((index === 0 || text[index - 1] === '\n') && (end === text.length || text[end] === '\n')) {
      const before = text.slice(0, index).trimEnd();
      const after = text.slice(end).replace(/^\n+/, '');
      return before && after ? `${before}\n\n${after}` : before || after;
    }
    index = index ? text.lastIndexOf(block, index - 1) : -1;
  }
  return text;
}

// Replaces this app's block in an activity description. previousBlock is the exact
// block last written to the activity, which may have used a different template.
function updateDescription(description, block, previousBlock) {
  let original = normalizeNewlines(description);
  original = removeBlock(original, normalizeNewlines(previousBlock).trim());
  original = removeBlock(original, block);
  original = original.replace(BLOCK_PATTERN, '').trim();
  if (!block) return original;
  return original ? `${original}\n\n${block}` : block;
}

function fastestEffort(efforts, segmentId) {
  return efforts
    .filter(effort => String(effort.segment && effort.segment.id) === segmentId)
    .reduce((best, effort) => (!best || Number(effort.elapsed_time) < Number(best.elapsed_time) ? effort : best), null);
}

async function processActivity(athleteId, activityId) {
  const tracked = store.listTracked(athleteId);
  if (!tracked.length) {
    store.recordEvent(athleteId, activityId, 'ignored', 'No segment IDs are configured.');
    return;
  }

  try {
    const activity = await strava.getActivity(athleteId, activityId);
    const efforts = activity.segment_efforts || [];
    const completedIds = new Set(efforts.map(effort => String(effort.segment && effort.segment.id)));
    const completed = tracked.filter(segment => completedIds.has(segment.segment_id));
    if (!completed.length) {
      store.recordEvent(athleteId, activityId, 'ignored', 'The activity did not include a tracked segment.');
      return;
    }

    const template = store.getTemplate(athleteId) || segmentTemplate.DEFAULT_TEMPLATE;
    const counts = [];
    for (const configured of completed) {
      const segment = await strava.getSegment(athleteId, configured.segment_id);
      const count = Number(segment.athlete_segment_stats && segment.athlete_segment_stats.effort_count);
      if (!Number.isFinite(count)) throw new Error(`Strava did not return an effort count for segment ${configured.segment_id}.`);
      const fields = segmentTemplate.segmentFields(segment, configured.name);
      const effort = segmentTemplate.effortFields(fastestEffort(efforts, configured.segment_id));
      counts.push({ name: fields.name, count, line: segmentTemplate.render(template, fields, effort) });
    }

    const block = buildBlock(counts.map(item => item.line));
    const current = normalizeNewlines(activity.description);
    const description = updateDescription(current, block, store.getDescriptionBlock(athleteId, activityId));
    if (description !== current) {
      await strava.updateActivityDescription(athleteId, activityId, description);
    }
    store.recordEvent(athleteId, activityId, 'updated', counts.map(item => `${item.name}: ${item.count}`).join(', '), block);
  } catch (error) {
    store.recordEvent(athleteId, activityId, 'error', error.message);
    throw error;
  }
}

module.exports = { processActivity, updateDescription, buildBlock };
