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

function fixture(role = 'operator') {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      calls.push({ scope: 'pool', sql: text, params });
      if (text.includes('LEFT JOIN LATERAL')) return { rows: [policyRow(role)] };
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
          ) return { rows: [], rowCount: 0 };
          if (text.includes('statement_timestamp()')) {
            return { rows: [{ nowMs: NOW }], rowCount: 1 };
          }
          if (text.includes('lock_run_management_policy_fence')) {
            return { rows: [{ matches: true }], rowCount: 1 };
          }
          if (text.includes('idempotency_key = $2')) return { rows: [] };
          if (text.includes('WHERE run.id = $1')) {
            return {
              rows: [{
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
              }],
            };
          }
          if (text.includes('FROM "ql3"."task_definitions"')) {
            return { rows: [{ enabled: true }] };
          }
          if (text.includes('task_execution_revisions')) {
            return { rows: [{ sourceContentDigest: SOURCE_DIGEST, contentDigest: EXECUTION_DIGEST }] };
          }
          if (text.startsWith('SELECT') && text.includes("trigger_type = 'run_manual_retry'")) {
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
  const runInsert = calls.find(({ sql }) => sql.startsWith('INSERT INTO "ql3"."runs"'));
  assert.equal(runInsert.params[0], GENERATED[0]);
  assert.equal(runInsert.params.includes(GENERATED[2]), false);
  assert.equal(
    calls.some(({ sql }) => sql.includes('lock_run_management_policy_fence')),
    true,
  );
});

test('denied policy writes only the caller-supplied failure audit', async () => {
  const { calls, service } = fixture('viewer');
  await assert.rejects(service.retry(request()), ClusterRunManagementAuthorizationError);
  const audits = calls.filter(({ sql }) =>
    sql.startsWith('INSERT INTO "ql3"."security_audit_events"'),
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].params[0], request().failureAuditEventId);
  assert.equal(calls.some(({ scope }) => scope === 'client'), false);
});
