require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_EXECUTOR_HANDLE_LENGTH,
  MAX_LOG_ARTIFACT_ID_LENGTH,
  MAX_RUN_ERROR_CODE_LENGTH,
  MAX_RUN_ERROR_SUMMARY_LENGTH,
  isTerminalRunAttemptStatus,
  isTerminalRunStatus,
  requestRunCancellation,
  reserveRunEvent,
  transitionRun,
  transitionRunAttempt,
} = require('../../back/runtime/domain/runStateMachine');
const {
  InvalidRunAttemptTransitionError,
  InvalidRunTransitionError,
  InvalidTransitionMetadataError,
  InvalidTransitionTimestampError,
  RunVersionConflictError,
} = require('../../back/runtime/domain/stateMachineErrors');

const CREATED_AT_MS = 1_750_000_000_000;

function createRun(overrides = {}) {
  return {
    id: '019f70c0-0000-7000-8000-000000000001',
    projectId: 'default',
    taskId: 'legacy-cron:1',
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'created',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: CREATED_AT_MS,
    ...overrides,
  };
}

function createAttempt(runId, overrides = {}) {
  return {
    id: '019f70c0-0000-7000-8000-000000000002',
    runId,
    attempt: 1,
    status: 'claimed',
    executorType: 'legacy_local',
    callbackSequence: 0,
    createdAtMs: CREATED_AT_MS + 1,
    ...overrides,
  };
}

test('drives the successful Run lifecycle while reserving ordered events', () => {
  const initial = createRun();
  const snapshot = structuredClone(initial);

  const queued = transitionRun(initial, {
    to: 'queued',
    expectedVersion: 0,
    atMs: CREATED_AT_MS + 1,
  });
  const dispatching = transitionRun(queued.run, {
    to: 'dispatching',
    expectedVersion: 1,
    atMs: CREATED_AT_MS + 2,
  });
  const running = transitionRun(dispatching.run, {
    to: 'running',
    expectedVersion: 2,
    atMs: CREATED_AT_MS + 3,
  });
  const succeeded = transitionRun(running.run, {
    to: 'succeeded',
    expectedVersion: 3,
    atMs: CREATED_AT_MS + 4,
  });

  assert.deepEqual(initial, snapshot, 'state decisions must not mutate input');
  assert.equal(succeeded.run.status, 'succeeded');
  assert.equal(succeeded.run.version, 4);
  assert.equal(succeeded.run.eventSequence, 4);
  assert.equal(succeeded.run.queuedAtMs, CREATED_AT_MS + 1);
  assert.equal(succeeded.run.startedAtMs, CREATED_AT_MS + 3);
  assert.equal(succeeded.run.finishedAtMs, CREATED_AT_MS + 4);
  assert.deepEqual(
    [queued, dispatching, running, succeeded].map((decision) => [
      decision.event.sequence,
      decision.event.type,
    ]),
    [
      [1, 'run.queued'],
      [2, 'run.dispatching'],
      [3, 'run.running'],
      [4, 'run.succeeded'],
    ],
  );
  assert.deepEqual(succeeded.event.payload, {
    from_status: 'running',
    to_status: 'succeeded',
    version: 4,
  });
});

test('supports retry and lost recovery paths and clears stale errors on queueing', () => {
  const running = createRun({
    status: 'running',
    version: 3,
    eventSequence: 3,
    queuedAtMs: CREATED_AT_MS + 1,
    startedAtMs: CREATED_AT_MS + 3,
  });
  const retryWait = transitionRun(running, {
    to: 'retry_wait',
    expectedVersion: 3,
    atMs: CREATED_AT_MS + 4,
    errorCode: 'EXECUTOR_BUSY',
    errorSummary: 'worker capacity is exhausted',
  });
  const requeued = transitionRun(retryWait.run, {
    to: 'queued',
    expectedVersion: 4,
    atMs: CREATED_AT_MS + 10,
  });

  assert.equal(retryWait.run.errorCode, 'EXECUTOR_BUSY');
  assert.equal(retryWait.run.errorSummary, 'worker capacity is exhausted');
  assert.equal(requeued.run.queuedAtMs, CREATED_AT_MS + 10);
  assert.equal(requeued.run.errorCode, undefined);
  assert.equal(requeued.run.errorSummary, undefined);

  const lost = createRun({
    status: 'lost',
    version: 8,
    eventSequence: 8,
    startedAtMs: CREATED_AT_MS + 2,
    errorCode: 'LEASE_EXPIRED',
    errorSummary: 'worker lease expired',
  });
  const recovered = transitionRun(lost, {
    to: 'queued',
    expectedVersion: 8,
    atMs: CREATED_AT_MS + 20,
  });
  assert.equal(recovered.run.status, 'queued');
  assert.equal(recovered.run.errorCode, undefined);
  assert.equal(recovered.run.errorSummary, undefined);
});

