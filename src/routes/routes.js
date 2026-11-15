const express = require('express');
const strava = require('../strava');
const { decodeFirstPoint } = require('../polyline');
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

router.get('/api/routes', requireAuth, async (req, res) => {
  try {
    const routes = await strava.listRoutes(req.session.athleteId);
    res.json({ routes: routes.map(summarizeRoute) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
module.exports.summarizeRoute = summarizeRoute;
