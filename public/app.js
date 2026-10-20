const $ = (sel) => document.querySelector(sel);

let gearCache = [];
let importedSegments = [];
let localSegments = [];
let localSegmentsSort = { key: 'name', direction: 1 };
let activityPage = 0;
let activitiesLoading = false;
let garminLoginDisabledUntil = null;
let garminPauseTimer = null;
let signedIn = false;

async function init() {
  document.querySelectorAll('[data-tab]').forEach(tab => {
    tab.onclick = () => switchTab(tab.dataset.tab);
  });
  $('#garminForm').onsubmit = onSaveGarmin;
  $('#garminTest').onclick = onTestGarmin;
  $('#wahooConnect').onclick = () => { window.location.href = '/auth/wahoo/login'; };
  $('#wahooTest').onclick = onTestWahoo;
  $('#wahooDisconnect').onclick = onDisconnectWahoo;
  document.querySelectorAll('form[data-provider]').forEach(form => { form.onsubmit = onSaveProviderCredentials; });
  document.querySelectorAll('[data-test-provider]').forEach(button => {
    button.onclick = () => onTestProvider(button.dataset.testProvider, button);
  });
  const requestedPanel = document.getElementById(window.location.hash.slice(1));

  const me = await api('/api/me');
  loadGarminLoginStatus();
  if (!me.authenticated) {
    $('#loginSection').classList.remove('hidden');
    $('#mainSection').classList.remove('hidden');
    disableSignedOutControls();
    switchTab(requestedPanel && requestedPanel.classList.contains('tab-panel')
      ? requestedPanel.id
      : 'gearPanel');
    return;
  }
  $('#mainSection').classList.remove('hidden');
  signedIn = true;
  updateGarminPauseWarning(garminLoginDisabledUntil);
  $('#userBox').innerHTML = `Signed in as <strong>${escapeHtml(me.athlete.firstname)} ${escapeHtml(me.athlete.lastname)}</strong> · <button class="btn" id="logoutBtn">Sign out</button>`;
  $('#logoutBtn').onclick = async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  };

  await Promise.all([loadGear(), loadMappings(), loadSettings(), loadGearWebhook()]);

  $('#inspectFile').onchange = onInspect;
  $('#fetchOriginalActivities').onclick = onFetchOriginalActivities;
  $('#mappingForm').onsubmit = onSaveMapping;
  $('#refreshActivities').onclick = () => loadActivities(true);
  $('#loadMoreActivities').onclick = () => loadActivities();
  $('#syncForm').onsubmit = onSync;
  $('#gearWebhookForm').onsubmit = onSaveGearWebhook;
  if (requestedPanel && requestedPanel.classList.contains('tab-panel')) {
    switchTab(requestedPanel.id);
  }
  $('#refreshSegments').onclick = loadStarredSegments;
  $('#exportSegments').onclick = () => { window.location.href = '/api/segments/export'; };
  $('#unstarAllSegments').onclick = onUnstarAllSegments;
  $('#segmentImportFile').onchange = onImportSegments;
  $('#saveSelectedSegments').onclick = onSaveSelectedSegments;
  $('#starSelectedSegments').onclick = onStarSelectedSegments;
  $('#selectAllImportedSegments').onchange = ev => {
    document.querySelectorAll('[data-import-segment]').forEach(input => {
      input.checked = ev.target.checked;
    });
    updateSelectAllImportedSegments();
  };
  $('#importedSegmentsTable').onchange = ev => {
    if (ev.target.matches('[data-import-segment]')) updateSelectAllImportedSegments();
  };
  $('#refreshLocalSegments').onclick = loadLocalSegments;
  $('#addLocalSegmentForm').onsubmit = onAddLocalSegment;
  document.querySelectorAll('#localSegmentsTable [data-sort]').forEach(button => {
    button.onclick = () => {
      const key = button.dataset.sort;
      const direction = localSegmentsSort.key === key ? -localSegmentsSort.direction : 1;
      localSegmentsSort = { key, direction };
      document.querySelectorAll('#localSegmentsTable th').forEach(th => th.removeAttribute('aria-sort'));
      button.closest('th').setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
      document.querySelectorAll('#localSegmentsTable [data-sort] span').forEach(indicator => {
        indicator.textContent = '';
      });
      button.querySelector('span').textContent = direction === 1 ? '↑' : '↓';
      renderLocalSegments();
    };
  });
  await loadActivities(true);
}

