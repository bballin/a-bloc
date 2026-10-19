const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
process.env.WAHOO_CLIENT_ID = 'wahoo-client';
process.env.WAHOO_CLIENT_SECRET = 'wahoo-secret';
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const settings = require('../src/settings');
const originalFile = require('../src/original-file');
const coros = require('../src/coros');
const hammerhead = require('../src/hammerhead');
const wahoo = require('../src/wahoo');
const sync = require('../src/sync');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
after(cleanup);

// Minimal 14-byte FIT header followed by a couple of bytes; enough for detection.
const FIT = Buffer.concat([Buffer.from([14, 0x10, 0, 0, 2, 0, 0, 0]), Buffer.from('.FIT'), Buffer.from([0, 0, 1, 2])]);
const START = '2026-10-18T15:00:00Z';
const START_MS = Date.parse(START);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [pattern, handler] of routes) {
      if (pattern.test(String(url))) return handler(String(url), options);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  return calls;
}

function readAndCleanup(fetched) {
  const data = fs.readFileSync(fetched.fitPath);
  fetched.cleanup();
  assert.equal(fs.existsSync(fetched.fitPath), false, 'cleanup removes the temp file');
  return data;
}

test('saveFit accepts raw, zipped and gzipped FIT data and rejects other files', () => {
  assert.deepEqual(readAndCleanup(originalFile.saveFit(FIT, { filename: 'a.fit' })), FIT);

  const zip = new AdmZip();
  zip.addFile('nested/ride.fit', FIT);
  assert.deepEqual(readAndCleanup(originalFile.saveFit(zip.toBuffer(), { filename: 'a.zip' })), FIT);

  assert.deepEqual(readAndCleanup(originalFile.saveFit(zlib.gzipSync(FIT), { filename: 'a.fit.gz' })), FIT);

  assert.throws(() => originalFile.saveFit(Buffer.from('<gpx></gpx>'), { filename: '../x.gpx', label: 'Test' }), /Test original file is not a FIT/);
});

test('closestByStartTime picks the nearest activity inside the window', () => {
  const items = [{ id: 'far', t: START_MS + 10 * 60_000 }, { id: 'near', t: START_MS + 30_000 }, { id: 'nearer', t: START_MS - 10_000 }];
  assert.equal(originalFile.closestByStartTime(items, i => i.t, START).id, 'nearer');
  assert.equal(originalFile.closestByStartTime(items.slice(0, 1), i => i.t, START), null);
  assert.equal(originalFile.closestByStartTime(items, i => i.t, 'not a date'), null);
});

test('COROS logs in with an MD5 password, uses the regional host and downloads the FIT export', async () => {
  settings.set(10, 'coros_username', 'rider@example.com');
  settings.set(10, 'coros_password', 'secret');
  const calls = mockFetch([
    [/teamapi\.coros\.com\/account\/login/, () => json({ result: '0000', data: { accessToken: 'tok', userId: 42, regionId: 3 } })],
    [/teameuapi\.coros\.com\/activity\/query/, () => json({ result: '0000', data: { dataList: [
      { labelId: 'other', sportType: 200, startTime: START_MS / 1000 - 3600 },
      { labelId: 'ride', sportType: 200, startTime: START_MS / 1000 + 20 },
    ] } })],
    [/teameuapi\.coros\.com\/activity\/detail\/download/, () => json({ result: '0000', data: { fileUrl: 'https://cdn.example/ride.fit' } })],
    [/cdn\.example/, () => new Response(FIT)],
  ]);

  assert.equal(coros.isConfigured(10), true);
  const client = await coros.getClient(10);
  const match = await coros.findActivityByStartTime(client, START);
  assert.equal(match.labelId, 'ride');
  assert.deepEqual(readAndCleanup(await coros.downloadOriginalFit(client, match)), FIT);

  const login = JSON.parse(calls[0].options.body);
  assert.deepEqual(login, { account: 'rider@example.com', accountType: 2, pwd: crypto.createHash('md5').update('secret').digest('hex') });
  const query = calls.find(c => c.url.includes('/activity/query'));
  assert.equal(query.options.headers.accesstoken, 'tok');
  assert.equal(query.options.headers.yfheader, JSON.stringify({ userId: '42' }));
  const download = new URL(calls.find(c => c.url.includes('/detail/download')).url);
  assert.equal(download.searchParams.get('fileType'), '4');
  assert.equal(download.searchParams.get('labelId'), 'ride');
  assert.equal(JSON.parse(settings.get(10, 'coros_token')).regionId, 3, 'token is cached');
});

