const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  ClusterApprovalManagementTransportAuthenticationError,
  ClusterApprovalManagementTransportRequestError,
  createClusterApprovalManagementTransport,
} = require('@qinglong/cluster-admin/approval-management-transport');

const ACTION = Object.freeze({
  permission: 'run.start',
  actionType: 'tool.invoke',
  actionRef: 'tool:task-1',
  actionDigest: 'a'.repeat(64),
  previewDigest: 'b'.repeat(64),
});
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner-1' }),
  authenticationId: 'oidc:session-1',
  authenticatedAtMs: 1_000,
  expiresAtMs: 20_000,
  assurance: 'hardware',
});
const BASE_REQUEST = Object.freeze({
  projectId: 'default',
  approvalRequestId: 'approval-1',
  requestId: 'approval-command-1',
  auditEventId: '40000000-0000-4000-8000-000000000001',
  failureAuditEventId: '40000000-0000-4000-8000-000000000002',
});

function pending() {
  return createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action: ACTION,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 900,
    expiresAtMs: 10_000,
    requestFence: { projectVersion: 1, bindingVersion: 2 },
  });
}

function inspectCommand() {
  return {
    schemaVersion: 1,
    operation: 'approval.inspect',
    request: BASE_REQUEST,
  };
}

function decideCommand() {
  return {
    schemaVersion: 1,
    operation: 'approval.decide',
    request: {
      ...BASE_REQUEST,
      expectedVersion: 1,
      expectedAction: ACTION,
      decisionId: 'decision-1',
      decision: 'approved',
      reasonCode: 'reviewed',
    },
  };
}

test('inspects and decides through fresh strong authentication without leaking principal facts', async () => {
  const calls = [];
  const failures = [];
  const transport = createClusterApprovalManagementTransport({
    service: {
      async inspect(request, confirmAuthorization) {
        calls.push(['inspect', request]);
        await confirmAuthorization();
        return {
          request: pending(),
          preview: {
            title: 'Run task',
            summary: 'Runs one reviewed task.',
            fields: [{ kind: 'identifier', label: 'Task', value: 'task-1' }],
            warnings: ['external_effect'],
          },
        };
      },
      async decide(request, confirmAuthorization) {
        calls.push(['decide', request]);
        await confirmAuthorization();
        return {
          status: 'decided',
          request: decideApprovalRequest(pending(), {
            expectedVersion: 1,
            decisionId: request.decisionId,
            decision: request.decision,
            reasonCode: request.reasonCode,
            principal: request.principal,
            decidedAtMs: 2_000,
            authorizationFence: { projectVersion: 1, bindingVersion: 2 },
          }),
        };
      },
      async recordFailure(record) {
        failures.push(record);
      },
    },
    now: () => 2_000,
  });
  let authenticationCalls = 0;
  const authentication = {
    async authenticate() {
      authenticationCalls += 1;
      return PRINCIPAL;
    },
  };

  const inspected = await transport.execute(inspectCommand(), authentication);
  assert.equal(authenticationCalls, 2);
  assert.equal(inspected.status, 'found');
  assert.equal(inspected.approval.preview.title, 'Run task');
  assert.equal(inspected.approval.expectedAction.actionDigest, 'a'.repeat(64));

  const decided = await transport.execute(decideCommand(), authentication);
  assert.equal(authenticationCalls, 4);
  assert.equal(decided.status, 'decided');
  assert.equal(decided.approval.state, 'approved');
  assert.equal(decided.approval.version, 2);
  assert.deepEqual(calls.map(([operation]) => operation), ['inspect', 'decide']);
  assert.equal(failures.length, 0);
  assert.doesNotMatch(
    JSON.stringify([inspected, decided]),
    /authenticationId|authenticatedAtMs|assurance/,
  );
});

test('records unauthenticated and reauthentication failures with schema-valid identities', async () => {
  const failures = [];
  const service = {
    async inspect(_request, confirmAuthorization) {
      await confirmAuthorization();
      return null;
    },
    async decide() {
      throw new Error('not used');
    },
    async recordFailure(record) {
      failures.push(record);
    },
  };
  const transport = createClusterApprovalManagementTransport({
    service,
    now: () => 2_000,
  });

  await assert.rejects(
    transport.execute(inspectCommand(), {
      async authenticate() {
        return { ...PRINCIPAL, assurance: 'single_factor' };
      },
    }),
    ClusterApprovalManagementTransportAuthenticationError,
  );
  assert.equal(failures[0].outcome, 'authentication_rejected');
  assert.equal(failures[0].subject, null);
  assert.equal(failures[0].authenticationId, null);

  let calls = 0;
  await assert.rejects(
    transport.execute(inspectCommand(), {
      async authenticate() {
        calls += 1;
        return calls === 1
          ? PRINCIPAL
          : { ...PRINCIPAL, authenticationId: 'oidc:session-2' };
      },
    }),
    ClusterApprovalManagementTransportAuthenticationError,
  );
  assert.equal(failures[1].outcome, 'denied');
  assert.deepEqual(failures[1].subject, PRINCIPAL.subject);
  assert.equal(failures[1].authenticationId, PRINCIPAL.authenticationId);
});

test('rejects widened or ambiguously audited commands before authentication', async () => {
  let authenticationCalls = 0;
  const transport = createClusterApprovalManagementTransport({
    service: {
      async inspect() {},
      async decide() {},
      async recordFailure() {},
    },
  });
  await assert.rejects(
    transport.execute(
      {
        ...inspectCommand(),
        extra: true,
      },
      {
        async authenticate() {
          authenticationCalls += 1;
          return PRINCIPAL;
        },
      },
    ),
    ClusterApprovalManagementTransportRequestError,
  );
  await assert.rejects(
    transport.execute(
      {
        ...inspectCommand(),
        request: {
          ...BASE_REQUEST,
          failureAuditEventId: BASE_REQUEST.auditEventId,
        },
      },
      {
        async authenticate() {
          authenticationCalls += 1;
          return PRINCIPAL;
        },
      },
    ),
    ClusterApprovalManagementTransportRequestError,
  );
  assert.equal(authenticationCalls, 0);
});
