(() => {
const $ = selector => document.querySelector(selector);

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
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
  for (let index = 0; index < 5; index += 1) {
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
  const countsSection = $('#countsSection') || $('#segmentCountsPanel');
  countsSection.classList.remove('hidden');
  $('#segmentsForm').addEventListener('submit', saveSegments);
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