const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate } = require('../src/migrations');
const { createWebhookQueue } = require('../src/webhook-queue');

function setup(handlers, options = {}) {
  const db = new Database(':memory:');
  migrate(db);
  const clock = { now: 1_000_000 };
  const logger = { error() {}, log() {} };
  const queue = createWebhookQueue({
    db, handlers, logger, now: () => clock.now, pollIntervalMs: 60_000, ...options,
  });
  const jobs = () => db.prepare('SELECT kind, activity_id, status, attempts, last_error FROM webhook_jobs ORDER BY id').all();
  return { db, queue, clock, jobs };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function idle(queue) {
  await settle();
  await queue.stop();
}

test('processes jobs and ignores duplicate deliveries', async () => {
  const seen = [];
  const { queue, jobs } = setup({ gear: async (athleteId, activityId) => { seen.push([athleteId, activityId]); } });
  queue.start();
  assert.equal(queue.enqueue('gear', 7, 42), true);
  assert.equal(queue.enqueue('gear', 7, 42), false);
  await idle(queue);
  assert.deepEqual(seen, [[7, '42']]);
  assert.deepEqual(jobs(), [{ kind: 'gear', activity_id: '42', status: 'done', attempts: 1, last_error: null }]);
});

test('retries failures with backoff, then gives up', async () => {
  let calls = 0;
  const { queue, clock, jobs } = setup({ gear: async () => { calls += 1; throw new Error('boom'); } }, { retryDelayMs: 1000 });
  queue.start();
  queue.enqueue('gear', 1, 1);
  await settle();
  assert.equal(jobs()[0].status, 'pending');

  queue.kick();
  await settle();
  assert.equal(calls, 1, 'not retried before the backoff elapses');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    clock.now += 10_000;
    queue.kick();
    await settle();
  }
  await idle(queue);
  assert.equal(calls, 3);
  assert.deepEqual(jobs()[0], { kind: 'gear', activity_id: '1', status: 'failed', attempts: 3, last_error: 'boom' });
});

test('a job interrupted by shutdown is retried after its lease expires', async () => {
  const { db, queue, clock, jobs } = setup({ gear: async () => {} }, { leaseMs: 5000 });
  const t = Math.floor(clock.now / 1000);
  db.prepare(`
    INSERT INTO webhook_jobs (kind, athlete_id, activity_id, status, attempts, run_after_ms, locked_until_ms, created_at, updated_at)
    VALUES ('gear', 1, '9', 'running', 1, 0, ?, ?, ?)
  `).run(clock.now + 5000, t, t);

  queue.start();
  await settle();
  assert.equal(jobs()[0].status, 'running', 'still leased by the previous process');

  clock.now += 6000;
  queue.kick();
  await idle(queue);
  assert.equal(jobs()[0].status, 'done');
});

test('stop() waits for the in-progress job and claims nothing new', async () => {
  let release;
  const order = [];
  const { queue, jobs } = setup({
    gear: (athleteId, activityId) => {
      order.push(activityId);
      return new Promise(resolve => { release = resolve; });
    },
  });
  queue.start();
  queue.enqueue('gear', 1, 1);
  queue.enqueue('gear', 1, 2);
  await settle();
  const stopped = queue.stop();
  let finished = false;
  stopped.then(() => { finished = true; });
  await settle();
  assert.equal(finished, false);
  release();
  await stopped;
  assert.deepEqual(order, ['1']);
  assert.deepEqual(jobs().map(job => job.status), ['done', 'pending']);
});
