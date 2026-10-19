const express = require('express');
const config = require('../config');
const strava = require('../strava');
const segments = require('../store/segments');
const { requireAuth } = require('./middleware');

const SEGMENT_RATE_LIMIT_RETRIES = 3;

const router = express.Router();

function parseSegmentIds(body) {
  const ids = Array.isArray(body && body.segmentIds) ? body.segmentIds : [];
  return [...new Set(ids.map(id => String(id).trim()).filter(id => /^\d+$/.test(id) && Number(id) > 0))];
}

function summarize(results) {
  return {
    results,
    succeeded: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
  };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function mutateSegmentWithRetry(athleteId, id, starred) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await strava.setSegmentStarred(athleteId, id, starred);
    } catch (e) {
      if (e.status !== 429 || attempt >= SEGMENT_RATE_LIMIT_RETRIES) throw e;
      await delay(Math.min(e.retryAfterMs || 2000 * (attempt + 1), 30000));
    }
  }
}

// Strava rate-limits star/unstar, so mutations run one at a time with a pause between them.
async function mutateSegments(athleteId, segmentIds, starred) {
  const results = [];
  for (const id of segmentIds) {
    try {
      if (results.length) await delay(config.segmentMutationDelayMs);
      results.push({ id, ok: true, segment: await mutateSegmentWithRetry(athleteId, id, starred) });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return results;
}

async function getCachedOrRemoteSegment(athleteId, segmentId) {
  const cached = segments.getCached(segmentId);
  if (cached) return cached;
  const segment = await strava.getSegment(athleteId, segmentId);
  segments.cache(segment);
  return segment;
}

router.get('/api/segments/starred', requireAuth, async (req, res) => {
  try {
    res.json({ segments: await strava.listStarredSegments(req.session.athleteId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/segments/local', requireAuth, (req, res) => {
  res.json({ segments: segments.listForAthlete(req.session.athleteId) });
});

router.get('/api/segments/local/:id/details', requireAuth, async (req, res) => {
  const athleteId = req.session.athleteId;
  const segmentId = String(req.params.id);
  if (!segments.isSavedByAthlete(athleteId, segmentId)) return res.status(404).json({ error: 'Segment not found.' });

  try {
    const segment = await strava.getSegment(athleteId, segmentId);
    const athleteStats = segment.athlete_segment_stats || {};
    const asNumber = value => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const athleteIsKom = athleteStats.is_kom === true;
    let rank = athleteIsKom ? 1 : asNumber(athleteStats.kom_rank ?? segment.kom_rank);
    const prActivityId = athleteStats.pr_activity_id_str
      || athleteStats.pr_activity_id
      || segment.athlete_pr_effort?.pr_activity_id
      || athleteStats.activity_id;
    if (prActivityId && !athleteIsKom) {
      try {
        const activity = await strava.getActivity(athleteId, prActivityId, true);
        const effort = (activity.segment_efforts || []).find(item => String(item.segment && item.segment.id) === segmentId);
        if (effort) rank = asNumber(effort.kom_rank) ?? rank;
      } catch {
        // Rank is optional; keep the segment details available if its PR activity cannot be read.
      }
    }
    res.json({
      details: {
        average_grade: asNumber(segment.average_grade),
        total_elevation_gain: asNumber(segment.total_elevation_gain),
        climb_category: asNumber(segment.climb_category),
        athlete_effort_count: asNumber(athleteStats.effort_count),
        rank,
      },
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/api/segments/local', requireAuth, async (req, res) => {
  const results = [];
  for (const id of parseSegmentIds(req.body)) {
    try {
      const segment = await getCachedOrRemoteSegment(req.session.athleteId, id);
      segments.addToAthlete(req.session.athleteId, id);
      results.push({ id, ok: true, segment });
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  res.json(summarize(results));
});

router.delete('/api/segments/local/:id', requireAuth, (req, res) => {
  segments.removeFromAthlete(req.session.athleteId, req.params.id);
  res.json({ ok: true });
});

// Look up segments for an import preview. Results are cached but not added to the athlete's local database.
router.post('/api/segments/preview', requireAuth, async (req, res) => {
  const requestedIds = Array.isArray(req.body && req.body.segmentIds) ? req.body.segmentIds : [];
  const ids = parseSegmentIds(req.body);
  const found = [];
  const errors = requestedIds
    .filter(id => !ids.includes(String(id).trim()))
    .map(id => ({ id: String(id), error: 'Invalid segment ID' }));
  for (const id of ids) {
    try {
      found.push(await getCachedOrRemoteSegment(req.session.athleteId, id));
    } catch (e) {
      errors.push({ id, error: e.message });
    }
  }
  res.json({ segments: found, errors });
});

router.get('/api/segments/export', requireAuth, async (req, res) => {
  try {
    const starred = await strava.listStarredSegments(req.session.athleteId);
    res.set('Content-Disposition', 'attachment; filename="a-bloc-segments.json"');
    res.json({
      format: 'a-bloc-segment-ids',
      version: 1,
      exportedAt: new Date().toISOString(),
      segmentIds: starred.map(segment => segment.id),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/segments/star', requireAuth, async (req, res) => {
  res.json(summarize(await mutateSegments(req.session.athleteId, parseSegmentIds(req.body), true)));
});

router.post('/api/segments/unstar', requireAuth, async (req, res) => {
  res.json(summarize(await mutateSegments(req.session.athleteId, parseSegmentIds(req.body), false)));
});

router.post('/api/segments/unstar-all', requireAuth, async (req, res) => {
  try {
    const starred = await strava.listStarredSegments(req.session.athleteId);
    res.json(summarize(await mutateSegments(req.session.athleteId, starred.map(segment => String(segment.id)), false)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