// Signed-out visitors can browse the tabs, but every action needs a Strava login.
function disableSignedOutControls() {
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.querySelectorAll('button, input, select, textarea').forEach(control => { control.disabled = true; });
  });
}

function switchTab(panelId) {
  document.querySelectorAll('[data-tab]').forEach(tab => {
    const active = tab.dataset.tab === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== panelId);
  });
  if (panelId === 'segmentCatalogPanel') loadLocalSegments();
}

async function loadStarredSegments() {
  const tbody = $('#starredSegmentsTable tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  $('#starredSegmentsStatus').textContent = '';
  try {
    const { segments } = await api('/api/segments/starred');
    renderSegmentRows(tbody, segments, false);
    $('#starredSegmentsStatus').textContent = `${segments.length} starred segment${segments.length === 1 ? '' : 's'}.`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="status-error">${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderSegmentRows(tbody, segments, withCheckbox) {
  if (!segments.length) {
    tbody.innerHTML = `<tr><td colspan="${withCheckbox ? 6 : 6}" class="muted">No segments found.</td></tr>`;
    if (withCheckbox) updateSelectAllImportedSegments();
    return;
  }
  tbody.innerHTML = segments.map(segment => `
    <tr>
      ${withCheckbox ? `<td><input type="checkbox" data-import-segment="${segment.id}" aria-label="Select ${escapeHtml(segment.name)}"></td>` : ''}
      <td><a href="https://www.strava.com/segments/${segment.id}" target="_blank" rel="noreferrer">${escapeHtml(segment.name || segment.id)}</a><div class="muted">${escapeHtml([segment.city, segment.state, segment.country].filter(Boolean).join(', '))}</div></td>
      <td>${escapeHtml(segment.activity_type || '')}</td>
      <td>${formatDistance(segment.distance)}</td>
      <td>${segment.average_grade == null ? '' : `${escapeHtml(segment.average_grade)}%`}</td>
      <td><code>${escapeHtml(segment.id)}</code></td>
      ${withCheckbox ? '' : `<td><button class="btn" type="button" data-unstar-segment="${segment.id}">Unstar</button></td>`}
    </tr>`).join('');
  if (!withCheckbox) {
    tbody.querySelectorAll('[data-unstar-segment]').forEach(button => {
      button.onclick = () => onUnstarSegments([button.dataset.unstarSegment], button);
    });
  } else {
    updateSelectAllImportedSegments();
  }
}

function updateSelectAllImportedSegments() {
  const selectAll = $('#selectAllImportedSegments');
  const inputs = [...document.querySelectorAll('[data-import-segment]')];
  const selectedCount = inputs.filter(input => input.checked).length;
  selectAll.disabled = inputs.length === 0;
  selectAll.checked = inputs.length > 0 && selectedCount === inputs.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < inputs.length;
}

function formatDistance(meters) {
  if (meters == null || Number.isNaN(Number(meters))) return '';
  return `<span data-distance-meters="${Number(meters)}"></span>`;
}

async function onImportSegments(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const status = $('#segmentImportStatus');
  const tbody = $('#importedSegmentsTable tbody');
  const button = $('#starSelectedSegments');
  const saveButton = $('#saveSelectedSegments');
  button.disabled = true;
  saveButton.disabled = true;
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Reading file…</td></tr>';
  updateSelectAllImportedSegments();
  try {
    const raw = JSON.parse(await file.text());
    const requested = Array.isArray(raw) ? raw : raw && raw.segmentIds;
    if (!Array.isArray(requested)) throw new Error('JSON must be an array of segment IDs or an object with a segmentIds array.');
    const ids = [...new Set(requested.map(id => String(id).trim()).filter(id => /^\d+$/.test(id) && Number(id) > 0))];
    if (!ids.length) throw new Error('The JSON file does not contain any valid segment IDs.');
    const result = await api('/api/segments/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds: ids }),
    });
    importedSegments = result.segments || [];
    renderSegmentRows(tbody, importedSegments, true);
    button.disabled = !importedSegments.length;
    saveButton.disabled = !importedSegments.length;
    const errorCount = (result.errors || []).length;
    status.textContent = `${importedSegments.length} segment${importedSegments.length === 1 ? '' : 's'} ready${errorCount ? `; ${errorCount} ID${errorCount === 1 ? '' : 's'} unavailable` : ''}.`;
  } catch (e) {
    importedSegments = [];
    tbody.innerHTML = `<tr><td colspan="6" class="status-error">${escapeHtml(e.message)}</td></tr>`;
    updateSelectAllImportedSegments();
    status.textContent = '';
  }
}

async function onSaveSelectedSegments() {
  const ids = [...document.querySelectorAll('[data-import-segment]:checked')].map(input => input.dataset.importSegment);
  if (!ids.length) return;
  const button = $('#saveSelectedSegments');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const result = await api('/api/segments/local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds: ids }),
    });
    showMutationStatus('#segmentImportStatus', result);
    await loadLocalSegments();
  } catch (e) {
    $('#segmentImportStatus').textContent = e.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Add selected to local database';
  }
}

async function loadLocalSegments() {
  const tbody = $('#localSegmentsTable tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  $('#localSegmentsStatus').textContent = '';
  try {
    const { segments } = await api('/api/segments/local');
    localSegments = segments;
    renderLocalSegments();
    $('#localSegmentsStatus').textContent = `${segments.length} local segment${segments.length === 1 ? '' : 's'}.`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="status-error">${escapeHtml(e.message)}</td></tr>`;
  }
}

async function onAddLocalSegment(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const input = $('#addLocalSegmentId');
  const id = input.value.trim();
  const button = form.querySelector('button[type="submit"]');
  const status = $('#addLocalSegmentStatus');
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    status.textContent = 'Enter a valid positive segment ID.';
    return;
  }

  button.disabled = true;
  status.textContent = 'Adding segment…';
  try {
    const result = await api('/api/segments/local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds: [id] }),
    });
    const added = result.results[0];
    if (!added) throw new Error('The server did not return a result for this segment.');
    if (!added.ok) throw new Error(added.error);
    status.textContent = `Added ${added.segment.name || id} to the local database.`;
    input.value = '';
    await loadLocalSegments();
  } catch (e) {
    status.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

function renderLocalSegments() {
  const tbody = $('#localSegmentsTable tbody');
  if (!localSegments.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">No local segments yet. Import a JSON file from the Segmentation tab to add them.</td></tr>';
    return;
  }

  const { key, direction } = localSegmentsSort;
  const segments = [...localSegments].sort((left, right) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue == null || leftValue === '') return rightValue == null || rightValue === '' ? 0 : 1;
    if (rightValue == null || rightValue === '') return -1;
    if (key === 'name') return String(leftValue).localeCompare(String(rightValue)) * direction;
    return (Number(leftValue) - Number(rightValue)) * direction;
  });

  tbody.innerHTML = segments.map(segment => `
    <tr>
      <td><a href="https://www.strava.com/segments/${segment.segment_id}" target="_blank" rel="noreferrer">${escapeHtml(segment.name)}</a><div class="muted">${escapeHtml([segment.city, segment.state, segment.country].filter(Boolean).join(', '))}</div></td>
      <td>${formatDistance(segment.distance)}</td>
      <td>${segment.average_grade == null ? '' : `${escapeHtml(segment.average_grade)}%`}</td>
      <td>${segment.total_elevation_gain == null ? '' : `${escapeHtml(segment.total_elevation_gain)} m`}</td>
      <td>${formatCoordinates(segment.start_lat, segment.start_lng)}</td>
      <td><code>${escapeHtml(segment.segment_id)}</code></td>
      <td><button class="btn danger" type="button" data-delete-local-segment="${escapeHtml(segment.segment_id)}">Delete</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-delete-local-segment]').forEach(button => {
    button.onclick = () => onDeleteLocalSegment(button.dataset.deleteLocalSegment, button);
  });
}

function formatCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

async function onDeleteLocalSegment(id, button) {
  button.disabled = true;
  try {
    await api(`/api/segments/local/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadLocalSegments();
  } catch (e) {
    $('#localSegmentsStatus').textContent = e.message;
    button.disabled = false;
  }
}

async function onStarSelectedSegments() {
  const ids = [...document.querySelectorAll('[data-import-segment]:checked')].map(input => input.dataset.importSegment);
  if (!ids.length) return;
  const button = $('#starSelectedSegments');
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const result = await api('/api/segments/star', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds: ids }),
    });
    showMutationStatus('#segmentImportStatus', result);
    await loadStarredSegments();
  } catch (e) {
    $('#segmentImportStatus').textContent = e.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Add selected to Starred';
  }
}

async function onUnstarSegments(ids, button) {
  if (button) { button.disabled = true; button.textContent = '…'; }
  try {
    const result = await api('/api/segments/unstar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds: ids }),
    });
    showMutationStatus('#starredSegmentsStatus', result);
    await loadStarredSegments();
  } catch (e) {
    $('#starredSegmentsStatus').textContent = e.message;
    if (button) button.disabled = false;
  }
}

async function onUnstarAllSegments() {
  if (!confirm('Unstar every segment currently in your Strava starred list?')) return;
  const button = $('#unstarAllSegments');
  button.disabled = true;
  button.textContent = 'Deleting…';
  $('#starredSegmentsStatus').textContent = 'Unstarring segments one at a time…';
  try {
    const result = await api('/api/segments/unstar-all', { method: 'POST' });
    showMutationStatus('#starredSegmentsStatus', result);
    await loadStarredSegments();
  } catch (e) {
    $('#starredSegmentsStatus').textContent = e.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Delete all starred';
  }
}

function showMutationStatus(selector, result) {
  const failed = result.failed || 0;
  document.querySelector(selector).textContent = `${result.succeeded || 0} completed${failed ? `; ${failed} failed` : '.'}`;
}

async function loadGearWebhook() {
  try {
    const state = await api('/api/gear-webhook');
    $('#gearWebhookEnabled').checked = !!state.enabled;
    $('#gearWebhookCallback').textContent = state.callbackUrl;
    $('#gearWebhookStatus').textContent = state.enabled ? 'enabled' : 'disabled';
    $('#gearWebhookStatus').className = state.enabled ? 'status-ok' : 'muted';
  } catch (e) {
    $('#gearWebhookStatus').textContent = e.message;
  }
}

async function onSaveGearWebhook(ev) {
  ev.preventDefault();
  const enabled = $('#gearWebhookEnabled').checked;
  const status = $('#gearWebhookStatus');
  status.textContent = 'Saving…';
  try {
    await api('/api/gear-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    status.textContent = enabled ? 'enabled' : 'disabled';
    status.className = enabled ? 'status-ok' : 'muted';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'status-error';
  }
}

function timeAgo(epochSeconds) {
  const s = Math.floor(Date.now() / 1000) - epochSeconds;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

async function loadSettings() {
  const s = await api('/api/settings');
  $('#garminStatus').textContent = describeCredentials(s.garmin);
  updateGarminPauseWarning(s.garmin.loginDisabledUntil);
  renderWahoo(s.wahoo);
  for (const provider of ['hammerhead', 'coros']) {
    $(`#${provider}Status`).textContent = describeCredentials(s[provider]);
  }
  showWahooRedirectResult();
}

const PROVIDER_NAMES = { hammerhead: 'Hammerhead', coros: 'COROS' };

function renderWahoo(w, message) {
  const status = $('#wahooStatus');
  $('#wahooConnect').disabled = !w.appConfigured;
  $('#wahooConnect').textContent = w.connected ? 'Reconnect Wahoo' : 'Connect Wahoo';
  $('#wahooTest').disabled = !w.connected;
  $('#wahooDisconnect').disabled = !w.connected;
  status.className = 'muted';
  status.textContent = message || (!w.appConfigured
    ? 'Not available: the server has no Wahoo API credentials (WAHOO_CLIENT_ID / WAHOO_CLIENT_SECRET).'
    : w.connected ? 'Connected.' : 'Not connected.');
}

// The Wahoo OAuth callback redirects back with ?wahoo=connected|denied.
function showWahooRedirectResult() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('wahoo');
  if (!result) return;
  const status = $('#wahooStatus');
  if (result === 'connected') {
    status.textContent = 'Wahoo connected.';
    status.className = 'status-ok';
  } else {
    status.textContent = 'Wahoo authorization was cancelled.';
    status.className = 'status-error';
  }
  params.delete('wahoo');
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
}