test('rejects illegal Run transitions, stale versions, timestamps, and metadata', () => {
  const terminal = createRun({
    status: 'succeeded',
    version: 4,
    eventSequence: 4,
    startedAtMs: CREATED_AT_MS + 2,
    finishedAtMs: CREATED_AT_MS + 3,
  });
  assert.throws(
    () =>
      transitionRun(terminal, {
        to: 'queued',
        expectedVersion: 4,
        atMs: CREATED_AT_MS + 4,
      }),
    InvalidRunTransitionError,
  );
  assert.throws(
    () =>
      transitionRun(createRun({ status: 'running' }), {
        to: 'created',
        expectedVersion: 0,
        atMs: CREATED_AT_MS + 1,
      }),
    InvalidRunTransitionError,
  );

  assert.throws(
    () =>
      transitionRun(createRun(), {
        to: 'queued',
        expectedVersion: 7,
        atMs: CREATED_AT_MS + 1,
      }),
    (error) => {
      assert.ok(error instanceof RunVersionConflictError);
      assert.equal(error.code, 'RUN_VERSION_CONFLICT');
      assert.equal(error.expectedVersion, 7);
      assert.equal(error.actualVersion, 0);
      return true;
    },
  );
  assert.throws(
    () =>
      transitionRun(createRun(), {
        to: 'queued',
        expectedVersion: 0,
        atMs: CREATED_AT_MS - 1,
      }),
    InvalidTransitionTimestampError,
  );
  assert.throws(
    () =>
      transitionRun(
        createRun({
          status: 'running',
          startedAtMs: CREATED_AT_MS + 10,
        }),
        {
          to: 'succeeded',
          expectedVersion: 0,
          atMs: CREATED_AT_MS + 9,
        },
      ),
    InvalidTransitionTimestampError,
  );
  assert.throws(
    () =>
      transitionRun(createRun({ status: 'running' }), {
        to: 'succeeded',
        expectedVersion: 0,
        atMs: CREATED_AT_MS + 1,
        errorCode: 'NOT_ALLOWED',
      }),
    InvalidTransitionMetadataError,
  );
  assert.throws(
    () =>
      transitionRun(createRun({ status: 'running' }), {
        to: 'failed',
        expectedVersion: 0,
        atMs: CREATED_AT_MS + 1,
        errorCode: 'x'.repeat(MAX_RUN_ERROR_CODE_LENGTH + 1),
      }),
    InvalidTransitionMetadataError,
  );
  assert.throws(
    () =>
      transitionRun(createRun({ status: 'running' }), {
        to: 'failed',
        expectedVersion: 0,
        atMs: CREATED_AT_MS + 1,
        errorSummary: 'x'.repeat(MAX_RUN_ERROR_SUMMARY_LENGTH + 1),
      }),
    InvalidTransitionMetadataError,
  );
});

