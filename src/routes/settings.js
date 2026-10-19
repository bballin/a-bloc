const express = require('express');
const config = require('../config');
const settings = require('../settings');
const garmin = require('../garmin');
const { requireAuth } = require('./middleware');

const router = express.Router();

function setOrRemove(athleteId, key, value) {
  if (value) settings.set(athleteId, key, value);
  else settings.remove(athleteId, key);
}

router.get('/api/settings', requireAuth, (req, res) => {
  res.json(settings.summary(req.session.athleteId));
});

// Public so the Garmin lockout is enforced in the UI whether or not a Strava user is signed in.
router.get('/api/garmin/status', (req, res) => {
  res.json({ loginDisabledUntil: settings.getGarminLoginDisabledUntil() });
});

// Body: { username, password }; both optional, an empty string clears the value.
// Changing credentials drops cached OAuth tokens so the next call logs in again.
router.post('/api/settings/garmin', requireAuth, (req, res) => {
  const { username, password } = req.body || {};
  const athleteId = req.session.athleteId;
  let credentialsChanged = false;
  for (const [key, value] of [['garmin_username', username], ['garmin_password', password]]) {
    if (typeof value !== 'string' || value === (settings.get(athleteId, key) || '')) continue;
    setOrRemove(athleteId, key, value);
    credentialsChanged = true;
  }
  if (credentialsChanged) {
    settings.remove(athleteId, 'garmin_oauth1');
    settings.remove(athleteId, 'garmin_oauth2');
  }
  if (req.is('application/x-www-form-urlencoded')) {
    return res.redirect(303, '/#configurationPanel');
  }
  res.json({ ok: true, ...settings.summary(athleteId).garmin });
});

router.post('/api/settings/garmin/test', requireAuth, async (req, res) => {
  try {
    garmin.assertLoginAllowed();
    const client = await garmin.getClient(req.session.athleteId);
    if (!client) return res.status(400).json({ ok: false, error: 'Garmin is not configured.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 429 ? 429 : 400).json({
      ok: false,
      error: e.message,
      loginDisabledUntil: settings.getGarminLoginDisabledUntil(),
    });
  }
});

// Body: { username, password, session_cookie }. The cookie may be a bare value,
// "_strava4_session=...", or a full "name=val; ..." string.
router.post('/api/settings/strava-web', requireAuth, (req, res) => {
  const { username, password, session_cookie } = req.body || {};
  const athleteId = req.session.athleteId;
  if (typeof username === 'string') setOrRemove(athleteId, 'strava_username', username);
  if (typeof password === 'string') setOrRemove(athleteId, 'strava_password', password);
  if (typeof session_cookie === 'string') setOrRemove(athleteId, 'strava_session_cookie', session_cookie.trim());
  res.json({ ok: true, ...settings.summary(athleteId).strava_web });
});

router.get('/api/gear-webhook', requireAuth, (req, res) => {
  res.json({
    enabled: settings.get(req.session.athleteId, 'gear_webhook_enabled') === '1',
    callbackUrl: config.webhookCallbackUrl,
  });
});

router.post('/api/gear-webhook', requireAuth, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  settings.set(req.session.athleteId, 'gear_webhook_enabled', enabled ? '1' : '');
  res.json({ enabled });
});

module.exports = router;
