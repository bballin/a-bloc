const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const settings = require('../src/settings');
const originals = require('../src/original-activities');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
after(cleanup);

const FIT = Buffer.concat([Buffer.from([14, 0x10, 0, 0, 2, 0, 0, 0]), Buffer.from('.FIT'), Buffer.from([0, 0, 1, 2])]);
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

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

const hour = n => new Date(Date.UTC(2026, 9, 18, n)).toISOString();

function fakeProvider(label, { connected = true, items = [], error = null } = {}) {
  return {
    label,
    isConnected: () => connected,
    async list(athleteId, limit) {
      if (error) throw new Error(error);
      return items.slice(0, limit);
    },
    async download(athleteId, id) { return { id }; },
  };
}

test('listRecent reports no connections when no source is configured', async () => {
  const providers = { garmin: fakeProvider('Garmin', { connected: false }) };
  assert.deepEqual(await originals.listRecent(1, { providers }), { connected: [], activities: [], errors: [] });
  assert.deepEqual(originals.connectedSources(999), [], 'real providers are not connected for a new athlete');
});

test('listRecent merges connected sources newest first, keeps 10 and reports failures', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, name: `Ride ${i}`, sport: 'cycling', startTime: hour(11 - i) }));
  const providers = {
    garmin: fakeProvider('Garmin Connect', { items: many }),
    wahoo: fakeProvider('Wahoo', { items: [{ id: 'w1', name: 'Latest', sport: null, startTime: hour(23) }] }),
    hammerhead: fakeProvider('Hammerhead', { error: 'HTTP 500' }),
    coros: fakeProvider('COROS', { connected: false, items: [{ id: 'c1', startTime: hour(22) }] }),
  };
  const r = await originals.listRecent(1, { providers });
  assert.deepEqual(r.connected, ['garmin', 'wahoo', 'hammerhead']);
  assert.equal(r.activities.length, 10);
  assert.deepEqual(r.activities.slice(0, 2).map(a => [a.id, a.source, a.sourceLabel]), [
    ['w1', 'wahoo', 'Wahoo'],
    ['g0', 'garmin', 'Garmin Connect'],
  ]);
  assert.equal(r.activities[9].id, 'g8');
  assert.deepEqual(r.errors, [{ source: 'hammerhead', sourceLabel: 'Hammerhead', message: 'HTTP 500' }]);
});

test('downloadFit validates the source, ID and connection', async () => {
  const providers = { garmin: fakeProvider('Garmin Connect'), wahoo: fakeProvider('Wahoo', { connected: false }) };
  assert.deepEqual(await originals.downloadFit(1, 'garmin', '123', { providers }), { id: '123' });
  for (const [source, id, message] of [
    ['strava', '1', /Unknown activity source/],
    ['toString', '1', /Unknown activity source/],
    ['garmin', '../etc', /Invalid activity ID/],
    ['garmin', '', /Invalid activity ID/],
    ['wahoo', '1', /Wahoo is not connected/],
  ]) {
    await assert.rejects(originals.downloadFit(1, source, id, { providers }), error => {
      assert.equal(error.status, 400);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('COROS activities are listed with a label:sportType ID that downloads the FIT export', async () => {
  settings.set(20, 'coros_username', 'rider@example.com');
  settings.set(20, 'coros_password', 'secret');
  const startSeconds = Date.UTC(2026, 9, 18, 15) / 1000;
  const calls = mockFetch([
    [/\/account\/login/, () => json({ result: '0000', data: { accessToken: 'tok', userId: 42, regionId: 1 } })],
    [/\/activity\/query/, () => json({ result: '0000', data: { dataList: [
      { labelId: '987', sportType: 200, name: 'Morning Ride', startTime: startSeconds },
    ] } })],
    [/\/activity\/detail\/download/, () => json({ result: '0000', data: { fileUrl: 'https://cdn.example/987.fit' } })],
    [/cdn\.example/, () => new Response(FIT)],
  ]);

  const r = await originals.listRecent(20);
  assert.deepEqual(r.connected, ['coros']);
  assert.deepEqual(r.activities, [{
    id: '987:200', name: 'Morning Ride', sport: null, startTime: hour(15), source: 'coros', sourceLabel: 'COROS',
  }]);
  assert.match(calls.find(c => c.url.includes('/activity/query')).url, /size=10/);

  const fetched = await originals.downloadFit(20, 'coros', '987:200');
  assert.deepEqual(fs.readFileSync(fetched.fitPath), FIT);
  fetched.cleanup();
  const download = new URL(calls.find(c => c.url.includes('/detail/download')).url);
  assert.equal(download.searchParams.get('labelId'), '987');
  assert.equal(download.searchParams.get('sportType'), '200');
});
