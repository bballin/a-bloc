// Decode the first coordinate of a Google encoded polyline (the format Strava uses for map.summary_polyline).
function decodeFirstPoint(encoded) {
  if (typeof encoded !== 'string' || !encoded) return null;
  let index = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  };
  const lat = next();
  const lng = next();
  if (lat == null || lng == null) return null;
  return [lat / 1e5, lng / 1e5];
}

module.exports = { decodeFirstPoint };
