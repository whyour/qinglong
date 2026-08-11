'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  RemoteWorkerCompletionFenceRejectedError,
  RemoteWorkerCompletionUnavailableError,
} = require('@qinglong/runtime-core/remote-worker-completion');
const {
  createStepRunRecord,
  transitionStepRunRecord,
} = require('@qinglong/runtime-core/step-run');
const { PostgresRemoteWorkerCompletionRepository } = require('../dist/entrypoints/runtime');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LEASE_DIGEST = createHash('sha256').update(LEASE_TOKEN).digest('hex');
const LOG_ARTIFACT_ID = `wlog-${'a'.repeat(30)}`;
const ARTIFACT_SHA256 = 'b'.repeat(64);
const CALLBACK_DIGEST = 'c'.repeat(64);

function fence() {
  return {
    workerId: 'worker-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: LEASE_TOKEN,
    expectedLeaseVersion: 4,
  };
}

function uploadCommand() {
  return {
    ...fence(),
    logArtifactId: LOG_ARTIFACT_ID,
    byteLength: 10,
    truncated: false,
  };
}

function completionCommand(overrides = {}) {
  return {
    ...fence(),
    callbackSequence: 1,
    callbackTokenDigest: CALLBACK_DIGEST,
    result: {
      outcome: 'succeeded',
      startedAtMs: 100,
      finishedAtMs: 200,
      exitCode: 0,
    },
    artifact: {
      logArtifactId: LOG_ARTIFACT_ID,
      byteLength: 10,
      sha256: ARTIFACT_SHA256,
      truncated: false,
    },
    attemptEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a1',
    runEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a2',
    ...overrides,
  };
}

function aggregate(overrides = {}) {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    runStatus: 'dispatching',
    executionOwner: 'runtime',
    cancelRequestedAtMs: null,
    cancelReason: null,
    runErrorCode: null,
    runVersion: 3,
    eventSequence: 7,
    runCreatedAtMs: 40,
    runStartedAtMs: null,
    attemptId: 'attempt-1',
    attemptRunId: 'run-1',
    attemptStatus: 'starting',
    executorType: 'remote_worker',
    attemptWorkerId: 'worker-1',
    attemptWorkerSessionId: SESSION_ID,
    attemptWorkerGeneration: 2,
    attemptLeaseGeneration: 3,
    attemptLeaseVersion: 4,
    attemptLeaseTokenDigest: LEASE_DIGEST,
    attemptOfferId: 'offer-1',
    callbackSequence: 0,
    callbackTokenDigest: null,
    logArtifactId: null,
    attemptCreatedAtMs: 50,
    startedAtMs: null,
    finishedAtMs: null,
    exitCode: null,
    attemptErrorCode: null,
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
    attemptId: 'attempt-1',
    runId: 'run-1',
    leaseStatus: 'leased',
    leaseVersion: 4,
    leaseGeneration: 3,
    workerId: 'worker-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    leaseTokenDigest: LEASE_DIGEST,
    offerId: 'offer-1',
    leaseExpiresAtMs: 2_000,
    ...overrides,
  };
}

function replayPayload(command, overrides = {}) {
  return {
    attempt_id: command.attemptId,
    lease_generation: command.leaseGeneration,
    from_status: 'running',
    to_status: 'succeeded',
    callback_sequence: command.callbackSequence,
    callback_token_digest: command.callbackTokenDigest,
    worker_started_at_ms: command.result.startedAtMs,
    worker_finished_at_ms: command.result.finishedAtMs,
    exit_code: command.result.exitCode,
    log_artifact_id: command.artifact.logArtifactId,
    artifact_byte_length: command.artifact.byteLength,
    artifact_sha256: command.artifact.sha256,
    artifact_truncated: command.artifact.truncated,
    error_code: null,
    ...overrides,
  };
}

function workflowReadyStep() {
  return createStepRunRecord({
    id: 'workflow-step-1',
    runId: 'run-1',
    stepKey: 'collect',
    kind: 'task',
    definitionRef: 'pkg:demo:alpha',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    mutationId: 'workflow-step-created',
    createdAtMs: 60,
  });
}

function workflowAggregate(stepRun, overrides = {}) {
  return aggregate({
    runStatus: 'running',
    runVersion: 4,
    eventSequence: 9,
    runStartedAtMs: 50,
    attemptStepRunId: stepRun.id,
    workflowAttemptId: 'attempt-1',
    workflowStepRunId: stepRun.id,
    admittedWorkflowStepVersion: 1,
    admittedWorkflowStepDigest: workflowReadyStep().stepRunDigest,
    ...overrides,
  });
}

