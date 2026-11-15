const db = require('../db');

const deleteForAthleteStatement = db.prepare('DELETE FROM athlete_routes WHERE athlete_id = ?');
const upsertStatement = db.prepare(`
  INSERT INTO athlete_routes (
    athlete_id, route_id, name, description, type, sub_type, distance, elevation_gain,
    estimated_moving_time, private, starred, created_at, start_lat, start_lng
  ) VALUES (
    @athlete_id, @route_id, @name, @description, @type, @sub_type, @distance, @elevation_gain,
    @estimated_moving_time, @private, @starred, @created_at, @start_lat, @start_lng
  )
  ON CONFLICT(athlete_id, route_id) DO UPDATE SET
    name=excluded.name,
    description=excluded.description,
    type=excluded.type,
    sub_type=excluded.sub_type,
    distance=excluded.distance,
    elevation_gain=excluded.elevation_gain,
    estimated_moving_time=excluded.estimated_moving_time,
    private=excluded.private,
    starred=excluded.starred,
    created_at=excluded.created_at,
    start_lat=excluded.start_lat,
    start_lng=excluded.start_lng
`);
const idsStatement = db.prepare('SELECT route_id FROM athlete_routes WHERE athlete_id = ?');
const recordSyncStatement = db.prepare(`
  INSERT INTO athlete_route_syncs (athlete_id, synced_at) VALUES (?, ?)
  ON CONFLICT(athlete_id) DO UPDATE SET synced_at = excluded.synced_at
`);
const getSyncStatement = db.prepare('SELECT synced_at FROM athlete_route_syncs WHERE athlete_id = ?');
const listStatement = db.prepare(`
  SELECT * FROM athlete_routes WHERE athlete_id = ?
  ORDER BY created_at DESC, name COLLATE NOCASE
`);

function toRow(athleteId, route) {
  return {
    athlete_id: athleteId,
    route_id: String(route.id),
    name: route.name || String(route.id),
    description: route.description || '',
    type: route.type ?? null,
    sub_type: route.sub_type ?? null,
    distance: route.distance ?? null,
    elevation_gain: route.elevation_gain ?? null,
    estimated_moving_time: route.estimated_moving_time ?? null,
    private: route.private ? 1 : 0,
    starred: route.starred ? 1 : 0,
    created_at: route.created_at ?? null,
    start_lat: route.start_lat ?? null,
    start_lng: route.start_lng ?? null,
  };
}

function fromRow(row) {
  return {
    id: row.route_id,
    name: row.name,
    description: row.description || '',
    type: row.type,
    sub_type: row.sub_type,
    distance: row.distance,
    elevation_gain: row.elevation_gain,
    estimated_moving_time: row.estimated_moving_time,
    private: row.private === 1,
    starred: row.starred === 1,
    created_at: row.created_at,
    start_lat: row.start_lat,
    start_lng: row.start_lng,
  };
}

const recordSync = athleteId => recordSyncStatement.run(athleteId, Math.floor(Date.now() / 1000));

// Replaces the athlete's cached routes with a fresh list, so routes deleted on Strava disappear too.
const replaceForAthlete = db.transaction((athleteId, routes) => {
  deleteForAthleteStatement.run(athleteId);
  for (const route of routes) upsertStatement.run(toRow(athleteId, route));
  recordSync(athleteId);
});

// Adds or updates routes without removing any others.
const upsertForAthlete = db.transaction((athleteId, routes) => {
  for (const route of routes) upsertStatement.run(toRow(athleteId, route));
  recordSync(athleteId);
});

function idsForAthlete(athleteId) {
  return new Set(idsStatement.all(athleteId).map(row => row.route_id));
}

function listForAthlete(athleteId) {
  return listStatement.all(athleteId).map(fromRow);
}

// Unix seconds of the last successful sync, or null if routes were never fetched.
function syncedAt(athleteId) {
  const row = getSyncStatement.get(athleteId);
  return row ? row.synced_at : null;
}

module.exports = { replaceForAthlete, upsertForAthlete, idsForAthlete, listForAthlete, syncedAt };
