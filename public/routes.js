// Routes tab: locally cached Strava routes with type, distance and start-location filters.
// Relies on $, escapeHtml, formatDistance and timeAgo from app.js and api from common.js.

const LEAFLET_CSS = { href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', integrity: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=' };
const LEAFLET_JS = { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', integrity: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=' };
const METERS_PER_UNIT = { km: 1000, mi: 1609.344 };

let routes = [];
let routesSyncedAt = null;
let routesLoaded = false;
let routeSyncMessage = '';
let routeDistanceSort = 0; // 0 = newest first, 1 = shortest first, -1 = longest first
let routeLocation = null; // { lat, lng, radiusMeters }
let leafletLoading = null;
let routeLocationMap = null;
let routeLocationLayers = null;
let pendingRouteCenter = null;

$('#fetchNewRoutes').onclick = () => syncRoutes('sync-new');
$('#resyncRoutes').onclick = () => syncRoutes('resync');
$('#routeTypeFilter').onchange = renderRoutes;
$('#sortRoutesByDistance').onclick = () => {
  routeDistanceSort = routeDistanceSort === 1 ? -1 : 1;
  renderRoutes();
};
$('#routeLocationFilter').onclick = openRouteLocationDialog;
$('#clearRouteLocation').onclick = () => {
  routeLocation = null;
  renderRoutes();
};
$('#routeRadius').oninput = updateRouteRadius;
$('#routeLocationDialog').addEventListener('close', onRouteLocationDialogClose);

// Shows the cached list; the server only contacts Strava if nothing has been cached yet.
async function loadRoutes() {
  if (routesLoaded) return renderRoutes();
  setRoutesBusy(true, 'Loading…');
  try {
    applyRoutesResponse(await api('/api/routes'));
    routesLoaded = true;
  } catch (e) {
    showRoutesError(e);
  } finally {
    setRoutesBusy(false);
  }
}

async function syncRoutes(mode) {
  setRoutesBusy(true, mode === 'resync' ? 'Resyncing every route from Strava…' : 'Fetching new routes from Strava…');
  try {
    const body = await api(`/api/routes/${mode}`, { method: 'POST' });
    routeSyncMessage = mode === 'resync'
      ? `Resynced ${body.fetched} route${body.fetched === 1 ? '' : 's'}.`
      : body.added ? `Added ${body.added} new route${body.added === 1 ? '' : 's'}.` : 'No new routes.';
    applyRoutesResponse(body);
    routesLoaded = true;
  } catch (e) {
    showRoutesError(e);
  } finally {
    setRoutesBusy(false);
  }
}

function applyRoutesResponse(body) {
  routes = body.routes;
  routesSyncedAt = body.syncedAt;
  renderRoutes();
}

