const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { GarminConnect } = require('garmin-connect');
const settings = require('./settings');

/**
 * Returns a logged-in GarminConnect client for the athlete, or null if
 * Garmin is not configured. Reuses stored OAuth tokens when possible.
 */
async function getClient(athleteId) {
  const username = settings.get(athleteId, 'garmin_username');
  const password = settings.get(athleteId, 'garmin_password');
  if (!username || !password) return null;

  const client = new GarminConnect({ username, password });

  const oauth1Raw = settings.get(athleteId, 'garmin_oauth1');
  const oauth2Raw = settings.get(athleteId, 'garmin_oauth2');
  let restored = false;
  if (oauth1Raw && oauth2Raw) {
    try {
      client.loadToken(JSON.parse(oauth1Raw), JSON.parse(oauth2Raw));
      // Smoke-test the token
      await client.getUserProfile();
      restored = true;
    } catch (e) {
      restored = false;
    }
  }
  if (!restored) {
    await client.login();
    try {
      const o1 = client.client && client.client.oauth1Token;
      const o2 = client.client && client.client.oauth2Token;
      if (o1) settings.set(athleteId, 'garmin_oauth1', JSON.stringify(o1));
      if (o2) settings.set(athleteId, 'garmin_oauth2', JSON.stringify(o2));
    } catch { /* ignore */ }
  }
  return client;
}

/**
 * Find the Garmin activity whose startTimeLocal/startTimeGMT is within
 * `windowMs` of `startTime`. Searches the most recent `limit` activities.
 */
// Garmin returns startTimeGMT like "2024-05-08 14:14:00" (UTC, but no zone marker).
// JS Date() would parse that as local time. Normalize to ISO-UTC.
function parseGarminGmt(s) {
  if (!s) return NaN;
  // Already has timezone info?
  if (/[zZ]|[+\-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

async function findActivityByStartTime(client, startTime, { limit = 30, windowMs = 5 * 60 * 1000 } = {}) {
  const activities = await client.getActivities(0, limit);
  const target = new Date(startTime).getTime();
  return activities.find(a => {
    const t = parseGarminGmt(a.startTimeGMT) || parseGarminGmt(a.startTimeLocal) || 0;
    return Math.abs(t - target) <= windowMs;
  }) || null;
}

/**
 * Download the original activity (FIT) for the given Garmin activity.
 * Returns { fitPath, cleanup() } where fitPath is a real .fit file on disk.
 *
 * Garmin's "original" download is a zip; we extract the first .fit inside.
 */
async function downloadOriginalFit(client, activity) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-gc-'));
  await client.downloadOriginalActivityData(activity, tmpDir);

  const files = fs.readdirSync(tmpDir).map(f => path.join(tmpDir, f));
  let fitPath = files.find(f => f.toLowerCase().endsWith('.fit'));
  if (!fitPath) {
    const zipPath = files.find(f => f.toLowerCase().endsWith('.zip'));
    if (!zipPath) {
      cleanupDir(tmpDir);
      throw new Error(`Garmin original download did not contain a FIT or ZIP. Got: ${files.map(f => path.basename(f)).join(', ')}`);
    }
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    const fitEntry = entries.find(e => e.entryName.toLowerCase().endsWith('.fit'));
    if (!fitEntry) {
      cleanupDir(tmpDir);
      throw new Error(`Garmin original zip did not contain a .fit file. Entries: ${entries.map(e => e.entryName).join(', ')}`);
    }
    fitPath = path.join(tmpDir, fitEntry.entryName);
    zip.extractEntryTo(fitEntry, tmpDir, false, true);
  }

  return {
    fitPath,
    cleanup: () => cleanupDir(tmpDir),
  };
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

module.exports = { getClient, findActivityByStartTime, downloadOriginalFit };
