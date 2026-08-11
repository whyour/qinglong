'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterRunLostRetryCoordinator,
  ClusterRunLostRetryUnavailableError,
  buildClusterRunLostRetryTransition,
  normalizeClusterRunLostRetryPageCommand,
  normalizeClusterRunLostRetryPageResult,
} = require('../dist/run/clusterRunLostRetry');

function lostRun(status = 'lost') {
  return {
    id: 'run-1',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status,
    version: 4,
    eventSequence: 4,
    priority: 0,
    createdAtMs: 100,
    queuedAtMs: 110,
    startedAtMs: 150,
    errorCode: 'CLUSTER_RECOVERY_EXECUTION_NOT_RUNNING',
    errorSummary: 'lost',
  };
}

function lostAttempt(attempt = 1) {
  return {
    id: `attempt-${attempt}`,
    runId: 'run-1',
    attempt,
    status: 'lost',
    executorType: 'remote_worker',
    callbackSequence: 0,
    createdAtMs: 120,
    startedAtMs: 150,
    finishedAtMs: 200,
    errorCode: 'CLUSTER_RECOVERY_EXECUTION_NOT_RUNNING',
    errorSummary: 'lost',
  };
}

function policy(overrides = {}) {
  return {
    runId: 'run-1',
    maxAttempts: 3,
    retryOnLost: true,
    safety: 'idempotent',
    backoffBaseMs: 1_000,
    backoffMaxMs: 8_000,
    version: 0,
    createdAtMs: 100,
    updatedAtMs: 100,
    ...overrides,
  };
}

test('schedules a safe lost Run from its admitted immutable policy', () => {
  const result = buildClusterRunLostRetryTransition({
    run: lostRun(),
    attempt: lostAttempt(),
    policy: policy(),
    observedAtMs: 300,
    runEventId: 'event-1',
  });

  assert.equal(result.disposition, 'scheduled');
  assert.equal(result.runTransitions.length, 1);
  assert.equal(result.runTransitions[0].status, 'retry_wait');
  assert.equal(result.runTransitions[0].version, 5);
  assert.equal(result.policy.nextAttemptAtMs, 1_200);
  assert.equal(result.policy.version, 1);
  assert.deepEqual(
    result.events.map((event) => [event.type, event.sequence]),
    [['run.retry_wait', 5]],
  );
});

test('requeues a due retry_wait Run with one fresh unleased Attempt', () => {
  const result = buildClusterRunLostRetryTransition({
    run: lostRun('retry_wait'),
    attempt: lostAttempt(),
    policy: policy({ nextAttemptAtMs: 250 }),
    observedAtMs: 300,
    runEventId: 'event-queued',
    attemptId: 'attempt-2',
    attemptEventId: 'event-claimed',
  });

  assert.equal(result.disposition, 'requeued');
  assert.deepEqual(
    result.runTransitions.map((run) => [run.status, run.version]),
    [
      ['queued', 5],
      ['queued', 6],
    ],
  );
  assert.deepEqual(result.attempt, {
    id: 'attempt-2',
    runId: 'run-1',
    attempt: 2,
    status: 'claimed',
    executorType: 'remote_worker',
    callbackSequence: 0,
    createdAtMs: 300,
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.policy, 'nextAttemptAtMs'),
    false,
  );
  assert.deepEqual(
    result.events.map((event) => [event.type, event.sequence]),
    [
      ['run.queued', 5],
      ['attempt.claimed', 6],
    ],
  );
});

test('terminalizes disabled, unsafe and exhausted policies without retrying', () => {
  const cases = [
    [null, lostAttempt(), 'failed_disabled', 'RUN_LOST_RETRY_DISABLED'],
    [
      policy({ safety: 'unknown' }),
      lostAttempt(),
      'failed_unsafe',
      'RUN_LOST_RETRY_UNSAFE',
    ],
    [
      policy({ maxAttempts: 3 }),
      lostAttempt(3),
      'failed_exhausted',
      'RUN_LOST_RETRY_EXHAUSTED',
    ],
  ];
  for (const [admittedPolicy, attempt, disposition, errorCode] of cases) {
    const result = buildClusterRunLostRetryTransition({
      run: lostRun(),
      attempt,
      policy: admittedPolicy,
      observedAtMs: 300,
      runEventId: `event-${disposition}`,
    });
    assert.equal(result.disposition, disposition);
    assert.equal(result.runTransitions[0].status, 'failed');
    assert.equal(result.runTransitions[0].errorCode, errorCode);
    assert.equal(result.runTransitions[0].finishedAtMs, 300);
  }
});

test('rejects cancellation, Workflow aggregates and early retry_wait', () => {
  assert.throws(() =>
    buildClusterRunLostRetryTransition({
      run: { ...lostRun(), cancelRequestedAtMs: 250, cancelReason: 'user' },
      attempt: lostAttempt(),
      policy: policy(),
      observedAtMs: 300,
      runEventId: 'event-cancelled',
    }),
  );
  assert.throws(() =>
    buildClusterRunLostRetryTransition({
      run: { ...lostRun(), triggerType: 'plugin_package_workflow' },
      attempt: lostAttempt(),
      policy: policy(),
      observedAtMs: 300,
      runEventId: 'event-workflow',
    }),
  );
  assert.throws(() =>
    buildClusterRunLostRetryTransition({
      run: lostRun('retry_wait'),
      attempt: lostAttempt(),
      policy: policy({ nextAttemptAtMs: 301 }),
      observedAtMs: 300,
      runEventId: 'event-early',
      attemptId: 'attempt-2',
      attemptEventId: 'event-2',
    }),
  );
});

test('normalizes one bounded page and coalesces overlapping callers', async () => {
  assert.deepEqual(normalizeClusterRunLostRetryPageCommand({ limit: 2 }), {
    limit: 2,
  });
  assert.deepEqual(
    normalizeClusterRunLostRetryPageResult(
      {
        scanned: 2,
        scheduled: 1,
        requeued: 0,
        failed: 0,
        raced: 1,
        hasMore: false,
      },
      2,
    ),
    {
      scanned: 2,
      scheduled: 1,
      requeued: 0,
      failed: 0,
      raced: 1,
      hasMore: false,
    },
  );

  let release;
  const coordinator = new ClusterRunLostRetryCoordinator(
    {
      async reconcilePage(command) {
        await new Promise((resolve) => {
          release = resolve;
        });
        return {
          scanned: command.limit,
          scheduled: command.limit,
          requeued: 0,
          failed: 0,
          raced: 0,
          hasMore: false,
        };
      },
    },
    { pageSize: 2 },
  );
  const first = coordinator.reconcile();
  const second = coordinator.reconcile();
  assert.equal(first, second);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).scheduled, 2);
});

test('wraps malformed repository results as unavailable', async () => {
  const coordinator = new ClusterRunLostRetryCoordinator({
    async reconcilePage() {
      return {
        scanned: 1,
        scheduled: 1,
        requeued: 1,
        failed: 0,
        raced: 0,
        hasMore: false,
      };
    },
  });
  await assert.rejects(
    coordinator.reconcile(),
    ClusterRunLostRetryUnavailableError,
  );
});
