'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  RemoteWorkerLeaseControlFenceRejectedError,
} = require('@qinglong/runtime-core/remote-worker-lease-control');
const {
  createStepRunRecord,
  transitionStepRunRecord,
} = require('@qinglong/runtime-core/step-run');
const {
  PostgresRemoteWorkerLeaseControlRepository,
} = require('../dist/entrypoints/runtime');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LEASE_DIGEST = createHash('sha256').update(LEASE_TOKEN).digest('hex');

function command() {
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
    leaseDurationMs: 30_000,
    timeoutEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a1',
  };
}

function aggregate(overrides = {}) {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    runStatus: 'running',
    executionOwner: 'runtime',
    cancelRequestedAtMs: null,
    cancelReason: null,
    runVersion: 3,
    eventSequence: 7,
    attemptId: 'attempt-1',
    attemptRunId: 'run-1',
    attemptStatus: 'running',
    executorType: 'remote_worker',
    attemptWorkerId: 'worker-1',
    attemptWorkerSessionId: SESSION_ID,
    attemptWorkerGeneration: 2,
    attemptLeaseGeneration: 3,
    attemptLeaseVersion: 4,
    attemptLeaseTokenDigest: LEASE_DIGEST,
    attemptOfferId: 'offer-1',
    deadlineAtMs: null,
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
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

function workflowSteps() {
  const ready = createStepRunRecord({
    id: 'workflow-step-1',
    runId: 'run-1',
    stepKey: 'collect',
    kind: 'task',
    definitionRef: 'pkg:demo:alpha',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    mutationId: 'workflow-step-created',
    createdAtMs: 100,
  });
  const running = transitionStepRunRecord(ready, {
    expectedVersion: ready.version,
    expectedDigest: ready.stepRunDigest,
    mutationId: 'workflow-step-running',
    to: 'running',
    atMs: 200,
  });
  return { ready, running };
}

function fixture(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (
        normalized === 'BEGIN' || normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' || normalized.startsWith('SET LOCAL') ||
        normalized.startsWith('SELECT pg_advisory_xact_lock')
      ) return { rows: [], rowCount: 0 };
      if (normalized.includes('FROM "ql3"."worker_sessions"')) {
        return {
          rows: [options.worker ?? {
            workerId: 'worker-1',
            sessionId: SESSION_ID,
            workerGeneration: 2,
            workerStatus: 'online',
            workerLeaseExpiresAtMs: 2_000,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('INNER JOIN "ql3"."run_attempts"')) {
        return { rows: [options.aggregate ?? aggregate()], rowCount: 1 };
      }
      if (normalized.includes('FROM "ql3"."step_runs"')) {
        return {
          rows: options.stepRun
            ? [{
                workflowStepVersion: options.stepRun.version,
                workflowStepDigest: options.stepRun.stepRunDigest,
                workflowStepJson: options.stepRun,
              }]
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
        normalized.startsWith('SELECT created_at_ms') &&
        normalized.includes('FROM "ql3"."run_events"')
      ) {
        return {
          rows: options.existingTimeoutAt === undefined
            ? []
            : [{ createdAtMs: options.existingTimeoutAt }],
          rowCount: options.existingTimeoutAt === undefined ? 0 : 1,
        };
      }
      if (
        normalized.startsWith('UPDATE "ql3"."run_dispatch_leases"') &&
        normalized.includes('RETURNING')
      ) {
        return {
          rows: [{ renewedAtMs: options.nowMs ?? 1_000, expiresAtMs: 31_000 }],
          rowCount: 1,
        };
      }
      if (normalized.startsWith('UPDATE "ql3"."runs"')) {
        return { rows: [], rowCount: options.runUpdateCount ?? 1 };
      }
      if (normalized.startsWith('UPDATE "ql3"."run_attempts"')) {
        return { rows: [], rowCount: options.attemptUpdateCount ?? 1 };
      }
      if (normalized.startsWith('INSERT INTO "ql3"."run_events"')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    repository: new PostgresRemoteWorkerLeaseControlRepository({
      async connect() { return client; },
    }),
    calls,
  };
}

test('renews one exact live Lease without creating control intent', async () => {
  const { repository, calls } = fixture();
  assert.deepEqual(await repository.control(command()), {
    status: 'renewed',
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseVersion: 5,
    renewedAtMs: 1_000,
    expiresAtMs: 31_000,
  });
  assert.equal(calls.some(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"')), false);
  assert.equal(calls.some(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"')), false);
  assert.equal(JSON.stringify(calls).includes(LEASE_TOKEN), false);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), true);
});

test('projects an existing durable cancellation while renewing', async () => {
  const { repository } = fixture({
    aggregate: aggregate({ cancelRequestedAtMs: 900, cancelReason: 'user' }),
  });
  const result = await repository.control(command());
  assert.equal(result.status, 'stop_requested');
  assert.deepEqual(result.stop, { reason: 'user', requestedAtMs: 900 });
  assert.equal(result.leaseVersion, 5);
});

test('persists one due deadline as timeout intent before returning stop', async () => {
  const { repository, calls } = fixture({
    aggregate: aggregate({ deadlineAtMs: 950 }),
  });
  const result = await repository.control(command());
  assert.equal(result.status, 'stop_requested');
  assert.deepEqual(result.stop, { reason: 'timeout', requestedAtMs: 1_000 });
  const cancel = calls.find(({ sql }) => sql.startsWith('UPDATE "ql3"."runs"'));
  assert.deepEqual(cancel.params, ['run-1', 1_000, 4, 8, 3]);
  const event = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"'));
  assert.equal(event.params[0], command().timeoutEventId);
  assert.equal(event.params[3], 'remote-timeout:attempt-1:3');
});

test('stops one timed-out Workflow Task without cancelling its parent Run', async () => {
  const { ready, running } = workflowSteps();
  const { repository, calls } = fixture({
    stepRun: running,
    aggregate: aggregate({
      deadlineAtMs: 950,
      attemptStepRunId: running.id,
      workflowAttemptId: 'attempt-1',
      workflowStepRunId: running.id,
      admittedWorkflowStepVersion: ready.version,
      admittedWorkflowStepDigest: ready.stepRunDigest,
    }),
  });
  const result = await repository.control(command());
  assert.equal(result.status, 'stop_requested');
  assert.deepEqual(result.stop, {
    reason: 'timeout',
    requestedAtMs: 1_000,
  });

  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'));
  assert.match(runUpdate.sql, /SET version = \$2, event_sequence = \$3/);
  assert.equal(runUpdate.sql.includes('cancel_requested_at_ms ='), false);
  assert.deepEqual(runUpdate.params, ['run-1', 4, 8, 3]);

  const event = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"'));
  assert.match(event.sql, /workflow\.task_timeout_requested/);
  assert.equal(event.params[5], running.id);
  assert.match(event.params[6], /"execution_scope":"workflow_task"/);
});

test('returns an exact terminal projection without renewing', async () => {
  const { repository, calls } = fixture({
    aggregate: aggregate({
      runStatus: 'cancelled',
      attemptStatus: 'cancelled',
    }),
    lease: lease({ leaseStatus: 'completed', leaseVersion: 5 }),
  });
  assert.deepEqual(await repository.control(command()), {
    status: 'terminal',
    projectId: 'project-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    offerId: 'offer-1',
    leaseGeneration: 3,
    terminalStatus: 'cancelled',
  });
  assert.equal(calls.some(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_dispatch_leases"')), false);
});

test('fences stale versions and rolls the transaction back', async () => {
  const { repository, calls } = fixture({
    lease: lease({ leaseVersion: 5 }),
  });
  await assert.rejects(
    repository.control(command()),
    (error) =>
      error instanceof RemoteWorkerLeaseControlFenceRejectedError &&
      error.reason === 'version_mismatch',
  );
  assert.equal(calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
});

test('preserves granular identity fence reasons without exposing capability data', async () => {
  const cases = [
    [{ worker: { workerId: 'worker-1', sessionId: SESSION_ID,
      workerGeneration: 3, workerStatus: 'online', workerLeaseExpiresAtMs: 2_000 } },
    'worker_generation_mismatch'],
    [{ aggregate: aggregate({ projectId: 'project-other' }) }, 'project_mismatch'],
    [{ aggregate: aggregate({ executionOwner: 'legacy' }) }, 'execution_owner_mismatch'],
    [{ lease: lease({ workerSessionId: '018f5c64-9b9d-7f1a-8c2d-1234567890ad' }) },
    'worker_session_mismatch'],
    [{ aggregate: aggregate({ attemptOfferId: 'offer-other' }) }, 'offer_mismatch'],
    [{ lease: lease({ leaseTokenDigest: 'f'.repeat(64) }) }, 'lease_token_mismatch'],
  ];
  for (const [options, reason] of cases) {
    const { repository } = fixture(options);
    await assert.rejects(
      repository.control(command()),
      (error) =>
        error instanceof RemoteWorkerLeaseControlFenceRejectedError &&
        error.reason === reason &&
        !error.message.includes(LEASE_TOKEN),
    );
  }
});