function fixture(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (
        normalized === 'BEGIN' ||
        normalized.startsWith('SET LOCAL') ||
        normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' ||
        normalized.startsWith('SELECT pg_advisory_xact_lock')
      )
        return { rows: [], rowCount: 0 };
      if (normalized.includes('FROM "ql3"."worker_sessions"')) {
        return {
          rows: [
            options.worker ?? {
              workerId: 'worker-1',
              sessionId: SESSION_ID,
              workerGeneration: 2,
              workerStatus: 'online',
              workerLeaseExpiresAtMs: 2_000,
            },
          ],
          rowCount: 1,
        };
      }
      if (normalized.includes('INNER JOIN "ql3"."run_attempts"')) {
        return { rows: [options.aggregate ?? aggregate()], rowCount: 1 };
      }
      if (normalized.includes('FROM "ql3"."step_runs"')) {
        return {
          rows: options.stepRun
            ? [
                {
                  workflowStepVersion: options.stepRun.version,
                  workflowStepDigest: options.stepRun.stepRunDigest,
                  workflowStepJson: options.stepRun,
                },
              ]
            : [],
          rowCount: options.stepRun ? 1 : 0,
        };
      }
      if (normalized.includes('FROM "ql3"."run_dispatch_leases"')) {
        return { rows: [options.lease ?? lease()], rowCount: 1 };
      }
      if (normalized.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: options.nowMs ?? 1_000 }], rowCount: 1 };
      }
      if (
        normalized.startsWith('SELECT payload') &&
        normalized.includes('FROM "ql3"."run_events"')
      ) {
        return {
          rows: options.replayPayload
            ? [{ payload: options.replayPayload }]
            : [],
          rowCount: options.replayPayload ? 1 : 0,
        };
      }
      if (
        normalized.startsWith('UPDATE "ql3"."run_dispatch_leases"') ||
        normalized.startsWith('UPDATE "ql3"."run_attempts"') ||
        normalized.startsWith('UPDATE "ql3"."runs"') ||
        normalized.startsWith('UPDATE "ql3"."step_runs"')
      )
        return { rows: [], rowCount: options.updateRowCount ?? 1 };
      if (
        normalized.startsWith('INSERT INTO "ql3"."run_events"') ||
        normalized.startsWith('INSERT INTO "ql3"."step_run_mutations"')
      ) {
        if (options.failEvent) throw new Error('injected event failure');
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    repository: new PostgresRemoteWorkerCompletionRepository({
      async connect() {
        return client;
      },
    }),
    calls,
  };
}

test('authorizes Artifact upload only after the shared Attempt lock and DB clock', async () => {
  const { repository, calls } = fixture();
  await repository.authorizeArtifactUpload(uploadCommand());
  const index = (needle) => calls.findIndex(({ sql }) => sql.includes(needle));
  assert.ok(index('pg_advisory_xact_lock') < index('worker_sessions'));
  assert.ok(
    index('worker_sessions') < index('INNER JOIN "ql3"."run_attempts"'),
  );
  assert.ok(
    index('INNER JOIN "ql3"."run_attempts"') < index('run_dispatch_leases'),
  );
  assert.ok(index('run_dispatch_leases') < index('statement_timestamp()'));
  assert.equal(
    calls.some(({ sql }) => sql === 'COMMIT'),
    true,
  );
  assert.equal(JSON.stringify(calls).includes(LEASE_TOKEN), false);
  assert.equal(JSON.stringify(calls).includes(LEASE_DIGEST), false);
});

test('completes directly from the durable starting crash window in one transaction', async () => {
  const { repository, calls } = fixture();
  assert.deepEqual(await repository.complete(completionCommand()), {
    status: 'applied',
    runId: 'run-1',
    attemptId: 'attempt-1',
    callbackSequence: 1,
  });
  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'),
  );
  assert.equal(attemptUpdate.params[9], 'succeeded');
  assert.equal(attemptUpdate.params[10], 5);
  assert.equal(attemptUpdate.params[11], 1);
  assert.equal(attemptUpdate.params[12], CALLBACK_DIGEST);
  assert.equal(attemptUpdate.params[13], LOG_ARTIFACT_ID);
  assert.equal(attemptUpdate.params[14], 100);
  assert.equal(attemptUpdate.params[15], 1_000);
  assert.equal(attemptUpdate.params[16], 0);
  assert.equal(attemptUpdate.params[19], 'starting');
  assert.equal(
    calls.filter(({ sql }) => sql.startsWith('INSERT INTO "ql3"."run_events"'))
      .length,
    2,
  );
  assert.equal(
    calls.some(({ sql }) => sql === 'COMMIT'),
    true,
  );
  assert.equal(JSON.stringify(calls).includes(LEASE_TOKEN), false);
  assert.equal(JSON.stringify(calls).includes(ARTIFACT_SHA256), true);
});