function setRoutesBusy(busy, message) {
  $('#fetchNewRoutes').disabled = busy;
  $('#resyncRoutes').disabled = busy;
  if (busy) {
    $('#routesStatus').textContent = message;
    if (!routes.length) $('#routesTable tbody').innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(message)}</td></tr>`;
  }
}

function showRoutesError(e) {
  if (routes.length) {
    renderRoutes();
    $('#routesStatus').textContent = e.message;
  } else {
    $('#routesStatus').textContent = '';
    $('#routesTable tbody').innerHTML = `<tr><td colspan="6" class="status-error">${escapeHtml(e.message)}</td></tr>`;
  }
}

function routeTypeLabel(route) {
  return [route.type, route.sub_type].filter(Boolean).join(' · ');
}

function hasStart(route) {
  return Number.isFinite(route.start_lat) && Number.isFinite(route.start_lng);
}

function metersBetween(lat1, lng1, lat2, lng2) {
  const toRad = deg => deg * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function renderRouteTypeOptions() {
  const select = $('#routeTypeFilter');
  const types = [...new Set(routes.map(route => route.type).filter(Boolean))].sort();
  const selected = types.includes(select.value) ? select.value : '';
  select.innerHTML = '<option value="">All types</option>'
    + types.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
  select.value = selected;
}

function renderRoutes() {
  renderRouteTypeOptions();
  const type = $('#routeTypeFilter').value;
  const shown = routes
    .filter(route => !type || route.type === type)
    .filter(route => !routeLocation || (hasStart(route)
      && metersBetween(routeLocation.lat, routeLocation.lng, route.start_lat, route.start_lng) <= routeLocation.radiusMeters));
  if (routeDistanceSort) {
    shown.sort((left, right) => {
      if (left.distance == null) return right.distance == null ? 0 : 1;
      if (right.distance == null) return -1;
      return (left.distance - right.distance) * routeDistanceSort;
    });
  }

  const sortButton = $('#sortRoutesByDistance');
  const sortHeader = sortButton.closest('th');
  if (routeDistanceSort) sortHeader.setAttribute('aria-sort', routeDistanceSort === 1 ? 'ascending' : 'descending');
  else sortHeader.removeAttribute('aria-sort');
  sortButton.querySelector('span').textContent = routeDistanceSort === 1 ? '↑' : routeDistanceSort === -1 ? '↓' : '';

  const summary = $('#routeLocationSummary');
  summary.classList.toggle('hidden', !routeLocation);
  if (routeLocation) {
    summary.querySelector('span').innerHTML = `Within <span data-distance-meters="${routeLocation.radiusMeters}"></span> of ${routeLocation.lat.toFixed(4)}, ${routeLocation.lng.toFixed(4)}`;
  }

  const tbody = $('#routesTable tbody');
  tbody.innerHTML = shown.length
    ? shown.map(route => `
      <tr>
        <td><a href="https://www.strava.com/routes/${encodeURIComponent(route.id)}" target="_blank" rel="noreferrer">${escapeHtml(route.name || route.id)}</a>${route.private ? ' <span class="muted">(private)</span>' : ''}</td>
        <td>${escapeHtml(routeTypeLabel(route))}</td>
        <td>${formatDistance(route.distance)}</td>
        <td>${route.elevation_gain == null ? '' : `${escapeHtml(Math.round(route.elevation_gain))} m`}</td>
        <td>${route.created_at ? escapeHtml(new Date(route.created_at).toLocaleDateString()) : ''}</td>
        <td><code>${escapeHtml(route.id)}</code></td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="muted">${routes.length ? 'No routes match the current filters.' : 'No routes found.'}</td></tr>`;

  const count = shown.length === routes.length
    ? `${routes.length} saved route${routes.length === 1 ? '' : 's'}.`
    : `Showing ${shown.length} of ${routes.length} saved routes.`;
  const synced = routesSyncedAt
    ? ` Last fetched from Strava ${Date.now() / 1000 - routesSyncedAt < 86400 ? timeAgo(routesSyncedAt) : `on ${new Date(routesSyncedAt * 1000).toLocaleDateString()}`}.`
    : '';
  $('#routesStatus').textContent = [routeSyncMessage, count + synced].filter(Boolean).join(' ');
}

// Leaflet is only needed for the location picker, so it is loaded the first time the picker opens.
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletLoading) {
    // The map lays out its tiles using Leaflet's CSS, so wait for the stylesheet as well as the script.
    const load = (tag, attributes) => new Promise((resolve, reject) => {
      const element = Object.assign(document.createElement(tag), attributes, { crossOrigin: '' });
      element.onload = resolve;
      element.onerror = () => {
        element.remove();
        reject(new Error('Could not load the map library.'));
      };
      document.head.appendChild(element);
    });
    leafletLoading = Promise.all([
      load('link', { rel: 'stylesheet', ...LEAFLET_CSS }),
      load('script', LEAFLET_JS),
    ]).catch(error => {
      leafletLoading = null;
      throw error;
    });
  }
  return leafletLoading;
}

function radiusUnit() {
  return window.distanceUnits.getUnit();
}

function radiusMeters() {
  return Number($('#routeRadius').value) * METERS_PER_UNIT[radiusUnit()];
}

async function openRouteLocationDialog() {
  const dialog = $('#routeLocationDialog');
  dialog.returnValue = '';
  pendingRouteCenter = routeLocation ? { lat: routeLocation.lat, lng: routeLocation.lng } : null;
  $('#routeRadius').value = routeLocation
    ? Math.min(200, Math.max(1, Math.round(routeLocation.radiusMeters / METERS_PER_UNIT[radiusUnit()])))
    : 25;
  dialog.showModal();
  try {
    await loadLeaflet();
  } catch (e) {
    $('#routeRadiusValue').textContent = e.message;
    return;
  }

  if (!routeLocationMap) {
    routeLocationMap = L.map('routeLocationMap');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(routeLocationMap);
    routeLocationLayers = {
      starts: L.layerGroup().addTo(routeLocationMap),
      selection: L.layerGroup().addTo(routeLocationMap),
    };
    routeLocationMap.on('click', event => {
      pendingRouteCenter = { lat: event.latlng.lat, lng: event.latlng.lng };
      updateRouteRadius();
    });
  }
  routeLocationMap.invalidateSize();

  // Show every route start so the user can see where to place the circle.
  routeLocationLayers.starts.clearLayers();
  const starts = routes.filter(hasStart).map(route => [route.start_lat, route.start_lng]);
  starts.forEach(point => {
    L.circleMarker(point, { radius: 4, color: '#fc4c02', fillColor: '#fc4c02', fillOpacity: 0.8, weight: 1 })
      .addTo(routeLocationLayers.starts);
  });

  const circle = updateRouteRadius();
  if (circle) routeLocationMap.fitBounds(circle.getBounds(), { padding: [24, 24] });
  else if (starts.length > 1) routeLocationMap.fitBounds(starts, { padding: [24, 24] });
  else if (starts.length === 1) routeLocationMap.setView(starts[0], 11);
  else routeLocationMap.setView([20, 0], 2);
}

// Redraws the selection and radius label; returns the circle when a center is set.
function updateRouteRadius() {
  const unit = radiusUnit();
  $('#routeRadiusValue').textContent = `${$('#routeRadius').value} ${unit}`;
  $('#applyRouteLocation').disabled = !pendingRouteCenter;
  if (!routeLocationLayers) return null;
  routeLocationLayers.selection.clearLayers();
  if (!pendingRouteCenter) return null;
  const center = [pendingRouteCenter.lat, pendingRouteCenter.lng];
  L.marker(center).addTo(routeLocationLayers.selection);
  return L.circle(center, { radius: radiusMeters(), color: '#ff7a3d', fillOpacity: 0.12, weight: 2 })
    .addTo(routeLocationLayers.selection);
}

function onRouteLocationDialogClose() {
  if ($('#routeLocationDialog').returnValue !== 'apply' || !pendingRouteCenter) return;
  routeLocation = { ...pendingRouteCenter, radiusMeters: radiusMeters() };
  renderRoutes();
}
