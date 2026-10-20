(() => {
const $ = selector => document.querySelector(selector);
const templates = window.segmentTemplate;

const SAMPLE_SEGMENT = {
  id: '0', name: 'Sample Climb', distance: 2400, average_grade: 6.1, maximum_grade: 11.4,
  total_elevation_gain: 148, climb_category: 1, city: 'Hill Town', state: 'CA', country: 'United States',
  effort_count: 12, pr_elapsed_time: 498, pr_date: '2026-06-01', athlete_count: 15230,
  total_effort_count: 98140, kom: '5:02', qom: '6:11',
};
let previewSegments = [];
let savedTemplate = templates.DEFAULT_TEMPLATE;

// Ride-specific values are unknown until an activity is processed, so the preview invents them.
function sampleEffort(segment) {
  const best = segment.pr_elapsed_time;
  const fallback = segment.distance ? Math.round(segment.distance / (25 / 3.6)) : 300;
  return {
    elapsed_time: best ? best + 12 : fallback,
    average_watts: 245,
    average_heartrate: 152,
    pr_rank: best ? 2 : null,
    kom_rank: null,
  };
}

function renderPreview() {
  const template = $('#templateInput').value;
  const error = templates.validateTemplate(template);
  $('#templateError').textContent = error || '';
  $('#templateError').classList.toggle('hidden', !error);
  const segments = previewSegments.length ? previewSegments : [SAMPLE_SEGMENT];
  const lines = segments
    .map(segment => templates.render(template.trim() || templates.DEFAULT_TEMPLATE, segment, sampleEffort(segment)))
    .filter(Boolean);
  $('#templatePreview').textContent = lines.length ? ['-'.repeat(28), ...lines].join('\n') : '(nothing will be added)';
  $('#templatePreviewNote').textContent = previewSegments.length
    ? 'Shows every tracked segment as if all were completed. This-ride values (time, PR rank, power, heart rate, speed) are sample values.'
    : 'Uses a sample segment until you track one. This-ride values (time, PR rank, power, heart rate, speed) are sample values.';
  const status = $('#templateStatus');
  if (template.trim() !== savedTemplate && !status.dataset.busy) {
    status.textContent = 'Unsaved changes.';
    status.className = 'muted';
  } else if (status.textContent === 'Unsaved changes.') {
    status.textContent = '';
  }
}

function insertVariable(name) {
  const input = $('#templateInput');
  const token = `{${name}}`;
  const start = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? start : input.selectionEnd;
  input.setRangeText(token, start, end, 'end');
  input.focus();
  renderPreview();
}

function renderVariables() {
  const container = $('#templateVariables');
  container.replaceChildren();
  let group = null;
  templates.VARIABLES.forEach(variable => {
    if (variable.group !== group) {
      group = variable.group;
      const heading = document.createElement('h4');
      heading.textContent = group;
      container.append(heading);
    }
    const item = document.createElement('div');
    item.className = 'template-variable';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `{${variable.name}}`;
    button.title = `Insert {${variable.name}}`;
    button.addEventListener('click', () => insertVariable(variable.name));
    const description = document.createElement('span');
    description.textContent = variable.description;
    item.append(button, description);
    container.append(item);
  });
}

function applyTemplate(data) {
  savedTemplate = data.template || templates.DEFAULT_TEMPLATE;
  $('#templateInput').value = savedTemplate;
  renderPreview();
}

async function saveTemplate(template) {
  const status = $('#templateStatus');
  status.dataset.busy = 'true';
  status.textContent = 'Saving...';
  status.className = 'muted';
  try {
    const data = await api('/api/segment-counts/template', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    delete status.dataset.busy;
    applyTemplate(data);
    status.textContent = data.isDefault ? 'Using the default text.' : 'Description text saved.';
    status.className = 'status-ok';
  } catch (error) {
    delete status.dataset.busy;
    status.textContent = error.message;
    status.className = 'status-error';
  }
}

function renderSegmentDetails(segment) {
  const details = document.createElement('div');
  details.className = 'segment-details';
  if (!segment) return details;

  const name = document.createElement('a');
  name.href = `https://www.strava.com/segments/${encodeURIComponent(segment.segment_id)}`;
  name.target = '_blank';
  name.rel = 'noreferrer';
  name.textContent = segment.name;
  details.append(name);

  const stats = document.createElement('dl');
  stats.className = 'segment-stats';
  const values = [
    ['Length', null],
    ['Avg gradient', Number.isFinite(segment.average_grade) ? `${segment.average_grade.toFixed(1)}%` : 'Unavailable'],
    ['Elevation gain', Number.isFinite(segment.total_elevation_gain) ? `${Math.round(segment.total_elevation_gain)} m` : 'Unavailable'],
    ['Total completions', Number.isFinite(segment.effort_count) ? segment.effort_count.toLocaleString() : 'Unavailable'],
  ];
  values.forEach(([label, value]) => {
    const stat = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    if (label === 'Length' && Number.isFinite(segment.distance)) {
      description.dataset.distanceMeters = segment.distance;
      description.dataset.compactMetric = 'true';
    } else {
      description.textContent = value || 'Unavailable';
    }
    stat.append(term, description);
    stats.append(stat);
  });
  details.append(stats);
  return details;
}

function renderInputs(segments) {
  const container = $('#segmentInputs');
  container.replaceChildren();
  for (let index = 0; index < 10; index += 1) {
    const segment = segments[index];
    const row = document.createElement('div');
    row.className = 'segment-id-row';
    const number = document.createElement('label');
    number.className = 'muted';
    number.textContent = `${index + 1}.`;
    const input = document.createElement('input');
    input.id = `segmentId${index + 1}`;
    input.type = 'text';
    input.autocomplete = 'off';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]*';
    input.name = 'segmentId';
    input.placeholder = 'Segment ID';
    input.value = segment ? segment.segment_id : '';
    number.htmlFor = input.id;
    row.append(number, input, renderSegmentDetails(segment));
    container.append(row);
  }
}

function renderEvents(events) {
  const tbody = $('#eventsTable tbody');
  tbody.replaceChildren();
  if (!events.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 4;
    cell.className = 'muted';
    cell.textContent = 'No webhook events processed yet.';
    return;
  }
  events.forEach(event => {
    const row = tbody.insertRow();
    const when = row.insertCell();
    when.textContent = new Date(event.created_at * 1000).toLocaleString();
    const activity = row.insertCell();
    const link = document.createElement('a');
    link.href = `https://www.strava.com/activities/${encodeURIComponent(event.activity_id)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = event.activity_id;
    activity.append(link);
    const status = row.insertCell();
    status.className = event.status === 'updated' ? 'status-ok' : event.status === 'error' ? 'status-error' : 'muted';
    status.textContent = event.status;
    row.insertCell().textContent = event.message || '';
  });
}

async function loadConfiguration() {
  const data = await api('/api/segment-counts');
  renderInputs(data.segments || []);
  renderEvents(data.events || []);
  previewSegments = (data.segments || []).map(segment => segment.template_fields).filter(Boolean);
  applyTemplate(data);
}

async function saveSegments(event) {
  event.preventDefault();
  const status = $('#segmentsStatus');
  const segmentIds = [...document.querySelectorAll('[name="segmentId"]')].map(input => input.value.trim()).filter(Boolean);
  status.textContent = 'Saving...';
  try {
    const data = await api('/api/segment-counts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentIds }),
    });
    renderInputs(data.segments || []);
    previewSegments = (data.segments || []).map(segment => segment.template_fields).filter(Boolean);
    renderPreview();
    status.textContent = `${data.segments.length} segment${data.segments.length === 1 ? '' : 's'} saved.`;
    status.className = 'status-ok';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status-error';
  }
}

async function refreshEvents() {
  const button = $('#refreshEvents');
  const status = $('#eventsRefreshStatus');
  button.disabled = true;
  status.textContent = 'Refreshing...';
  status.className = 'muted';
  try {
    const data = await api('/api/segment-counts/refresh', { method: 'POST' });
    await loadConfiguration();
    status.textContent = data.refreshedActivityId
      ? 'Latest activity refreshed.'
      : 'No recent activity found.';
    status.className = 'status-ok';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status-error';
  } finally {
    button.disabled = false;
  }
}

async function loadSubscription() {
  const status = $('#subscriptionStatus');
  status.textContent = 'Checking...';
  try {
    const data = await api('/api/segment-counts/subscription');
    const subscription = (data.subscriptions || [])[0];
    $('#createSubscription').classList.toggle('hidden', Boolean(subscription));
    $('#deleteSubscription').classList.toggle('hidden', !subscription);
    $('#deleteSubscription').dataset.id = subscription ? subscription.id : '';
    status.textContent = subscription ? `Active subscription ${subscription.id}` : 'No subscription found.';
    status.className = subscription ? 'status-ok' : 'muted';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status-error';
  }
}

async function createSubscription() {
  const status = $('#subscriptionStatus');
  status.textContent = 'Creating...';
  try {
    await api('/api/segment-counts/subscription', { method: 'POST' });
    await loadSubscription();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status-error';
  }
}

async function deleteSubscription() {
  const id = $('#deleteSubscription').dataset.id;
  if (!id) return;
  const status = $('#subscriptionStatus');
  status.textContent = 'Deleting...';
  try {
    await api(`/api/segment-counts/subscription/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSubscription();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status-error';
  }
}

async function initialize() {
  const me = await api('/api/me');
  if (!me.authenticated) {
    $('#loginSection').classList.remove('hidden');
    return;
  }
  const countsSection = $('#countsSection');
  if (countsSection) countsSection.classList.remove('hidden');
  $('#segmentsForm').addEventListener('submit', saveSegments);
  renderVariables();
  $('#templateInput').addEventListener('input', renderPreview);
  $('#templateForm').addEventListener('submit', event => {
    event.preventDefault();
    saveTemplate($('#templateInput').value);
  });
  $('#resetTemplate').addEventListener('click', () => saveTemplate(''));
  const subscriptionStatus = $('#subscriptionStatus');
  if (subscriptionStatus) {
    $('#createSubscription').addEventListener('click', createSubscription);
    $('#deleteSubscription').addEventListener('click', deleteSubscription);
    $('#refreshSubscription').addEventListener('click', loadSubscription);
  }
  $('#refreshEvents').addEventListener('click', refreshEvents);
  const tasks = [loadConfiguration()];
  if (subscriptionStatus) tasks.push(loadSubscription());
  await Promise.all(tasks);
}

initialize().catch(error => {
  $('#loginSection').classList.remove('hidden');
  $('#loginSection').append(document.createTextNode(error.message));
});
})();