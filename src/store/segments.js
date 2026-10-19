const db = require('../db');

const upsertCacheStatement = db.prepare(`
  INSERT INTO segment_cache (
    segment_id, name, activity_type, distance, average_grade, total_elevation_gain,
    start_lat, start_lng, end_lat, end_lng, city, state, country, map_polyline, updated_at
  ) VALUES (
    @segment_id, @name, @activity_type, @distance, @average_grade, @total_elevation_gain,
    @start_lat, @start_lng, @end_lat, @end_lng, @city, @state, @country, @map_polyline, @updated_at
  )
  ON CONFLICT(segment_id) DO UPDATE SET
    name=excluded.name,
    activity_type=excluded.activity_type,
    distance=excluded.distance,
    average_grade=excluded.average_grade,
    total_elevation_gain=excluded.total_elevation_gain,
    start_lat=excluded.start_lat,
    start_lng=excluded.start_lng,
    end_lat=excluded.end_lat,
    end_lng=excluded.end_lng,
    city=excluded.city,
    state=excluded.state,
    country=excluded.country,
    map_polyline=excluded.map_polyline,
    updated_at=excluded.updated_at
`);
const getCachedStatement = db.prepare('SELECT * FROM segment_cache WHERE segment_id = ?');
const linkStatement = db.prepare(`
  INSERT INTO athlete_segments (athlete_id, segment_id, added_at) VALUES (?, ?, ?)
  ON CONFLICT(athlete_id, segment_id) DO NOTHING
`);
const listForAthleteStatement = db.prepare(`
  SELECT c.segment_id, c.name, c.activity_type, c.distance, c.average_grade, c.total_elevation_gain,
    c.start_lat, c.start_lng, c.end_lat, c.end_lng, c.city, c.state, c.country, c.updated_at
  FROM athlete_segments a JOIN segment_cache c ON c.segment_id = a.segment_id
  WHERE a.athlete_id = ? ORDER BY c.name COLLATE NOCASE, c.segment_id
`);
const isSavedStatement = db.prepare('SELECT 1 FROM athlete_segments WHERE athlete_id = ? AND segment_id = ?');
const unlinkStatement = db.prepare('DELETE FROM athlete_segments WHERE athlete_id = ? AND segment_id = ?');

const finiteOrNull = value => (Number.isFinite(value) ? value : null);

function toRow(segment) {
  const start = Array.isArray(segment.start_latlng) ? segment.start_latlng : [];
  const end = Array.isArray(segment.end_latlng) ? segment.end_latlng : [];
  return {
    segment_id: String(segment.id),
    name: segment.name || String(segment.id),
    activity_type: segment.activity_type || '',
    distance: segment.distance ?? null,
    average_grade: segment.average_grade ?? null,
    total_elevation_gain: segment.total_elevation_gain ?? null,
    start_lat: finiteOrNull(start[0]),
    start_lng: finiteOrNull(start[1]),
    end_lat: finiteOrNull(end[0]),
    end_lng: finiteOrNull(end[1]),
    city: segment.city || '',
    state: segment.state || '',
    country: segment.country || '',
    map_polyline: (segment.map && segment.map.polyline) || '',
    updated_at: Math.floor(Date.now() / 1000),
  };
}

// Returns the cached segment in the same shape as Strava's segment API response.
function fromRow(row) {
  return {
    id: row.segment_id,
    name: row.name,
    activity_type: row.activity_type,
    distance: row.distance,
    average_grade: row.average_grade,
    total_elevation_gain: row.total_elevation_gain,
    start_latlng: row.start_lat == null || row.start_lng == null ? null : [row.start_lat, row.start_lng],
    end_latlng: row.end_lat == null || row.end_lng == null ? null : [row.end_lat, row.end_lng],
    city: row.city,
    state: row.state,
    country: row.country,
    map: { polyline: row.map_polyline },
  };
}

function cache(segment) {
  upsertCacheStatement.run(toRow(segment));
}

function getCached(segmentId) {
  const row = getCachedStatement.get(String(segmentId));
  return row ? fromRow(row) : null;
}

// The segment must already be cached.
function addToAthlete(athleteId, segmentId) {
  linkStatement.run(athleteId, String(segmentId), Math.floor(Date.now() / 1000));
}

function listForAthlete(athleteId) {
  return listForAthleteStatement.all(athleteId);
}

function isSavedByAthlete(athleteId, segmentId) {
  return !!isSavedStatement.get(athleteId, String(segmentId));
}

function removeFromAthlete(athleteId, segmentId) {
  unlinkStatement.run(athleteId, String(segmentId));
}

module.exports = { cache, getCached, addToAthlete, listForAthlete, isSavedByAthlete, removeFromAthlete };
