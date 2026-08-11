'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  RunManualRetryFenceRejectedError,
  RunManualRetryRateLimitedError,
} = require('@qinglong/runtime-core/run-manual-retry');
const {
  CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
  PostgresRunManualRetryRepository,
} = require('@qinglong/cluster-postgres/run-manual-retry');

const SOURCE_DIGEST = 'a'.repeat(64);
const EXECUTION_DIGEST = 'b'.repeat(64);
const TASK_REVISION = `qltd:v1:7:${SOURCE_DIGEST}`;
const IDS = Object.freeze({
  mutationId: '019f9200-0000-4000-8000-000000000001',
  runId: '019f9200-0000-4000-8000-000000000002',
  attemptId: '019f9200-0000-4000-8000-000000000003',
  createdEventId: '019f9200-0000-4000-8000-000000000004',
  queuedEventId: '019f9200-0000-4000-8000-000000000005',
  auditEventId: '019f9200-0000-4000-8000-000000000006',
});

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    mutationId: IDS.mutationId,
    expectedRunVersion: 7,
    expectedRunStatus: 'failed',
    runId: IDS.runId,
    attemptId: IDS.attemptId,
    createdEventId: IDS.createdEventId,
    queuedEventId: IDS.queuedEventId,
    auditEventId: IDS.auditEventId,
    requestId: 'cluster-run-retry-1',
    principal: {
      subject: { type: 'user', id: 'operator-1' },
      authenticationId: 'oidc:mfa-session-1',
      authenticatedAtMs: 900_000,
      expiresAtMs: 1_100_000,
      assurance: 'multi_factor',
    },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

function sourceRow(overrides = {}) {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    taskName: 'Task 1',
    taskSnapshotRef: TASK_REVISION,
    parentRunId: null,
    triggerType: 'task_start',
    executionOwner: 'runtime',
    inputRef: 'artifact:input-1',
    priority: 3,
    runStatus: 'failed',
    runVersion: 7,
    attemptExecutorType: 'remote_worker',
    ...overrides,
  };
}