test('COROS re-logs in once when a cached token is rejected', async () => {
  settings.set(10, 'coros_token', JSON.stringify({ accessToken: 'stale', userId: '42', regionId: 1 }));
  let queries = 0;
  const calls = mockFetch([
    [/\/account\/login/, () => json({ result: '0000', data: { accessToken: 'fresh', userId: 42, regionId: 1 } })],
    [/\/activity\/query/, (url, options) => {
      queries += 1;
      return options.headers.accesstoken === 'fresh'
        ? json({ result: '0000', data: { dataList: [] } })
        : json({ result: '1019', message: 'access token invalid' });
    }],
  ]);
  const client = await coros.getClient(10);
  assert.equal(await coros.findActivityByStartTime(client, START), null);
  assert.equal(queries, 2);
  assert.equal(calls.filter(c => c.url.includes('/account/login')).length, 1);
});

test('Hammerhead uses the password grant, reads the user from the JWT and downloads the FIT', async () => {
  settings.set(11, 'hammerhead_username', 'karoo@example.com');
  settings.set(11, 'hammerhead_password', 'pw');
  const jwt = `x.${Buffer.from(JSON.stringify({ sub: '194067', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.y`;
  const calls = mockFetch([
    [/\/v1\/auth\/token$/, () => json({ access_token: jwt, refresh_token: 'refresh' })],
    [/\/v1\/users\/194067\/activities\?/, () => json({ data: [
      { id: '194067.activity.a', createdAt: new Date(START_MS - 2 * 3600_000).toISOString() },
      { id: '194067.activity.b', startTime: new Date(START_MS + 1000).toISOString() },
    ], totalPages: 1 })],
    [/\/activities\/194067\.activity\.b\/file\?format=fit/, () => new Response(FIT)],
  ]);

  const client = await hammerhead.getClient(11);
  const match = await hammerhead.findActivityByStartTime(client, START);
  assert.equal(match.id, '194067.activity.b');
  assert.deepEqual(readAndCleanup(await hammerhead.downloadOriginalFit(client, match)), FIT);

  const form = new URLSearchParams(calls[0].options.body);
  assert.equal(form.get('grant_type'), 'password');
  assert.equal(form.get('username'), 'karoo@example.com');
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${jwt}`);
  assert.equal(JSON.parse(settings.get(11, 'hammerhead_token')).userId, '194067');
});

test('Wahoo refreshes an expired token, matches a workout and downloads its summary FIT', async () => {
  settings.set(12, 'wahoo_access_token', 'old');
  settings.set(12, 'wahoo_refresh_token', 'refresh-1');
  settings.set(12, 'wahoo_token_expires_at', String(Math.floor(Date.now() / 1000) - 10));
  const calls = mockFetch([
    [/api\.wahooligan\.com\/oauth\/token/, () => json({ access_token: 'new', refresh_token: 'refresh-2', expires_in: 7200 })],
    [/api\.wahooligan\.com\/v1\/workouts\?/, () => json({ workouts: [
      { id: 1, starts: new Date(START_MS + 90_000).toISOString(), workout_summary: { file: { url: 'https://cdn.wahooligan.com/1.fit' } } },
    ] })],
    [/cdn\.wahooligan\.com/, () => new Response(FIT)],
  ]);

  const match = await wahoo.findWorkoutByStartTime(12, START);
  assert.equal(match.id, 1);
  assert.deepEqual(readAndCleanup(await wahoo.downloadOriginalFit(12, match)), FIT);

  const refresh = new URLSearchParams(calls[0].options.body);
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('refresh_token'), 'refresh-1');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer new');
  assert.equal(settings.get(12, 'wahoo_refresh_token'), 'refresh-2', 'rotated refresh token is saved');
  assert.equal(calls[2].options.headers.Authorization, undefined, 'CDN download is unauthenticated');
});

test('Wahoo authorize URL carries the state, callback and read scopes', () => {
  const url = new URL(wahoo.authorizeUrl('abc'));
  assert.equal(url.origin, 'https://api.wahooligan.com');
  assert.equal(url.searchParams.get('state'), 'abc');
  assert.equal(url.searchParams.get('client_id'), 'wahoo-client');
  assert.match(url.searchParams.get('redirect_uri'), /\/auth\/wahoo\/callback$/);
  assert.match(url.searchParams.get('scope'), /workouts_read/);
});

test('fetchOriginalFit checks each configured source, starting with the recording device', async () => {
  const tried = [];
  const provider = (name, { configured = true, result = null, error = null } = {}) => ({
    isConfigured: () => configured,
    async fetch() {
      tried.push(name);
      if (error) throw new Error(error);
      return result;
    },
  });
  const found = { fitPath: 'x.fit', cleanup() {} };
  const providers = {
    garmin: provider('garmin'),
    wahoo: provider('wahoo', { configured: false }),
    hammerhead: provider('hammerhead'),
    coros: provider('coros', { result: found }),
    strava_web: provider('strava_web', { configured: false }),
  };
  const activity = { id: 1, start_date: START, device_name: 'COROS DURA' };

  const out = await sync.fetchOriginalFit(1, activity, sync.SOURCES, { providers });
  assert.equal(out.source, 'coros');
  assert.deepEqual(tried, ['coros'], 'the device hint is tried first');

  tried.length = 0;
  const viaFallback = await sync.fetchOriginalFit(1, { ...activity, device_name: 'Zwift' }, sync.SOURCES, { providers });
  assert.equal(viaFallback.source, 'coros');
  assert.deepEqual(tried, ['garmin', 'hammerhead', 'coros'], 'unconfigured sources are skipped');

  providers.coros = provider('coros');
  const noMatch = await sync.fetchOriginalFit(1, activity, sync.SOURCES, { providers }).catch(e => e);
  assert.equal(noMatch.noMatchOnly, true);
  assert.match(noMatch.message, /coros: no matching activity/);

  providers.garmin = provider('garmin', { error: 'boom' });
  const failed = await sync.fetchOriginalFit(1, activity, sync.SOURCES, { providers }).catch(e => e);
  assert.equal(failed.noMatchOnly, false);
  assert.match(failed.message, /garmin: boom/);

  const none = await sync.fetchOriginalFit(1, activity, sync.SOURCES, { providers: {} }).catch(e => e);
  assert.match(none.message, /unknown source/);
});

test('webhook processing retries when no source has the activity yet, then records no_fit', async () => {
  const providers = { garmin: { isConfigured: () => true, fetch: async () => null } };
  const activity = { id: 99, start_date: START };
  await assert.rejects(
    sync.processActivity(1, activity, { force: true, retryNoMatch: true, sources: ['garmin'], providers }),
    error => error.retryable === true
  );
  const result = await sync.processActivity(1, activity, { force: true, sources: ['garmin'], providers });
  assert.equal(result.status, 'no_fit');
});

test('provider credentials and tokens are encrypted at rest', () => {
  const raw = key => require('../src/db').prepare('SELECT value FROM settings WHERE athlete_id = ? AND key = ?').get(10, key).value;
  settings.set(10, 'coros_password', 'secret');
  assert.notEqual(raw('coros_password'), 'secret');
  assert.ok(!raw('coros_token').includes('accessToken'));
  const summary = settings.summary(10);
  assert.deepEqual(summary.coros, { hasUsername: true, hasPassword: true, hasToken: true });
  assert.equal(summary.wahoo.appConfigured, true);
});
