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
  athletes.save({ id: 77, firstname: 'Test', lastname: 'Rider', profile: 'https://example.com/rider.jpg' }, {
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
    '/api/settings/hammerhead/test', '/api/settings/wahoo/test', '/api/settings/wahoo/disconnect',
    '/api/originals/garmin/1/inspect']) {
    assert.equal((await request(path, { method: 'POST', body: '{}' })).status, 401, path);
  }
  assert.equal((await request('/api/originals/recent')).status, 401);
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
  assert.deepEqual(enqueued, [['gear', 77, 123], ['segment_counts', 77, 123]]);

  settings.set(77, 'gear_webhook_enabled', '');
  enqueued.length = 0;
  await post(event);
  assert.deepEqual(enqueued, [['segment_counts', 77, 123]]);

  settings.set(77, 'gear_webhook_enabled', '1');
  enqueued.length = 0;
  await post(event);
  assert.deepEqual(enqueued, [['gear', 77, 123], ['segment_counts', 77, 123]]);

  enqueued.length = 0;
  assert.equal((await post({ ...event, owner_id: 5 })).status, 200);
  assert.equal((await post({ ...event, aspect_type: 'update' })).status, 200);
  assert.deepEqual(enqueued, []);
  settings.remove(77, 'gear_webhook_enabled');
});

test('OAuth login redirects to Strava with the configured callback', async () => {
  const res = await request('/auth/login', { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin, 'https://www.strava.com');
  assert.equal(location.searchParams.get('redirect_uri'), config.oauthCallbackUrl);
  assert.match(location.searchParams.get('scope'), /activity:write/);
});

test('existing signed-in accounts load and cache their Strava photo without exposing tokens', async (t) => {
  const strava = require('../src/strava');
  const signature = require('cookie-signature');
  const sessionStore = require('../src/session-store');
  athletes.save({ id: 79, firstname: 'Existing', lastname: 'Rider' }, {
    access_token: 'access', refresh_token: 'refresh', expires_at: 4_102_444_800,
  });
  require('../src/db').prepare('UPDATE athletes SET profile = NULL WHERE id = 79').run();
  await new Promise((resolve, reject) => sessionStore.set('profile', {
    cookie: { originalMaxAge: 60_000 }, athleteId: 79,
  }, error => (error ? reject(error) : resolve())));
  const cookie = `connect.sid=${encodeURIComponent(`s:${signature.sign('profile', config.sessionSecret)}`)}`;
  const getProfile = t.mock.method(strava, 'getAthleteProfile', async id => {
    assert.equal(id, 79);
    athletes.updateTokens(id, { access_token: 'refreshed', refresh_token: 'new-refresh', expires_at: 4_102_444_800 });
    return { id, firstname: 'Existing', lastname: 'Rider', profile: 'https://example.com/existing.jpg' };
  });
  const expected = {
    authenticated: true,
    athlete: { id: 79, firstname: 'Existing', lastname: 'Rider', profile: 'https://example.com/existing.jpg' },
  };
  for (let i = 0; i < 2; i++) {
    const response = await request('/api/me', { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  }
  assert.equal(getProfile.mock.callCount(), 1);
  assert.equal(athletes.get(79).access_token, 'refreshed');
  assert.deepEqual(await (await request('/api/me')).json(), { authenticated: false });
});

test('signed-in routes: FIT uploads are parsed and cleaned up, local segments and mappings are listed', async () => {
  const fs = require('fs');
  const signature = require('cookie-signature');
  const sessionStore = require('../src/session-store');
  await new Promise((resolve, reject) => sessionStore.set('signed-in', { cookie: { originalMaxAge: 60_000 }, athleteId: 77 },
    error => (error ? reject(error) : resolve())));
  const cookie = `connect.sid=${encodeURIComponent(`s:${signature.sign('signed-in', config.sessionSecret)}`)}`;

  const webhookState = async () => (await request('/api/gear-webhook', { headers: { cookie } })).json();
  assert.equal((await webhookState()).enabled, true, 'webhook defaults to enabled');
  for (const enabled of [false, true]) {
    const saved = await request('/api/gear-webhook', {
      method: 'POST', headers: { cookie }, body: JSON.stringify({ enabled }),
    });
    assert.deepEqual(await saved.json(), { enabled });
    assert.equal((await webhookState()).enabled, enabled, 'explicit choice is preserved');
  }

  const me = await (await fetch(`${baseUrl}/api/me`, { headers: { cookie } })).json();
  assert.deepEqual(me, {
    authenticated: true,
    athlete: { id: 77, firstname: 'Test', lastname: 'Rider', profile: 'https://example.com/rider.jpg' },
  });

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

  const recent = await fetch(`${baseUrl}/api/originals/recent`, { headers: { cookie } });
  assert.deepEqual(await recent.json(), { connected: [], activities: [], errors: [] });
  const notConnected = await fetch(`${baseUrl}/api/originals/garmin/123/inspect`, { method: 'POST', headers: { cookie } });
  assert.equal(notConnected.status, 400);
  assert.match((await notConnected.json()).error, /Garmin Connect is not connected/);
  const unknownSource = await fetch(`${baseUrl}/api/originals/strava/123/inspect`, { method: 'POST', headers: { cookie } });
  assert.equal(unknownSource.status, 400);

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

  const putTemplate = template => fetch(`${baseUrl}/api/segment-counts/template`, {
    method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ template }),
  });
  const invalid = await putTemplate('{segment} {bogus}');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'Unknown variable: {bogus}');
  assert.deepEqual(await (await putTemplate('{segment}: {count_ordinal} ride')).json(),
    { template: '{segment}: {count_ordinal} ride', isDefault: false });
  assert.deepEqual(await (await putTemplate('')).json(), { template: '{segment}: {count} {completions}', isDefault: true });
});

