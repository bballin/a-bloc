const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const mappings = require('../src/store/mappings');
const segments = require('../src/store/segments');
const settings = require('../src/settings');
const garmin = require('../src/garmin');
const sessionStore = require('../src/session-store');
const { chooseGear } = require('../src/matcher');

after(cleanup);

test('athlete photos are saved, updated, and preserved when tokens refresh', () => {
  const athletes = require('../src/store/athletes');
  const tokens = { access_token: 'access', refresh_token: 'refresh', expires_at: 123 };
  athletes.save({ id: 99, profile: 'https://example.com/photo.jpg' }, tokens);
  athletes.updateTokens(99, { ...tokens, access_token: 'new-access' });
  assert.equal(athletes.get(99).profile, 'https://example.com/photo.jpg');
  athletes.save({ id: 99, profile_medium: 'https://example.com/small.jpg' }, tokens);
  assert.equal(athletes.get(99).profile, 'https://example.com/small.jpg');
  athletes.save({ id: 99 }, tokens);
  assert.equal(athletes.get(99).profile, '');
});

test('chooseGear prefers the lowest priority mapping among matching sensors', () => {
  mappings.upsert(1, { sensorKey: 'A', gearId: 'b1', gearName: 'Bike 1', priority: 5 });
  mappings.upsert(1, { sensorKey: 'b', gearId: 'b2', gearName: 'Bike 2', priority: 1 });
  mappings.upsert(2, { sensorKey: 'c', gearId: 'other', priority: 0 });
  assert.equal(chooseGear(1, [{ key: 'a' }, { key: 'b' }, { key: 'c' }]).gear_id, 'b2');
  assert.equal(chooseGear(1, [{ key: 'a' }]).gear_id, 'b1', 'sensor keys are stored lowercase');
  assert.equal(chooseGear(1, [{ key: 'c' }]), null, 'other athletes\u2019 mappings are ignored');
  assert.equal(chooseGear(1, []), null);
});

test('segments are cached globally and linked per athlete', () => {
  segments.cache({ id: 55, name: 'Climb', distance: 1200, start_latlng: [1, 2], end_latlng: [], map: { polyline: 'abc' } });
  assert.deepEqual(segments.getCached('55').start_latlng, [1, 2]);
  assert.equal(segments.getCached('55').end_latlng, null);
  assert.deepEqual(segments.listForAthlete(1), [], 'caching alone does not add to an athlete');

  segments.addToAthlete(1, '55');
  segments.addToAthlete(1, '55');
  assert.deepEqual(segments.listForAthlete(1).map(s => s.name), ['Climb']);
  assert.equal(segments.isSavedByAthlete(2, '55'), false);

  segments.removeFromAthlete(1, '55');
  assert.deepEqual(segments.listForAthlete(1), []);
  assert.ok(segments.getCached('55'), 'cache entry survives removal');
});

test('credentials are encrypted at rest', () => {
  settings.set(1, 'garmin_password', 'hunter2');
  const raw = require('../src/db').prepare(`SELECT value FROM settings WHERE athlete_id = 1 AND key = 'garmin_password'`).get().value;
  assert.notEqual(raw, 'hunter2');
  assert.equal(settings.get(1, 'garmin_password'), 'hunter2');
});

test('the Garmin login pause is global and only ever extended', () => {
  require('../src/db').prepare('DELETE FROM app_settings').run();
  assert.equal(settings.getGarminLoginDisabledUntil(), null);
  assert.doesNotThrow(() => garmin.assertLoginAllowed());

  const later = Date.now() + 60_000;
  settings.disableGarminLoginUntil(later);
  settings.disableGarminLoginUntil(later - 30_000);
  assert.equal(settings.getGarminLoginDisabledUntil(), later);
  assert.equal(settings.summary(999).garmin.loginDisabledUntil, later, 'applies to every athlete');
  assert.throws(() => garmin.assertLoginAllowed(), error => error.status === 429 && error.disabledUntil === later);
});

test('isRateLimited recognises Garmin throttling responses', () => {
  assert.equal(garmin.isRateLimited({ response: { status: 429 } }), true);
  assert.equal(garmin.isRateLimited(new Error('Request failed with status code 429')), true);
  assert.equal(garmin.isRateLimited(new Error('bad password')), false);
});

test('session store persists, expires and destroys sessions', async () => {
  const call = (method, ...args) => new Promise((resolve, reject) => {
    sessionStore[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
  await call('set', 'live', { athleteId: 3, cookie: { originalMaxAge: 60_000 } });
  assert.equal((await call('get', 'live')).athleteId, 3);

  await call('set', 'stale', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(await call('get', 'stale'), null);

  await call('destroy', 'live');
  assert.equal(await call('get', 'live'), null);
});
