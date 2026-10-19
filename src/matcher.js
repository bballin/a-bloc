const mappings = require('./store/mappings');

/**
 * Given the sensors found in a FIT file, return the athlete's best gear mapping:
 * the matching mapping with the lowest priority number, tie-broken by the most
 * recently created mapping.
 */
function chooseGear(athleteId, sensors) {
  if (!sensors || !sensors.length) return null;
  return mappings.findBestMatch(athleteId, sensors.map(s => s.key));
}

module.exports = { chooseGear };
