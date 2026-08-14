const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  claimApprovedActionExecution,
  createApprovedActionExecution,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  createApprovedActionManualRecoveryService,
} = require('@qinglong/runtime-core/approved-action-manual-recovery');
const {
  PostgresApprovedActionManualRecoveryRepository,
} = require('@qinglong/cluster-postgres/approval-manager');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'oidc:session-1',
  authenticatedAtMs: 100,
  expiresAtMs: 20_000,
  assurance: 'hardware',
});

function executing() {
  const action = {
    permission: 'secret.manage',
    actionType: 'plugin_package.secret_binding.bind',
    actionRef: 'secret-binding:1',
    actionDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
  };
  const pending = createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 800,
    expiresAtMs: 10_000,
    requestFence: { projectVersion: 1, bindingVersion: 2 },
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: PRINCIPAL,
    decidedAtMs: 900,
    authorizationFence: { projectVersion: 1, bindingVersion: 2 },
  });
  const dispatch = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consumption-1',
    dispatchId: 'dispatch-1',
    action,
    requestedBy: pending.requestedBy,
    consumedBy: { type: 'system', id: 'package-executor' },
    consumedAtMs: 950,
    authorizationFence: { projectVersion: 1, bindingVersion: 2 },
  }).dispatch;
  const leased = claimApprovedActionExecution(createApprovedActionExecution(dispatch), {
    owner: 'executor-1',
    leaseToken: 'lease-1',
    nowMs: 1_000,
    leaseDurationMs: 500,
  });
  const execution = startApprovedActionExecution(
    { dispatch, execution: leased },
    {
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      actionDigest: dispatch.action.actionDigest,
      owner: leased.leaseOwner,
      leaseToken: leased.leaseToken,
      expectedVersion: leased.version,
      startedAtMs: 1_100,
    },
  );
  return { dispatch, execution };
}

test('resolves through the bounded PostgreSQL function and verifies the stored tuple', async () => {
  const initial = executing();
  let stored = { ...initial, resolution: null };
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push([text, values]);
      if (text.includes('resolve_approved_action_manual_recovery')) {
        stored = {
          dispatch: initial.dispatch,
          execution: JSON.parse(values[1]),
          resolution: JSON.parse(values[0]),
        };
        return { rows: [{ status: 'resolved' }] };
      }
      if (text.includes('approved_action_manual_recovery_resolutions')) {
        return {
          rows: [
            {
              dispatchJson: stored.dispatch,
              executionJson: stored.execution,
              executionDigest: stored.execution.executionDigest,
              resolutionJson: stored.resolution,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async connect() {
      throw new Error('repository must not open a broad transaction');
    },
  };
  const repository = new PostgresApprovedActionManualRecoveryRepository(pool);
  const service = createApprovedActionManualRecoveryService({
    repository,
    policy: {
      async authorize(_principal, _projectId, permission) {
        assert.equal(permission, 'approval.recover');
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 1, bindingVersion: 2 },
        };
      },
    },
    audit: { async record() {} },
    now: () => 2_000,
  });
  const result = await service.resolve({
    projectId: 'default',
    dispatchId: 'dispatch-1',
    expectedExecutionVersion: initial.execution.version,
    expectedExecutionDigest: initial.execution.executionDigest,
    mutationId: 'manual-recovery-1',
    decision: 'abandon_unknown',
    evidenceDigest: 'e'.repeat(64),
    reasonCode: 'orphan_absence_verified',
    auditEventId: '70000000-0000-4000-8000-000000000001',
    requestId: 'manual-recovery-request-1',
    principal: PRINCIPAL,
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.snapshot.execution.execution.status, 'blocked');
  assert.equal(result.snapshot.resolution.decision, 'abandon_unknown');
  assert.equal(
    calls.filter(([sql]) => sql.includes('resolve_approved_action_manual_recovery'))
      .length,
    1,
  );
});
