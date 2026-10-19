// Durable queue for Strava webhook work. Strava does not redeliver an event once
// it receives a 200, so events are persisted before responding and processed by
// an in-process worker. A job interrupted by a restart keeps its lease and is
// retried by the next process once the lease expires.

const DEFAULTS = {
  maxAttempts: 3,
  leaseMs: 5 * 60 * 1000,
  retryDelayMs: 60 * 1000,
  pollIntervalMs: 30 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
};

function createWebhookQueue({ db, handlers, logger = console, now = Date.now, ...options }) {
  const { maxAttempts, leaseMs, retryDelayMs, pollIntervalMs, retentionMs } = { ...DEFAULTS, ...options };
  const seconds = ms => Math.floor(ms / 1000);

  const enqueueStatement = db.prepare(`
    INSERT INTO webhook_jobs (kind, athlete_id, activity_id, status, run_after_ms, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(kind, athlete_id, activity_id) DO NOTHING
  `);
  const claimStatement = db.prepare(`
    UPDATE webhook_jobs
    SET status = 'running', attempts = attempts + 1, locked_until_ms = @lockedUntil, updated_at = @nowSeconds
    WHERE id = (
      SELECT id FROM webhook_jobs
      WHERE (status = 'pending' AND run_after_ms <= @now)
         OR (status = 'running' AND locked_until_ms <= @now AND attempts < @maxAttempts)
      ORDER BY id LIMIT 1
    )
    RETURNING *
  `);
  const abandonStatement = db.prepare(`
    UPDATE webhook_jobs
    SET status = 'failed', locked_until_ms = NULL, last_error = 'Interrupted by shutdown too many times', updated_at = @nowSeconds
    WHERE status = 'running' AND locked_until_ms <= @now AND attempts >= @maxAttempts
  `);
  const completeStatement = db.prepare(`
    UPDATE webhook_jobs SET status = 'done', locked_until_ms = NULL, last_error = NULL, updated_at = ? WHERE id = ?
  `);
  const failStatement = db.prepare(`
    UPDATE webhook_jobs
    SET status = @status, run_after_ms = @runAfter, locked_until_ms = NULL, last_error = @error, updated_at = @nowSeconds
    WHERE id = @id
  `);
  const pruneStatement = db.prepare(`
    DELETE FROM webhook_jobs WHERE status IN ('done', 'failed') AND updated_at < ?
  `);
  const countStatement = db.prepare(`SELECT status, COUNT(*) AS count FROM webhook_jobs GROUP BY status`);

  let stopped = true;
  let activeDrain = null;
  let pollTimer = null;
  let wakeRequested = false;

  function enqueue(kind, athleteId, activityId) {
    if (!handlers[kind]) throw new Error(`Unknown webhook job kind: ${kind}`);
    const time = now();
    return enqueueStatement.run(kind, athleteId, String(activityId), time, seconds(time), seconds(time)).changes > 0;
  }

  function claim() {
    const time = now();
    abandonStatement.run({ now: time, maxAttempts, nowSeconds: seconds(time) });
    return claimStatement.get({ now: time, lockedUntil: time + leaseMs, maxAttempts, nowSeconds: seconds(time) });
  }

  async function run(job) {
    const label = `[webhook-jobs] ${job.kind} activity ${job.activity_id} (attempt ${job.attempts}/${maxAttempts})`;
    try {
      await handlers[job.kind](job.athlete_id, job.activity_id, {
        attempt: job.attempts,
        maxAttempts,
        isFinalAttempt: job.attempts >= maxAttempts,
      });
      completeStatement.run(seconds(now()), job.id);
    } catch (error) {
      const message = (error && error.message) || String(error);
      const exhausted = job.attempts >= maxAttempts;
      failStatement.run({
        id: job.id,
        status: exhausted ? 'failed' : 'pending',
        runAfter: now() + retryDelayMs * job.attempts,
        error: message,
        nowSeconds: seconds(now()),
      });
      logger.error(`${label}: ${message}${exhausted ? ' (giving up)' : ' (will retry)'}`);
    }
  }

  async function drain() {
    while (!stopped) {
      wakeRequested = false;
      const job = claim();
      if (!job) return;
      await run(job);
    }
  }

  function kick() {
    if (stopped) return;
    wakeRequested = true;
    if (activeDrain) return;
    activeDrain = drain()
      .catch(error => logger.error('[webhook-jobs] Worker error:', error.message))
      .finally(() => {
        activeDrain = null;
        // A job enqueued after the last empty claim but before this point would otherwise wait for the next poll.
        if (wakeRequested) kick();
      });
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    pruneStatement.run(seconds(now() - retentionMs));
    pollTimer = setInterval(kick, pollIntervalMs);
    pollTimer.unref();
    kick();
  }

  // Stops claiming new jobs and resolves once the in-progress job (if any) finishes.
  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    return activeDrain || Promise.resolve();
  }

  function counts() {
    return Object.fromEntries(countStatement.all().map(row => [row.status, row.count]));
  }

  return {
    enqueue(kind, athleteId, activityId) {
      const added = enqueue(kind, athleteId, activityId);
      kick();
      return added;
    },
    start,
    stop,
    kick,
    counts,
    get busy() { return !!activeDrain; },
  };
}

module.exports = { createWebhookQueue };
