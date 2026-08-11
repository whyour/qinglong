'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PostgresClusterRunLostRetryRepository,
} = require('../dist/entrypoints/runtime');

function runRow(status) {
  return {
    id: 'run-1',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    taskName: null,
    taskSnapshotRef: null,
    legacyCronId: null,
    parentRunId: null,
    retryOfRunId: null,
    triggerId: null,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: null,
    requestId: null,
    scheduledForMs: null,
    status,
    version: 4,
    eventSequence: 4,
    priority: 0,
    idempotencyKey: null,
    inputRef: null,
    outputRef: null,
    createdAtMs: '100',
    queuedAtMs: '110',
    startedAtMs: '150',
    finishedAtMs: null,
    cancelRequestedAtMs: null,
    cancelReason: null,
    errorCode: 'CLUSTER_RECOVERY_EXECUTION_NOT_RUNNING',
    errorSummary: 'lost',
  };
}

function attemptRow() {
  return {
    id: 'attempt-1',
    runId: 'run-1',
    stepRunId: null,
    attempt: 1,
    status: 'lost',
    executorType: 'remote_worker',
    workerId: 'worker-1',
    workerSessionId: null,
    workerGeneration: null,
    executorHandle: null,
    pid: null,
    logArtifactId: null,
    leaseToken: null,
    leaseTokenDigest: null,
    leaseGeneration: null,
    leaseVersion: null,
    leaseExpiresAtMs: null,
    offerId: null,
    deadlineAtMs: null,
    callbackTokenHash: null,
    callbackSequence: 0,
    createdAtMs: '120',
    startedAtMs: '150',
    finishedAtMs: '200',
    exitCode: null,
    errorCode: 'CLUSTER_RECOVERY_EXECUTION_NOT_RUNNING',
    errorSummary: 'lost',
  };
}

function policyRow(nextAttemptAtMs = null) {
  return {
    runId: 'run-1',
    maxAttempts: 3,
    retryOnLost: true,
    safety: 'idempotent',
    backoffBaseMs: '1000',
    backoffMaxMs: '8000',
    nextAttemptAtMs,
    version: 0,
    createdAtMs: '100',
    updatedAtMs: '100',
  };
}

function harness(status = 'lost') {
  const calls = [];
  let id = 0;
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text.includes('pg_advisory_xact_lock')) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      if (
        text.includes('FROM "ql3"."runs" AS run') &&
        text.includes('FOR UPDATE')
      ) {
        return { rows: [{ runId: 'run-1' }], rowCount: 1 };
      }
      if (
        text.startsWith('SELECT') &&
        text.includes('FROM "ql3"."runs" WHERE')
      ) {
        return { rows: [runRow(status)], rowCount: 1 };
      }
      if (
        text.startsWith('SELECT') &&
        text.includes('FROM "ql3"."run_attempts"')
      ) {
        return { rows: [attemptRow()], rowCount: 1 };
      }
      if (
        text.startsWith('SELECT') &&
        text.includes('FROM "ql3"."run_retry_policies" WHERE') &&
        !text.includes('FOR UPDATE')
      ) {
        return {
          rows: [policyRow(status === 'retry_wait' ? '250' : null)],
          rowCount: 1,
        };
      }
      if (
        text.includes('FROM "ql3"."run_retry_policies"') &&
        text.includes('FOR UPDATE')
      ) {
        return { rows: [{ runId: 'run-1' }], rowCount: 1 };
      }
      if (text.includes('AS "observedAtMs"')) {
        return { rows: [{ observedAtMs: '300' }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."runs"')) {
        return { rows: [{ id: 'run-1' }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."run_retry_policies"')) {
        return { rows: [{ run_id: 'run-1' }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "ql3"."run_attempts"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "ql3"."run_events"')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    calls,
    repository: new PostgresClusterRunLostRetryRepository(
      {
        async query(text, values) {
          calls.push({ text, values });
          assert.match(text, /JOIN LATERAL/);
          return {
            rows: [{ runId: 'run-1', attemptId: 'attempt-1' }],
            rowCount: 1,
          };
        },
        async connect() {
          return client;
        },
      },
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    ),
  };
}

test('schedules one safe lost Run in a bounded atomic page', async () => {
  const database = harness('lost');
  assert.deepEqual(await database.repository.reconcilePage({ limit: 2 }), {
    scanned: 1,
    scheduled: 1,
    requeued: 0,
    failed: 0,
    raced: 0,
    hasMore: false,
  });
  assert.equal(
    database.calls.filter(({ text }) =>
      text.startsWith('UPDATE "ql3"."runs"'),
    ).length,
    1,
  );
  assert.equal(
    database.calls.filter(({ text }) =>
      text.startsWith('UPDATE "ql3"."run_retry_policies"'),
    ).length,
    1,
  );
  assert.equal(
    database.calls.filter(({ text }) =>
      text.startsWith('INSERT INTO "ql3"."run_events"'),
    ).length,
    1,
  );
  assert.equal(database.calls.at(-1).text, 'COMMIT');
});

test('creates exactly one fresh Attempt when retry_wait is due', async () => {
  const database = harness('retry_wait');
  assert.deepEqual(await database.repository.reconcilePage({ limit: 1 }), {
    scanned: 1,
    scheduled: 0,
    requeued: 1,
    failed: 0,
    raced: 0,
    hasMore: false,
  });
  assert.equal(
    database.calls.filter(({ text }) =>
      text.startsWith('UPDATE "ql3"."runs"'),
    ).length,
    2,
  );
  assert.equal(
    database.calls.filter(({ text }) =>
      text.startsWith('INSERT INTO "ql3"."run_attempts"'),
    ).length,
    1,
  );
  assert.equal(
    database.calls.filter(({ text }) =>
      text.startsWith('INSERT INTO "ql3"."run_events"'),
    ).length,
    2,
  );
});

test('rejects widened pages before querying PostgreSQL', async () => {
  const database = harness('lost');
  await assert.rejects(
    database.repository.reconcilePage({ limit: 65 }),
    /page size/,
  );
  assert.equal(database.calls.length, 0);
});
