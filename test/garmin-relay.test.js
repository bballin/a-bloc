const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createRelayApp } = require('../relay/garmin-relay');

const SECRET = 'relay-test-secret-0123456789abcdefghij';
const OAUTH1 = { oauth_token: 'o1', oauth_token_secret: 's1' };
const OAUTH2 = { access_token: 'a1', refresh_token: 'r1', expires_at: Math.floor(Date.now() / 1000) + 3600 };

const calls = [];
const fakeGarmin = {
  loginError: null,
  async login(username, password) {
    calls.push(['login', username, password]);
    if (this.loginError) throw this.loginError;
    return { oauth1: OAUTH1, oauth2: OAUTH2 };
  },
  async refresh(oauth1) {
    calls.push(['refresh', oauth1.oauth_token]);
    return { oauth2: { ...OAUTH2, access_token: 'refreshed' } };
  },
};

let server;
let relayUrl;
let garmin;
let settings;

before(async () => {
  server = createRelayApp({ secret: SECRET, garmin: fakeGarmin, minLoginIntervalMs: 0 }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  relayUrl = `http://127.0.0.1:${server.address().port}`;
  // Config is read once, so the relay address must be set before loading the app modules.
  process.env.GARMIN_RELAY_URL = relayUrl;
  process.env.GARMIN_RELAY_SECRET = SECRET;
  garmin = require('../src/garmin');
  settings = require('../src/settings');
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  cleanup();
});

const relay = (path, { secret = SECRET, body } = {}) => fetch(`${relayUrl}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('the relay requires a strong secret and authenticates every request', async () => {
  assert.throws(() => createRelayApp({ secret: 'short' }), /at least 32/);
  assert.equal((await relay('/health', { secret: null })).status, 401);
  assert.equal((await relay('/health', { secret: `${SECRET}x` })).status, 401);
  assert.equal((await relay('/login', { secret: null, body: { username: 'u', password: 'p' } })).status, 401);
  const health = await relay('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

test('the relay validates input and maps Garmin credential errors', async () => {
  assert.equal((await relay('/login', { body: { username: 'u' } })).status, 400);
  assert.equal((await relay('/refresh', { body: { oauth1: {} } })).status, 400);
  fakeGarmin.loginError = new Error('login failed (Ticket not found or MFA), please check username and password');
  const res = await relay('/login', { body: { username: 'u', password: 'bad' } });
  fakeGarmin.loginError = null;
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /Ticket not found/);
});

test('login status checks authenticated relay health without attempting Garmin login', async () => {
  calls.length = 0;
  assert.deepEqual(await garmin.getLoginStatus(), {
    relayConfigured: true,
    relayAvailable: true,
    loginDisabledUntil: null,
    loginAvailable: true,
  });
  assert.deepEqual(calls, []);
});

test('relay health failures mark login configuration offline and recovery restores it', async (t) => {
  const actualFetch = global.fetch;
  t.mock.method(console, 'warn', () => {});
  for (const outcome of [
    () => { throw new Error('connection refused'); },
    () => { throw new DOMException('Timed out', 'TimeoutError'); },
    () => new Response('{}', { status: 401 }),
    () => new Response('{}', { status: 502 }),
    () => new Response('not json'),
    () => new Response(JSON.stringify({ ok: true })),
    () => new Response(JSON.stringify({ ok: false, pausedUntil: null })),
  ]) {
    const mock = t.mock.method(global, 'fetch', async (url, options) => {
      assert.equal(url, `${relayUrl}/health`);
      assert.equal(options.headers.Authorization, `Bearer ${SECRET}`);
      assert.ok(options.signal instanceof AbortSignal);
      return outcome();
    });
    const status = await garmin.getLoginStatus();
    assert.equal(status.relayAvailable, false);
    assert.equal(status.loginAvailable, false);
    mock.mock.restore();
  }
  assert.equal(global.fetch, actualFetch);
  assert.equal((await garmin.getLoginStatus()).loginAvailable, true);
});

test('an online relay can still report logins paused', async (t) => {
  const until = Date.now() + 60_000;
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ ok: true, pausedUntil: until })));
  const status = await garmin.getLoginStatus();
  assert.equal(status.relayAvailable, true);
  assert.equal(status.loginDisabledUntil, until);
  assert.equal(status.loginAvailable, false);
});

test('A Bloc logs in to Garmin through the relay and stores the tokens', async (t) => {
  const actualFetch = global.fetch;
  t.mock.method(global, 'fetch', (url, options) => {
    assert.equal(options.redirect, 'error', 'credential requests must not follow relay redirects');
    return actualFetch(url, options);
  });
  settings.set(5, 'garmin_username', 'rider@example.com');
  settings.set(5, 'garmin_password', 'pw');
  calls.length = 0;
  const client = await garmin.getClient(5);
  assert.deepEqual(calls, [['login', 'rider@example.com', 'pw']]);
  assert.equal(client.client.oauth2Token.access_token, 'a1');
  assert.deepEqual(JSON.parse(settings.get(5, 'garmin_oauth1')), OAUTH1);

  calls.length = 0;
  await garmin.getClient(5);
  assert.deepEqual(calls, [], 'stored tokens are reused without another login');
});

test('a failed direct token refresh falls back to the relay and is persisted', async () => {
  const { HttpClient } = require('garmin-connect/dist/common/HttpClient');
  const original = HttpClient.prototype.refreshOauth2Token;
  HttpClient.prototype.refreshOauth2Token = async () => { throw new Error('Request failed with status code 403'); };
  try {
    const client = await garmin.getClient(5);
    calls.length = 0;
    await client.client.refreshOauth2Token();
    assert.deepEqual(calls, [['refresh', 'o1']]);
    assert.equal(client.client.oauth2Token.access_token, 'refreshed');
    assert.equal(JSON.parse(settings.get(5, 'garmin_oauth2')).access_token, 'refreshed');
  } finally {
    HttpClient.prototype.refreshOauth2Token = original;
  }
});

test('a relay rate limit pauses logins on both the relay and A Bloc', async () => {
  require('../src/db').prepare('DELETE FROM app_settings').run();
  settings.set(6, 'garmin_username', 'other@example.com');
  settings.set(6, 'garmin_password', 'pw');
  fakeGarmin.loginError = Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
  await assert.rejects(garmin.getClient(6), error => error.name === 'GarminLoginPausedError');
  fakeGarmin.loginError = null;
  assert.ok(settings.getGarminLoginDisabledUntil() > Date.now());

  calls.length = 0;
  const res = await relay('/login', { body: { username: 'u', password: 'p' } });
  assert.equal(res.status, 429);
  assert.deepEqual(calls, [], 'the relay does not contact Garmin while paused');
  assert.ok((await (await relay('/health')).json()).pausedUntil > Date.now());
});
