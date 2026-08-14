const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  approvalRequestDigest,
  approvedActionDispatchDigest,
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  createApprovedActionManualRecoveryService,
} = require('@qinglong/runtime-core/approved-action-manual-recovery');
const { ProjectPolicyEngine } = require('@qinglong/runtime-core/project-policy');
const {
  assertPostgresApprovalManagerSchemaReady,
  createPostgresDatabaseOpener,
  PostgresApprovedActionManualRecoveryRepository,
  PostgresProjectPolicyRepository,
  PostgresSecurityAuditRepository,
} = require('@qinglong/cluster-postgres/approval-manager');
const {
  PostgresApprovedActionExecutionRepository,
} = require('../dist/approved-action/approvedActionExecutionRepository');
const { runPostgresMigrations } = require('../dist/migration/migration');

const migrationConnectionString = process.env.QL3_TEST_POSTGRES_MIGRATION_URL;
const approvalManagerConnectionString =
  process.env.QL3_TEST_POSTGRES_APPROVAL_MANAGER_URL;

async function open(role, connectionString) {
  return createPostgresDatabaseOpener({
    role,
    connection: { connectionString, tls: { mode: 'disable' } },
    pool: {
      maxConnections: 1,
      applicationName: `ql3-manual-recovery-${role}`,
    },
    onPoolError(error) {
      throw error;
    },
  })();
}

