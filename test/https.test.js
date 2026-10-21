const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
process.env.NODE_ENV = 'production';
process.env.APP_BASE_URL = 'https://abloc.example';
process.env.GARMIN_RELAY_URL = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../src/app');
let server;
let baseUrl;

before(async () => {
  const app = createApp({ queue: { enqueue() {} } });
  app.get('/test-session', (req, res) => {
    req.session.athleteId = 1;
    res.json({ ok: true });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  cleanup();
});

test('production redirects HTTP pages to the configured HTTPS origin, not the request host', async () => {
  const response = await fetch(`${baseUrl}/?tab=configuration`, {
    redirect: 'manual', headers: { Host: 'untrusted.example' },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://abloc.example/?tab=configuration');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('production rejects HTTP credential submissions without redirecting or saving them', async () => {
  const response = await fetch(`${baseUrl}/api/settings/garmin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test@example.com', password: 'not-a-real-password' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null);
  assert.match((await response.json()).error, /HTTPS is required/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('HTTPS behind the production proxy serves the page with HSTS and Secure sessions', async () => {
  const headers = { 'X-Forwarded-Proto': 'https' };
  const page = await fetch(`${baseUrl}/`, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Garmin Connect/);
  assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');
  const session = await fetch(`${baseUrl}/test-session`, { headers });
  assert.equal(session.status, 200);
  assert.match(session.headers.get('set-cookie'), /;\s*Secure/i);
  assert.match(session.headers.get('set-cookie'), /;\s*HttpOnly/i);
});

test('production refuses an HTTP public URL at startup', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, APP_BASE_URL: 'http://abloc.example' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_BASE_URL must be a public HTTPS URL/);
});