test('drives Attempt state without mutating inputs and reserves Run events', () => {
  let run = createRun({
    status: 'dispatching',
    version: 2,
    eventSequence: 2,
  });
  let attempt = createAttempt(run.id);
  const initialRun = structuredClone(run);
  const initialAttempt = structuredClone(attempt);

  const starting = transitionRunAttempt(run, attempt, {
    to: 'starting',
    expectedRunVersion: 2,
    atMs: CREATED_AT_MS + 2,
  });
  run = starting.run;
  attempt = starting.attempt;
  const running = transitionRunAttempt(run, attempt, {
    to: 'running',
    expectedRunVersion: 3,
    atMs: CREATED_AT_MS + 3,
  });
  run = running.run;
  attempt = running.attempt;
  const failed = transitionRunAttempt(run, attempt, {
    to: 'failed',
    expectedRunVersion: 4,
    atMs: CREATED_AT_MS + 4,
    exitCode: 1,
    errorCode: 'EXIT_NON_ZERO',
    errorSummary: 'process exited with code 1',
  });

  assert.deepEqual(
    initialRun,
    createRun({
      status: 'dispatching',
      version: 2,
      eventSequence: 2,
    }),
  );
  assert.deepEqual(initialAttempt, createAttempt(initialRun.id));
  assert.equal(failed.run.status, 'dispatching');
  assert.equal(failed.run.version, 5);
  assert.equal(failed.run.eventSequence, 5);
  assert.equal(failed.attempt.status, 'failed');
  assert.equal(failed.attempt.startedAtMs, CREATED_AT_MS + 3);
  assert.equal(failed.attempt.finishedAtMs, CREATED_AT_MS + 4);
  assert.equal(failed.attempt.exitCode, 1);
  assert.equal(failed.attempt.errorCode, 'EXIT_NON_ZERO');
  assert.deepEqual(
    [starting, running, failed].map((decision) => [
      decision.event.sequence,
      decision.event.type,
    ]),
    [
      [3, 'attempt.starting'],
      [4, 'attempt.running'],
      [5, 'attempt.failed'],
    ],
  );
  assert.deepEqual(failed.event.payload, {
    attempt_id: initialAttempt.id,
    attempt: 1,
    from_status: 'running',
    to_status: 'failed',
    version: 5,
    exit_code: 1,
    error_code: 'EXIT_NON_ZERO',
  });
});

test('rejects invalid Attempt transitions and inconsistent aggregate metadata', () => {
  const run = createRun({ status: 'dispatching' });
  const attempt = createAttempt(run.id);

  assert.throws(
    () =>
      transitionRunAttempt(run, attempt, {
        to: 'succeeded',
        expectedRunVersion: 0,
        atMs: CREATED_AT_MS + 2,
      }),
    InvalidRunAttemptTransitionError,
  );
  assert.throws(
    () =>
      transitionRunAttempt(run, createAttempt(run.id, { status: 'failed' }), {
        to: 'succeeded',
        expectedRunVersion: 0,
        atMs: CREATED_AT_MS + 2,
      }),
    InvalidRunAttemptTransitionError,
  );
  assert.throws(
    () =>
      transitionRunAttempt(run, createAttempt('another-run'), {
        to: 'starting',
        expectedRunVersion: 0,
        atMs: CREATED_AT_MS + 2,
      }),
    InvalidTransitionMetadataError,
  );
  assert.throws(
    () =>
      transitionRunAttempt(run, attempt, {
        to: 'starting',
        expectedRunVersion: 0,
        atMs: CREATED_AT_MS + 2,
        exitCode: 0,
      }),
    InvalidTransitionMetadataError,
  );
  assert.throws(
    () =>
      transitionRunAttempt(createRun({ status: 'succeeded' }), attempt, {
        to: 'starting',
        expectedRunVersion: 0,
        atMs: CREATED_AT_MS + 2,
      }),
    InvalidTransitionMetadataError,
  );
  assert.throws(
    () =>
      transitionRunAttempt(run, attempt, {
        to: 'starting',
        expectedRunVersion: 1,
        atMs: CREATED_AT_MS + 2,
      }),
    RunVersionConflictError,
  );
});

