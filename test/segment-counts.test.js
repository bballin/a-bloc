const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const strava = require('../src/strava');
const store = require('../src/store/segment-counts');
const { updateDescription, buildBlock, processActivity } = require('../src/segment-counts');
const segmentTemplate = require('../public/segment-template');

after(cleanup);

const DIVIDER = '-'.repeat(28);
const countLines = counts => counts.map(({ name, count }) => `${name}: ${count} completion${count === 1 ? '' : 's'}`);
const update = (description, counts, previous) => updateDescription(description, buildBlock(countLines(counts)), previous);

test('appends a counts block to the description', () => {
  assert.equal(
    update('Nice ride', [{ name: 'Hill', count: 1 }, { name: 'Sprint', count: 4 }]),
    `Nice ride\n\n${DIVIDER}\nHill: 1 completion\nSprint: 4 completions`
  );
  assert.equal(update('', [{ name: 'Hill', count: 2 }]), `${DIVIDER}\nHill: 2 completions`);
});

test('replaces an existing block instead of stacking a new one', () => {
  const once = update('Nice ride', [{ name: 'Hill', count: 3 }]);
  const twice = update(once, [{ name: 'Hill', count: 4 }]);
  assert.equal(twice, `Nice ride\n\n${DIVIDER}\nHill: 4 completions`);
  assert.equal(update(twice, [{ name: 'Hill', count: 4 }]), twice, 'idempotent');
});

test('cleans up blocks already stacked by older versions', () => {
  const stacked = `Nice ride\n\n${DIVIDER}\nHill: 3 completions\n\n${DIVIDER}\nHill: 4 completions`;
  assert.equal(update(stacked, [{ name: 'Hill', count: 5 }]), `Nice ride\n\n${DIVIDER}\nHill: 5 completions`);
});

test('removes legacy blocks that had a closing divider and keeps text around them', () => {
  const legacy = `Before\n\n${DIVIDER}\nHill: 3 completions\n${DIVIDER}\n\nAfter`;
  assert.equal(update(legacy, [{ name: 'Hill', count: 4 }]), `Before\n\nAfter\n\n${DIVIDER}\nHill: 4 completions`);
});

test('leaves unrelated dividers alone', () => {
  const text = `Notes\n${DIVIDER}\nnot a count line`;
  assert.equal(update(text, [{ name: 'Hill', count: 1 }]), `${text}\n\n${DIVIDER}\nHill: 1 completion`);
});

test('replaces a custom-format block using the block previously written', () => {
  const previous = buildBlock(['Hill — 3rd time, best 4:05']);
  const description = `Nice ride\r\n\r\n${previous.replace(/\n/g, '\r\n')}\r\n\r\nAdded by another app`;
  const next = buildBlock(['Hill — 4th time, best 4:01']);
  assert.equal(
    updateDescription(description, next, previous),
    `Nice ride\n\nAdded by another app\n\n${next}`
  );
  assert.equal(updateDescription(`Nice ride\n\n${next}`, next, null), `Nice ride\n\n${next}`, 'idempotent without history');
  assert.equal(updateDescription(`Nice ride\n\n${previous}`, '', previous), 'Nice ride', 'empty block only removes');
});

const SEGMENT = {
  id: 42,
  name: 'Hill',
  distance: 2500,
  average_grade: 5.25,
  maximum_grade: 12,
  total_elevation_gain: 131.4,
  climb_category: 2,
  city: 'Town',
  state: 'CA',
  athlete_count: 1234,
  effort_count: 56789,
  xoms: { kom: '4:59', qom: '6:01' },
  athlete_segment_stats: { effort_count: 22, pr_elapsed_time: 390, pr_date: '2026-03-07' },
};
const EFFORT = { segment: { id: 42 }, elapsed_time: 400, average_watts: 251.6, average_heartrate: 160.2, pr_rank: 2, kom_rank: 3 };

