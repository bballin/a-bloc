const express = require('express');
const strava = require('../strava');
const { decodeFirstPoint } = require('../polyline');
const routeStore = require('../store/routes');
const { requireAuth } = require('./middleware');

const router = express.Router();

const ROUTE_TYPES = { 1: 'Ride', 2: 'Run', 3: 'Walk', 4: 'Hike', 5: 'Trail Run', 6: 'Gravel Ride' };
const ROUTE_SUB_TYPES = { 1: 'Road', 2: 'Mountain Bike', 3: 'Cross', 4: 'Trail', 5: 'Mixed' };

function summarizeRoute(route) {
  const start = decodeFirstPoint(route.map && route.map.summary_polyline);
  const asNumber = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    // Route IDs exceed Number.MAX_SAFE_INTEGER, so always use the string form.
    id: String(route.id_str || route.id),
    name: route.name || '',
    description: route.description || '',
    type: ROUTE_TYPES[route.type] || null,
    sub_type: ROUTE_SUB_TYPES[route.sub_type] || null,
    distance: asNumber(route.distance),
    elevation_gain: asNumber(route.elevation_gain),
    estimated_moving_time: asNumber(route.estimated_moving_time),
    private: route.private === true,
    starred: route.starred === true,
    created_at: route.created_at || null,
    start_lat: start ? start[0] : null,
    start_lng: start ? start[1] : null,
  };
}

const routeId = route => String(route.id_str || route.id);

// Re-reads every route, capturing edits and dropping routes deleted on Strava.
async function resync(athleteId) {
  const routes = await strava.listRoutes(athleteId);
  routeStore.replaceForAthlete(athleteId, routes.map(summarizeRoute));
  return { fetched: routes.length };
}

// Pages only until a route that is already cached, then stores the routes not seen before.
async function syncNew(athleteId) {
  const known = routeStore.idsForAthlete(athleteId);
  const routes = await strava.listRoutes(athleteId, { stopAt: route => known.has(routeId(route)) });
  const added = routes.filter(route => !known.has(routeId(route)));
  routeStore.upsertForAthlete(athleteId, added.map(summarizeRoute));
  return { fetched: routes.length, added: added.length };
}

function listResponse(athleteId, extra = {}) {
  return { routes: routeStore.listForAthlete(athleteId), syncedAt: routeStore.syncedAt(athleteId), ...extra };
}

function syncHandler(sync) {
  return async (req, res) => {
    try {
      res.json(listResponse(req.session.athleteId, await sync(req.session.athleteId)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  };
}

// Serves the locally cached routes. Strava is only queried here the first time, before anything is cached.
router.get('/api/routes', requireAuth, async (req, res) => {
  const athleteId = req.session.athleteId;
  try {
    if (routeStore.syncedAt(athleteId) == null) await resync(athleteId);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  res.json(listResponse(athleteId));
});

router.post('/api/routes/sync-new', requireAuth, syncHandler(syncNew));
router.post('/api/routes/resync', requireAuth, syncHandler(resync));

module.exports = router;
module.exports.summarizeRoute = summarizeRoute;
