'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterRunManagementAuthorizationError,
  createClusterRunManagementService,
} = require('@qinglong/cluster-admin/run-management');

const NOW = 1_000_000;
const SOURCE_DIGEST = 'a'.repeat(64);
const EXECUTION_DIGEST = 'b'.repeat(64);
const TASK_REVISION = `qltd:v1:7:${SOURCE_DIGEST}`;
const GENERATED = [
  '019f9500-0000-4000-8000-000000000010',
  '019f9500-0000-4000-8000-000000000011',
  '019f9500-0000-4000-8000-000000000012',
  '019f9500-0000-4000-8000-000000000013',
];

function request() {
  return {
    projectId: 'project-1',
    sourceRunId: 'source-run-1',
    mutationId: '019f9500-0000-4000-8000-000000000001',
    expectedRunVersion: 7,
    expectedRunStatus: 'failed',
    requestId: 'request-1',
    auditEventId: '019f9500-0000-4000-8000-000000000002',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000003',
    principal: {
      subject: { type: 'user', id: 'operator-1' },
      authenticationId: 'oidc:run-management-1',
      authenticatedAtMs: 999_000,
      expiresAtMs: 1_100_000,
      assurance: 'multi_factor',
    },
  };
}

function policyRow(role = 'operator') {
  return {
    projectId: 'project-1',
    projectName: 'Project 1',
    projectSlug: 'project-1',
    projectStatus: 'active',
    projectVersion: 2,
    projectCreatedAtMs: '1',
    projectUpdatedAtMs: '2',
    bindingProjectId: 'project-1',
    bindingSubjectType: 'user',
    bindingSubjectId: 'operator-1',
    bindingVersion: 3,
    bindingState: 'active',
    bindingRole: role,
    bindingMutationId: 'binding-3',
    bindingChangedByType: 'user',
    bindingChangedById: 'owner-1',
    bindingCreatedAtMs: '3',
  };
}

