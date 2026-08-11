const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ApprovalInspectionAuthorizationError,
  ApprovalInspectionUnavailableError,
  createApprovalInspectionService,
} = require('@qinglong/runtime-core/approval-inspection');
const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');

const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 7 });
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'oidc:session-1',
  authenticatedAtMs: 1_500,
  expiresAtMs: 20_000,
  assurance: 'hardware',
});
const REQUEST = Object.freeze({
  projectId: 'default',
  approvalRequestId: 'approval-1',
  requestId: 'approval-inspect-1',
  auditEventId: '30000000-0000-4000-8000-000000000001',
  principal: PRINCIPAL,
});

function approval(overrides = {}) {
  return createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action: {
      permission: 'run.start',
      actionType: 'tool.invoke',
      actionRef: 'tool:task-1',
      actionDigest: 'a'.repeat(64),
      previewDigest: 'b'.repeat(64),
    },
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 1_000,
    expiresAtMs: 10_000,
    requestFence: FENCE,
    ...overrides,
  });
}

function detail(request = approval()) {
  return {
    request,
    preview: {
      title: 'Run task',
      summary: 'Runs one reviewed task.',
      fields: [{ kind: 'identifier', label: 'Task', value: 'task-1' }],
      warnings: ['external_effect'],
    },
  };
}

function fixture(overrides = {}) {
  const audits = [];
  const permissions = [];
  let reads = 0;
  let confirms = 0;
  const service = createApprovalInspectionService({
    source: {
      async getApprovalRequestDetail(query) {
        reads += 1;
        assert.deepEqual(query, {
          projectId: 'default',
          requestId: 'approval-1',
        });
        return overrides.found === undefined ? detail() : overrides.found;
      },
    },
    policy: {
      async authorize(principal, projectId, permission) {
        assert.deepEqual(principal, PRINCIPAL);
        assert.equal(projectId, 'default');
        permissions.push(permission);
        const fence =
          permission === 'artifact.read' && overrides.artifactFence
            ? overrides.artifactFence
            : FENCE;
        return { effect: 'allow', reasons: ['role_grant'], fence };
      },
    },
    audit: {
      async record(record) {
        audits.push(record);
      },
    },
    async confirmAuthorization() {
      confirms += 1;
    },
    now: () => 2_000,
  });
  return {
    service,
    state: () => ({ audits, confirms, permissions: permissions.sort(), reads }),
  };
}

test('requires dual current authority and audits one exact human inspection', async () => {
  const value = fixture();
  const result = await value.service.inspect(REQUEST);
  assert.equal(result.request.id, 'approval-1');
  assert.equal(result.preview.title, 'Run task');
  assert.deepEqual(value.state().permissions, ['approval.read', 'artifact.read']);
  assert.equal(value.state().confirms, 1);
  assert.equal(value.state().reads, 1);
  assert.deepEqual(value.state().audits, [
    {
      eventId: REQUEST.auditEventId,
      requestId: REQUEST.requestId,
      operationId: 'approval.inspect',
      projectId: 'default',
      subject: PRINCIPAL.subject,
      authenticationId: PRINCIPAL.authenticationId,
      outcome: 'allowed',
      reasons: ['human_approval_inspection'],
      fence: FENCE,
      occurredAtMs: 2_000,
    },
  ]);
});

test('audits an absent target without revealing cross-Project existence', async () => {
  const value = fixture({ found: null });
  assert.equal(await value.service.inspect(REQUEST), null);
  assert.equal(value.state().audits.length, 1);
  assert.equal(value.state().audits[0].outcome, 'allowed');
});

test('rejects authorization fence drift before reading Approval content', async () => {
  const value = fixture({
    artifactFence: { projectVersion: 4, bindingVersion: 7 },
  });
  await assert.rejects(
    value.service.inspect(REQUEST),
    ApprovalInspectionAuthorizationError,
  );
  assert.equal(value.state().confirms, 0);
  assert.equal(value.state().reads, 0);
  assert.equal(value.state().audits.length, 0);
});

test('fails closed when storage returns an Approval outside the exact binding', async () => {
  const value = fixture({
    found: detail(approval({ id: 'approval-2' })),
  });
  await assert.rejects(
    value.service.inspect(REQUEST),
    ApprovalInspectionUnavailableError,
  );
  assert.equal(value.state().audits.length, 0);
});
