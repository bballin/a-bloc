const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const athletes = require('../src/store/athletes');
const settings = require('../src/settings');
const { createApp } = require('../src/app');

const enqueued = [];
const queue = { enqueue: (...args) => { enqueued.push(args); return true; } };
let server;
let baseUrl;

before(async () => {
  athletes.save({ id: 77, firstname: 'Test', lastname: 'Rider' }, {
    access_token: 'x', refresh_token: 'y', expires_at: 4_102_444_800,
  });
  server = createApp({ queue }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  cleanup();
});

const request = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
});

test('Garmin lockout status is public; Garmin actions require sign-in', async () => {
  require('../src/db').prepare('DELETE FROM app_settings').run();
  const until = Date.now() + 3_600_000;
  settings.disableGarminLoginUntil(until);
  const status = await request('/api/garmin/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).loginDisabledUntil, until);
  assert.equal(status.headers.get('cache-control'), 'no-store');

  assert.equal((await request('/api/settings/garmin/test', { method: 'POST' })).status, 401);
  assert.equal((await request('/api/settings')).status, 401);
});

test('original file source settings require sign-in', async () => {
  for (const path of ['/api/settings/hammerhead', '/api/settings/coros', '/api/settings/coros/test',
    '/api/settings/hammerhead/test', '/api/settings/wahoo/test', '/api/settings/wahoo/disconnect']) {
    assert.equal((await request(path, { method: 'POST', body: '{}' })).status, 401, path);
  }
  const wahooLogin = await request('/auth/wahoo/login', { redirect: 'manual' });
  assert.equal(wahooLogin.status, 302);
  assert.equal(wahooLogin.headers.get('location'), '/');
});

test('Strava webhook verification checks the verify token', async () => {
  const ok = await request(`/api/webhook/strava?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.webhookVerifyToken)}&hub.challenge=abc`);
  assert.deepEqual(await ok.json(), { 'hub.challenge': 'abc' });
  const bad = await request('/api/webhook/strava?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc');
  assert.equal(bad.status, 403);
});

test('Strava activity webhooks are queued for known athletes only', async () => {
  const post = body => request('/api/webhook/strava', { method: 'POST', body: JSON.stringify(body) });
  const event = { object_type: 'activity', aspect_type: 'create', owner_id: 77, object_id: 123 };

  enqueued.length = 0;
  assert.equal((await post(event)).status, 200);
  assert.deepEqual(enqueued, [['segment_counts', 77, 123]]);

  settings.set(77, 'gear_webhook_enabled', '1');
  enqueued.length = 0;
  await post(event);
  assert.deepEqual(enqueued, [['gear', 77, 123], ['segment_counts', 77, 123]]);

  enqueued.length = 0;
  assert.equal((await post({ ...event, owner_id: 5 })).status, 200);
  assert.equal((await post({ ...event, aspect_type: 'update' })).status, 200);
  assert.deepEqual(enqueued, []);
});

test('OAuth login redirects to Strava with the configured callback', async () => {
  const res = await request('/auth/login', { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin, 'https://www.strava.com');
  assert.equal(location.searchParams.get('redirect_uri'), config.oauthCallbackUrl);
  assert.match(location.searchParams.get('scope'), /activity:write/);
});

test('signed-in routes: FIT uploads are parsed and cleaned up, local segments and mappings are listed', async () => {
  const fs = require('fs');
  const signature = require('cookie-signature');
  const sessionStore = require('../src/session-store');
  await new Promise((resolve, reject) => sessionStore.set('signed-in', { cookie: { originalMaxAge: 60_000 }, athleteId: 77 },
    error => (error ? reject(error) : resolve())));
  const cookie = `connect.sid=${encodeURIComponent(`s:${signature.sign('signed-in', config.sessionSecret)}`)}`;

  const me = await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json();
  assert.deepEqual(me, { authenticated: true, athlete: { id: 77, firstname: 'Test', lastname: 'Rider' } });

  const form = new FormData();
  form.append('fit', new Blob([Buffer.from('not a fit file')]), 'ride.fit');
  const uploadsBefore = fs.readdirSync(config.uploadDir).length;
  const inspect = await fetch(`${baseUrl}/api/fit/inspect`, { method: 'POST', body: form, headers: { cookie } });
  assert.equal(inspect.status, 400);
  assert.match((await inspect.json()).error, /^Failed to parse FIT/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(fs.readdirSync(config.uploadDir).length, uploadsBefore, 'temporary upload is deleted');

  assert.deepEqual(await (await fetch(`${baseUrl}/api/segments/local`, { headers: { cookie } })).json(), { segments: [] });
  const created = await fetch(`${baseUrl}/api/mappings`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sensor_key: 'Garmin:Edge:1', gear_id: 'b1', gear_name: 'Crux' }),
  });
  assert.equal(created.status, 200);
  const { mappings } = await (await fetch(`${baseUrl}/api/mappings`, { headers: { cookie } })).json();
  assert.deepEqual(mappings.map(m => [m.sensor_key, m.gear_name]), [['garmin:edge:1', 'Crux']]);

  const saved = await fetch(`${baseUrl}/api/settings/coros`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'rider@example.com', password: 'pw' }),
  });
  assert.deepEqual(await saved.json(), { ok: true, hasUsername: true, hasPassword: true, hasToken: false });
  settings.set(77, 'coros_token', '{"accessToken":"t"}');
  await fetch(`${baseUrl}/api/settings/coros`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'changed' }),
  });
  assert.equal(settings.get(77, 'coros_token'), null, 'changing credentials drops the cached token');
  assert.equal(settings.get(77, 'coros_password'), 'changed');

  const summary = await (await fetch(`${baseUrl}/api/settings`, { headers: { cookie } })).json();
  assert.deepEqual(Object.keys(summary).sort(), ['coros', 'garmin', 'hammerhead', 'strava_web', 'wahoo']);
  assert.equal(summary.wahoo.connected, false);
});
