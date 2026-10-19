// Helpers shared by the original-activity-file sources (Wahoo, Hammerhead, COROS).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const DEFAULT_MATCH_WINDOW_MS = 5 * 60 * 1000;

// FIT files carry ".FIT" at byte offset 8 of the file header.
function isFitBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 12 && buffer.toString('ascii', 8, 12) === '.FIT';
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function safeBaseName(name, fallback) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-]+/g, '_');
  return base && base !== '.' && base !== '..' ? base : fallback;
}

/**
 * Write a downloaded original activity file to a temp directory and return
 * { fitPath, cleanup() }. Accepts a raw FIT, a ZIP containing a FIT, or a
 * gzipped FIT. Throws if no FIT data is found.
 */
function saveFit(buffer, { filename = 'activity.fit', prefix = 'sgt-src-', label = 'Source' } = {}) {
  let fitBuffer = null;
  let fitName = safeBaseName(filename, 'activity.fit');

  if (isFitBuffer(buffer)) {
    fitBuffer = buffer;
  } else if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const inflated = zlib.gunzipSync(buffer);
    if (isFitBuffer(inflated)) {
      fitBuffer = inflated;
      fitName = fitName.replace(/\.gz$/i, '');
    }
  } else if (buffer.length >= 4 && buffer.toString('ascii', 0, 2) === 'PK') {
    const entry = new AdmZip(buffer).getEntries()
      .find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.fit'));
    if (entry) {
      fitBuffer = entry.getData();
      fitName = safeBaseName(entry.entryName, 'activity.fit');
    }
  }
  if (!fitBuffer) throw new Error(`${label} original file is not a FIT file (got "${fitName}").`);
  if (!fitName.toLowerCase().endsWith('.fit')) fitName += '.fit';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fitPath = path.join(tmpDir, fitName);
  fs.writeFileSync(fitPath, fitBuffer);
  return { fitPath, cleanup: () => cleanupDir(tmpDir) };
}

async function downloadFit(url, { headers = {}, label = 'Source', ...options } = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} FIT download failed: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const disposition = res.headers.get('content-disposition') || '';
  const nameMatch = disposition.match(/filename="?([^";]+)"?/i);
  const urlName = (() => { try { return path.basename(new URL(url).pathname); } catch { return ''; } })();
  return saveFit(buffer, { filename: (nameMatch && nameMatch[1]) || urlName || 'activity.fit', label, ...options });
}

/**
 * Return the item whose start time is closest to `startTime`, or null when
 * none fall within `windowMs`. `getStartMs` maps an item to epoch milliseconds.
 */
function closestByStartTime(items, getStartMs, startTime, windowMs = DEFAULT_MATCH_WINDOW_MS) {
  const target = new Date(startTime).getTime();
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const item of items || []) {
    const start = getStartMs(item);
    if (!Number.isFinite(start)) continue;
    const delta = Math.abs(start - target);
    if (delta <= windowMs && delta < bestDelta) {
      best = item;
      bestDelta = delta;
    }
  }
  return best;
}

module.exports = {
  DEFAULT_MATCH_WINDOW_MS,
  isFitBuffer,
  saveFit,
  downloadFit,
  closestByStartTime,
  cleanupDir,
};
