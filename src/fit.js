const fs = require('fs');
const FitParser = require('fit-file-parser').default;

/**
 * Parse a FIT file and extract:
 *   - sensors: list of unique sensor identifiers ({ key, label, manufacturer, product, antDeviceNumber, deviceType })
 *   - startTime: activity start time (Date)
 *   - sport: sport string if present
 *
 * Sensor "key" is a stable, human-meaningful string used for mapping. We prefer
 * `${manufacturer}:${product}:${ant_device_number}` when available, falling back
 * to whatever identifying info we have.
 */
function parseFit(filePath) {
  return new Promise((resolve, reject) => {
    const buf = fs.readFileSync(filePath);
    const parser = new FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'km',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'list',
    });
    parser.parse(buf, (error, data) => {
      if (error) return reject(error);
      try {
        resolve(extractSensors(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function extractSensors(data) {
  const result = {
    sensors: [],
    startTime: null,
    sport: null,
    raw: { deviceInfoCount: 0 },
  };

  // Sport
  const sessions = data.sessions || (data.session ? [data.session] : []);
  if (sessions.length) {
    result.sport = sessions[0].sport || null;
    if (sessions[0].start_time) result.startTime = new Date(sessions[0].start_time);
  }
  if (!result.startTime && data.activity && data.activity.timestamp) {
    result.startTime = new Date(data.activity.timestamp);
  }
  if (!result.startTime && Array.isArray(data.records) && data.records.length) {
    result.startTime = new Date(data.records[0].timestamp);
  }

  // Device infos
  const deviceInfos = data.device_infos || data.devices || [];
  result.raw.deviceInfoCount = deviceInfos.length;
  const seen = new Map();
  for (const d of deviceInfos) {
    const manufacturer = d.manufacturer || d.manufacturer_name || 'unknown';
    const product = d.product_name || d.garmin_product || d.product || '';
    const ant = d.ant_device_number || d.serial_number || '';
    const deviceType = d.device_type || d.antplus_device_type || d.source_type || '';

    // Skip the head unit / "creator" device — we want sensors, but also keep
    // the head unit as a possible mapping key (some users may want to map by it).
    const key = `${manufacturer}:${product || deviceType || 'device'}:${ant || ''}`.toLowerCase();
    if (seen.has(key)) continue;

    const label = [
      manufacturer,
      product || deviceType,
      ant ? `#${ant}` : null,
    ].filter(Boolean).join(' ');

    seen.set(key, {
      key,
      label,
      manufacturer: String(manufacturer),
      product: String(product || ''),
      antDeviceNumber: ant ? String(ant) : '',
      deviceType: String(deviceType || ''),
    });
  }
  result.sensors = [...seen.values()];
  return result;
}

module.exports = { parseFit, extractSensors };