function fixture(role = 'operator', options = {}) {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ scope: 'pool', sql: text, params });
      if (text.includes('LEFT JOIN LATERAL'))
        return { rows: [policyRow(role)] };
      if (text.startsWith('INSERT INTO "ql3"."security_audit_events"')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected pool query: ${text}`);
    },
    async connect() {
      return {
        async query(sql, params = []) {
          const text = sql.replace(/\s+/g, ' ').trim();
          calls.push({ scope: 'client', sql: text, params });
          if (
            text === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
            text === 'COMMIT' ||
            text === 'ROLLBACK' ||
            text.startsWith('SELECT set_config')
          )
            return { rows: [], rowCount: 0 };
          if (
            text.includes('statement_timestamp()') ||
            text.includes('transaction_timestamp()')
          ) {
            return { rows: [{ nowMs: NOW }], rowCount: 1 };
          }
          if (text.includes('lock_run_management_policy_fence')) {
            return { rows: [{ matches: true }], rowCount: 1 };
          }
          if (text.includes('FROM "ql3"."runs" WHERE id = $1 FOR UPDATE')) {
            if (!text.includes('cancel_reason AS "cancelReason"')) {
              return {
                rows: [
                  {
                    projectId: 'project-1',
                    runStatus: 'running',
                    runVersion: 6,
                    eventSequence: 8,
                    cancelRequestedAtMs: NOW - 2_000,
                  },
                ],
                rowCount: 1,
              };
            }
            return {
              rows: [
                {
                  projectId: 'project-1',
                  runStatus: 'running',
                  runVersion: 4,
                  eventSequence: 6,
                  cancelRequestedAtMs: null,
                  cancelReason: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (text.startsWith('UPDATE "ql3"."runs"')) {
            return {
              rows: [
                {
                  projectId: 'project-1',
                  runStatus: 'running',
                  runVersion: 5,
                  eventSequence: 7,
                  cancelRequestedAtMs: NOW,
                  cancelReason: 'user',
                },
              ],
              rowCount: 1,
            };
          }
          if (
            text.includes('FROM "ql3"."runs" WHERE id = $1') &&
            !text.includes('FOR UPDATE')
          ) {
            return {
              rows: [
                {
                  projectId: 'project-1',
                  runStatus: 'running',
                  runVersion: 6,
                  eventSequence: 8,
                  cancelRequestedAtMs: NOW - 2_000,
                  cancelReason: 'user',
                },
              ],
              rowCount: 1,
            };
          }
          if (
            text.includes('FROM "ql3"."run_events"') &&
            text.includes('dedupe_key = $2')
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (
            text.includes('FROM "ql3"."run_cancellation_dispatches" AS dispatch')
          ) {
            return {
              rows: [
                {
                  total: '5',
                  pending: '1',
                  leased: '1',
                  retryWait: '1',
                  dispatched: '1',
                  blocked: '1',
                  due: '1',
                  expiredLease: '1',
                  identityMismatch: '1',
                  pidMismatch: '0',
                  unsupported: '0',
                  invalid: '0',
                  oldestBlockedAtMs: String(NOW - 1_500),
                },
              ],
              rowCount: 1,
            };
          }
          if (
            text.startsWith(
              'SELECT run_id AS "runId", updated_at_ms AS "blockedAtMs"',
            )
          ) {
            return {
              rows: [
                { runId: 'run-1', blockedAtMs: String(NOW - 1_500) },
              ],
              rowCount: 1,
            };
          }
          if (
            text.startsWith('SELECT attempt_id AS "attemptId"') &&
            text.includes('FROM "ql3"."run_cancellation_dispatches"') &&
            !text.includes('dispatchStatus') &&
            !text.includes('FOR UPDATE')
          ) {
            return { rows: [{ attemptId: 'attempt-1' }], rowCount: 1 };
          }
          if (text.includes('WHERE run.id = $1')) {
            return {
              rows: [
                {
                  projectId: 'project-1',
                  taskId: 'task-1',
                  taskRevision: TASK_REVISION,
                  taskName: 'Task 1',
                  taskSnapshotRef: TASK_REVISION,
                  parentRunId: null,
                  triggerType: 'task_start',
                  executionOwner: 'runtime',
                  inputRef: null,
                  priority: 1,
                  runStatus: 'failed',
                  runVersion: 7,
                  attemptExecutorType: 'remote_worker',
                },
              ],
            };
          }
          if (text.includes('FROM "ql3"."run_attempts"')) {
            return { rows: [{ attemptStatus: 'running' }], rowCount: 1 };
          }
          if (
            text.includes('FROM "ql3"."run_cancellation_dispatches"') &&
            text.includes('FOR UPDATE')
          ) {
            return {
              rows: [
                {
                  attemptId: 'attempt-1',
                  dispatchStatus: 'blocked',
                  dispatchVersion: 3,
                  lastResult: options.lastResult ?? 'identity_mismatch',
                },
              ],
              rowCount: 1,
            };
          }
          if (text.includes('FROM "ql3"."run_cancellation_dispatches"')) {
            return {
              rows: [
                {
                  attemptId: 'attempt-1',
                  dispatchStatus: 'blocked',
                  dispatchVersion: 3,
                  dispatchCount: 1,
                  nextAttemptAtMs: null,
                  leaseExpiresAtMs: null,
                  lastResult: options.lastResult ?? 'identity_mismatch',
                  lastDispatchedAtMs: NOW - 1_500,
                  dispatchCreatedAtMs: NOW - 1_900,
                  dispatchUpdatedAtMs: NOW - 1_500,
                },
              ],
              rowCount: 1,
            };
          }
          if (
            text.startsWith(
              'UPDATE "ql3"."run_cancellation_dispatches"',
            )
          ) {
            return { rows: [], rowCount: 1 };
          }
          if (
            text.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
            text.includes('RETURNING event_id')
          ) {
            return { rows: [{ eventId: request().auditEventId }], rowCount: 1 };
          }
          if (text.includes('idempotency_key = $2')) return { rows: [] };
          if (text.includes('FROM "ql3"."task_definitions"')) {
            return { rows: [{ enabled: true }] };
          }
          if (text.includes('task_execution_revisions')) {
            return {
              rows: [
                {
                  sourceContentDigest: SOURCE_DIGEST,
                  contentDigest: EXECUTION_DIGEST,
                },
              ],
            };
          }
          if (
            text.startsWith('SELECT') &&
            text.includes("trigger_type = 'run_manual_retry'")
          ) {
            return { rows: [] };
          }
          if (text.startsWith('INSERT INTO')) return { rows: [], rowCount: 1 };
          throw new Error(`unexpected client query: ${text}`);
        },
        release() {},
      };
    },
  };
  let index = 0;
  return {
    calls,
    service: createClusterRunManagementService({
      pool,
      now: () => NOW,
      randomUuid: () => GENERATED[index++],
    }),
  };
}

test('authorizes run.retry and keeps all generated aggregate identities server-side', async () => {
  const { calls, service } = fixture();
  const result = await service.retry(request());
  assert.equal(result.status, 'accepted');
  assert.equal(result.runId, GENERATED[0]);
  assert.equal(result.attemptId, GENERATED[1]);
  const runInsert = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."runs"'),
  );
  assert.equal(runInsert.params[0], GENERATED[0]);
  assert.equal(runInsert.params.includes(GENERATED[2]), false);
  assert.equal(
    calls.some(({ sql }) => sql.includes('lock_run_management_policy_fence')),
    true,
  );
});

test('denied policy writes only the caller-supplied failure audit', async () => {
  const { calls, service } = fixture('viewer');
  await assert.rejects(
    service.retry(request()),
    ClusterRunManagementAuthorizationError,
  );
  const audits = calls.filter(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."security_audit_events"'),
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params[0], request().failureAuditEventId);
  assert.equal(
    calls.some(({ scope }) => scope === 'client'),
    false,
  );
});

test('authorizes run.stop and commits intent plus allowed audit together', async () => {
  const { calls, service } = fixture();
  const stopRequest = {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: '019f9500-0000-4000-8000-000000000021',
    requestId: 'request-stop-1',
    auditEventId: '019f9500-0000-4000-8000-000000000022',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000023',
    principal: request().principal,
  };
  const result = await service.stop(stopRequest);
  assert.equal(result.status, 'accepted');
  assert.equal(result.cancelRequestedAtMs, NOW);
  const event = calls.find(
    ({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."run_events"') &&
      sql.includes('run.cancel_requested'),
  );
  assert.equal(event.params[0], GENERATED[0]);
  const allowedAudit = calls.find(
    ({ sql }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      sql.includes("'run.stop'"),
  );
  assert.equal(allowedAudit.params[0], stopRequest.auditEventId);
  assert.ok(
    calls.findIndex(({ sql }) => sql.includes("'run.stop'")) <
      calls.findIndex(({ sql }) => sql === 'COMMIT'),
  );
});

test('allows a viewer to inspect only low-sensitive cancellation state', async () => {
  const { calls, service } = fixture('viewer');
  const inspectRequest = {
    projectId: 'project-1',
    runId: 'run-1',
    requestId: 'request-inspect-1',
    auditEventId: '019f9500-0000-4000-8000-000000000031',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000032',
    principal: request().principal,
  };
  const result = await service.inspectCancellation(inspectRequest);
  assert.equal(result.operatorAction, 'rearm');
  assert.equal(result.dispatch.lastResult, 'identity_mismatch');
  assert.equal(JSON.stringify(result).includes('leaseOwner'), false);
  assert.equal(JSON.stringify(result).includes('leaseToken'), false);
  const audit = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      params[2] === 'run.cancellation.inspect',
  );
  assert.equal(audit.params[0], inspectRequest.auditEventId);
});

test('allows a viewer to summarize Project cancellation availability atomically', async () => {
  const { calls, service } = fixture('viewer');
  const summaryRequest = {
    projectId: 'project-1',
    requestId: 'request-summary-1',
    auditEventId: '019f9500-0000-4000-8000-000000000061',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000062',
    principal: request().principal,
  };
  const result = await service.summarizeCancellation(summaryRequest);
  assert.equal(result.assessment, 'attention_required');
  assert.equal(result.operatorAction, 'inspect');
  assert.equal(result.dispatches.blocked, 1);
  assert.equal(result.blockingResults.identityMismatch, 1);
  assert.equal(Object.hasOwn(result, 'runId'), false);
  assert.equal(JSON.stringify(result).includes('attemptId'), false);
  const aggregate = calls.find(({ sql }) =>
    sql.includes('FROM "ql3"."run_cancellation_dispatches" AS dispatch'),
  );
  assert.deepEqual(aggregate.params, ['project-1', NOW]);
  const audit = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      params[2] === 'run.cancellation.summary',
  );
  assert.equal(audit.params[0], summaryRequest.auditEventId);
  assert.ok(
    calls.indexOf(audit) < calls.findIndex(({ sql }) => sql === 'COMMIT'),
  );
});

test('allows a viewer to page blocked Run identities under run.read', async () => {
  const { calls, service } = fixture('viewer');
  const listRequest = {
    projectId: 'project-1',
    requestId: 'request-blocked-1',
    auditEventId: '019f9500-0000-4000-8000-000000000071',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000072',
    principal: request().principal,
  };
  const result = await service.listBlockedCancellations(listRequest);
  assert.deepEqual(result.items, [
    { runId: 'run-1', blockedAtMs: NOW - 1_500 },
  ]);
  assert.equal(result.snapshotAtMs, NOW);
  assert.equal(result.truncated, false);
  const list = calls.find(({ sql }) =>
    sql.startsWith(
      'SELECT run_id AS "runId", updated_at_ms AS "blockedAtMs"',
    ),
  );
  assert.deepEqual(list.params, ['project-1', NOW, null, '', 17]);
  const audit = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      params[2] === 'run.cancellation.blocked.list',
  );
  assert.equal(audit.params[0], listRequest.auditEventId);
});

test('authorizes exact cancellation rearm and keeps the event identity server-side', async () => {
  const { calls, service } = fixture();
  const rearmRequest = {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: '019f9500-0000-4000-8000-000000000041',
    expectedDispatchVersion: 3,
    expectedLastResult: 'identity_mismatch',
    retryDelayMs: 5_000,
    requestId: 'request-rearm-1',
    auditEventId: '019f9500-0000-4000-8000-000000000042',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000043',
    principal: request().principal,
  };
  const result = await service.rearmCancellation(rearmRequest);
  assert.equal(result.status, 'rearmed');
  assert.equal(result.dispatchVersion, 4);
  const event = calls.find(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."run_events"'),
  );
  assert.equal(event.params[0], GENERATED[0]);
  assert.equal(event.params.includes(rearmRequest.mutationId), false);
  const allowedAudit = calls.find(
    ({ sql, params }) =>
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"') &&
      params[2] === 'run.cancellation.rearm',
  );
  assert.equal(allowedAudit.params[0], rearmRequest.auditEventId);
  assert.ok(
    calls.indexOf(allowedAudit) < calls.findIndex(({ sql }) => sql === 'COMMIT'),
  );
});

test('denies viewer rearm and records stale dispatch conflicts outside the transaction', async () => {
  const rearmRequest = {
    projectId: 'project-1',
    runId: 'run-1',
    mutationId: '019f9500-0000-4000-8000-000000000051',
    expectedDispatchVersion: 3,
    expectedLastResult: 'identity_mismatch',
    retryDelayMs: 5_000,
    requestId: 'request-rearm-conflict-1',
    auditEventId: '019f9500-0000-4000-8000-000000000052',
    failureAuditEventId: '019f9500-0000-4000-8000-000000000053',
    principal: request().principal,
  };

  const viewer = fixture('viewer');
  await assert.rejects(
    viewer.service.rearmCancellation(rearmRequest),
    ClusterRunManagementAuthorizationError,
  );
  assert.equal(
    viewer.calls.some(({ scope }) => scope === 'client'),
    false,
  );

  const stale = fixture('operator', { lastResult: 'pid_mismatch' });
  await assert.rejects(
    stale.service.rearmCancellation(rearmRequest),
    { code: 'CLUSTER_RUN_MANAGEMENT_CONFLICT' },
  );
  const failureAudit = stale.calls.find(
    ({ scope, sql }) =>
      scope === 'pool' &&
      sql.startsWith('INSERT INTO "ql3"."security_audit_events"'),
  );
  assert.equal(failureAudit.params[0], rearmRequest.failureAuditEventId);
  assert.equal(
    failureAudit.params.some(
      (value) =>
        typeof value === 'string' &&
        value.includes('dispatch_result_changed'),
    ),
    true,
  );
});
