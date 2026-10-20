// Segment-count description templates. Shared by the server (rendering activity
// descriptions) and the Segment Counts page (live preview), so keep it dependency-free.
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.segmentTemplate = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const DEFAULT_TEMPLATE = '{segment}: {count} {completions}';
  const MAX_TEMPLATE_LENGTH = 1000;
  const VARIABLE_PATTERN = /\{([a-z0-9_]+)\}/gi;

  const finite = value => (value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
  const text = value => (value == null ? '' : String(value).trim());

  function formatNumber(value, digits = 0) {
    return value == null ? '' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function withUnit(value, digits, unit) {
    return value == null ? '' : `${formatNumber(value, digits)}${unit}`;
  }

  function formatDuration(seconds) {
    const total = finite(seconds);
    if (total == null) return '';
    const rounded = Math.round(Math.abs(total));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const pad = n => String(n).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(rounded % 60)}` : `${minutes}:${pad(rounded % 60)}`;
  }

  function ordinal(value) {
    if (value == null) return '';
    const n = Math.trunc(value);
    const lastTwo = Math.abs(n) % 100;
    const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[Math.abs(n) % 10] || 'th';
    return `${formatNumber(n)}${suffix}`;
  }

  function formatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
    if (!match) return '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
  }

  const CLIMB_CATEGORIES = ['', 'Cat 4', 'Cat 3', 'Cat 2', 'Cat 1', 'HC'];
  const PR_RANKS = { 1: 'PR', 2: '2nd best', 3: '3rd best' };

  // The subset of a Strava DetailedSegment that templates can use.
  function segmentFields(segment, name) {
    const stats = segment.athlete_segment_stats || {};
    const xoms = segment.xoms || {};
    return {
      id: String(segment.id),
      name: text(name) || text(segment.name) || String(segment.id),
      distance: finite(segment.distance),
      average_grade: finite(segment.average_grade),
      maximum_grade: finite(segment.maximum_grade),
      total_elevation_gain: finite(segment.total_elevation_gain),
      climb_category: finite(segment.climb_category),
      city: text(segment.city),
      state: text(segment.state),
      country: text(segment.country),
      effort_count: finite(stats.effort_count),
      pr_elapsed_time: finite(stats.pr_elapsed_time),
      pr_date: text(stats.pr_date),
      athlete_count: finite(segment.athlete_count),
      total_effort_count: finite(segment.effort_count),
      kom: text(xoms.kom),
      qom: text(xoms.qom),
    };
  }

  // The subset of a Strava DetailedSegmentEffort (this activity's effort) that templates can use.
  function effortFields(effort) {
    if (!effort) return {};
    return {
      elapsed_time: finite(effort.elapsed_time),
      average_watts: finite(effort.average_watts),
      average_heartrate: finite(effort.average_heartrate),
      pr_rank: finite(effort.pr_rank),
      kom_rank: finite(effort.kom_rank),
    };
  }

  function speed(segment, effort, metersPerUnit) {
    if (segment.distance == null || !effort.elapsed_time) return null;
    return (segment.distance / metersPerUnit) / (effort.elapsed_time / 3600);
  }

  function timeVsBest(segment, effort) {
    if (effort.elapsed_time == null || segment.pr_elapsed_time == null) return '';
    const difference = Math.round(effort.elapsed_time - segment.pr_elapsed_time);
    return `${difference > 0 ? '+' : difference < 0 ? '-' : '±'}${formatDuration(difference)}`;
  }

  const VARIABLES = [
    { name: 'segment', group: 'Segment', description: 'Segment name', value: s => s.name },
    { name: 'segment_id', group: 'Segment', description: 'Strava segment ID', value: s => s.id },
    { name: 'url', group: 'Segment', description: 'Link to the segment on Strava', value: s => `https://www.strava.com/segments/${s.id}` },
    { name: 'distance_km', group: 'Segment', description: 'Segment length in kilometres', value: s => withUnit(s.distance == null ? null : s.distance / 1000, 2, ' km') },
    { name: 'distance_mi', group: 'Segment', description: 'Segment length in miles', value: s => withUnit(s.distance == null ? null : s.distance / 1609.344, 2, ' mi') },
    { name: 'elevation_m', group: 'Segment', description: 'Elevation gain in metres', value: s => withUnit(s.total_elevation_gain, 0, ' m') },
    { name: 'elevation_ft', group: 'Segment', description: 'Elevation gain in feet', value: s => withUnit(s.total_elevation_gain == null ? null : s.total_elevation_gain * 3.28084, 0, ' ft') },
    { name: 'grade', group: 'Segment', description: 'Average gradient', value: s => withUnit(s.average_grade, 1, '%') },
    { name: 'max_grade', group: 'Segment', description: 'Maximum gradient', value: s => withUnit(s.maximum_grade, 1, '%') },
    { name: 'climb_category', group: 'Segment', description: 'Climb category (Cat 4 to HC), blank if uncategorised', value: s => CLIMB_CATEGORIES[s.climb_category] || '' },
    { name: 'location', group: 'Segment', description: 'City and state', value: s => [s.city, s.state].filter(Boolean).join(', ') },
    { name: 'kom_time', group: 'Segment', description: 'Current KOM time', value: s => s.kom },
    { name: 'qom_time', group: 'Segment', description: 'Current QOM time', value: s => s.qom },
    { name: 'athletes', group: 'Segment', description: 'Number of athletes who have done the segment', value: s => formatNumber(s.athlete_count) },
    { name: 'total_efforts', group: 'Segment', description: 'Efforts on the segment by all athletes', value: s => formatNumber(s.total_effort_count) },
    { name: 'count', group: 'You', description: 'Your total completions', value: s => formatNumber(s.effort_count) },
    { name: 'count_ordinal', group: 'You', description: 'Your total completions as an ordinal, e.g. 42nd', value: s => ordinal(s.effort_count) },
    { name: 'completions', group: 'You', description: '"completion" or "completions" to match {count}', value: s => (s.effort_count === 1 ? 'completion' : 'completions') },
    { name: 'best_time', group: 'You', description: 'Your best (PR) time', value: s => formatDuration(s.pr_elapsed_time) },
    { name: 'best_date', group: 'You', description: 'Date of your best time', value: s => formatDate(s.pr_date) },
    { name: 'time', group: 'This ride', description: 'Your time on the segment in this ride', value: (s, e) => formatDuration(e.elapsed_time) },
    { name: 'time_vs_best', group: 'This ride', description: 'This ride\'s time compared with your best, e.g. +0:12', value: timeVsBest },
    { name: 'pr_rank', group: 'This ride', description: '"PR", "2nd best" or "3rd best" when this ride ranks', value: (s, e) => PR_RANKS[e.pr_rank] || '' },
    { name: 'leaderboard_rank', group: 'This ride', description: 'Overall leaderboard place when in the top 10, e.g. 7th', value: (s, e) => ordinal(e.kom_rank) },
    { name: 'speed_kmh', group: 'This ride', description: 'Average speed in km/h', value: (s, e) => withUnit(speed(s, e, 1000), 1, ' km/h') },
    { name: 'speed_mph', group: 'This ride', description: 'Average speed in mph', value: (s, e) => withUnit(speed(s, e, 1609.344), 1, ' mph') },
    { name: 'avg_power', group: 'This ride', description: 'Average power', value: (s, e) => withUnit(e.average_watts, 0, ' W') },
    { name: 'avg_hr', group: 'This ride', description: 'Average heart rate', value: (s, e) => withUnit(e.average_heartrate, 0, ' bpm') },
  ];
  const VARIABLES_BY_NAME = new Map(VARIABLES.map(variable => [variable.name, variable]));

  function unknownVariables(template) {
    const unknown = new Set();
    for (const [, name] of String(template).matchAll(VARIABLE_PATTERN)) {
      if (!VARIABLES_BY_NAME.has(name.toLowerCase())) unknown.add(name);
    }
    return [...unknown];
  }

  // Returns an error message, or null when the template can be saved.
  function validateTemplate(template) {
    if (typeof template !== 'string') return 'The template must be text.';
    if (template.length > MAX_TEMPLATE_LENGTH) return `The template must be at most ${MAX_TEMPLATE_LENGTH} characters.`;
    const unknown = unknownVariables(template);
    if (unknown.length) return `Unknown variable${unknown.length === 1 ? '' : 's'}: ${unknown.map(name => `{${name}}`).join(', ')}`;
    return null;
  }

  // Renders the text for one completed segment. Missing values render as blank.
  function render(template, segment, effort) {
    const effortValues = effort || {};
    return String(template || DEFAULT_TEMPLATE)
      .replace(/\r\n?/g, '\n')
      .replace(VARIABLE_PATTERN, (match, name) => {
        const variable = VARIABLES_BY_NAME.get(name.toLowerCase());
        return variable ? String(variable.value(segment, effortValues)) : match;
      })
      .replace(/[ \t]+$/gm, '')
      .trim();
  }

  return {
    DEFAULT_TEMPLATE,
    MAX_TEMPLATE_LENGTH,
    VARIABLES: VARIABLES.map(({ name, group, description }) => ({ name, group, description })),
    segmentFields,
    effortFields,
    validateTemplate,
    render,
    formatDuration,
  };
}));
