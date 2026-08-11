const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  ApprovedActionExecutionFenceConflictError,
  InvalidApprovedActionExecutionError,
  approvedActionExecutionEffectiveStatus,
  claimApprovedActionExecution,
  completeApprovedActionExecution,
  createApprovedActionExecution,
  normalizeApprovedActionExecutionRecord,
  normalizeApprovedActionExecutionSnapshot,
  releaseApprovedActionExecutionBeforeStart,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'package_dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function dispatch() {
  const action = {
    permission: 'package.manage',
    actionType: 'plugin_package.install',
    actionRef: 'proposal:monitor-v1',
    actionDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
  };
  const pending = createApprovalRequest({
    id: 'approval-monitor-v1',
    projectId: 'default',
    action,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 10,
    expiresAtMs: 10_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-monitor-v1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REQUESTER,
      authenticationId: 'auth-owner-step-up',
      authenticatedAtMs: 15,
      expiresAtMs: 5_000,
      assurance: 'local_console',
    },
    decidedAtMs: 20,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-monitor-v1',
    dispatchId: 'dispatch-monitor-v1',
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  }).dispatch;
}

test('persists a pending baseline before claim and a durable start barrier before success', () => {
  const approvedDispatch = dispatch();
  const pending = createApprovedActionExecution(approvedDispatch);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.version, 0);
  assert.equal(pending.eligibleAtMs, approvedDispatch.createdAtMs);
  assert.deepEqual(
    normalizeApprovedActionExecutionSnapshot({
      dispatch: approvedDispatch,
      execution: pending,
    }).execution,
    pending,
  );

  const leased = claimApprovedActionExecution(pending, {
    owner: 'admin-1',
    leaseToken: 'lease-1',
    nowMs: 40,
    leaseDurationMs: 1_000,
  });
  assert.equal(leased.status, 'leased');
  assert.equal(leased.attemptCount, 1);

  const executing = startApprovedActionExecution(
    { dispatch: approvedDispatch, execution: leased },
    {
      dispatchId: approvedDispatch.id,
      approvalRequestId: approvedDispatch.approvalRequestId,
      actionDigest: approvedDispatch.action.actionDigest,
      owner: 'admin-1',
      leaseToken: 'lease-1',
      expectedVersion: leased.version,
      startedAtMs: 50,
    },
  );
  assert.equal(executing.status, 'executing');
  assert.equal(executing.startedAtMs, 50);

  const succeeded = completeApprovedActionExecution(executing, {
    owner: 'admin-1',
    leaseToken: 'lease-1',
    expectedVersion: executing.version,
    resultMutationId: 'complete-1',
    outcome: 'succeeded',
    resultCode: 'package_admitted',
    resultDigest: 'c'.repeat(64),
    completedAtMs: 1_100,
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.resultDigest, 'c'.repeat(64));
  assert.deepEqual(
    normalizeApprovedActionExecutionRecord(succeeded),
    succeeded,
  );
});

test('never blindly takes over an execution after its start lease expires', () => {
  const approvedDispatch = dispatch();
  const leased = claimApprovedActionExecution(
    createApprovedActionExecution(approvedDispatch),
    {
      owner: 'admin-1',
      leaseToken: 'lease-1',
      nowMs: 40,
      leaseDurationMs: 100,
    },
  );
  const executing = startApprovedActionExecution(
    { dispatch: approvedDispatch, execution: leased },
    {
      dispatchId: approvedDispatch.id,
      approvalRequestId: approvedDispatch.approvalRequestId,
      actionDigest: approvedDispatch.action.actionDigest,
      owner: 'admin-1',
      leaseToken: 'lease-1',
      expectedVersion: leased.version,
      startedAtMs: 50,
    },
  );
  assert.equal(
    approvedActionExecutionEffectiveStatus(executing, 140),
    'recovery_required',
  );
  assert.throws(
    () =>
      claimApprovedActionExecution(executing, {
        owner: 'admin-2',
        leaseToken: 'lease-2',
        nowMs: 140,
        leaseDurationMs: 100,
      }),
    { code: 'APPROVED_ACTION_EXECUTION_STATE_CONFLICT' },
  );
});

test('retries only before start and blocks on exhausted or indeterminate work', () => {
  const approvedDispatch = dispatch();
  const leased = claimApprovedActionExecution(
    createApprovedActionExecution(approvedDispatch, 2),
    {
      owner: 'admin-1',
      leaseToken: 'lease-1',
      nowMs: 40,
      leaseDurationMs: 100,
    },
  );
  const retrying = releaseApprovedActionExecutionBeforeStart(leased, {
    owner: 'admin-1',
    leaseToken: 'lease-1',
    expectedVersion: leased.version,
    resultMutationId: 'release-1',
    resultCode: 'proposal_unavailable',
    atMs: 50,
    retryAtMs: 70,
  });
  assert.equal(retrying.status, 'retry_wait');

  const finalLease = claimApprovedActionExecution(retrying, {
    owner: 'admin-2',
    leaseToken: 'lease-2',
    nowMs: 70,
    leaseDurationMs: 100,
  });
  const blocked = releaseApprovedActionExecutionBeforeStart(finalLease, {
    owner: 'admin-2',
    leaseToken: 'lease-2',
    expectedVersion: finalLease.version,
    resultMutationId: 'release-2',
    resultCode: 'proposal_unavailable',
    atMs: 80,
    retryAtMs: 90,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.startedAtMs, null);

  assert.throws(
    () =>
      completeApprovedActionExecution(finalLease, {
        owner: 'admin-2',
        leaseToken: 'lease-2',
        expectedVersion: finalLease.version,
        resultMutationId: 'complete-2',
        outcome: 'succeeded',
        resultCode: 'package_admitted',
        completedAtMs: 90,
      }),
    ApprovedActionExecutionFenceConflictError,
  );
});

test('detects persisted execution digest drift', () => {
  const record = createApprovedActionExecution(dispatch());
  assert.throws(
    () =>
      normalizeApprovedActionExecutionRecord({
        ...record,
        maxAttempts: record.maxAttempts + 1,
      }),
    InvalidApprovedActionExecutionError,
  );
});
