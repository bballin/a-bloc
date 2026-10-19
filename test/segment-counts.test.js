const { cleanup } = require('./helpers/temp-db.cjs').useTempDatabase();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { updateDescription } = require('../src/segment-counts');

after(cleanup);

const DIVIDER = '-'.repeat(28);

test('appends a counts block to the description', () => {
  assert.equal(
    updateDescription('Nice ride', [{ name: 'Hill', count: 1 }, { name: 'Sprint', count: 4 }]),
    `Nice ride\n\n${DIVIDER}\nHill: 1 completion\nSprint: 4 completions`
  );
  assert.equal(updateDescription('', [{ name: 'Hill', count: 2 }]), `${DIVIDER}\nHill: 2 completions`);
});

test('replaces an existing block instead of stacking a new one', () => {
  const once = updateDescription('Nice ride', [{ name: 'Hill', count: 3 }]);
  const twice = updateDescription(once, [{ name: 'Hill', count: 4 }]);
  assert.equal(twice, `Nice ride\n\n${DIVIDER}\nHill: 4 completions`);
  assert.equal(updateDescription(twice, [{ name: 'Hill', count: 4 }]), twice, 'idempotent');
});

test('cleans up blocks already stacked by older versions', () => {
  const stacked = `Nice ride\n\n${DIVIDER}\nHill: 3 completions\n\n${DIVIDER}\nHill: 4 completions`;
  assert.equal(updateDescription(stacked, [{ name: 'Hill', count: 5 }]), `Nice ride\n\n${DIVIDER}\nHill: 5 completions`);
});

test('removes legacy blocks that had a closing divider and keeps text around them', () => {
  const legacy = `Before\n\n${DIVIDER}\nHill: 3 completions\n${DIVIDER}\n\nAfter`;
  assert.equal(updateDescription(legacy, [{ name: 'Hill', count: 4 }]), `Before\n\nAfter\n\n${DIVIDER}\nHill: 4 completions`);
});

test('leaves unrelated dividers alone', () => {
  const text = `Notes\n${DIVIDER}\nnot a count line`;
  assert.equal(updateDescription(text, [{ name: 'Hill', count: 1 }]), `${text}\n\n${DIVIDER}\nHill: 1 completion`);
});