function replayRow(overrides = {}) {
  return {
    runId: IDS.runId,
    projectId: 'project-1',
    retryOfRunId: 'source-run-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    triggerType: 'run_manual_retry',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: 'operator-1',
    requestId: IDS.mutationId,
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    createdAtMs: 1_000_000,
    attemptId: IDS.attemptId,
    executorType: 'remote_worker',
    createdActorType: 'user',
    createdActorId: 'operator-1',
    createdPayload: {
      mutation_id: IDS.mutationId,
      retry_of_run_id: 'source-run-1',
      source_run_status: 'failed',
      source_run_version: 7,
      inherit_retry_policy: false,
      authentication_id: 'oidc:mfa-session-1',
      audit_event_id: IDS.auditEventId,
      execution_revision_digest: EXECUTION_DIGEST,
      policy_fence: { project_version: 2, binding_version: 3 },
    },
    queuedActorType: 'user',
    queuedActorId: 'operator-1',
    queuedPayload: {
      from_status: 'created',
      to_status: 'queued',
      version: 2,
    },
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  let connections = 0;
  const pool = {
    async connect() {
      connections += 1;
      const connection = connections;
      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          calls.push({ connection, sql: normalized, params });
          if (normalized.startsWith('BEGIN')) {
            if (options.failFirstBegin && connection === 1) {
              const error = new Error('serialization retry');
              error.code = '40001';
              throw error;
            }
            return { rows: [], rowCount: 0 };
          }
          if (
            normalized === 'COMMIT' ||
            normalized === 'ROLLBACK' ||
            normalized.startsWith('SELECT set_config')
          )
            return { rows: [], rowCount: 0 };
          if (normalized.includes('statement_timestamp()')) {
            return { rows: [{ nowMs: 1_000_000 }], rowCount: 1 };
          }
          if (normalized.includes('lock_run_management_policy_fence')) {
            return {
              rows: [{ matches: options.authorizationMatches ?? true }],
              rowCount: 1,
            };
          }
          if (normalized.includes('idempotency_key = $2')) {
            const rows = options.replayRows ?? [];
            return { rows, rowCount: rows.length };
          }
          if (normalized.includes('WHERE run.id = $1')) {
            const rows = options.sourceRows ?? [sourceRow()];
            return { rows, rowCount: rows.length };
          }
          if (normalized.includes('FROM "ql3"."task_definitions"')) {
            const rows = options.taskRows ?? [{ enabled: true }];
            return { rows, rowCount: rows.length };
          }
          if (normalized.includes('task_execution_revisions')) {
            const rows = options.executionRows ?? [
              {
                sourceContentDigest: SOURCE_DIGEST,
                contentDigest: EXECUTION_DIGEST,
              },
            ];
            return { rows, rowCount: rows.length };
          }
          if (
            normalized.includes("trigger_type = 'run_manual_retry'") &&
            normalized.startsWith('SELECT')
          ) {
            const rows = options.rateRows ?? [];
            return { rows, rowCount: rows.length };
          }
          if (normalized.startsWith('INSERT INTO')) {
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL: ${normalized}`);
        },
        release() {
          calls.push({ connection, sql: 'RELEASE', params: [] });
        },
      };
    },
  };
  return {
    calls,
    repository: new PostgresRunManualRetryRepository(pool),
  };
}

test('atomically appends a linked queued Run, remote Attempt, events and allowed audit', async () => {
  const { calls, repository } = fixture();
  assert.deepEqual(await repository.retryRun(command()), {
    status: 'accepted',
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    sourceRunStatus: 'failed',
    sourceRunVersion: 7,
    runId: IDS.runId,
    retryOfRunId: 'source-run-1',
    taskId: 'task-1',
    taskRevision: TASK_REVISION,
    attemptId: IDS.attemptId,
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'remote_worker',
    executionRevisionDigest: EXECUTION_DIGEST,
    createdAtMs: 1_000_000,
  });
  const inserts = calls.filter(({ sql }) => sql.startsWith('INSERT INTO'));
  assert.equal(inserts.length, 5);
  assert.match(inserts.at(-1).sql, /security_audit_events/);
  assert.deepEqual(JSON.parse(inserts[2].params[6]), {
    status: 'created',
    version: 1,
    execution_owner: 'runtime',
    executor_type: 'remote_worker',
    execution_revision_digest: EXECUTION_DIGEST,
    source_content_digest: SOURCE_DIGEST,
    retry_of_run_id: 'source-run-1',
    source_run_status: 'failed',
    source_run_version: 7,
    inherit_retry_policy: false,
    mutation_id: IDS.mutationId,
    authentication_id: 'oidc:mfa-session-1',
    audit_event_id: IDS.auditEventId,
    policy_fence: { project_version: 2, binding_version: 3 },
  });
  assert.equal(
    calls.some(({ sql }) => sql === 'COMMIT'),
    true,
  );
});

test('returns durable identities for an exact replay without appending again', async () => {
  const { calls, repository } = fixture({
    replayRows: [
      replayRow({ runStatus: 'running', runVersion: 4, eventSequence: 4 }),
    ],
  });
  const result = await repository.retryRun(
    command({
      runId: '019f9200-0000-4000-8000-000000000102',
      attemptId: '019f9200-0000-4000-8000-000000000103',
      createdEventId: '019f9200-0000-4000-8000-000000000104',
      queuedEventId: '019f9200-0000-4000-8000-000000000105',
    }),
  );
  assert.equal(result.status, 'existing');
  assert.equal(result.runId, IDS.runId);
  assert.equal(result.attemptId, IDS.attemptId);
  assert.equal(result.runStatus, 'queued');
  assert.equal(
    calls.some(({ sql }) => sql.startsWith('INSERT INTO')),
    false,
  );
});

test('rejects stale authentication and changed authorization inside the transaction', async () => {
  const stale = fixture();
  await assert.rejects(
    stale.repository.retryRun(
      command({
        principal: {
          ...command().principal,
          authenticatedAtMs: 600_000,
        },
      }),
    ),
    (error) =>
      error instanceof RunManualRetryFenceRejectedError &&
      error.reason === 'authentication_changed',
  );
  assert.equal(
    stale.calls.some(({ sql }) => sql === 'ROLLBACK'),
    true,
  );
  assert.equal(
    stale.calls.some(({ sql }) => sql.includes('lock_run_management_policy_fence')),
    false,
  );

  const changed = fixture({ authorizationMatches: false });
  await assert.rejects(
    changed.repository.retryRun(command()),
    (error) =>
      error instanceof RunManualRetryFenceRejectedError &&
      error.reason === 'authorization_changed',
  );
});

test('uses the durable Run ledger for the per-project User quota', async () => {
  const rateRows = Array.from(
    { length: CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT },
    (_, index) => ({ createdAtMs: 999_000 - index }),
  );
  const { calls, repository } = fixture({ rateRows });
  await assert.rejects(
    repository.retryRun(command()),
    (error) =>
      error instanceof RunManualRetryRateLimitedError &&
      error.retryAfterMs === 58_937,
  );
  assert.equal(
    calls.some(({ sql }) => sql.startsWith('INSERT INTO')),
    false,
  );
  assert.equal(
    calls.some(({ sql }) => sql === 'ROLLBACK'),
    true,
  );
});

test('retries one serializable conflict with a fresh connection', async () => {
  const { calls, repository } = fixture({ failFirstBegin: true });
  const result = await repository.retryRun(command());
  assert.equal(result.status, 'accepted');
  assert.deepEqual(
    [...new Set(calls.map(({ connection }) => connection))],
    [1, 2],
  );
  assert.equal(calls.filter(({ sql }) => sql === 'RELEASE').length, 2);
});
