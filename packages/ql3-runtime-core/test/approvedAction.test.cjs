const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  APPROVAL_REQUEST_SCHEMA,
  APPROVED_ACTION_DISPATCH_SCHEMA,
  ApprovalHumanDecisionRequiredError,
  ApprovalMutationConflictError,
  ApprovalRequestExpiredError,
  ApprovalRequestVersionConflictError,
  ApprovalSeparationOfDutyError,
  InvalidApprovedActionValueError,
  approvalRequestEffectiveStatus,
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
  normalizeApprovalRequestRecord,
  normalizeApprovedActionDispatchRecord,
} = require('@qinglong/runtime-core/approved-action');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_reviewer' });
const SYSTEM = Object.freeze({ type: 'system', id: 'approved-dispatcher' });
const FENCE = Object.freeze({ projectVersion: 2, bindingVersion: 3 });

function action(overrides = {}) {
  return {
    permission: 'package.manage',
    actionType: 'plugin_package.install',
    actionRef: 'proposal:pkg-demo-v1',
    actionDigest: DIGEST_A,
    previewDigest: DIGEST_B,
    ...overrides,
  };
}

function request(overrides = {}) {
  return createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action: action(),
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 1_000,
    expiresAtMs: 61_000,
    requestFence: FENCE,
    ...overrides,
  });
}

function principal(subject = REQUESTER, overrides = {}) {
  return {
    subject,
    authenticationId: 'auth-step-up-1',
    authenticatedAtMs: 1_500,
    expiresAtMs: 10_000,
    assurance: 'local_console',
    ...overrides,
  };
}

function approve(current, overrides = {}) {
  return decideApprovalRequest(current, {
    expectedVersion: 1,
    decisionId: 'decision-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: principal(),
    decidedAtMs: 2_000,
    authorizationFence: FENCE,
    ...overrides,
  });
}

function consume(current, overrides = {}) {
  return consumeApprovalRequest(current, {
    expectedVersion: 2,
    consumptionId: 'consume-1',
    dispatchId: 'dispatch-1',
    action: action(),
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 3_000,
    authorizationFence: FENCE,
    ...overrides,
  });
}

test('builds a digest-bound request and reports pending expiry without mutation', () => {
  const created = request();
  assert.equal(created.schema, APPROVAL_REQUEST_SCHEMA);
  assert.equal(created.version, 1);
  assert.equal(created.state, 'pending');
  assert.equal(created.action.permission, 'package.manage');
  assert.equal(approvalRequestEffectiveStatus(created, 60_999), 'pending');
  assert.equal(approvalRequestEffectiveStatus(created, 61_000), 'expired');
  assert.equal(created.state, 'pending');
  assert.throws(
    () => request({ expiresAtMs: 1_000 + 24 * 60 * 60 * 1_000 + 1 }),
    InvalidApprovedActionValueError,
  );
});

test('allows strong same-user confirmation for owner-only edge deployments', () => {
  const decided = approve(request());
  assert.equal(decided.version, 2);
  assert.equal(decided.state, 'approved');
  assert.deepEqual(decided.decidedBy, REQUESTER);
  assert.equal(decided.decisionAssurance, 'local_console');

  const result = consume(decided);
  assert.equal(result.request.version, 3);
  assert.equal(result.request.state, 'consumed');
  assert.equal(result.dispatch.schema, APPROVED_ACTION_DISPATCH_SCHEMA);
  assert.equal(result.dispatch.approvalRequestVersion, 3);
  assert.equal(result.dispatch.action.actionDigest, DIGEST_A);
  assert.equal(result.dispatch.approvedBy.id, REQUESTER.id);
  assert.deepEqual(result.dispatch.approvalFence, FENCE);
  assert.deepEqual(
    normalizeApprovedActionDispatchRecord(result.dispatch),
    result.dispatch,
  );
});

test('enforces separation of duty when the project ceremony requests it', () => {
  const separated = request({ decisionMode: 'separation_of_duty' });
  assert.throws(() => approve(separated), ApprovalSeparationOfDutyError);
  const decided = approve(separated, {
    principal: principal(REVIEWER, {
      authenticationId: 'auth-reviewer-1',
      assurance: 'multi_factor',
    }),
  });
  assert.equal(decided.decidedBy.id, REVIEWER.id);
  assert.equal(decided.decisionAssurance, 'multi_factor');
});

test('rejects weak, service and expired human decision principals', () => {
  for (const candidate of [
    principal(REQUESTER, { assurance: 'single_factor' }),
    principal(
      { type: 'system', id: 'not-human' },
      { assurance: 'service' },
    ),
    principal(REQUESTER, { expiresAtMs: 2_000 }),
  ]) {
    assert.throws(
      () => approve(request(), { principal: candidate }),
      ApprovalHumanDecisionRequiredError,
    );
  }
});

test('provides exact decision and consumption replay while rejecting drift', () => {
  const decided = approve(request());
  assert.deepEqual(approve(decided), decided);
  assert.throws(
    () => approve(decided, { reasonCode: 'changed' }),
    ApprovalMutationConflictError,
  );

  const consumed = consume(decided);
  const replay = consume(consumed.request);
  assert.deepEqual(replay, consumed);
  assert.throws(
    () =>
      consume(consumed.request, {
        action: action({ previewDigest: 'c'.repeat(64) }),
      }),
    ApprovalMutationConflictError,
  );
});

test('fails closed on expiry, stale versions and corrupt persisted tuples', () => {
  assert.throws(
    () =>
      approve(request(), {
        decidedAtMs: 61_000,
        principal: principal(REQUESTER, { expiresAtMs: 70_000 }),
      }),
    ApprovalRequestExpiredError,
  );
  assert.throws(
    () => approve(request(), { expectedVersion: 2 }),
    ApprovalRequestVersionConflictError,
  );
  const decided = approve(request());
  assert.throws(
    () => consume(decided, { consumedAtMs: 61_000 }),
    ApprovalRequestExpiredError,
  );
  assert.throws(
    () =>
      normalizeApprovalRequestRecord({
        ...decided,
        decisionAuthenticationId: null,
      }),
    InvalidApprovedActionValueError,
  );
  assert.throws(
    () =>
      normalizeApprovedActionDispatchRecord({
        ...consume(decided).dispatch,
        unexpected: true,
      }),
    InvalidApprovedActionValueError,
  );
});
