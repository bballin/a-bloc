// Lists recent activities from the connected original activity file sources
// (Garmin, Wahoo, Hammerhead, COROS) and downloads a chosen one's FIT file.
const settings = require('./settings');
const garmin = require('./garmin');
const wahoo = require('./wahoo');
const hammerhead = require('./hammerhead');
const coros = require('./coros');

const DEFAULT_LIMIT = 10;
const ID_PATTERN = /^[\w.:-]{1,200}$/;

const toIso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// Each list() resolves to [{ id, name, sport, startTime }]; `id` is everything download() needs.
const PROVIDERS = {
  garmin: {
    label: 'Garmin Connect',
    isConnected: athleteId => !!(settings.get(athleteId, 'garmin_username') && settings.get(athleteId, 'garmin_password')),
    async list(athleteId, limit) {
      const client = await garmin.getClient(athleteId);
      if (!client) throw new Error('Garmin is not configured.');
      return (await client.getActivities(0, limit) || []).map(a => ({
        id: String(a.activityId),
        name: a.activityName || null,
        sport: (a.activityType && a.activityType.typeKey) || null,
        startTime: toIso(garmin.parseGarminGmt(a.startTimeGMT) || garmin.parseGarminGmt(a.startTimeLocal)),
      }));
    },
    async download(athleteId, id) {
      if (!/^\d+$/.test(id)) throw new Error('Invalid Garmin activity ID.');
      const client = await garmin.getClient(athleteId);
      if (!client) throw new Error('Garmin is not configured.');
      return garmin.downloadOriginalFit(client, { activityId: id });
    },
  },
  wahoo: {
    label: 'Wahoo',
    isConnected: athleteId => wahoo.isAppConfigured() && wahoo.isConnected(athleteId),
    async list(athleteId, limit) {
      return (await wahoo.listWorkouts(athleteId, { perPage: limit })).map(w => ({
        id: String(w.id),
        name: w.name || null,
        sport: null,
        startTime: toIso(new Date(w.starts).getTime()),
      }));
    },
    download: (athleteId, id) => wahoo.downloadOriginalFit(athleteId, { id }),
  },
  hammerhead: {
    label: 'Hammerhead',
    isConnected: athleteId => hammerhead.isConfigured(athleteId),
    async list(athleteId, limit) {
      const client = await hammerhead.getClient(athleteId);
      return (await hammerhead.listActivities(client, { perPage: limit })).map(a => ({
        id: String(a.id),
        name: a.name || a.title || null,
        sport: a.activityType || a.sport || a.type || null,
        startTime: toIso(hammerhead.activityStartMs(a)),
      }));
    },
    async download(athleteId, id) {
      return hammerhead.downloadOriginalFit(await hammerhead.getClient(athleteId), { id });
    },
  },
  coros: {
    label: 'COROS',
    isConnected: athleteId => coros.isConfigured(athleteId),
    async list(athleteId, limit) {
      const client = await coros.getClient(athleteId);
      return (await coros.listActivities(client, { size: limit })).map(a => ({
        // The FIT export needs both the label and the sport type.
        id: `${a.labelId}:${a.sportType}`,
        name: a.name || null,
        sport: null,
        startTime: toIso(coros.activityStartMs(a)),
      }));
    },
    async download(athleteId, id) {
      const [labelId, sportType] = id.split(':');
      if (!labelId || !sportType) throw new Error('Invalid COROS activity ID.');
      return coros.downloadOriginalFit(await coros.getClient(athleteId), { labelId, sportType });
    },
  },
};

const SOURCES = Object.keys(PROVIDERS);

function connectedSources(athleteId, providers = PROVIDERS) {
  return Object.keys(providers).filter(src => providers[src].isConnected(athleteId));
}

/**
 * Fetch the most recent `limit` activities across every connected source,
 * newest first. Sources that fail are reported in `errors` without hiding the others.
 */
async function listRecent(athleteId, { limit = DEFAULT_LIMIT, providers = PROVIDERS } = {}) {
  const connected = connectedSources(athleteId, providers);
  const settled = await Promise.allSettled(connected.map(src => providers[src].list(athleteId, limit)));
  const activities = [];
  const errors = [];
  settled.forEach((outcome, i) => {
    const source = connected[i];
    const sourceLabel = providers[source].label;
    if (outcome.status === 'rejected') {
      errors.push({ source, sourceLabel, message: outcome.reason && outcome.reason.message ? outcome.reason.message : String(outcome.reason) });
      return;
    }
    for (const activity of outcome.value || []) activities.push({ ...activity, source, sourceLabel });
  });
  activities.sort((a, b) => (Date.parse(b.startTime) || 0) - (Date.parse(a.startTime) || 0));
  return { connected, activities: activities.slice(0, limit), errors };
}

class OriginalActivityError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OriginalActivityError';
    this.status = status;
  }
}

/** Download the FIT for one listed activity. Resolves to { fitPath, cleanup() }. */
async function downloadFit(athleteId, source, id, { providers = PROVIDERS } = {}) {
  const provider = Object.prototype.hasOwnProperty.call(providers, source) ? providers[source] : null;
  if (!provider) throw new OriginalActivityError(`Unknown activity source "${source}".`, 400);
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new OriginalActivityError('Invalid activity ID.', 400);
  if (!provider.isConnected(athleteId)) throw new OriginalActivityError(`${provider.label} is not connected.`, 400);
  return provider.download(athleteId, id);
}

module.exports = {
  DEFAULT_LIMIT,
  PROVIDERS,
  SOURCES,
  OriginalActivityError,
  connectedSources,
  listRecent,
  downloadFit,
};
