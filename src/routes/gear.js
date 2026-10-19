const fs = require('fs');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const strava = require('../strava');
const sync = require('../sync');
const mappings = require('../store/mappings');
const processed = require('../store/processed');
const { parseFit } = require('../fit');
const { chooseGear } = require('../matcher');
const { requireAuth } = require('./middleware');

const ACTIVITY_MATCH_WINDOW_MS = 5 * 60 * 1000;

fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({ dest: config.uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

const router = express.Router();

function syncOptions(body = {}) {
  return {
    dryRun: !!body.dryRun,
    force: !!body.force,
    sources: Array.isArray(body.sources) && body.sources.length ? body.sources : sync.SOURCES,
  };
}

async function parseUploadedFit(file) {
  try {
    return await parseFit(file.path);
  } finally {
    fs.unlink(file.path, () => {});
  }
}

router.get('/api/gear', requireAuth, async (req, res) => {
  try {
    res.json({ gear: await strava.listGear(req.session.athleteId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/mappings', requireAuth, (req, res) => {
  res.json({ mappings: mappings.list(req.session.athleteId) });
});

router.post('/api/mappings', requireAuth, (req, res) => {
  const { sensor_key, sensor_label, gear_id, gear_name, priority } = req.body || {};
  if (!sensor_key || !gear_id) return res.status(400).json({ error: 'sensor_key and gear_id required' });
  try {
    mappings.upsert(req.session.athleteId, {
      sensorKey: sensor_key, sensorLabel: sensor_label, gearId: gear_id, gearName: gear_name, priority,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/api/mappings/:id', requireAuth, (req, res) => {
  mappings.remove(req.session.athleteId, req.params.id);
  res.json({ ok: true });
});

// Inspect a FIT file without touching Strava; used to build mappings.
router.post('/api/fit/inspect', requireAuth, upload.single('fit'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    const parsed = await parseUploadedFit(req.file);
    res.json({
      filename: req.file.originalname,
      startTime: parsed.startTime,
      sport: parsed.sport,
      sensors: parsed.sensors,
    });
  } catch (e) {
    res.status(400).json({ error: `Failed to parse FIT: ${e.message}` });
  }
});

// Parse an uploaded FIT, find the Strava activity with the same start time, and set its gear.
router.post('/api/fit/apply', requireAuth, upload.single('fit'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const athleteId = req.session.athleteId;
  let parsed;
  try {
    parsed = await parseUploadedFit(req.file);
  } catch (e) {
    return res.status(400).json({ error: `Failed to parse FIT: ${e.message}` });
  }

  const log = {
    filename: req.file.originalname,
    startTime: parsed.startTime,
    sport: parsed.sport,
    sensors: parsed.sensors,
  };
  const record = fields => processed.record({
    athleteId, fitFilename: log.filename, sensors: parsed.sensors, ...fields,
  });

  const match = chooseGear(athleteId, parsed.sensors);
  if (!match) {
    record({ status: 'no_mapping', message: 'No sensor mapping matched.' });
    return res.json({ ...log, matched: null, message: 'No mapping matched the sensors in this file.' });
  }
  const matched = { gear_id: match.gear_id, gear_name: match.gear_name, sensor_key: match.sensor_key };

  if (!parsed.startTime) {
    return res.status(400).json({ ...log, error: 'Could not determine start time from FIT file.' });
  }
  let activity;
  try {
    const activities = await strava.listRecentActivities(athleteId, 30, 1);
    const target = parsed.startTime.getTime();
    activity = activities.find(a => Math.abs(new Date(a.start_date).getTime() - target) <= ACTIVITY_MATCH_WINDOW_MS);
  } catch (e) {
    return res.status(500).json({ ...log, error: `Failed to list activities: ${e.message}` });
  }

  if (!activity) {
    record({
      match, status: 'no_activity',
      message: 'No Strava activity found near that start time. Upload to Strava first, then retry.',
    });
    return res.json({
      ...log,
      matched,
      message: 'No Strava activity found near that start time. Upload it to Strava first, then re-run apply.',
    });
  }

  try {
    await strava.updateActivityGear(athleteId, activity.id, match.gear_id);
  } catch (e) {
    record({ activityId: activity.id, match, status: 'error', message: e.message });
    return res.status(500).json({ ...log, error: e.message });
  }

  record({ activityId: activity.id, match, status: 'ok', message: `Set gear on activity ${activity.id}` });
  res.json({
    ...log,
    matched,
    activity: { id: activity.id, name: activity.name, start_date: activity.start_date },
    message: `Set gear "${match.gear_name}" on activity "${activity.name}".`,
  });
});

router.get('/api/log', requireAuth, (req, res) => {
  res.json({ entries: processed.listRecent(req.session.athleteId) });
});

// Pull recent Strava activities and tag them automatically.
router.post('/api/sync', requireAuth, async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.body && req.body.limit, 10) || 10, 30));
  try {
    const results = await sync.syncRecent(req.session.athleteId, { limit, ...syncOptions(req.body) });
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/activities/:id/process', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid activity ID' });
  try {
    const activity = await strava.getActivity(req.session.athleteId, id);
    res.json(await sync.processActivity(req.session.athleteId, activity, syncOptions(req.body)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/activities', requireAuth, async (req, res) => {
  const pageValue = req.query.page === undefined ? '1' : String(req.query.page);
  if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue))) {
    return res.status(400).json({ error: 'page must be a positive integer' });
  }
  try {
    const list = await strava.listRecentActivities(req.session.athleteId, 10, Number(pageValue));
    res.json({
      activities: list.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        sport_type: a.sport_type,
        start_date: a.start_date,
        distance: a.distance,
        gear_id: a.gear_id,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
