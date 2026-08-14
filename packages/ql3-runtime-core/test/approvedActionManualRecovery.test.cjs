const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  approvedActionDispatchDigest,
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
  ApprovedActionManualRecoveryAuthorizationError,
  ApprovedActionManualRecoveryFenceConflictError,
  ApprovedActionManualRecoveryUnsupportedError,
  createApprovedActionManualRecoveryService,
  normalizeApprovedActionManualRecoverySnapshot,
} = require('@qinglong/runtime-core/approved-action-manual-recovery');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'oidc:session-1',
  authenticatedAtMs: 100,
  expiresAtMs: 20_000,
  assurance: 'hardware',
});

function executing(actionType = 'plugin_package.secret_binding.bind') {
  const action = {
    permission: 'secret.manage',
    actionType,
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
  const baseline = createApprovedActionExecution(dispatch);
  const leased = claimApprovedActionExecution(baseline, {
    owner: 'executor-1',
    leaseToken: 'lease-1',
    nowMs: 1_000,
    leaseDurationMs: 500,
  });
  const started = startApprovedActionExecution(
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
  assert.equal(started.dispatchDigest, approvedActionDispatchDigest(dispatch));
  return Object.freeze({ dispatch, execution: started });
}

function harness(options = {}) {
  let current = {
    execution: options.execution ?? executing(),
    resolution: null,
  };
  const audits = [];
  const calls = [];
  const service = createApprovedActionManualRecoveryService({
    repository: {
      async findByDispatchId() {
        return current;
      },
      async resolve(command) {
        calls.push(command);
        current = normalizeApprovedActionManualRecoverySnapshot({
          execution: {
            dispatch: command.previous.dispatch,
            execution: command.nextExecution,
          },
          resolution: command.resolution,
        });
        return { status: 'resolved', snapshot: current };
      },
    },
    policy: {
      async authorize(_principal, _projectId, permission) {
        assert.equal(permission, 'approval.recover');
        return options.denied
          ? { effect: 'deny', reasons: ['permission_missing'], fence: null }
          : {
              effect: 'allow',
              reasons: ['role_grant'],
              fence: { projectVersion: 1, bindingVersion: 2 },
            };
      },
    },
    audit: {
      async record(record) {
        audits.push(record);
      },
    },
    now: () => options.now ?? 2_000,
  });
  return { service, audits, calls, current: () => current };
}

function inspectRequest() {
  return {
    projectId: 'default',
    dispatchId: 'dispatch-1',
    auditEventId: '10000000-0000-4000-8000-000000000001',
    requestId: 'recover-inspect-1',
    principal: PRINCIPAL,
  };
}

function resolveRequest(decision = 'abandon_unknown') {
  const snapshot = executing();
  return {
    ...inspectRequest(),
    auditEventId: '10000000-0000-4000-8000-000000000002',
    requestId: 'recover-resolve-1',
    expectedExecutionVersion: snapshot.execution.version,
    expectedExecutionDigest: snapshot.execution.executionDigest,
    mutationId: 'manual-recovery-1',
    decision,
    evidenceDigest: 'e'.repeat(64),
    reasonCode: 'orphan_absence_verified',
  };
}

test('inspects only after strong authorization and writes a bounded audit', async () => {
  const { service, audits } = harness();
  let confirmed = 0;
  const result = await service.inspect(inspectRequest(), () => {
    confirmed += 1;
  });
  assert.equal(result.execution.execution.status, 'executing');
  assert.equal(result.resolution, null);
  assert.equal(confirmed, 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operationId, 'approval.recover.inspect');
  assert.deepEqual(audits[0].reasons, [
    'role_grant',
    'strong_authentication',
    'manual_recovery',
  ]);
});

test('abandons an expired executing action as blocked with immutable evidence', async () => {
  const { service, calls, current } = harness();
  const result = await service.resolve(resolveRequest());
  assert.equal(result.status, 'resolved');
  assert.equal(result.snapshot.execution.execution.status, 'blocked');
  assert.equal(
    result.snapshot.execution.execution.resultCode,
    'manual_recovery_abandoned_unknown',
  );
  assert.equal(result.snapshot.resolution.evidenceDigest, 'e'.repeat(64));
  assert.equal(result.snapshot.resolution.decision, 'abandon_unknown');
  assert.equal(calls[0].audit.operationId, 'approval.recover.resolve');
  assert.equal(current().resolution.resolvedBy.id, 'owner-1');
});

test('confirms a verified no-effect execution as failed and replays exactly', async () => {
  const { service } = harness();
  const request = resolveRequest('confirm_failed');
  const first = await service.resolve(request);
  const replay = await service.resolve(request);
  assert.equal(first.snapshot.execution.execution.status, 'failed');
  assert.equal(replay.status, 'existing');
  assert.equal(
    replay.snapshot.execution.execution.resultCode,
    'manual_recovery_confirmed_failed',
  );
  await assert.rejects(
    service.resolve({ ...request, evidenceDigest: 'f'.repeat(64) }),
    ApprovedActionManualRecoveryFenceConflictError,
  );
});

test('rejects live leases, stale fences, unsupported actions and weak Users', async () => {
  const live = executing();
  const { service: liveService } = harness({ execution: live, now: 1_200 });
  await assert.rejects(
    liveService.resolve({
      ...resolveRequest(),
      expectedExecutionVersion: live.execution.version,
      expectedExecutionDigest: live.execution.executionDigest,
    }),
    ApprovedActionManualRecoveryFenceConflictError,
  );

  const { service: unsupported } = harness({
    execution: executing('tool.invoke'),
  });
  await assert.rejects(
    unsupported.inspect(inspectRequest()),
    ApprovedActionManualRecoveryUnsupportedError,
  );

  const { service: weak } = harness();
  await assert.rejects(
    weak.inspect({
      ...inspectRequest(),
      principal: { ...PRINCIPAL, assurance: 'single_factor' },
    }),
    ApprovedActionManualRecoveryAuthorizationError,
  );
});

test('rejects missing approval.recover permission before storage mutation', async () => {
  const { service, calls } = harness({ denied: true });
  await assert.rejects(
    service.resolve(resolveRequest()),
    ApprovedActionManualRecoveryAuthorizationError,
  );
  assert.equal(calls.length, 0);
});