async function onTestWahoo() {
  const button = $('#wahooTest');
  const status = $('#wahooStatus');
  button.disabled = true;
  status.textContent = 'Checking…';
  status.className = 'muted';
  try {
    const r = await api('/api/settings/wahoo/test', { method: 'POST' });
    status.textContent = `OK: ${r.displayName || 'connected'}`;
    status.className = 'status-ok';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.className = 'status-error';
  } finally {
    button.disabled = false;
  }
}

async function onDisconnectWahoo() {
  if (!confirm('Disconnect Wahoo? A Bloc will stop fetching FIT files from Wahoo.')) return;
  try {
    const result = await api('/api/settings/wahoo/disconnect', { method: 'POST' });
    renderWahoo(result, 'Disconnected.');
  } catch (e) {
    $('#wahooStatus').textContent = `Error: ${e.message}`;
    $('#wahooStatus').className = 'status-error';
  }
}

async function onSaveProviderCredentials(ev) {
  ev.preventDefault();
  const provider = ev.target.dataset.provider;
  const fd = new FormData(ev.target);
  const status = $(`#${provider}Status`);
  status.textContent = 'Saving…';
  status.className = 'muted';
  try {
    const result = await api(`/api/settings/${provider}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: fd.get('username') || '',
        password: fd.get('password') || '',
      }),
    });
    ev.target.reset();
    status.textContent = `Saved. ${describeCredentials(result)}`;
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    status.className = 'status-error';
  }
}

async function onTestProvider(provider, button) {
  const status = $(`#${provider}Status`);
  button.disabled = true;
  status.textContent = 'Logging in…';
  status.className = 'muted';
  try {
    await api(`/api/settings/${provider}/test`, { method: 'POST' });
    status.textContent = `OK: logged in to ${PROVIDER_NAMES[provider]}.`;
    status.className = 'status-ok';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.className = 'status-error';
  } finally {
    button.disabled = false;
  }
}
async function loadGarminLoginStatus() {
  try {
    const { loginDisabledUntil } = await api('/api/garmin/status');
    updateGarminPauseWarning(loginDisabledUntil);
  } catch (e) {
    console.error('Failed to load Garmin login status:', e);
  }
}
function isGarminLoginPaused() {
  return Number.isFinite(garminLoginDisabledUntil) && garminLoginDisabledUntil > Date.now();
}
function updateGarminPauseWarning(disabledUntil) {
  garminLoginDisabledUntil = disabledUntil;
  const warning = $('#garminPauseWarning');
  const disabled = isGarminLoginPaused();
  warning.classList.toggle('hidden', !disabled);
  warning.textContent = disabled
    ? `Garmin access is temporarily disabled until ${new Date(disabledUntil).toLocaleString()}.`
    : '';
  $('#garminTest').disabled = disabled || !signedIn;
  clearTimeout(garminPauseTimer);
  // setTimeout overflows above ~24.8 days; re-check on the next page load instead.
  const remainingMs = disabled ? disabledUntil - Date.now() : 0;
  if (disabled && remainingMs < 2 ** 31 - 1) {
    garminPauseTimer = setTimeout(() => updateGarminPauseWarning(null), remainingMs);
  }
}
function describeCredentials(g) {
  if (!g.hasUsername || !g.hasPassword) return 'Not configured.';
  return g.hasToken ? 'Configured (cached token).' : 'Configured.';
}

async function onSaveGarmin(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const status = $('#garminStatus');
  status.textContent = 'Saving…';
  status.className = 'muted';
  try {
    const result = await api('/api/settings/garmin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: fd.get('username') || '',
        password: fd.get('password') || '',
      }),
    });
    ev.target.reset();
    status.textContent = `Saved. ${describeCredentials(result)}`;
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    status.className = 'status-error';
  }
}

