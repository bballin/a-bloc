const os = require('os');
const config = require('./config');
const db = require('./db');
const gearWebhook = require('./gear-webhook');
const segmentCounts = require('./segment-counts');
const { createWebhookQueue } = require('./webhook-queue');
const { createApp } = require('./app');

console.log(`Started. PID=${process.pid}`);
for (const warning of config.warnings) console.warn(`[warn] ${warning}`);

let shuttingDown = false;

const queue = createWebhookQueue({
  db,
  handlers: {
    async gear(athleteId, activityId, job) {
      const result = await gearWebhook.processActivity(athleteId, activityId, job);
      console.log(`[gear-webhook] Activity ${activityId}: ${result.status} - ${result.message}`);
    },
    segment_counts: (athleteId, activityId) => segmentCounts.processActivity(athleteId, activityId),
  },
});

const app = createApp({ queue, isShuttingDown: () => shuttingDown });

const server = app.listen(config.port, config.host, () => {
  console.log(`A Bloc listening on ${config.host}:${config.port}`);
  console.log(`  Local:   ${config.appBaseUrl}`);
  if (config.host === '0.0.0.0') {
    for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
      for (const ni of interfaces || []) {
        if (ni.family === 'IPv4' && !ni.internal) console.log(`  Network: http://${ni.address}:${config.port}  (${name})`);
      }
    }
  }
  console.log(`  OAuth callback (must match Strava app + APP_BASE_URL): ${config.oauthCallbackUrl}`);
  queue.start();
});

function waitForServerClose() {
  return new Promise(resolve => {
    server.close(error => {
      if (error) console.error('[error] Failed to close HTTP server cleanly:', error);
      resolve(!error);
    });
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    console.warn(`[warn] Received ${signal} again; exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[info] Received ${signal}; draining HTTP requests${queue.busy ? ' and the running webhook job' : ''}`);

  let timeout;
  const deadline = new Promise(resolve => { timeout = setTimeout(resolve, config.shutdownTimeoutMs, 'timeout'); });
  const drained = Promise.all([waitForServerClose(), queue.stop()])
    .then(([serverClosed]) => (serverClosed ? 'drained' : 'error'));
  const outcome = await Promise.race([drained, deadline]);
  clearTimeout(timeout);

  let exitCode = outcome === 'drained' ? 0 : 1;
  if (outcome === 'timeout') {
    // Unfinished webhook jobs stay in the database and are retried after their lease expires.
    console.warn(`[warn] Shutdown exceeded ${config.shutdownTimeoutMs}ms; forcing exit`);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }

  try {
    db.close();
    console.log('[info] Shutdown complete');
  } catch (error) {
    console.error('[error] Failed to close database cleanly:', error);
    exitCode = 1;
  }
  // Exit explicitly so lingering sockets or timers cannot outlive Railway's drain window.
  process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