test('renders every template variable', () => {
  const fields = segmentTemplate.segmentFields(SEGMENT, 'My Hill');
  const effort = segmentTemplate.effortFields(EFFORT);
  const values = Object.fromEntries(segmentTemplate.VARIABLES
    .map(({ name }) => [name, segmentTemplate.render(`{${name}}`, fields, effort)]));
  assert.deepEqual(values, {
    segment: 'My Hill',
    segment_id: '42',
    url: 'https://www.strava.com/segments/42',
    distance_km: '2.50 km',
    distance_mi: '1.55 mi',
    elevation_m: '131 m',
    elevation_ft: '431 ft',
    grade: '5.3%',
    max_grade: '12.0%',
    climb_category: 'Cat 3',
    location: 'Town, CA',
    kom_time: '4:59',
    qom_time: '6:01',
    athletes: '1,234',
    total_efforts: '56,789',
    count: '22',
    count_ordinal: '22nd',
    completions: 'completions',
    best_time: '6:30',
    best_date: '7 Mar 2026',
    time: '6:40',
    time_vs_best: '+0:10',
    pr_rank: '2nd best',
    leaderboard_rank: '3rd',
    speed_kmh: '22.5 km/h',
    speed_mph: '14.0 mph',
    avg_power: '252 W',
    avg_hr: '160 bpm',
  });
});

test('renders the default template like the original format and blanks missing values', () => {
  const fields = segmentTemplate.segmentFields({ id: 1, name: 'Hill', athlete_segment_stats: { effort_count: 1 } });
  assert.equal(segmentTemplate.render(segmentTemplate.DEFAULT_TEMPLATE, fields, {}), 'Hill: 1 completion');
  assert.equal(segmentTemplate.render('{segment} {avg_power}\n{pr_rank}', fields, {}), 'Hill');
  assert.equal(segmentTemplate.render('{count_ordinal} {count_ordinal}', { effort_count: 111 }, {}), '111th 111th');
  assert.equal(segmentTemplate.formatDuration(3725), '1:02:05');
});

test('validates templates', () => {
  assert.equal(segmentTemplate.validateTemplate('{segment} {Count} {not braces'), null);
  assert.equal(segmentTemplate.validateTemplate('{segment} {nope} {nope} {bad}'), 'Unknown variables: {nope}, {bad}');
  assert.match(segmentTemplate.validateTemplate('x'.repeat(1001)), /at most 1000/);
  assert.equal(segmentTemplate.validateTemplate(5), 'The template must be text.');
});

test('templates are saved per athlete and the default is not stored', () => {
  assert.equal(store.getTemplate(9), null);
  assert.equal(store.setTemplate(9, '  {segment}\r\n{count}  '), '{segment}\n{count}');
  assert.equal(store.getTemplate(9), '{segment}\n{count}');
  assert.equal(store.getTemplate(10), null);
  assert.equal(store.setTemplate(9, segmentTemplate.DEFAULT_TEMPLATE), null);
  assert.equal(store.setTemplate(9, ''), null);
});

test('processActivity writes the athlete template and replaces it after the template changes', async t => {
  const athleteId = 5;
  let description = 'Morning ride';
  const writes = [];
  t.mock.method(strava, 'getActivity', async () => ({
    description,
    segment_efforts: [{ ...EFFORT, elapsed_time: 420 }, EFFORT, { segment: { id: 99 }, elapsed_time: 10 }],
  }));
  t.mock.method(strava, 'getSegment', async () => SEGMENT);
  t.mock.method(strava, 'updateActivityDescription', async (id, activityId, text) => {
    writes.push(text);
    description = text;
  });
  store.replaceTracked(athleteId, [{ id: 42, name: 'Hill' }]);

  store.setTemplate(athleteId, '{segment}: {count_ordinal} time in {time} ({pr_rank})');
  await processActivity(athleteId, 1001);
  assert.equal(description, `Morning ride\n\n${DIVIDER}\nHill: 22nd time in 6:40 (2nd best)`);

  store.setTemplate(athleteId, '{segment} x{count}');
  await processActivity(athleteId, 1001);
  assert.equal(description, `Morning ride\n\n${DIVIDER}\nHill x22`);

  await processActivity(athleteId, 1001);
  assert.equal(writes.length, 2, 'unchanged descriptions are not rewritten');
  assert.equal(store.listRecentEvents(athleteId)[0].message, 'Hill: 22');
});
