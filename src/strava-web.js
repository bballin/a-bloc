const fs = require('fs');
const path = require('path');
const os = require('os');
const { CookieJar } = require('tough-cookie');
const AdmZip = require('adm-zip');
const settings = require('./settings');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Build a session that has a valid `_strava4_session` cookie.
 *  - If a cookie is stored in settings, use it directly.
 *  - Otherwise, attempt an email/password login against Strava's web form.
 *    Strava sometimes uses Cloudflare/recaptcha; this can fail. When it does,
 *    the user must paste a session cookie via the settings UI.
 */
async function getSession(athleteId) {
  const cookie = settings.get(athleteId, 'strava_session_cookie');
  if (cookie) {
    return { cookieHeader: buildCookieHeader(cookie) };
  }
  const username = settings.get(athleteId, 'strava_username');
  const password = settings.get(athleteId, 'strava_password');
  if (!username || !password) {
    throw new Error('Strava-web is not configured (no session cookie and no credentials).');
  }
  const sessionCookie = await loginAndGetSessionCookie(username, password);
  // Cache it for later uses
  settings.set(athleteId, 'strava_session_cookie', sessionCookie);
  return { cookieHeader: buildCookieHeader(sessionCookie) };
}

function buildCookieHeader(sessionCookie) {
  // Accept either a bare value or a "name=value" pair
  if (sessionCookie.includes('=')) return sessionCookie;
  return `_strava4_session=${sessionCookie}`;
}

async function loginAndGetSessionCookie(email, password) {
  const jar = new CookieJar();

  // 1. Load login page to get authenticity_token + initial cookies
  const loginPage = await fetchWithJar(jar, 'https://www.strava.com/login', { method: 'GET' });
  const html = await loginPage.text();
  const tokenMatch = html.match(/name="authenticity_token"\s+value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not find authenticity_token on Strava login page (Cloudflare or layout change).');
  const authenticityToken = tokenMatch[1];

  // 2. POST credentials
  const form = new URLSearchParams();
  form.set('utf8', '✓');
  form.set('authenticity_token', authenticityToken);
  form.set('plan', '');
  form.set('email', email);
  form.set('password', password);

  const res = await fetchWithJar(jar, 'https://www.strava.com/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
  if (res.status >= 400) {
    throw new Error(`Strava login failed: HTTP ${res.status}`);
  }

  const cookies = await jar.getCookies('https://www.strava.com');
  const sess = cookies.find(c => c.key === '_strava4_session');
  if (!sess) {
    throw new Error('Strava login did not return a session cookie. You may need to paste one manually.');
  }
  return `_strava4_session=${sess.value}`;
}

async function fetchWithJar(jar, url, options = {}) {
  const cookieHeader = await jar.getCookieString(url);
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    ...(options.headers || {}),
  };
  if (cookieHeader) headers['Cookie'] = cookieHeader;
  const res = await fetch(url, { ...options, headers });
  const setCookies = res.headers.getSetCookie();
  for (const sc of setCookies) {
    try { await jar.setCookie(sc, url); } catch { /* ignore */ }
  }
  return res;
}

/**
 * Download the original ride file for a Strava activity. Returns
 * { fitPath, cleanup() }. If the export is a .zip (rare), unzips it.
 * Throws if the export is not a FIT (e.g. GPX-only manual upload).
 */
async function downloadOriginalFit(athleteId, activityId) {
  const session = await getSession(athleteId);
  const url = `https://www.strava.com/activities/${activityId}/export_original`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Cookie': session.cookieHeader,
      'Accept': '*/*',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Strava export_original failed: HTTP ${res.status} (cookie may be expired; re-paste it in Settings)`);
  }
  const cd = res.headers.get('content-disposition') || '';
  const nameMatch = cd.match(/filename="?([^";]+)"?/i);
  const filename = (nameMatch ? nameMatch[1] : `activity-${activityId}.bin`).trim();
  const ext = path.extname(filename).toLowerCase();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-sw-'));
  const filePath = path.join(tmpDir, filename);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);

  let fitPath = null;
  if (ext === '.fit') {
    fitPath = filePath;
  } else if (ext === '.zip' || ext === '.gz') {
    if (ext === '.zip') {
      const zip = new AdmZip(filePath);
      const entry = zip.getEntries().find(e => e.entryName.toLowerCase().endsWith('.fit'));
      if (entry) {
        fitPath = path.join(tmpDir, entry.entryName);
        zip.extractEntryTo(entry, tmpDir, false, true);
      }
    }
    // .gz: not handling for now; rare for "original"
  }
  if (!fitPath) {
    cleanupDir(tmpDir);
    throw new Error(`Original file is not a FIT (got "${filename}"). Sensor mapping requires a FIT-source activity.`);
  }
  return { fitPath, cleanup: () => cleanupDir(tmpDir) };
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = { downloadOriginalFit };