test('completes a Workflow Task from the starting crash window without terminalizing its parent Run', async () => {
  const stepRun = workflowReadyStep();
  const { repository, calls } = fixture({
    stepRun,
    aggregate: workflowAggregate(stepRun),
  });
  assert.equal(
    (await repository.complete(completionCommand())).status,
    'applied',
  );

  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'),
  );
  assert.match(runUpdate.sql, /SET version = \$2, event_sequence = \$3/);
  assert.equal(runUpdate.sql.includes('SET status ='), false);
  assert.deepEqual(runUpdate.params, ['run-1', 7, 12, 4]);

  const stepUpdates = calls.filter(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."step_runs"'),
  );
  assert.equal(stepUpdates.length, 2);
  assert.equal(stepUpdates[0].params[0], 'running');
  assert.equal(stepUpdates[0].params[2], 1);
  assert.equal(stepUpdates[1].params[0], 'succeeded');
  assert.equal(stepUpdates[1].params[2], 1);
  assert.equal(
    calls.filter(({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."step_run_mutations"'),
    ).length,
    2,
  );

  const attemptEvent = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."run_events"') &&
      params[3] === 'workflow.task_attempt.succeeded',
  );
  assert.equal(attemptEvent.params[2], 11);
  assert.equal(attemptEvent.params[7], stepRun.id);
  assert.match(attemptEvent.params[8], /"execution_scope":"workflow_task"/);
  assert.match(attemptEvent.params[8], /"step_run_id":"workflow-step-1"/);
});

test('makes parent Workflow cancellation win over a successful stopped Worker completion', async () => {
  const ready = workflowReadyStep();
  const running = transitionStepRunRecord(ready, {
    expectedVersion: ready.version,
    expectedDigest: ready.stepRunDigest,
    mutationId: 'workflow-step-running-before-stop',
    to: 'running',
    atMs: 100,
  });
  const { repository, calls } = fixture({
    stepRun: running,
    aggregate: workflowAggregate(running, {
      attemptStatus: 'running',
      callbackSequence: 1,
      callbackTokenDigest: CALLBACK_DIGEST,
      logArtifactId: LOG_ARTIFACT_ID,
      cancelRequestedAtMs: 150,
      cancelReason: 'user',
      startedAtMs: 100,
    }),
  });
  assert.equal(
    (await repository.complete(completionCommand())).status,
    'applied',
  );

  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'),
  );
  assert.equal(attemptUpdate.params[9], 'cancelled');
  assert.equal(attemptUpdate.params[17], 'EXECUTION_CANCELLED');
  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'),
  );
  assert.match(runUpdate.sql, /SET version = \$2, event_sequence = \$3/);
  assert.equal(runUpdate.sql.includes('SET status ='), false);
  const stepUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."step_runs"'),
  );
  assert.equal(stepUpdate.params[0], 'cancelled');
  const attemptEvent = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."run_events"') &&
      params[3] === 'workflow.task_attempt.cancelled',
  );
  assert.equal(attemptEvent.params[7], running.id);
  assert.match(attemptEvent.params[8], /"error_code":"EXECUTION_CANCELLED"/);
  assert.equal(
    calls.some(({ sql }) => sql === 'COMMIT'),
    true,
  );
});

test('makes timeout intent win over a successful Worker exit', async () => {
  const running = aggregate({
    runStatus: 'running',
    attemptStatus: 'running',
    cancelRequestedAtMs: 900,
    cancelReason: 'timeout',
    callbackSequence: 1,
    callbackTokenDigest: CALLBACK_DIGEST,
    logArtifactId: LOG_ARTIFACT_ID,
    runStartedAtMs: 100,
    startedAtMs: 100,
  });
  const { repository, calls } = fixture({ aggregate: running });
  await repository.complete(completionCommand());
  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'),
  );
  assert.equal(attemptUpdate.params[9], 'timed_out');
  assert.equal(attemptUpdate.params[17], 'EXECUTION_TIMED_OUT');
  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'),
  );
  assert.equal(runUpdate.params[1], 'timed_out');
});

test('makes a Workflow Task deadline win without timing out its parent Run', async () => {
  const ready = workflowReadyStep();
  const running = transitionStepRunRecord(ready, {
    expectedVersion: ready.version,
    expectedDigest: ready.stepRunDigest,
    mutationId: 'workflow-step-running',
    to: 'running',
    atMs: 100,
  });
  const { repository, calls } = fixture({
    stepRun: running,
    aggregate: workflowAggregate(running, {
      attemptStatus: 'running',
      callbackSequence: 1,
      callbackTokenDigest: CALLBACK_DIGEST,
      logArtifactId: LOG_ARTIFACT_ID,
      deadlineAtMs: 950,
      startedAtMs: 100,
    }),
  });
  await repository.complete(completionCommand());

  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'),
  );
  assert.equal(attemptUpdate.params[9], 'timed_out');
  assert.equal(attemptUpdate.params[17], 'EXECUTION_TIMED_OUT');
  const stepUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."step_runs"'),
  );
  assert.equal(stepUpdate.params[0], 'timed_out');
  assert.equal(stepUpdate.params[8], 'execution_timed_out');
  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'),
  );
  assert.equal(runUpdate.sql.includes('SET status ='), false);
});