test('segment-count template changes require sign-in', async () => {
  assert.equal((await request('/api/segment-counts/template', { method: 'PUT', body: '{"template":"x"}' })).status, 401);
});

test('mapping edits update editable fields only and are scoped to the signed-in athlete', async () => {
  const signature = require('cookie-signature');
  const sessionStore = require('../src/session-store');
  const mappings = require('../src/store/mappings');
  await new Promise((resolve, reject) => sessionStore.set('mapping-editor', {
    cookie: { originalMaxAge: 60_000 }, athleteId: 77,
  }, error => (error ? reject(error) : resolve())));
  const cookie = `connect.sid=${encodeURIComponent(`s:${signature.sign('mapping-editor', config.sessionSecret)}`)}`;
  mappings.upsert(77, { sensorKey: 'editable:1', gearId: 'old', sensorLabel: 'Old', priority: 4 });
  mappings.upsert(78, { sensorKey: 'private:1', gearId: 'private', priority: 1 });
  const original = mappings.list(77).find(m => m.sensor_key === 'editable:1');
  const other = mappings.list(78)[0];
  const payload = { sensor_label: 'New label', gear_id: 'new', gear_name: 'New bike', priority: -2, sensor_key: 'changed' };
  const edit = (id, body, authenticated = true) => request(`/api/mappings/${id}`, {
    method: 'PUT', headers: authenticated ? { cookie } : {}, body: JSON.stringify(body),
  });
  assert.equal((await edit(original.id, payload, false)).status, 401);
  assert.equal((await edit(original.id, payload)).status, 200);
  const updated = mappings.list(77).find(m => m.id === original.id);
  assert.deepEqual(updated, {
    ...original, sensor_label: 'New label', gear_id: 'new', gear_name: 'New bike', priority: -2,
  });
  for (const invalid of [{ ...payload, gear_id: '' }, { ...payload, priority: 1.5 }]) {
    assert.equal((await edit(original.id, invalid)).status, 400);
  }
  assert.equal((await edit(other.id, payload)).status, 404);
  assert.deepEqual(mappings.list(78)[0], other);
  assert.deepEqual(mappings.list(77).find(m => m.id === original.id), updated);
});

test('tracked segments accept ten IDs and reject eleven without changing saved segments', async (t) => {
  const signature = require('cookie-signature');
  const sessionStore = require('../src/session-store');
  const strava = require('../src/strava');
  const store = require('../src/store/segment-counts');
  await new Promise((resolve, reject) => sessionStore.set('segment-limit', {
    cookie: { originalMaxAge: 60_000 }, athleteId: 77,
  }, error => (error ? reject(error) : resolve())));
  const cookie = `connect.sid=${encodeURIComponent(`s:${signature.sign('segment-limit', config.sessionSecret)}`)}`;
  const getSegment = t.mock.method(strava, 'getSegment', async (_athleteId, id) => ({
    id: Number(id), name: `Segment ${id}`,
  }));
  const save = segmentIds => request('/api/segment-counts', {
    method: 'PUT', headers: { cookie }, body: JSON.stringify({ segmentIds }),
  });
  const ids = Array.from({ length: 10 }, (_, index) => String(index + 1));
  const accepted = await save(ids);
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).segments.map(segment => segment.segment_id), ids);
  const rejected = await save([...ids, '11']);
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: 'A maximum of 10 segment IDs can be tracked.' });
  assert.equal(getSegment.mock.callCount(), 10);
  assert.deepEqual(store.listTracked(77).map(segment => segment.segment_id).sort((a, b) => Number(a) - Number(b)), ids);
});