async function onTestGarmin() {
  const button = $('#garminTest');
  const status = $('#garminStatus');
  button.disabled = true;
  status.textContent = 'Logging in…';
  status.className = 'muted';
  try {
    const r = await api('/api/settings/garmin/test', { method: 'POST' });
    status.textContent = `OK: ${r.displayName || 'logged in'}`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.className = 'status-error';
    if (e.status === 429) await loadGarminLoginStatus();
  } finally {
    button.disabled = isGarminLoginPaused();
  }
}

async function loadActivities(reset = false) {
  const tbody = document.querySelector('#activitiesTable tbody');
  const refreshButton = $('#refreshActivities');
  const loadMoreButton = $('#loadMoreActivities');
  if (activitiesLoading) return;

  const page = reset ? 1 : activityPage + 1;
  activitiesLoading = true;
  refreshButton.disabled = true;
  loadMoreButton.disabled = true;
  if (reset) {
    activityPage = 0;
    loadMoreButton.classList.add('hidden');
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
  } else {
    tbody.querySelector('[data-activity-load-error]')?.remove();
    loadMoreButton.textContent = 'Loading…';
  }
  try {
    const { activities } = await api(`/api/activities?page=${page}`);
    if (reset) tbody.replaceChildren();
    const rows = activities.map(a => `
      <tr>
        <td>${new Date(a.start_date).toLocaleString()}</td>
        <td><a href="https://www.strava.com/activities/${a.id}" target="_blank">${escapeHtml(a.name)}</a></td>
        <td>${escapeHtml(a.sport_type || a.type || '')}</td>
        <td>${a.gear_id ? escapeHtml(gearName(a.gear_id)) : '<span class="muted">none</span>'}</td>
        <td><button class="btn" data-process="${a.id}">Tag</button> <button class="btn" data-process="${a.id}" data-force="1">Re-tag</button></td>
      </tr>
    `).join('');
    if (rows) tbody.insertAdjacentHTML('beforeend', rows);
    else {
      const row = tbody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.className = 'muted';
      cell.textContent = reset ? 'No recent activities.' : 'No more recent activities.';
    }
    if (activities.length) activityPage = page;
    loadMoreButton.classList.toggle('hidden', activities.length < 10);
    tbody.querySelectorAll('button[data-process]').forEach(b => {
      b.onclick = () => onProcessActivity(b.dataset.process, !!b.dataset.force, b);
    });
  } catch (e) {
    if (reset) tbody.innerHTML = `<tr><td colspan="5" class="status-error">${escapeHtml(e.message)}</td></tr>`;
    else {
      const row = tbody.insertRow();
      row.dataset.activityLoadError = 'true';
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.className = 'status-error';
      cell.textContent = e.message;
    }
  } finally {
    activitiesLoading = false;
    refreshButton.disabled = false;
    loadMoreButton.disabled = false;
    loadMoreButton.textContent = 'Load More';
  }
}

