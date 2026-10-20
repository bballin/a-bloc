const express = require('express');
const config = require('../config');
const strava = require('../strava');

const router = express.Router();

router.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: config.strava.clientId,
    response_type: 'code',
    redirect_uri: config.oauthCallbackUrl,
    approval_prompt: 'auto',
    scope: 'read,activity:read_all,activity:write,profile:read_all,profile:write',
  });
  res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
});

router.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Strava auth error: ${error}`);
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokens = await strava.exchangeCodeForToken(code);
    strava.saveAthlete(tokens.athlete, tokens);
    req.session.athleteId = tokens.athlete.id;
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).send(`Auth failed: ${e.message}`);
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/api/me', async (req, res) => {
  let athlete = req.session.athleteId && strava.getAthlete(req.session.athleteId);
  if (!athlete) return res.json({ authenticated: false });
  if (athlete.profile === null) {
    try {
      const profile = await strava.getAthleteProfile(athlete.id);
      strava.saveAthlete(profile, strava.getAthlete(athlete.id));
      athlete = strava.getAthlete(athlete.id);
    } catch (e) {
      console.error(e);
      return res.status(502).json({ error: 'Unable to load your Strava profile. Please try again.' });
    }
  }
  res.json({
    authenticated: true,
    athlete: { id: athlete.id, firstname: athlete.firstname, lastname: athlete.lastname, profile: athlete.profile },
  });
});

module.exports = router;
