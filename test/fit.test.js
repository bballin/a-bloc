const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractSensors } = require('../src/fit');

test('extracts start time, sport and de-duplicated sensors', () => {
  const result = extractSensors({
    sessions: [{ sport: 'cycling', start_time: '2026-05-01T10:00:00Z' }],
    device_infos: [
      { manufacturer: 'garmin', product_name: 'edge_840', serial_number: 3344 },
      { manufacturer: 'sram', device_type: 'bike_power', ant_device_number: 12345 },
      { manufacturer: 'sram', device_type: 'bike_power', ant_device_number: 12345 },
    ],
  });
  assert.equal(result.sport, 'cycling');
  assert.equal(result.startTime.toISOString(), '2026-05-01T10:00:00.000Z');
  assert.deepEqual(result.sensors.map(s => s.key), ['garmin:edge_840:3344', 'sram:bike_power:12345']);
  assert.equal(result.sensors[1].label, 'sram bike_power #12345');
});

test('falls back to the first record timestamp for start time', () => {
  const result = extractSensors({ records: [{ timestamp: '2026-05-01T08:00:00Z' }] });
  assert.equal(result.startTime.toISOString(), '2026-05-01T08:00:00.000Z');
  assert.deepEqual(result.sensors, []);
});