test('replays a completed Workflow Task from immutable Attempt state after its parent Run is cancelled', async () => {
  const command = completionCommand();
  const ready = workflowReadyStep();
  const running = transitionStepRunRecord(ready, {
    expectedVersion: ready.version,
    expectedDigest: ready.stepRunDigest,
    mutationId: 'workflow-step-running',
    to: 'running',
    atMs: 100,
  });
  const succeeded = transitionStepRunRecord(running, {
    expectedVersion: running.version,
    expectedDigest: running.stepRunDigest,
    mutationId: command.runEventId,
    to: 'succeeded',
    atMs: 1_000,
  });
  const aggregateRow = workflowAggregate(succeeded, {
    runStatus: 'cancelled',
    cancelRequestedAtMs: 1_200,
    cancelReason: 'user',
    runErrorCode: 'EXECUTION_CANCELLED',
    attemptStatus: 'succeeded',
    attemptLeaseVersion: 5,
    callbackSequence: 1,
    callbackTokenDigest: CALLBACK_DIGEST,
    logArtifactId: LOG_ARTIFACT_ID,
    startedAtMs: 100,
    finishedAtMs: 1_000,
    exitCode: 0,
  });
  const exact = fixture({
    aggregate: aggregateRow,
    stepRun: succeeded,
    lease: lease({ leaseStatus: 'completed', leaseVersion: 5 }),
    replayPayload: replayPayload(command, {
      execution_scope: 'workflow_task',
      step_run_id: succeeded.id,
    }),
  });
  assert.equal(
    (await exact.repository.complete(command)).status,
    'already_completed',
  );
});

test('accepts only an event-authenticated exact completed replay', async () => {
  const command = completionCommand();
  const terminal = aggregate({
    runStatus: 'succeeded',
    attemptStatus: 'succeeded',
    attemptLeaseVersion: 5,
    callbackSequence: 1,
    callbackTokenDigest: CALLBACK_DIGEST,
    logArtifactId: LOG_ARTIFACT_ID,
    runStartedAtMs: 100,
    startedAtMs: 100,
    finishedAtMs: 1_000,
    exitCode: 0,
  });
  const exact = fixture({
    aggregate: terminal,
    lease: lease({ leaseStatus: 'completed', leaseVersion: 5 }),
    replayPayload: replayPayload(command),
  });
  assert.equal(
    (await exact.repository.complete(command)).status,
    'already_completed',
  );

  const drifted = fixture({
    aggregate: terminal,
    lease: lease({ leaseStatus: 'completed', leaseVersion: 5 }),
    replayPayload: replayPayload(command, { artifact_sha256: 'd'.repeat(64) }),
  });
  await assert.rejects(
    drifted.repository.complete(command),
    (error) =>
      error instanceof RemoteWorkerCompletionFenceRejectedError &&
      error.reason === 'replay_mismatch',
  );

  const invalidOrigin = fixture({
    aggregate: terminal,
    lease: lease({ leaseStatus: 'completed', leaseVersion: 5 }),
    replayPayload: replayPayload(command, { from_status: 'queued' }),
  });
  await assert.rejects(
    invalidOrigin.repository.complete(command),
    (error) =>
      error instanceof RemoteWorkerCompletionFenceRejectedError &&
      error.reason === 'replay_mismatch',
  );
});

test('fences future Worker timestamps and rolls storage failures back', async () => {
  const future = fixture();
  await assert.rejects(
    future.repository.complete(
      completionCommand({
        result: {
          outcome: 'succeeded',
          startedAtMs: 100,
          finishedAtMs: 302_000,
          exitCode: 0,
        },
      }),
    ),
    (error) =>
      error instanceof RemoteWorkerCompletionFenceRejectedError &&
      error.reason === 'state_mismatch',
  );

  const failed = fixture({ failEvent: true });
  await assert.rejects(
    failed.repository.complete(completionCommand()),
    (error) =>
      error instanceof RemoteWorkerCompletionUnavailableError &&
      error.cause?.message === 'injected event failure',
  );
  assert.equal(
    failed.calls.some(({ sql }) => sql === 'ROLLBACK'),
    true,
  );
  assert.equal(
    failed.calls.some(({ sql }) => sql === 'COMMIT'),
    false,
  );
});
