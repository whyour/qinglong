const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  RemoteRunActivationUnavailableError,
} = require('@qinglong/runtime-core/remote-activation');
const {
  createStepRunRecord,
} = require('@qinglong/runtime-core/step-run');
const {
  PostgresRemoteRunActivationRepository,
} = require('../dist/entrypoints/runtime');

const SESSION_ID = '018f5c64-9b9d-7f1a-8c2d-1234567890ac';
const LEASE_TOKEN = 'worker_generated_lease_capability_0000000000000001';
const LEASE_DIGEST = createHash('sha256').update(LEASE_TOKEN).digest('hex');

function command() {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    workerId: 'edge-1',
    workerSessionId: SESSION_ID,
    workerGeneration: 2,
    offerId: 'offer-1',
    leaseGeneration: 3,
    leaseToken: LEASE_TOKEN,
    expectedLeaseVersion: 4,
    eventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a1',
  };
}

function fixture({ failEvent = false, timeoutMs = 5_000, omitTimeout = false } = {}) {
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
      ) return { rows: [], rowCount: 0 };
      if (normalized.includes('FROM "ql3"."worker_sessions"')) {
        return {
          rows: [{
            workerId: 'edge-1',
            sessionId: SESSION_ID,
            workerGeneration: 2,
            workerStatus: 'online',
            workerLeaseExpiresAtMs: 2_000,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('INNER JOIN "ql3"."run_attempts"')) {
        return {
          rows: [{
            runId: 'run-1',
            runStatus: 'dispatching',
            executionOwner: 'runtime',
            cancelRequestedAtMs: null,
            cancelReason: null,
            runErrorCode: null,
            runVersion: 3,
            eventSequence: 7,
            planJson: {
              command: { kind: 'argv', file: '/bin/true', args: [] },
              environment: [],
              ...(omitTimeout ? {} : { timeoutMs }),
            },
            attemptId: 'attempt-1',
            attemptRunId: 'run-1',
            attemptStatus: 'claimed',
            executorType: 'remote_worker',
            attemptWorkerId: 'edge-1',
            attemptWorkerSessionId: SESSION_ID,
            attemptWorkerGeneration: 2,
            attemptLeaseGeneration: 3,
            attemptLeaseVersion: 4,
            attemptLeaseTokenDigest: LEASE_DIGEST,
            attemptOfferId: 'offer-1',
            callbackSequence: 0,
            callbackTokenDigest: null,
            executorHandle: null,
            logArtifactId: null,
            deadlineAtMs: null,
            startedAtMs: null,
            finishedAtMs: null,
            attemptErrorCode: null,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('FROM "ql3"."run_dispatch_leases"')) {
        return {
          rows: [{
            attemptId: 'attempt-1',
            runId: 'run-1',
            leaseStatus: 'leased',
            leaseVersion: 4,
            leaseGeneration: 3,
            workerId: 'edge-1',
            workerSessionId: SESSION_ID,
            workerGeneration: 2,
            leaseTokenDigest: LEASE_DIGEST,
            offerId: 'offer-1',
            leaseExpiresAtMs: 2_000,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: 1_000 }], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE "ql3"."run_attempts"')) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE "ql3"."runs"')) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('INSERT INTO "ql3"."run_events"')) {
        if (failEvent) throw new Error('injected event failure');
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  const pool = {
    async connect() { return client; },
  };
  return { repository: new PostgresRemoteRunActivationRepository(pool), calls };
}

test('locks every authority before database time and persists digest-only starting', async () => {
  const { repository, calls } = fixture();
  const activation = await repository.acknowledgeStarting(command());
  assert.equal(activation.status, 'applied');
  assert.equal(activation.snapshot.attemptStatus, 'starting');
  assert.equal(activation.snapshot.deadlineAtMs, 6_000);
  const index = (needle) => calls.findIndex(({ sql }) => sql.includes(needle));
  assert.ok(index('pg_advisory_xact_lock') < index('worker_sessions'));
  assert.ok(index('worker_sessions') < index('INNER JOIN "ql3"."run_attempts"'));
  assert.ok(index('INNER JOIN "ql3"."run_attempts"') < index('run_dispatch_leases'));
  assert.ok(index('run_dispatch_leases') < index('statement_timestamp()'));
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), true);
  assert.equal(JSON.stringify(calls).includes(LEASE_TOKEN), false);
  assert.equal(JSON.stringify(calls).includes(LEASE_DIGEST), true);
  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'));
  assert.equal(attemptUpdate.params.at(-1), 6_000);
});

test('keeps the durable deadline absent when the immutable revision has no timeout', async () => {
  const { repository, calls } = fixture({ omitTimeout: true });
  const activation = await repository.acknowledgeStarting(command());
  assert.equal(activation.snapshot.deadlineAtMs, undefined);
  const attemptUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."run_attempts"'));
  assert.equal(attemptUpdate.params.at(-1), null);
});

test('rolls the transaction back and exposes storage failure as unavailable', async () => {
  const { repository, calls } = fixture({ failEvent: true });
  await assert.rejects(
    repository.acknowledgeStarting(command()),
    (error) =>
      error instanceof RemoteRunActivationUnavailableError &&
      error.cause?.message === 'injected event failure',
  );
  assert.equal(calls.some(({ sql }) => sql === 'ROLLBACK'), true);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), false);
});

function workflowFixture() {
  const stepRun = createStepRunRecord({
    id: 'workflow-step-1',
    runId: 'run-1',
    stepKey: 'collect',
    kind: 'task',
    definitionRef: 'pkg:demo:alpha',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    mutationId: 'workflow-step-created',
    createdAtMs: 500,
  });
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
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (normalized.includes('FROM "ql3"."worker_sessions"')) {
        return {
          rows: [{
            workerId: 'edge-1',
            sessionId: SESSION_ID,
            workerGeneration: 2,
            workerStatus: 'online',
            workerLeaseExpiresAtMs: 2_000,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('INNER JOIN "ql3"."run_attempts"')) {
        return {
          rows: [{
            runId: 'run-1',
            runStatus: 'running',
            executionOwner: 'runtime',
            cancelRequestedAtMs: null,
            cancelReason: null,
            runErrorCode: null,
            runVersion: 4,
            eventSequence: 4,
            planJson: {
              command: { kind: 'argv', file: '/bin/true', args: [] },
              environment: [],
              timeoutMs: 5_000,
            },
            attemptId: 'attempt-1',
            attemptRunId: 'run-1',
            attemptStepRunId: stepRun.id,
            attemptStatus: 'starting',
            executorType: 'remote_worker',
            attemptWorkerId: 'edge-1',
            attemptWorkerSessionId: SESSION_ID,
            attemptWorkerGeneration: 2,
            attemptLeaseGeneration: 3,
            attemptLeaseVersion: 4,
            attemptLeaseTokenDigest: LEASE_DIGEST,
            attemptOfferId: 'offer-1',
            callbackSequence: 0,
            callbackTokenDigest: null,
            executorHandle: null,
            logArtifactId: null,
            deadlineAtMs: 6_000,
            startedAtMs: null,
            finishedAtMs: null,
            attemptErrorCode: null,
            workflowAttemptId: 'attempt-1',
            workflowStepRunId: stepRun.id,
            admittedWorkflowStepVersion: stepRun.version,
            admittedWorkflowStepDigest: stepRun.stepRunDigest,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('FROM "ql3"."step_runs"')) {
        return {
          rows: [{
            workflowStepVersion: stepRun.version,
            workflowStepDigest: stepRun.stepRunDigest,
            workflowStepJson: stepRun,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('FROM "ql3"."run_dispatch_leases"')) {
        return {
          rows: [{
            attemptId: 'attempt-1',
            runId: 'run-1',
            leaseStatus: 'leased',
            leaseVersion: 4,
            leaseGeneration: 3,
            workerId: 'edge-1',
            workerSessionId: SESSION_ID,
            workerGeneration: 2,
            leaseTokenDigest: LEASE_DIGEST,
            offerId: 'offer-1',
            leaseExpiresAtMs: 2_000,
          }],
          rowCount: 1,
        };
      }
      if (normalized.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: 1_000 }], rowCount: 1 };
      }
      if (
        normalized.startsWith('UPDATE ') ||
        normalized.startsWith('INSERT INTO ')
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    calls,
    repository: new PostgresRemoteRunActivationRepository({
      async connect() {
        return client;
      },
    }),
    stepRun,
  };
}

test('activates a Workflow Task Attempt by advancing StepRun, not the aggregate Run', async () => {
  const { repository, calls, stepRun } = workflowFixture();
  const result = await repository.acknowledgeRunning({
    ...command(),
    attemptEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a2',
    runEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a3',
    executorHandle: 'worker-handle-1',
    callbackSequence: 1,
    callbackTokenDigest: 'b'.repeat(64),
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.snapshot.runStatus, 'running');
  assert.equal(result.snapshot.attemptStatus, 'running');

  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'));
  assert.equal(runUpdate.params[1], 'running');
  assert.equal(runUpdate.params.at(-1), 'running');
  const stepUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."step_runs"'));
  assert.ok(stepUpdate);
  assert.equal(stepUpdate.params[0], 'running');
  assert.equal(stepUpdate.params[2], stepRun.attemptCount + 1);
  assert.ok(
    calls.some(({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."step_run_mutations"')),
  );
  const attemptEvent = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."run_events"') &&
      params[3] === 'workflow.task_attempt.running',
  );
  assert.equal(attemptEvent.params[7], stepRun.id);
  assert.match(attemptEvent.params[8], /"execution_scope":"workflow_task"/);
});

test('fails a Workflow Task before StepRun start without terminalizing its aggregate Run', async () => {
  const { repository, calls, stepRun } = workflowFixture();
  const result = await repository.failStart({
    ...command(),
    attemptEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a2',
    runEventId: '018f5c64-9b9d-7f1a-8c2d-1234567890a3',
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.snapshot.runStatus, 'running');
  assert.equal(result.snapshot.attemptStatus, 'failed');
  assert.equal(result.snapshot.errorCode, 'EXECUTOR_START_FAILED');

  const runUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."runs"'));
  assert.equal(runUpdate.params[1], 'running');
  assert.equal(runUpdate.params[2], null);
  assert.equal(runUpdate.params[3], null);
  assert.equal(runUpdate.params[4], null);
  const stepUpdate = calls.find(({ sql }) =>
    sql.startsWith('UPDATE "ql3"."step_runs"'));
  assert.ok(stepUpdate);
  assert.equal(stepUpdate.params[0], 'failed');
  assert.equal(stepUpdate.params[2], stepRun.attemptCount);
  assert.equal(stepUpdate.params[5], stepRun.readyAtMs);
  assert.equal(stepUpdate.params[6], null);
  assert.equal(stepUpdate.params[7], 1_000);
  assert.ok(
    calls.some(({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."step_run_mutations"')),
  );
});