async function insertFixture(pool, namespace) {
  const projectId = `${namespace}-project`;
  const principal = Object.freeze({
    subject: Object.freeze({ type: 'user', id: `${namespace}-owner` }),
    authenticationId: `${namespace}-session`,
    authenticatedAtMs: 100,
    expiresAtMs: 20_000,
    assurance: 'hardware',
  });
  const action = Object.freeze({
    permission: 'secret.manage',
    actionType: 'plugin_package.secret_binding.bind',
    actionRef: `${namespace}:secret-binding`,
    actionDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
  });
  const pending = createApprovalRequest({
    id: `${namespace}-approval`,
    projectId,
    action,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: `${namespace}-agent` },
    requestedAtMs: 800,
    expiresAtMs: 10_000,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: `${namespace}-decision`,
    decision: 'approved',
    reasonCode: 'reviewed',
    principal,
    decidedAtMs: 900,
    authorizationFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const consumed = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: `${namespace}-consumption`,
    dispatchId: `${namespace}-dispatch`,
    action,
    requestedBy: pending.requestedBy,
    consumedBy: { type: 'system', id: 'package-executor' },
    consumedAtMs: 950,
    authorizationFence: { projectVersion: 1, bindingVersion: 1 },
  });
  await pool.query(
    `INSERT INTO "ql3"."projects" (
       id, name, slug, status, version, created_at_ms, updated_at_ms
     ) VALUES ($1, $1, $2, 'active', 1, 1, 1)`,
    [projectId, projectId.replace(/[^a-z0-9-]/g, '-')],
  );
  await pool.query(
    `INSERT INTO "ql3"."project_role_bindings" (
       project_id, subject_type, subject_id, version, state, role,
       mutation_id, changed_by_type, changed_by_id, created_at_ms
     ) VALUES ($1, 'user', $2, 1, 'active', 'owner', $3, 'system',
       'integration-fixture', 2)`,
    [projectId, principal.subject.id, `${namespace}-binding`],
  );
  const request = consumed.request;
  await pool.query(
    `INSERT INTO "ql3"."approval_requests" (
       request_id, project_id, version, state, action_type, action_ref,
       action_digest, preview_digest, requested_by_type, requested_by_id,
       decision_id, consumption_id, dispatch_id, expires_at_ms, request_json,
       request_digest, updated_at_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15::jsonb, $16, $17
     )`,
    [
      request.id,
      request.projectId,
      request.version,
      request.state,
      request.action.actionType,
      request.action.actionRef,
      request.action.actionDigest,
      request.action.previewDigest,
      request.requestedBy.type,
      request.requestedBy.id,
      request.decisionId,
      request.consumptionId,
      request.dispatchId,
      request.expiresAtMs,
      JSON.stringify(request),
      approvalRequestDigest(request),
      request.consumedAtMs,
    ],
  );
  const dispatch = consumed.dispatch;
  await pool.query(
    `INSERT INTO "ql3"."approved_action_dispatches" (
       dispatch_id, approval_request_id, project_id, action_type, action_ref,
       action_digest, preview_digest, dispatch_json, dispatch_digest,
       created_at_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      dispatch.id,
      dispatch.approvalRequestId,
      dispatch.projectId,
      dispatch.action.actionType,
      dispatch.action.actionRef,
      dispatch.action.actionDigest,
      dispatch.action.previewDigest,
      JSON.stringify(dispatch),
      approvedActionDispatchDigest(dispatch),
      dispatch.createdAtMs,
    ],
  );
  const executions = new PostgresApprovedActionExecutionRepository(pool);
  await pool.query(
    `INSERT INTO "ql3"."approved_action_executions" (
       dispatch_id, dispatch_digest, project_id, status, version,
       attempt_count, max_attempts, eligible_at_ms, next_attempt_at_ms,
       lease_owner, lease_token, lease_expires_at_ms, started_at_ms,
       result_mutation_id, result_code, result_digest, completed_at_ms,
       created_at_ms, updated_at_ms, execution_json, execution_digest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21)`,
    (() => {
      const value = createApprovedActionExecution(dispatch);
      return [
        value.dispatchId, value.dispatchDigest, value.projectId, value.status,
        value.version, value.attemptCount, value.maxAttempts, value.eligibleAtMs,
        value.nextAttemptAtMs, value.leaseOwner, value.leaseToken,
        value.leaseExpiresAtMs, value.startedAtMs, value.resultMutationId,
        value.resultCode, value.resultDigest, value.completedAtMs,
        value.createdAtMs, value.updatedAtMs, JSON.stringify(value),
        value.executionDigest,
      ];
    })(),
  );
  const claimed = await executions.claimExecution({
    dispatchId: dispatch.id,
    owner: `${namespace}-executor`,
    leaseToken: `${namespace}-lease`,
    nowMs: 1_000,
    leaseDurationMs: 500,
  });
  const started = await executions.startExecution({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: `${namespace}-executor`,
    leaseToken: `${namespace}-lease`,
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: 1_100,
  });
  return { projectId, principal, dispatch, execution: started.execution };
}

if (!migrationConnectionString || !approvalManagerConnectionString) {
  test('PostgreSQL manual recovery gate requires migration and Approval manager URLs', {
    skip: true,
  });
} else {
  test('PostgreSQL atomically resolves and exactly replays an expired Secret Action', async () => {
    const migration = await open('migration', migrationConnectionString);
    let manager;
    try {
      await runPostgresMigrations({ pool: migration.pool });
      manager = await open('approval-manager', approvalManagerConnectionString);
      const readiness = await assertPostgresApprovalManagerSchemaReady(manager.pool);
      assert.equal(readiness.contractVersion, 64);
      const namespace = `recovery-${process.pid}-${Date.now()}`;
      const fixture = await insertFixture(migration.pool, namespace);
      const service = createApprovedActionManualRecoveryService({
        repository: new PostgresApprovedActionManualRecoveryRepository(manager.pool),
        policy: new ProjectPolicyEngine(
          new PostgresProjectPolicyRepository(manager.pool),
        ),
        audit: new PostgresSecurityAuditRepository(manager.pool),
        now: () => 2_000,
      });
      const inspected = await service.inspect({
        projectId: fixture.projectId,
        dispatchId: fixture.dispatch.id,
        requestId: `${namespace}-inspect`,
        auditEventId: '80000000-0000-4000-8000-000000000001',
        principal: fixture.principal,
      });
      assert.equal(inspected.execution.execution.status, 'executing');
      const request = {
        projectId: fixture.projectId,
        dispatchId: fixture.dispatch.id,
        expectedExecutionVersion: fixture.execution.version,
        expectedExecutionDigest: fixture.execution.executionDigest,
        mutationId: `${namespace}-mutation`,
        decision: 'abandon_unknown',
        evidenceDigest: 'e'.repeat(64),
        reasonCode: 'orphan_absence_verified',
        requestId: `${namespace}-resolve`,
        auditEventId: '80000000-0000-4000-8000-000000000002',
        principal: fixture.principal,
      };
      const first = await service.resolve(request);
      const replay = await service.resolve(request);
      assert.equal(first.status, 'resolved');
      assert.equal(replay.status, 'existing');
      assert.equal(first.snapshot.execution.execution.status, 'blocked');
      assert.equal(first.snapshot.resolution.decision, 'abandon_unknown');
      const persisted = await migration.pool.query(
        `SELECT
           (SELECT count(*)::integer FROM "ql3"."approved_action_manual_recovery_resolutions"
             WHERE dispatch_id = $1) AS "resolutionCount",
           (SELECT count(*)::integer FROM "ql3"."security_audit_events"
             WHERE event_id = $2) AS "auditCount"`,
        [fixture.dispatch.id, request.auditEventId],
      );
      assert.deepEqual(persisted.rows[0], { resolutionCount: 1, auditCount: 1 });
      await assert.rejects(
        manager.pool.query(
          `UPDATE "ql3"."approved_action_executions" SET status = 'failed'
            WHERE dispatch_id = $1`,
          [fixture.dispatch.id],
        ),
        (error) => error && error.code === '42501',
      );
    } finally {
      if (manager) await manager.close();
      await migration.close();
    }
  });
}
