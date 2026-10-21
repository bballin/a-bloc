const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createUi() {
  const elements = new Map();
  const controls = [{}, {}, {}];
  const element = selector => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        classList: { toggle() {} },
        querySelectorAll: () => controls,
      });
    }
    return elements.get(selector);
  };
  const timers = [];
  const context = vm.createContext({
    document: { querySelector: element },
    console: { error() {} },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  vm.runInContext(source.slice(0, source.lastIndexOf('init().catch(')), context);
  return {
    element, controls, timers, context,
    setStatus(status) { context.api = async () => status; },
    signIn() { vm.runInContext('signedIn = true', context); },
    load() { return vm.runInContext('loadGarminLoginStatus()', context); },
  };
}

test('Garmin configuration disables during a relay outage and recovers automatically', async () => {
  const ui = createUi();
  ui.signIn();
  ui.setStatus({ relayConfigured: true, relayAvailable: false, loginDisabledUntil: null });
  await ui.load();
  assert.match(ui.element('#garminRelayStatus').textContent, /configuration is temporarily offline/);
  assert.ok(ui.controls.every(control => control.disabled));
  assert.equal(ui.element('#garminTest').disabled, true);
  assert.equal(ui.timers.at(-1).delay, 30_000);

  ui.setStatus({ relayConfigured: true, relayAvailable: true, loginDisabledUntil: null });
  await ui.timers.at(-1).callback();
  assert.equal(ui.element('#garminRelayStatus').textContent, 'Garmin relay is online.');
  assert.ok(ui.controls.every(control => !control.disabled));
  assert.equal(ui.element('#garminTest').disabled, false);
});

test('health check failures are visible and recovery never enables signed-out controls', async () => {
  const ui = createUi();
  ui.context.api = async () => { throw new Error('Network unavailable'); };
  await ui.load();
  assert.match(ui.element('#garminRelayStatus').textContent, /Unable to check/);
  assert.ok(ui.controls.every(control => control.disabled));
  ui.setStatus({ relayConfigured: false, relayAvailable: null, loginDisabledUntil: null });
  await ui.load();
  assert.match(ui.element('#garminRelayStatus').textContent, /direct connection/);
  assert.ok(ui.controls.every(control => control.disabled));
  assert.equal(ui.element('#garminTest').disabled, true);
});

test('an online but paused relay keeps Test login disabled', async () => {
  const ui = createUi();
  ui.signIn();
  ui.setStatus({ relayConfigured: true, relayAvailable: true, loginDisabledUntil: Date.now() + 60_000 });
  await ui.load();
  assert.match(ui.element('#garminPauseWarning').textContent, /temporarily disabled/);
  assert.equal(ui.element('#garminTest').disabled, true);
});
