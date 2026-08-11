const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  InvalidPluginPackagePublisherTrustTransitionError,
  PluginPackagePublisherTrustTransitionBindingConflictError,
  createPluginPackagePublisherTrustTransitionProposal,
  normalizePluginPackagePublisherTrustTransitionProposal,
  normalizePluginPackagePublisherTrustTransitionReceipt,
  resolvePluginPackagePublisherTrustTransitionProposal,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal');

const OWNER = Object.freeze({ type: 'user', id: 'usr_owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_security' });
const SYSTEM = Object.freeze({ type: 'system', id: 'package_executor' });
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function definition(keyId) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    publisher: 'publisher-a.example',
    keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: 1_000,
    notAfterMs: 10_000,
  };
}

function dispatch(proposal) {
  const action = {
    permission: proposal.permission,
    actionType: proposal.actionType,
    actionRef: proposal.actionRef,
    actionDigest: proposal.actionDigest,
    previewDigest: proposal.previewDigest,
  };
  const pending = createApprovalRequest({
    id: `approval-${proposal.actionInput.mode}`,
    projectId: proposal.projectId,
    action,
    risk: 'critical',
    decisionMode: 'separation_of_duty',
    requestedBy: OWNER,
    requestedAtMs: 5_010,
    expiresAtMs: 6_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: `decision-${proposal.actionInput.mode}`,
    decision: 'approved',
    reasonCode: 'publisher_key_reviewed',
    principal: {
      subject: REVIEWER,
      authenticationId: 'auth-reviewer',
      authenticatedAtMs: 5_015,
      expiresAtMs: 5_500,
      assurance: 'multi_factor',
    },
    decidedAtMs: 5_020,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: `consume-${proposal.actionInput.mode}`,
    dispatchId: `dispatch-${proposal.actionInput.mode}`,
    action,
    requestedBy: OWNER,
    consumedBy: SYSTEM,
    consumedAtMs: 5_025,
    authorizationFence: FENCE,
  }).dispatch;
}

test('derives one overlap-add proposal and dual-control receipt', () => {
  const oldKey = definition('key-a');
  const newKey = definition('key-b');
  const current = createPluginPackagePublisherTrustSnapshot([oldKey]);
  const material = createPluginPackagePublisherTrustSnapshot([
    oldKey,
    newKey,
  ]);
  const created = createPluginPackagePublisherTrustTransitionProposal({
    actionRef: 'publisher-overlap:publisher-a.example:key-b',
    authorityProjectId: 'cluster-trust-authority',
    trustAuthorityId: 'cluster',
    trustGeneration: 3,
    mode: 'overlap_add',
    trustSnapshot: current,
    materialSnapshot: material,
    publisher: 'publisher-a.example',
    keyId: 'key-b',
    proposedBy: OWNER,
    proposerAssurance: 'multi_factor',
    proposalFence: FENCE,
    createdAtMs: 5_000,
  });
  assert.equal(created.proposal.actionInput.previousTrustDigest, current.snapshotDigest);
  assert.equal(created.proposal.actionInput.currentTrustDigest, material.snapshotDigest);
  assert.deepEqual(
    normalizePluginPackagePublisherTrustTransitionProposal(created.proposal),
    created.proposal,
  );
  const receipt =
    resolvePluginPackagePublisherTrustTransitionProposal(
      created.proposal,
      dispatch(created.proposal),
      5_040,
      null,
    );
  assert.equal(receipt.currentGeneration, 4);
  assert.equal(receipt.retirementMatchingInstallations, null);
  assert.deepEqual(
    normalizePluginPackagePublisherTrustTransitionReceipt(receipt),
    receipt,
  );
});

test('derives safe retirement and requires zero-impact distinct review', () => {
  const current = createPluginPackagePublisherTrustSnapshot([
    definition('key-a'),
    definition('key-b'),
  ]);
  const { proposal, candidateSnapshot } =
    createPluginPackagePublisherTrustTransitionProposal({
      actionRef: 'publisher-retire:publisher-a.example:key-a',
      authorityProjectId: 'cluster-trust-authority',
      trustAuthorityId: 'cluster',
      trustGeneration: 8,
      mode: 'safe_retire',
      trustSnapshot: current,
      publisher: 'publisher-a.example',
      keyId: 'key-a',
      proposedBy: OWNER,
      proposerAssurance: 'hardware',
      proposalFence: FENCE,
      createdAtMs: 5_000,
    });
  assert.equal(candidateSnapshot.keys.length, 1);
  const receipt =
    resolvePluginPackagePublisherTrustTransitionProposal(
      proposal,
      dispatch(proposal),
      5_040,
      0,
    );
  assert.equal(receipt.mode, 'safe_retire');
  assert.equal(receipt.retirementMatchingInstallations, 0);
  assert.throws(
    () =>
      resolvePluginPackagePublisherTrustTransitionProposal(
        proposal,
        dispatch(proposal),
        5_040,
        null,
      ),
    PluginPackagePublisherTrustTransitionBindingConflictError,
  );
});

test('rejects client digest surfaces, weak principals and transition drift', () => {
  const current = createPluginPackagePublisherTrustSnapshot([
    definition('key-a'),
  ]);
  const material = createPluginPackagePublisherTrustSnapshot([
    definition('key-a'),
    definition('key-b'),
  ]);
  assert.throws(
    () =>
      createPluginPackagePublisherTrustTransitionProposal({
        actionRef: 'publisher-overlap:publisher-a.example:key-b',
        authorityProjectId: 'cluster-trust-authority',
        trustAuthorityId: 'cluster',
        trustGeneration: 1,
        mode: 'overlap_add',
        trustSnapshot: current,
        materialSnapshot: material,
        publisher: 'publisher-a.example',
        keyId: 'key-b',
        proposedBy: { type: 'agent', id: 'agent-a' },
        proposerAssurance: 'service',
        proposalFence: FENCE,
        createdAtMs: 5_000,
        previousTrustDigest: '0'.repeat(64),
      }),
    InvalidPluginPackagePublisherTrustTransitionError,
  );
});
