const express = require('express');
const config = require('../config');
const strava = require('../strava');
const segmentCounts = require('../segment-counts');
const store = require('../store/segment-counts');
const { requireAuth } = require('./middleware');

const MAX_TRACKED_SEGMENTS = 5;

const router = express.Router();

const finiteOrNull = value => (Number.isFinite(Number(value)) && value != null ? Number(value) : null);

function segmentCountDetails(segment) {
  return {
    segment_id: String(segment.id),
    name: segment.name || String(segment.id),
    distance: finiteOrNull(segment.distance),
    average_grade: finiteOrNull(segment.average_grade),
    total_elevation_gain: finiteOrNull(segment.total_elevation_gain),
    effort_count: finiteOrNull(segment.athlete_segment_stats && segment.athlete_segment_stats.effort_count),
  };
}

router.get('/api/segment-counts', requireAuth, async (req, res) => {
  const athleteId = req.session.athleteId;
  try {
    const segments = await Promise.all(store.listTracked(athleteId)
      .map(async tracked => segmentCountDetails(await strava.getSegment(athleteId, tracked.segment_id))));
    res.json({
      segments,
      events: store.listRecentEvents(athleteId),
      callbackUrl: config.webhookCallbackUrl,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/api/segment-counts/refresh', requireAuth, async (req, res) => {
  try {
    const [activity] = await strava.listRecentActivities(req.session.athleteId, 1);
    if (activity) await segmentCounts.processActivity(req.session.athleteId, activity.id);
    res.json({ refreshedActivityId: activity ? String(activity.id) : null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.put('/api/segment-counts', requireAuth, async (req, res) => {
  const requested = Array.isArray(req.body && req.body.segmentIds)
    ? req.body.segmentIds.map(id => String(id).trim()).filter(Boolean)
    : [];
  const segmentIds = [...new Set(requested.filter(id => /^\d+$/.test(id) && Number(id) > 0))];
  if (segmentIds.length > MAX_TRACKED_SEGMENTS) {
    return res.status(400).json({ error: `A maximum of ${MAX_TRACKED_SEGMENTS} segment IDs can be tracked.` });
  }
  if (segmentIds.length !== requested.length) {
    return res.status(400).json({ error: 'Every segment ID must be a positive number.' });
  }

  try {
    const segments = [];
    for (const id of segmentIds) segments.push(await strava.getSegment(req.session.athleteId, id));
    store.replaceTracked(req.session.athleteId, segments);
    res.json({ segments: segments.map(segmentCountDetails) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/api/segment-counts/subscription', requireAuth, async (req, res) => {
  try {
    res.json({ subscriptions: await strava.listWebhookSubscriptions() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/segment-counts/subscription', requireAuth, async (req, res) => {
  if (!/^https:\/\//i.test(config.webhookCallbackUrl)) {
    return res.status(400).json({ error: 'APP_BASE_URL must be a public HTTPS URL before Strava can create a webhook subscription.' });
  }
  try {
    const existing = await strava.listWebhookSubscriptions();
    if (existing.length) return res.status(409).json({ error: 'This Strava application already has a webhook subscription.' });
    res.json(await strava.createWebhookSubscription(config.webhookCallbackUrl, config.webhookVerifyToken));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/segment-counts/subscription/:id', requireAuth, async (req, res) => {
  try {
    await strava.deleteWebhookSubscription(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
