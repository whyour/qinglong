const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  createPluginPackagePublisherTrustTransitionProposal,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal');
const {
  ClusterPluginPackageManagementTransportRequestError,
  createClusterPluginPackageManagementTransport,
} = require('@qinglong/cluster-admin/plugin-package-management-transport');

const NOW = 1_000;
const OWNER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'cluster-reviewer' });
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function principal() {
  return {
    subject: REVIEWER,
    authenticationId: 'reviewer-session',
    authenticatedAtMs: NOW - 100,
    expiresAtMs: NOW + 1_000,
    assurance: 'multi_factor',
  };
}

function authentication() {
  return {
    async authenticate() {
      return principal();
    },
  };
}

function definition(keyId) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    publisher: 'publisher-a.example',
    keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: 1,
    notAfterMs: 20_000,
  };
}

const oldDefinition = definition('key-old');
const newDefinition = definition('key-new');
const currentSnapshot = createPluginPackagePublisherTrustSnapshot([
  oldDefinition,
]);
const materialSnapshot = createPluginPackagePublisherTrustSnapshot([
  oldDefinition,
  newDefinition,
]);

function transition(createdAtMs = NOW) {
  return createPluginPackagePublisherTrustTransitionProposal({
    actionRef: 'publisher-overlap:publisher-a.example:key-new',
    authorityProjectId: 'cluster-trust-authority',
    trustAuthorityId: 'cluster',
    trustGeneration: 4,
    mode: 'overlap_add',
    trustSnapshot: currentSnapshot,
    materialSnapshot,
    publisher: 'publisher-a.example',
    keyId: 'key-new',
    proposedBy: OWNER,
    proposerAssurance: 'multi_factor',
    proposalFence: FENCE,
    createdAtMs,
  }).proposal;
}

function approval(candidate = transition(), overrides = {}) {
  return createApprovalRequest({
    id: 'approval-publisher-overlap',
    projectId: candidate.projectId,
    action: {
      permission: candidate.permission,
      actionType: candidate.actionType,
      actionRef: candidate.actionRef,
      actionDigest: candidate.actionDigest,
      previewDigest: candidate.previewDigest,
    },
    risk: 'critical',
    decisionMode: 'separation_of_duty',
    requestedBy: OWNER,
    requestedAtMs: candidate.createdAtMs,
    expiresAtMs: candidate.createdAtMs + 10_000,
    requestFence: FENCE,
    ...overrides,
  });
}

function command(operation, request = {}) {
  const common = {
    actionRef: 'publisher-overlap:publisher-a.example:key-new',
    approvalRequestId: 'approval-publisher-overlap',
  };
  if (operation.endsWith('.propose')) {
    return {
      schemaVersion: 1,
      operation,
      request: {
        ...common,
        proposalAuditEventId: 'proposal-overlap-audit',
        approvalAuditEventId: 'approval-overlap-audit',
        mode: 'overlap_add',
        publisher: 'publisher-a.example',
        keyId: 'key-new',
        ...request,
      },
    };
  }
  if (operation.endsWith('.decide')) {
    return {
      schemaVersion: 1,
      operation,
      request: {
        ...common,
        expectedVersion: 1,
        decisionId: 'decision-publisher-overlap',
        auditEventId: 'decision-overlap-audit',
        decision: 'approved',
        reasonCode: 'reviewed',
        ...request,
      },
    };
  }
  return {
    schemaVersion: 1,
    operation,
    request: {
      ...common,
      inspectionId: 'inspection-publisher-overlap',
      ...request,
    },
  };
}

function services(state = { proposal: null, approvalRequest: null }) {
  const calls = {
    decide: [],
    proposeTransition: [],
    inspectTransition: [],
    inspectTransitionAuthorized: [],
  };
  const installService = {
    async propose() {
      throw new Error('install proposal must not run');
    },
    async decide(request) {
      calls.decide.push(request);
      return {
        status: 'decided',
        request: decideApprovalRequest(state.approvalRequest, {
          expectedVersion: request.expectedVersion,
          decisionId: request.decisionId,
          decision: request.decision,
          reasonCode: request.reasonCode,
          principal: request.principal,
          decidedAtMs: request.decidedAtMs,
          authorizationFence: FENCE,
        }),
      };
    },
    async inspect() {
      return { proposal: null, approvalRequest: null };
    },
    async inspectAuthorized() {
      return { proposal: null, approvalRequest: null };
    },
    async inspectInstallationAuthorized() {
      return null;
    },
    async listInstallationsAuthorized() {
      return { items: [], truncated: false };
    },
  };
  const publisherTrust = {
    async propose() {
      throw new Error('revocation proposal must not run');
    },
    async inspect() {
      return { proposal: null, approvalRequest: null };
    },
    async inspectAuthorized() {
      return { proposal: null, approvalRequest: null };
    },
    async proposeTransition(request) {
      calls.proposeTransition.push(request);
      const candidate = transition(request.requestedAtMs);
      return {
        proposalStatus: 'created',
        approvalStatus: 'created',
        proposal: candidate,
        approvalRequest: approval(candidate),
      };
    },
    async inspectTransition(actionRef, approvalRequestId) {
      calls.inspectTransition.push({ actionRef, approvalRequestId });
      return state;
    },
    async inspectTransitionAuthorized(request) {
      calls.inspectTransitionAuthorized.push(request);
      return state;
    },
  };
  return { calls, installService, publisherTrust };
}

