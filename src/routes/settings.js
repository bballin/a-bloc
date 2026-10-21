const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const settings = require('../settings');
const garmin = require('../garmin');
const wahoo = require('../wahoo');
const hammerhead = require('../hammerhead');
const coros = require('../coros');
const { requireAuth } = require('./middleware');

const router = express.Router();
const CONFIGURATION_URL = '/#configurationPanel';

function setOrRemove(athleteId, key, value) {
  if (value) settings.set(athleteId, key, value);
  else settings.remove(athleteId, key);
}

// Body: { username, password }; both optional, an empty string clears the value.
// Changing credentials drops cached tokens so the next call logs in again.
function saveCredentials(athleteId, prefix, tokenKeys, { username, password } = {}) {
  let credentialsChanged = false;
  for (const [key, value] of [[`${prefix}_username`, username], [`${prefix}_password`, password]]) {
    if (typeof value !== 'string' || value === (settings.get(athleteId, key) || '')) continue;
    setOrRemove(athleteId, key, value);
    credentialsChanged = true;
  }
  if (credentialsChanged) for (const key of tokenKeys) settings.remove(athleteId, key);
}

router.get('/api/settings', requireAuth, (req, res) => {
  res.json(settings.summary(req.session.athleteId));
});

// Public so the Garmin lockout is enforced in the UI whether or not a Strava user is signed in.
router.get('/api/garmin/status', async (req, res, next) => {
  try {
    res.json(await garmin.getLoginStatus());
  } catch (error) {
    next(error);
  }
});

router.post('/api/settings/garmin', requireAuth, (req, res) => {
  const athleteId = req.session.athleteId;
  saveCredentials(athleteId, 'garmin', ['garmin_oauth1', 'garmin_oauth2'], req.body || {});
  if (req.is('application/x-www-form-urlencoded')) {
    return res.redirect(303, CONFIGURATION_URL);
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

// Starts the Wahoo OAuth flow; the callback stores tokens for the signed-in athlete.
router.get('/auth/wahoo/login', (req, res) => {
  if (!req.session.athleteId) return res.redirect('/');
  if (!wahoo.isAppConfigured()) {
    return res.status(503).send('Wahoo integration is not configured on this server (set WAHOO_CLIENT_ID and WAHOO_CLIENT_SECRET).');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.wahooOAuthState = state;
  req.session.save(error => {
    if (error) return res.status(500).send('Could not start Wahoo authorization.');
    res.redirect(wahoo.authorizeUrl(state));
  });
});

router.get('/auth/wahoo/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const expectedState = req.session.wahooOAuthState;
  delete req.session.wahooOAuthState;
  if (!req.session.athleteId) return res.redirect('/');
  if (error) return res.redirect(303, '/?wahoo=denied#configurationPanel');
  if (!code || typeof state !== 'string' || !expectedState || state !== expectedState) {
    return res.status(400).send('Invalid Wahoo authorization response. Please try connecting again.');
  }
  try {
    await wahoo.exchangeCode(req.session.athleteId, String(code));
    res.redirect(303, '/?wahoo=connected#configurationPanel');
  } catch (e) {
    console.error('[wahoo] Token exchange failed:', e.message);
    res.status(502).type('text/plain').send(`Wahoo authorization failed: ${e.message}`);
  }
});

router.post('/api/settings/wahoo/disconnect', requireAuth, async (req, res) => {
  const athleteId = req.session.athleteId;
  try {
    await wahoo.disconnect(athleteId);
  } catch (e) {
    // Tokens are cleared locally even if Wahoo could not be reached.
    console.warn('[wahoo] Deauthorization failed:', e.message);
  }
  res.json({ ok: true, ...settings.summary(athleteId).wahoo });
});

router.post('/api/settings/wahoo/test', requireAuth, async (req, res) => {
  const athleteId = req.session.athleteId;
  if (!wahoo.isAppConfigured()) return res.status(400).json({ ok: false, error: 'Wahoo is not configured on this server.' });
  if (!wahoo.isConnected(athleteId)) return res.status(400).json({ ok: false, error: 'Wahoo is not connected.' });
  try {
    const user = await wahoo.getUser(athleteId);
    res.json({ ok: true, displayName: [user.first, user.last].filter(Boolean).join(' ') || null });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

for (const [prefix, service] of [['hammerhead', hammerhead], ['coros', coros]]) {
  router.post(`/api/settings/${prefix}`, requireAuth, (req, res) => {
    const athleteId = req.session.athleteId;
    saveCredentials(athleteId, prefix, service.TOKEN_KEYS, req.body || {});
    res.json({ ok: true, ...settings.summary(athleteId)[prefix] });
  });

  router.post(`/api/settings/${prefix}/test`, requireAuth, async (req, res) => {
    const athleteId = req.session.athleteId;
    if (!service.isConfigured(athleteId)) {
      return res.status(400).json({ ok: false, error: `${prefix === 'coros' ? 'COROS' : 'Hammerhead'} is not configured.` });
    }
    try {
      await service.testConnection(athleteId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
}

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
    enabled: settings.isGearWebhookEnabled(req.session.athleteId),
    callbackUrl: config.webhookCallbackUrl,
  });
});

router.post('/api/gear-webhook', requireAuth, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  settings.set(req.session.athleteId, 'gear_webhook_enabled', enabled ? '1' : '');
  res.json({ enabled });
});

module.exports = router;