test('accepts bounded execution metadata only while an Attempt starts or runs', () => {
  const run = createRun({ status: 'dispatching' });
  const attempt = createAttempt(run.id);
  const starting = transitionRunAttempt(run, attempt, {
    to: 'starting',
    expectedRunVersion: 0,
    atMs: CREATED_AT_MS + 2,
    executorHandle: 'legacy-local:321',
    pid: 321,
    logArtifactId: 'legacy-log-1',
    deadlineAtMs: CREATED_AT_MS + 30_000,
  });

  assert.equal(starting.attempt.executorHandle, 'legacy-local:321');
  assert.equal(starting.attempt.pid, 321);
  assert.equal(starting.attempt.logArtifactId, 'legacy-log-1');
  assert.equal(starting.attempt.deadlineAtMs, CREATED_AT_MS + 30_000);
  assert.equal(starting.event.payload.deadline_at_ms, CREATED_AT_MS + 30_000);

  for (const command of [
    { executorHandle: '' },
    { executorHandle: 'x'.repeat(MAX_EXECUTOR_HANDLE_LENGTH + 1) },
    { pid: 0 },
    { pid: Number.MAX_SAFE_INTEGER + 1 },
    { logArtifactId: '' },
    { logArtifactId: 'x'.repeat(MAX_LOG_ARTIFACT_ID_LENGTH + 1) },
    { deadlineAtMs: CREATED_AT_MS + 2 },
    { deadlineAtMs: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () =>
        transitionRunAttempt(run, attempt, {
          to: 'starting',
          expectedRunVersion: 0,
          atMs: CREATED_AT_MS + 2,
          ...command,
        }),
      InvalidTransitionMetadataError,
    );
  }

  assert.throws(
    () =>
      transitionRunAttempt(
        run,
        createAttempt(run.id, {
          status: 'running',
          startedAtMs: CREATED_AT_MS + 2,
        }),
        {
          to: 'succeeded',
          expectedRunVersion: 0,
          atMs: CREATED_AT_MS + 3,
          executorHandle: 'late-handle',
        },
      ),
    InvalidTransitionMetadataError,
  );

  assert.throws(
    () =>
      transitionRunAttempt(
        run,
        createAttempt(run.id, {
          deadlineAtMs: CREATED_AT_MS + 20_000,
        }),
        {
          to: 'starting',
          expectedRunVersion: 0,
          atMs: CREATED_AT_MS + 2,
          deadlineAtMs: CREATED_AT_MS + 30_000,
        },
      ),
    /cannot replace/,
  );
  assert.throws(
    () =>
      transitionRunAttempt(
        run,
        createAttempt(run.id, {
          status: 'starting',
          startedAtMs: CREATED_AT_MS + 2,
        }),
        {
          to: 'running',
          expectedRunVersion: 0,
          atMs: CREATED_AT_MS + 3,
          deadlineAtMs: CREATED_AT_MS + 30_000,
        },
      ),
    /only allowed when an Attempt starts/,
  );
});

test('persists one immutable callback token hash and advances callback sequence once', () => {
  const currentRun = createRun({
    status: 'dispatching',
    version: 3,
    eventSequence: 3,
  });
  const currentAttempt = createAttempt(currentRun.id, { status: 'claimed' });
  const tokenHash = 'a'.repeat(64);
  const starting = transitionRunAttempt(currentRun, currentAttempt, {
    to: 'starting',
    expectedRunVersion: 3,
    atMs: CREATED_AT_MS + 10,
    callbackTokenHash: tokenHash,
  });
  assert.equal(starting.attempt.callbackTokenHash, tokenHash);

  const running = transitionRunAttempt(
    starting.run,
    {
      ...starting.attempt,
      status: 'running',
      startedAtMs: CREATED_AT_MS + 11,
    },
    {
      to: 'succeeded',
      expectedRunVersion: starting.run.version,
      atMs: CREATED_AT_MS + 20,
      callbackSequence: 1,
      exitCode: 0,
    },
  );
  assert.equal(running.attempt.callbackSequence, 1);
  assert.equal(running.event.payload.callback_sequence, 1);

  assert.throws(
    () =>
      transitionRunAttempt(currentRun, currentAttempt, {
        to: 'starting',
        expectedRunVersion: 3,
        atMs: CREATED_AT_MS + 10,
        callbackTokenHash: 'not-a-hash',
      }),
    InvalidTransitionMetadataError,
  );
  assert.throws(
    () =>
      transitionRunAttempt(
        starting.run,
        {
          ...starting.attempt,
          status: 'running',
          startedAtMs: CREATED_AT_MS + 11,
        },
        {
          to: 'failed',
          expectedRunVersion: starting.run.version,
          atMs: CREATED_AT_MS + 20,
          callbackSequence: 2,
        },
      ),
    InvalidTransitionMetadataError,
  );
});

test('reserves standalone aggregate events without changing status or input', () => {
  const run = createRun({
    status: 'waiting_approval',
    version: 7,
    eventSequence: 11,
  });
  const snapshot = structuredClone(run);
  const reserved = reserveRunEvent(run, 7);

  assert.deepEqual(run, snapshot);
  assert.equal(reserved.sequence, 12);
  assert.equal(reserved.run.status, 'waiting_approval');
  assert.equal(reserved.run.version, 8);
  assert.equal(reserved.run.eventSequence, 12);
});

test('reserves one durable cancellation request without changing Run status', () => {
  const run = createRun({
    status: 'running',
    version: 3,
    eventSequence: 3,
    startedAtMs: CREATED_AT_MS + 3,
  });
  const snapshot = structuredClone(run);
  const accepted = requestRunCancellation(run, {
    expectedVersion: 3,
    atMs: CREATED_AT_MS + 4,
    reason: 'user',
  });

  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(run, snapshot);
  assert.equal(accepted.run.status, 'running');
  assert.equal(accepted.run.version, 4);
  assert.equal(accepted.run.eventSequence, 4);
  assert.equal(accepted.run.cancelRequestedAtMs, CREATED_AT_MS + 4);
  assert.equal(accepted.run.cancelReason, 'user');
  assert.deepEqual(accepted.event, {
    sequence: 4,
    type: 'run.cancel_requested',
    payload: {
      status: 'running',
      reason: 'user',
      requested_at_ms: CREATED_AT_MS + 4,
      version: 4,
    },
  });

  const duplicate = requestRunCancellation(accepted.run, {
    expectedVersion: 4,
    atMs: CREATED_AT_MS + 5,
    reason: 'policy',
  });
  assert.equal(duplicate.status, 'already_requested');
  assert.equal(duplicate.run.version, 4);
  assert.equal(duplicate.run.cancelReason, 'user');
});

test('does not reserve cancellation events for terminal Runs or invalid input', () => {
  const terminal = createRun({
    status: 'succeeded',
    version: 4,
    eventSequence: 4,
    startedAtMs: CREATED_AT_MS + 2,
    finishedAtMs: CREATED_AT_MS + 3,
  });
  const decision = requestRunCancellation(terminal, {
    expectedVersion: 4,
    atMs: CREATED_AT_MS + 4,
    reason: 'user',
  });
  assert.equal(decision.status, 'already_terminal');
  assert.equal(decision.run.version, 4);

  assert.throws(
    () =>
      requestRunCancellation(createRun({ status: 'running' }), {
        expectedVersion: 0,
        atMs: CREATED_AT_MS - 1,
        reason: 'user',
      }),
    InvalidTransitionTimestampError,
  );
  assert.throws(
    () =>
      requestRunCancellation(createRun({ status: 'running' }), {
        expectedVersion: 0,
        atMs: CREATED_AT_MS + 1,
        reason: 'unbounded-raw-reason',
      }),
    InvalidTransitionMetadataError,
  );
});

test('reports terminal Run and Attempt statuses explicitly', () => {
  assert.equal(isTerminalRunStatus('succeeded'), true);
  assert.equal(isTerminalRunStatus('lost'), false);
  assert.equal(isTerminalRunAttemptStatus('lost'), true);
  assert.equal(isTerminalRunAttemptStatus('running'), false);
});

test('allows a dispatching Run to time out before execution starts', () => {
  const dispatching = createRun({
    status: 'dispatching',
    version: 2,
    eventSequence: 2,
    queuedAtMs: CREATED_AT_MS + 1,
  });
  const decision = transitionRun(dispatching, {
    to: 'timed_out',
    expectedVersion: 2,
    atMs: CREATED_AT_MS + 3,
    errorCode: 'EXECUTION_TIMED_OUT',
    errorSummary: 'Execution timed out before start',
  });
  assert.equal(decision.run.status, 'timed_out');
  assert.equal(decision.run.finishedAtMs, CREATED_AT_MS + 3);
  assert.equal(decision.event.type, 'run.timed_out');
});
