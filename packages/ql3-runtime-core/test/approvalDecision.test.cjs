const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ApprovalDecisionAuthorizationError,
  ApprovalDecisionBindingConflictError,
  ApprovalDecisionTargetUnavailableError,
  createApprovalDecisionService,
} = require('@qinglong/runtime-core/approval-decision');
const {
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');

const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 2 });
const ACTION = Object.freeze({
  permission: 'run.start',
  actionType: 'tool.invoke',
  actionRef: 'tool:run-task-1',
  actionDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
});
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'local-approval:auth-1',
  authenticatedAtMs: 1_500,
  expiresAtMs: 20_000,
  assurance: 'local_console',
});

function pending(overrides = {}) {
  return createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action: ACTION,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 1_000,
    expiresAtMs: 10_000,
    requestFence: FENCE,
    ...overrides,
  });
}

function command(overrides = {}) {
  return {
    projectId: 'default',
    approvalRequestId: 'approval-1',
    expectedVersion: 1,
    expectedAction: ACTION,
    decisionId: 'decision-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    auditEventId: '10000000-0000-4000-8000-000000000001',
    requestId: 'owner-command-1',
    principal: PRINCIPAL,
    ...overrides,
  };
}

function fixture(current = pending()) {
  let stored = current;
  let decideCalls = 0;
  let confirmCalls = 0;
  let captured;
  const service = createApprovalDecisionService({
    approvals: {
      async findById(id) {
        return id === stored.id ? stored : null;
      },
      async decide(value) {
        decideCalls += 1;
        captured = value;
        const { requestId: _requestId, audit: _audit, ...decision } = value;
        stored = decideApprovalRequest(stored, decision);
        return { status: 'decided', request: stored };
      },
    },
    policy: {
      async authorize(principal, projectId, permission) {
        assert.deepEqual(principal, PRINCIPAL);
        assert.ok(projectId === 'default' || projectId === 'other');
        assert.equal(permission, 'approval.decide');
        return { effect: 'allow', reasons: ['role_grant'], fence: FENCE };
      },
    },
    async confirmAuthorization() {
      confirmCalls += 1;
    },
    now: () => 2_000,
  });
  return {
    service,
    state: () => ({ stored, decideCalls, confirmCalls, captured }),
  };
}

test('binds a human decision to the exact reviewed action and durable audit', async () => {
  const { service, state } = fixture();
  const result = await service.decide(command());
  assert.equal(result.status, 'decided');
  assert.equal(result.request.state, 'approved');
  assert.equal(state().decideCalls, 1);
  assert.equal(state().confirmCalls, 1);
  assert.deepEqual(state().captured.audit, {
    eventId: '10000000-0000-4000-8000-000000000001',
    requestId: 'owner-command-1',
    operationId: 'approval.decide',
    projectId: 'default',
    subject: PRINCIPAL.subject,
    authenticationId: PRINCIPAL.authenticationId,
    outcome: 'allowed',
    reasons: ['human_approval_decision'],
    fence: FENCE,
    occurredAtMs: 2_000,
  });
});

test('returns an idempotent receipt without a second mutation', async () => {
  const first = fixture();
  await first.service.decide(command());
  const replay = fixture(first.state().stored);
  const result = await replay.service.decide(command({
    auditEventId: '10000000-0000-4000-8000-000000000002',
    requestId: 'owner-command-retry',
  }));
  assert.equal(result.status, 'existing');
  assert.equal(replay.state().decideCalls, 0);
  assert.equal(replay.state().confirmCalls, 1);
});

test('rejects binding drift and masks absent or cross-project targets', async () => {
  const { service, state } = fixture();
  await assert.rejects(
    service.decide(command({
      expectedAction: { ...ACTION, previewDigest: 'c'.repeat(64) },
    })),
    ApprovalDecisionBindingConflictError,
  );
  assert.equal(state().decideCalls, 0);
  await assert.rejects(
    service.decide(command({ projectId: 'other' })),
    ApprovalDecisionTargetUnavailableError,
  );
});

test('requires a strongly authenticated User even when policy allows', async () => {
  const { service } = fixture();
  for (const principal of [
    { ...PRINCIPAL, assurance: 'single_factor' },
    {
      ...PRINCIPAL,
      subject: { type: 'agent', id: 'agent-1' },
      assurance: 'hardware',
    },
  ]) {
    await assert.rejects(
      service.decide(command({ principal })),
      ApprovalDecisionAuthorizationError,
    );
  }
});