function gearName(id) {
  const g = gearCache.find(g => String(g.id) === String(id));
  return g ? g.name : id;
}

async function onProcessActivity(id, force, btn) {
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '…';
  try {
    const r = await api(`/api/activities/${id}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    btn.textContent = r.status === 'ok' ? '✓' : r.status;
    btn.title = r.message || '';
  } catch (e) {
    btn.textContent = 'err';
    btn.title = e.message;
    btn.disabled = false;
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000);
}

async function onSync(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const out = $('#syncResults');
  out.innerHTML = '<p class="muted">Working…</p>';
  try {
    const r = await api('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: parseInt(fd.get('limit') || '10', 10),
        dryRun: fd.get('dryRun') === 'on',
        force: fd.get('force') === 'on',
      }),
    });
    out.innerHTML = renderSyncResults(r.results);
  } catch (e) {
    out.innerHTML = `<p class="status-error">${escapeHtml(e.message)}</p>`;
  }
}

function renderSyncResults(results) {
  if (!results.length) return '<p class="muted">No activities.</p>';
  const rows = results.map(r => `
    <tr>
      <td><a href="https://www.strava.com/activities/${r.activityId}" target="_blank">${escapeHtml(r.activityName || r.activityId)}</a></td>
      <td>${escapeHtml(r.source || '')}</td>
      <td>${escapeHtml((r.matched && r.matched.gear_name) || '')}</td>
      <td class="status-${r.status}">${r.status}</td>
      <td class="muted">${escapeHtml(r.message || '')}</td>
    </tr>
  `).join('');
  return `<table><thead><tr><th>Activity</th><th>Source</th><th>Gear</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadGear() {
  try {
    const { gear } = await api('/api/gear');
    gearCache = gear;
    const sel = document.querySelector('select[name="gear_id"]');
    sel.innerHTML = '<option value="">Select gear…</option>' + gear.map(g =>
      `<option value="${g.id}">${escapeHtml(g.name || g.id)} (${g.type})</option>`
    ).join('');
  } catch (e) {
    console.error(e);
  }
}

async function loadMappings() {
  const { mappings } = await api('/api/mappings');
  const tbody = document.querySelector('#mappingsTable tbody');
  tbody.innerHTML = mappings.map(m => `
    <tr>
      <td><div><code>${escapeHtml(m.sensor_key)}</code></div><div class="muted">${escapeHtml(m.sensor_label || '')}</div></td>
      <td>${escapeHtml(m.gear_name || m.gear_id)}</td>
      <td>${m.priority}</td>
      <td><button class="btn" data-id="${m.id}">Delete</button></td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="muted">No mappings yet.</td></tr>';
  tbody.querySelectorAll('button[data-id]').forEach(b => {
    b.onclick = async () => {
      await api(`/api/mappings/${b.dataset.id}`, { method: 'DELETE' });
      loadMappings();
    };
  });
}

async function onInspect(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('fit', file);
  $('#inspectResult').innerHTML = '<p class="muted">Parsing…</p>';
  try {
    const r = await api('/api/fit/inspect', { method: 'POST', body: fd });
    renderInspect(r);
  } catch (e) {
    $('#inspectResult').innerHTML = `<p class="status-error">${escapeHtml(e.message)}</p>`;
  }
}

async function onFetchOriginalActivities() {
  const button = $('#fetchOriginalActivities');
  const out = $('#originalActivities');
  button.disabled = true;
  out.innerHTML = '<p class="muted">Fetching recent activities…</p>';
  try {
    const r = await api('/api/originals/recent');
    renderOriginalActivities(r);
  } catch (e) {
    out.innerHTML = `<p class="status-error">${escapeHtml(e.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

function renderOriginalActivities({ connected, activities, errors }) {
  const out = $('#originalActivities');
  if (!connected.length) {
    out.innerHTML = `<p class="status-error">An original activity file connection (Garmin, Wahoo, COROS or Hammerhead) is required.
      See the <a href="#configurationPanel" data-open-config>Configure</a> page to set one up.</p>`;
    out.querySelector('[data-open-config]').onclick = ev => {
      ev.preventDefault();
      switchTab('configurationPanel');
    };
    return;
  }
  const errorText = (errors || []).map(e =>
    `<p class="status-error">${escapeHtml(e.sourceLabel)}: ${escapeHtml(e.message)}</p>`
  ).join('');
  const rows = activities.map(a => `
    <tr>
      <td>${a.startTime ? escapeHtml(new Date(a.startTime).toLocaleString()) : '<span class="muted">unknown</span>'}</td>
      <td>${escapeHtml(a.name || '(unnamed)')}${a.sport ? `<div class="muted">${escapeHtml(a.sport)}</div>` : ''}</td>
      <td>${escapeHtml(a.sourceLabel)}</td>
      <td><button class="btn" type="button" data-original-source="${escapeHtml(a.source)}" data-original-id="${escapeHtml(a.id)}">Inspect</button></td>
    </tr>
  `).join('');
  const table = rows
    ? `<table><thead><tr><th>When</th><th>Name</th><th>Source</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : (errorText ? '' : '<p class="muted">No recent activities found.</p>');
  out.innerHTML = errorText + table;
  out.querySelectorAll('button[data-original-id]').forEach(b => {
    b.onclick = () => onInspectOriginalActivity(b.dataset.originalSource, b.dataset.originalId, b);
  });
}

async function onInspectOriginalActivity(source, id, button) {
  button.disabled = true;
  $('#inspectResult').innerHTML = '<p class="muted">Downloading and parsing…</p>';
  try {
    const r = await api(`/api/originals/${encodeURIComponent(source)}/${encodeURIComponent(id)}/inspect`, { method: 'POST' });
    renderInspect(r);
  } catch (e) {
    $('#inspectResult').innerHTML = `<p class="status-error">${escapeHtml(e.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

function renderInspect(r) {
  const meta = `
    <p class="muted">
      Start: <strong>${r.startTime ? new Date(r.startTime).toLocaleString() : 'unknown'}</strong> ·
      Sport: <strong>${escapeHtml(r.sport || 'unknown')}</strong>
    </p>`;
  const sensors = (r.sensors || []).map(s => `
    <div class="sensor-row">
      <div>
        <div><code>${escapeHtml(s.key)}</code></div>
        <div class="muted">${escapeHtml(s.label || '')}</div>
      </div>
      <button class="btn" data-key="${escapeHtml(s.key)}" data-label="${escapeHtml(s.label || '')}">Use this →</button>
    </div>
  `).join('') || '<p class="muted">No sensor/device entries found in this file.</p>';
  $('#inspectResult').innerHTML = meta + sensors;
  $('#inspectResult').querySelectorAll('button[data-key]').forEach(b => {
    b.onclick = () => {
      document.querySelector('input[name="sensor_key"]').value = b.dataset.key;
      document.querySelector('input[name="sensor_label"]').value = b.dataset.label;
      document.querySelector('select[name="gear_id"]').focus();
    };
  });
}

async function onSaveMapping(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const gearId = fd.get('gear_id');
  const gear = gearCache.find(g => String(g.id) === String(gearId));
  const payload = {
    sensor_key: String(fd.get('sensor_key') || '').toLowerCase().trim(),
    sensor_label: fd.get('sensor_label') || '',
    gear_id: gearId,
    gear_name: gear ? gear.name : '',
    priority: parseInt(fd.get('priority') || '0', 10),
  };
  if (!payload.sensor_key || !payload.gear_id) return;
  await api('/api/mappings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  ev.target.reset();
  document.querySelector('input[name="priority"]').value = '0';
  loadMappings();
}

init().catch(e => {
  document.body.innerHTML = `<pre style="color:#f87171;padding:24px">${escapeHtml(e.message)}</pre>`;
});
