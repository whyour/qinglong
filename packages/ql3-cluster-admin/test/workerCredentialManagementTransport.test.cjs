const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createWorkerCredentialManagementPlan,
} = require('@qinglong/runtime-core/worker-credential-management-plan');
const {
  ClusterWorkerCredentialManagementTransportAuthenticationError,
  ClusterWorkerCredentialManagementTransportRequestError,
  ClusterWorkerCredentialManagementTransportUnavailableError,
  createClusterWorkerCredentialManagementTransport,
} = require('@qinglong/cluster-admin/worker-credential-management-transport');

const REQUESTER = Object.freeze({ type: 'user', id: 'operator-a' });
const REVIEWER = Object.freeze({ type: 'user', id: 'reviewer-b' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function principal(subject = REQUESTER, assurance = 'multi_factor') {
  return Object.freeze({
    subject,
    authenticationId: `session-${subject.id}`,
    authenticatedAtMs: 900,
    expiresAtMs: 10_000,
    assurance,
  });
}

function plan() {
  return createWorkerCredentialManagementPlan({
    actionRef: 'worker-credential:worker-a:generation-2',
    authorityProjectId: 'cluster-authority',
    action: 'rotate',
    target: {
      deliveryId: '123e4567-e89b-42d3-a456-426614174901',
      workerId: 'worker-a',
      credentialId: 'credential-generation-2',
      previousCredentialId: 'credential-generation-1',
      credentialNotBeforeAtMs: 1_000,
      credentialExpiresAtMs: 9_000,
      deploymentTargetDigest: 'd'.repeat(64),
      deploymentGeneration: 'generation-2',
    },
    requestedBy: REQUESTER,
    plannedAtMs: 1_000,
    expiresAtMs: 5_000,
  });
}

function approval(planValue) {
  return createApprovalRequest({
    id: 'approval-worker-a-generation-2',
    projectId: planValue.authorityProjectId,
    action: {
      permission: 'worker.manage',
      actionType: 'worker_credential.delivery.rotate',
      actionRef: planValue.actionRef,
      actionDigest: planValue.planDigest,
      previewDigest: planValue.previewDigest,
    },
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedBy: REQUESTER,
    requestedAtMs: 1_001,
    expiresAtMs: 5_000,
    requestFence: FENCE,
  });
}

function commands() {
  return [
    {
      schemaVersion: 1,
      operation: 'worker-credential.plan',
      request: {
        actionRef: 'worker-credential:worker-a:generation-2',
        authorityProjectId: 'cluster-authority',
        action: 'rotate',
        deliveryId: '123e4567-e89b-42d3-a456-426614174901',
        workerId: 'worker-a',
        credentialId: 'credential-generation-2',
        previousCredentialId: 'credential-generation-1',
        credentialNotBeforeAtMs: 1_000,
        credentialExpiresAtMs: 9_000,
        deploymentTargetDigest: 'd'.repeat(64),
        deploymentGeneration: 'generation-2',
      },
    },
    {
      schemaVersion: 1,
      operation: 'worker-credential.propose',
      request: {
        actionRef: 'worker-credential:worker-a:generation-2',
        authorityProjectId: 'cluster-authority',
        approvalRequestId: 'approval-worker-a-generation-2',
        approvalAuditEventId: '123e4567-e89b-42d3-a456-426614174902',
      },
    },
    {
      schemaVersion: 1,
      operation: 'worker-credential.decide',
      request: {
        actionRef: 'worker-credential:worker-a:generation-2',
        authorityProjectId: 'cluster-authority',
        approvalRequestId: 'approval-worker-a-generation-2',
        expectedVersion: 1,
        decisionId: 'decision-worker-a-generation-2',
        auditEventId: '123e4567-e89b-42d3-a456-426614174903',
        decision: 'approved',
        reasonCode: 'reviewed',
      },
    },
    {
      schemaVersion: 1,
      operation: 'worker-credential.inspect',
      request: {
        actionRef: 'worker-credential:worker-a:generation-2',
        authorityProjectId: 'cluster-authority',
        approvalRequestId: 'approval-worker-a-generation-2',
        inspectionId: 'inspection-worker-a-generation-2',
      },
    },
  ];
}

test('routes the four public commands with strong User authority and low-sensitive results', async () => {
  const planValue = plan();
  const approvalValue = approval(planValue);
  const calls = [];
  const service = {
    async plan(request) {
      calls.push(['plan', request]);
      return { status: 'created', plan: planValue };
    },
    async propose(request) {
      calls.push(['propose', request]);
      return {
        plan: planValue,
        approvalStatus: 'created',
        approvalRequest: approvalValue,
      };
    },
    async decide(request) {
      calls.push(['decide', request]);
      return { status: 'decided', request: approvalValue };
    },
    async inspectAuthorized(request) {
      calls.push(['inspect', request]);
      return {
        plan: planValue,
        approvalRequest: approvalValue,
        stale: false,
      };
    },
  };
  const transport = createClusterWorkerCredentialManagementTransport({
    service,
    now: () => 1_100,
  });
  const authentication = {
    async authenticate() {
      return principal();
    },
  };
  const results = [];
  for (const command of commands()) {
    results.push(await transport.execute(command, authentication));
  }
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['plan', 'propose', 'decide', 'inspect'],
  );
  for (const [, request] of calls) {
    assert.deepEqual(request.principal, principal());
  }
  assert.deepEqual(
    results.map(({ operation }) => operation),
    [
      'worker-credential.plan',
      'worker-credential.propose',
      'worker-credential.decide',
      'worker-credential.inspect',
    ],
  );
  assert.equal(results[0].plan.planDigest, planValue.planDigest);
  assert.equal(results[1].approval.actionDigest, planValue.planDigest);
  assert.equal(results[3].stale, false);
  const serialized = JSON.stringify(results);
  assert.doesNotMatch(serialized, /authenticationId|credential-token|secret/i);
});

test('rejects weak or unavailable identity before management authority', async () => {
  let calls = 0;
  const service = Object.fromEntries(
    ['plan', 'propose', 'decide', 'inspectAuthorized'].map((name) => [
      name,
      async () => {
        calls += 1;
        throw new Error('must not call service');
      },
    ]),
  );
  const transport = createClusterWorkerCredentialManagementTransport({
    service,
    now: () => 1_100,
  });
  await assert.rejects(
    transport.execute(commands()[0], {
      async authenticate() {
        return principal(REVIEWER, 'service');
      },
    }),
    ClusterWorkerCredentialManagementTransportAuthenticationError,
  );
  await assert.rejects(
    transport.execute(commands()[0], {
      async authenticate() {
        throw new Error('identity provider unavailable');
      },
    }),
    ClusterWorkerCredentialManagementTransportUnavailableError,
  );
  assert.equal(calls, 0);
});

test('rejects widened and internal commands before authentication', async () => {
  const transport = createClusterWorkerCredentialManagementTransport({
    service: {
      async plan() {},
      async propose() {},
      async decide() {},
      async inspectAuthorized() {},
    },
  });
  let authentications = 0;
  const authentication = {
    async authenticate() {
      authentications += 1;
      return principal();
    },
  };
  await assert.rejects(
    transport.execute(
      { ...commands()[0], debug: true },
      authentication,
    ),
    ClusterWorkerCredentialManagementTransportRequestError,
  );
  await assert.rejects(
    transport.execute(
      {
        schemaVersion: 1,
        operation: 'worker-credential.execute',
        request: {},
      },
      authentication,
    ),
    ClusterWorkerCredentialManagementTransportRequestError,
  );
  assert.equal(authentications, 0);
});
