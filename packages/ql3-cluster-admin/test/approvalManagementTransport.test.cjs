const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  claimApprovedActionExecution,
  completeApprovedActionExecution,
  createApprovedActionExecution,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
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
const RECOVERY_BASE_REQUEST = Object.freeze({
  projectId: 'default',
  dispatchId: 'dispatch-1',
  requestId: 'recovery-command-1',
  auditEventId: '40000000-0000-4000-8000-000000000003',
  failureAuditEventId: '40000000-0000-4000-8000-000000000004',
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

function executingRecoverySnapshot() {
  const action = {
    ...ACTION,
    permission: 'secret.manage',
    actionType: 'plugin_package.secret_binding.bind',
    actionRef: 'secret-binding:1',
  };
  const recoveryPending = createApprovalRequest({
    id: 'approval-1',
    projectId: 'default',
    action,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: { type: 'agent', id: 'agent-1' },
    requestedAtMs: 900,
    expiresAtMs: 10_000,
    requestFence: { projectVersion: 1, bindingVersion: 2 },
  });
  const approved = decideApprovalRequest(recoveryPending, {
    expectedVersion: 1,
    decisionId: 'decision-recovery-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: PRINCIPAL,
    decidedAtMs: 1_100,
    authorizationFence: { projectVersion: 1, bindingVersion: 2 },
  });
  const dispatch = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consumption-1',
    dispatchId: 'dispatch-1',
    action,
    requestedBy: approved.requestedBy,
    consumedBy: { type: 'system', id: 'package-executor' },
    consumedAtMs: 1_200,
    authorizationFence: { projectVersion: 1, bindingVersion: 2 },
  }).dispatch;
  const leased = claimApprovedActionExecution(createApprovedActionExecution(dispatch), {
    owner: 'executor-1',
    leaseToken: 'lease-1',
    nowMs: 1_300,
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
      startedAtMs: 1_400,
    },
  );
  return { execution: { dispatch, execution }, resolution: null };
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
      async inspectRecovery() {
        throw new Error('not used');
      },
      async resolveRecovery() {
        throw new Error('not used');
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
    async inspectRecovery() {
      throw new Error('not used');
    },
    async resolveRecovery() {
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
      async inspectRecovery() {},
      async resolveRecovery() {},
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

test('inspects and resolves recovery without exposing execution lease or authentication facts', async () => {
  const source = executingRecoverySnapshot();
  const nextExecution = completeApprovedActionExecution(source.execution.execution, {
    owner: source.execution.execution.leaseOwner,
    leaseToken: source.execution.execution.leaseToken,
    expectedVersion: source.execution.execution.version,
    resultMutationId: 'manual-recovery-1',
    outcome: 'indeterminate',
    resultCode: 'manual_recovery_abandoned_unknown',
    completedAtMs: 2_000,
  });
  const resolution = {
    mutationId: 'manual-recovery-1',
    decision: 'abandon_unknown',
    evidenceDigest: 'e'.repeat(64),
    reasonCode: 'orphan_absence_verified',
    resolvedBy: { type: 'user', id: 'owner-1' },
    resolvedAtMs: 2_000,
    resolutionDigest: 'f'.repeat(64),
  };
  const transport = createClusterApprovalManagementTransport({
    service: {
      async inspect() {},
      async decide() {},
      async inspectRecovery(_request, confirmAuthorization) {
        await confirmAuthorization();
        return source;
      },
      async resolveRecovery(_request, confirmAuthorization) {
        await confirmAuthorization();
        return {
          status: 'resolved',
          snapshot: {
            execution: { dispatch: source.execution.dispatch, execution: nextExecution },
            resolution: {
              schema: 'qinglong/approved-action-manual-recovery@v1',
              dispatchId: 'dispatch-1',
              dispatchDigest: source.execution.execution.dispatchDigest,
              projectId: 'default',
              actionType: source.execution.dispatch.action.actionType,
              actionDigest: source.execution.dispatch.action.actionDigest,
              executionVersion: source.execution.execution.version,
              executionDigest: source.execution.execution.executionDigest,
              authenticationId: PRINCIPAL.authenticationId,
              assurance: PRINCIPAL.assurance,
              authenticatedAtMs: PRINCIPAL.authenticatedAtMs,
              authorizationFence: { projectVersion: 1, bindingVersion: 2 },
              auditEventId: RECOVERY_BASE_REQUEST.auditEventId,
              ...resolution,
            },
          },
        };
      },
      async recordFailure() {},
    },
    now: () => 2_000,
  });
  const authentication = { async authenticate() { return PRINCIPAL; } };
  const inspected = await transport.execute(
    { schemaVersion: 1, operation: 'approval.recover.inspect', request: RECOVERY_BASE_REQUEST },
    authentication,
  );
  const resolved = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'approval.recover.resolve',
      request: {
        ...RECOVERY_BASE_REQUEST,
        expectedExecutionVersion: source.execution.execution.version,
        expectedExecutionDigest: source.execution.execution.executionDigest,
        mutationId: resolution.mutationId,
        decision: resolution.decision,
        evidenceDigest: resolution.evidenceDigest,
        reasonCode: resolution.reasonCode,
      },
    },
    authentication,
  );
  assert.equal(inspected.recovery.execution.status, 'recovery_required');
  assert.equal(resolved.recovery.execution.status, 'blocked');
  assert.equal(resolved.recovery.resolution.decision, 'abandon_unknown');
  assert.doesNotMatch(
    JSON.stringify([inspected, resolved]),
    /leaseOwner|leaseToken|authenticationId|authenticatedAtMs|assurance/,
  );
});
