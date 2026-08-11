const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidLocalScheduleError,
  assertLocalSchedulePageSize,
  resolveLocalScheduleDecision,
} = require('../dist/scheduler/localScheduler');

const MINUTE = 60_000;

function nextMinute(schedule, afterMs) {
  if (schedule.expression !== '* * * * *' || schedule.timezone !== 'UTC') {
    throw new Error('unsupported test schedule');
  }
  return Math.floor(afterMs / MINUTE + 1) * MINUTE;
}

function candidate(overrides = {}) {
  return {
    projectId: 'default',
    triggerId: 'trigger-1',
    triggerRevision: 1,
    triggerContentDigest: 'a'.repeat(64),
    triggerUpdatedAtMs: 1,
    taskId: 'task-1',
    taskRevision: 1,
    taskContentDigest: 'b'.repeat(64),
    expression: '* * * * *',
    timezone: 'UTC',
    misfirePolicy: 'skip',
    stateVersion: 0,
    nextFireAtMs: MINUTE,
    ...overrides,
  };
}

test('admits one on-time occurrence and advances beyond the observation', () => {
  assert.deepEqual(
    resolveLocalScheduleDecision(
      candidate(),
      MINUTE + 1_000,
      5_000,
      nextMinute,
    ),
    {
      candidate: candidate(),
      observedAtMs: MINUTE + 1_000,
      scheduledForMs: MINUTE,
      nextFireAtMs: 2 * MINUTE,
      disposition: 'admit',
    },
  );
});

test('applies skip and fire-once misfire without replaying a backlog', () => {
  const observedAtMs = 10 * MINUTE + 30_000;
  const skipped = resolveLocalScheduleDecision(
    candidate(),
    observedAtMs,
    5_000,
    nextMinute,
  );
  assert.equal(skipped.disposition, 'skip');
  assert.equal(skipped.nextFireAtMs, 11 * MINUTE);

  const admitted = resolveLocalScheduleDecision(
    candidate({ misfirePolicy: 'fire_once' }),
    observedAtMs,
    5_000,
    nextMinute,
  );
  assert.equal(admitted.disposition, 'admit');
  assert.equal(admitted.scheduledForMs, MINUTE);
  assert.equal(admitted.nextFireAtMs, 11 * MINUTE);
});

test('initializes migrated state without inventing a due occurrence', () => {
  const decision = resolveLocalScheduleDecision(
    candidate({ triggerUpdatedAtMs: 30_000, nextFireAtMs: null }),
    40_000,
    5_000,
    nextMinute,
  );
  assert.deepEqual(
    {
      disposition: decision.disposition,
      nextFireAtMs: decision.nextFireAtMs,
      scheduledForMs: decision.scheduledForMs,
    },
    {
      disposition: 'initialize',
      nextFireAtMs: MINUTE,
      scheduledForMs: undefined,
    },
  );
});

test('rejects widened candidates, invalid cron and unbounded pages', () => {
  assert.throws(
    () =>
      resolveLocalScheduleDecision(
        { ...candidate(), extra: true },
        MINUTE,
        0,
        nextMinute,
      ),
    InvalidLocalScheduleError,
  );
  assert.throws(
    () =>
      resolveLocalScheduleDecision(
        candidate({ expression: 'invalid cron' }),
        MINUTE,
        0,
        nextMinute,
      ),
    InvalidLocalScheduleError,
  );
  assert.throws(
    () =>
      resolveLocalScheduleDecision(
        candidate(),
        MINUTE,
        0,
        (_schedule, afterMs) => afterMs,
      ),
    InvalidLocalScheduleError,
  );
  assert.throws(() => assertLocalSchedulePageSize(257), RangeError);
});