test('routes derived-only trust overlap proposal without key material', async () => {
  const fixture = services();
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.installService,
    publisherTrust: fixture.publisherTrust,
    now: () => NOW,
  });
  const proposed = command('plugin-package.publisher-trust-transition.propose');
  const result = await transport.execute(proposed, authentication());

  assert.equal(result.operation, proposed.operation);
  assert.equal(fixture.calls.proposeTransition.length, 1);
  assert.deepEqual(Object.keys(proposed.request).sort(), [
    'actionRef',
    'approvalAuditEventId',
    'approvalRequestId',
    'keyId',
    'mode',
    'proposalAuditEventId',
    'publisher',
  ]);
  assert.equal(JSON.stringify(proposed).includes('PUBLIC KEY'), false);
  assert.equal(JSON.stringify(result).includes('PUBLIC KEY'), false);
  assert.deepEqual(Object.keys(result.proposal).sort(), [
    'actionDigest',
    'actionRef',
    'createdAtMs',
    'currentTrustDigest',
    'keyId',
    'mode',
    'previewDigest',
    'previousTrustDigest',
    'projectId',
    'proposalDigest',
    'publisher',
    'trustAuthorityId',
    'trustGeneration',
  ]);
  assert.deepEqual(fixture.calls.proposeTransition[0].principal, principal());
  assert.equal(fixture.calls.proposeTransition[0].requestedAtMs, NOW);
});

test('requires exact separation-of-duty authority before transition decision', async () => {
  const candidate = transition();
  const pending = approval(candidate);
  const fixture = services({
    proposal: candidate,
    approvalRequest: pending,
  });
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.installService,
    publisherTrust: fixture.publisherTrust,
    now: () => NOW,
  });
  const result = await transport.execute(
    command('plugin-package.publisher-trust-transition.decide'),
    authentication(),
  );
  assert.equal(result.status, 'decided');
  assert.equal(result.approval.decisionMode, 'separation_of_duty');
  assert.equal(fixture.calls.decide.length, 1);
  assert.deepEqual(fixture.calls.decide[0].principal, principal());

  const invalid = services({
    proposal: candidate,
    approvalRequest: approval(candidate, {
      decisionMode: 'human_confirmation',
    }),
  });
  const invalidTransport = createClusterPluginPackageManagementTransport({
    service: invalid.installService,
    publisherTrust: invalid.publisherTrust,
    now: () => NOW,
  });
  await assert.rejects(
    invalidTransport.execute(
      command('plugin-package.publisher-trust-transition.decide'),
      authentication(),
    ),
    ClusterPluginPackageManagementTransportRequestError,
  );
  assert.deepEqual(invalid.calls.decide, []);
});

test('uses scoped authorized inspection and rejects client key material', async () => {
  const candidate = transition();
  const state = {
    proposal: candidate,
    approvalRequest: approval(candidate),
  };
  const fixture = services(state);
  const transport = createClusterPluginPackageManagementTransport({
    service: fixture.installService,
    publisherTrust: fixture.publisherTrust,
    now: () => NOW,
  });
  const result = await transport.execute(
    command('plugin-package.publisher-trust-transition.inspect'),
    authentication(),
  );
  assert.equal(
    result.operation,
    'plugin-package.publisher-trust-transition.inspect',
  );
  assert.deepEqual(fixture.calls.inspectTransition, []);
  assert.equal(fixture.calls.inspectTransitionAuthorized.length, 1);
  assert.deepEqual(
    fixture.calls.inspectTransitionAuthorized[0].principal,
    principal(),
  );

  await assert.rejects(
    transport.execute(
      command('plugin-package.publisher-trust-transition.propose', {
        publicKeyPem: 'client-controlled',
      }),
      authentication(),
    ),
    ClusterPluginPackageManagementTransportRequestError,
  );
});
