// Garmin login relay. Run it on a machine with a residential internet
// connection; the hosted app sends Garmin logins here because Garmin's SSO
// throttles and blocks logins from cloud-provider IP addresses.
//
//   GARMIN_RELAY_SECRET=... npm run garmin-relay
//
// The relay only performs the SSO login and OAuth token exchange. It never
// stores or logs credentials or tokens.
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { GarminConnect } = require('garmin-connect');

const MIN_SECRET_LENGTH = 32;
const RATE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_LOGIN_INTERVAL_MS = 5000;

function isRateLimited(error) {
  return !!error && (
    (error.response && error.response.status === 429) ||
    /\b429\b|rate.?limited/i.test(error.message || '')
  );
}

function isCredentialError(error) {
  return /password|MFA|AccountLocked|Ticket not found/i.test((error && error.message) || '');
}

function sameSecret(a, b) {
  const hash = value => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

const defaultGarmin = {
  async login(username, password) {
    const client = new GarminConnect({ username, password });
    await client.login();
    return { oauth1: client.client.oauth1Token, oauth2: client.client.oauth2Token };
  },
  async refresh(oauth1) {
    const client = new GarminConnect({ username: '', password: '' });
    // refreshOauth2Token requires an existing OAuth2 token object; the exchange replaces it.
    client.loadToken(oauth1, {});
    await client.client.refreshOauth2Token();
    return { oauth2: client.client.oauth2Token };
  },
};

function createRelayApp({ secret, garmin = defaultGarmin, now = Date.now, minLoginIntervalMs = MIN_LOGIN_INTERVAL_MS } = {}) {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`GARMIN_RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }

  let pausedUntil = 0;
  let lastLoginAt = 0;
  // Garmin throttles per source IP, so logins run one at a time and are spaced out.
  let loginChain = Promise.resolve();

  function serialize(task) {
    const run = loginChain.then(async () => {
      const wait = lastLoginAt + minLoginIntervalMs - now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      try {
        return await task();
      } finally {
        lastLoginAt = now();
      }
    });
    loginChain = run.catch(() => {});
    return run;
  }

  function sendGarminError(res, error) {
    if (isRateLimited(error)) {
      pausedUntil = Math.max(pausedUntil, now() + RATE_LIMIT_COOLDOWN_MS);
      return res.status(429).json({ error: 'Garmin rate-limited the relay.', retryAfter: pausedUntil });
    }
    if (isCredentialError(error)) return res.status(401).json({ error: error.message });
    console.error('[garmin-relay] Garmin request failed:', error.message);
    res.status(502).json({ error: `Garmin request failed: ${error.message}` });
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !sameSecret(token, secret)) return res.status(401).json({ error: 'Unauthorized.' });
    next();
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, pausedUntil: pausedUntil > now() ? pausedUntil : null });
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'username and password are required.' });
    }
    if (pausedUntil > now()) {
      return res.status(429).json({ error: 'Garmin logins are paused on the relay.', retryAfter: pausedUntil });
    }
    try {
      const { oauth1, oauth2 } = await serialize(() => garmin.login(username, password));
      if (!oauth1 || !oauth2) throw new Error('Garmin login completed without returning OAuth tokens.');
      res.json({ oauth1, oauth2 });
    } catch (error) {
      sendGarminError(res, error);
    }
  });

  app.post('/refresh', async (req, res) => {
    const { oauth1 } = req.body || {};
    if (!oauth1 || typeof oauth1.oauth_token !== 'string' || typeof oauth1.oauth_token_secret !== 'string') {
      return res.status(400).json({ error: 'oauth1 token is required.' });
    }
    try {
      const { oauth2 } = await garmin.refresh(oauth1);
      if (!oauth2) throw new Error('Garmin token exchange returned no OAuth2 token.');
      res.json({ oauth2 });
    } catch (error) {
      sendGarminError(res, error);
    }
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.GARMIN_RELAY_PORT) || 8787;
  // Loopback by default: expose it through an HTTPS tunnel rather than directly.
  const host = process.env.GARMIN_RELAY_HOST || '127.0.0.1';
  const app = createRelayApp({ secret: process.env.GARMIN_RELAY_SECRET });
  app.listen(port, host, () => console.log(`[garmin-relay] listening on http://${host}:${port}`));
}

module.exports = { createRelayApp };
