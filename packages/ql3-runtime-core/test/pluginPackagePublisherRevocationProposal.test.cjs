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
  InvalidPluginPackagePublisherRevocationProposalError,
  PluginPackagePublisherRevocationProposalBindingConflictError,
  createPluginPackagePublisherRevocationProposal,
  normalizePluginPackagePublisherRevocationProposal,
  resolvePluginPackagePublisherRevocationProposal,
} = require('@qinglong/runtime-core/plugin-package-publisher-revocation-proposal');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_security' });
const SYSTEM = Object.freeze({ type: 'system', id: 'package_executor' });
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function trustSnapshot() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return createPluginPackagePublisherTrustSnapshot([
    {
      publisher: 'publisher-a.example',
      keyId: 'key-a',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      notBeforeMs: 1_000,
      notAfterMs: 10_000,
    },
  ]);
}

function proposal(overrides = {}) {
  return createPluginPackagePublisherRevocationProposal({
    actionRef: 'publisher-revoke:publisher-a.example:key-a',
    authorityProjectId: 'cluster-trust-authority',
    trustAuthorityId: 'cluster',
    trustGeneration: 3,
    trustSnapshot: trustSnapshot(),
    publisher: 'publisher-a.example',
    keyId: 'key-a',
    authorizationMode: 'dual_control',
    reasonCode: 'suspected_key_compromise',
    proposedBy: REQUESTER,
    proposerAssurance: 'multi_factor',
    proposalFence: FENCE,
    createdAtMs: 5,
    ...overrides,
  });
}

function dispatch(candidate, options = {}) {
  const {
    approvedBy = REVIEWER,
    assurance = 'multi_factor',
    decisionMode = 'separation_of_duty',
  } = options;
  const action = {
    permission: candidate.permission,
    actionType: candidate.actionType,
    actionRef: candidate.actionRef,
    actionDigest: candidate.actionDigest,
    previewDigest: candidate.previewDigest,
  };
  const pending = createApprovalRequest({
    id: `approval-${candidate.actionInput.authorizationMode}`,
    projectId: candidate.projectId,
    action,
    risk: 'critical',
    decisionMode,
    requestedBy: REQUESTER,
    requestedAtMs: 10,
    expiresAtMs: 1_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: `decision-${candidate.actionInput.authorizationMode}`,
    decision: 'approved',
    reasonCode: 'publisher_key_reviewed',
    principal: {
      subject: approvedBy,
      authenticationId: `auth-${approvedBy.id}`,
      authenticatedAtMs: 15,
      expiresAtMs: 500,
      assurance,
    },
    decidedAtMs: 20,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: `consume-${candidate.actionInput.authorizationMode}`,
    dispatchId: `dispatch-${candidate.actionInput.authorizationMode}`,
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  }).dispatch;
}

test('derives low-sensitive trust transition and resolves dual-control receipt', () => {
  const candidate = proposal();
  assert.deepEqual(
    normalizePluginPackagePublisherRevocationProposal(candidate),
    candidate,
  );
  assert.notEqual(
    candidate.actionInput.previousTrustDigest,
    candidate.actionInput.currentTrustDigest,
  );
  assert.equal('trustSnapshot' in candidate, false);
  assert.equal('publicKeyPem' in candidate.actionInput, false);

  const receipt = resolvePluginPackagePublisherRevocationProposal(
    candidate,
    dispatch(candidate),
    40,
  );
  assert.equal(receipt.mutationId, 'dispatch-dual_control');
  assert.deepEqual(receipt.proposer, REQUESTER);
  assert.deepEqual(receipt.confirmer, REVIEWER);
  assert.equal(receipt.authorizationMode, 'dual_control');
  assert.equal(
    receipt.previousTrustDigest,
    candidate.actionInput.previousTrustDigest,
  );
});

test('allows same-subject break-glass only with hardware assurance end to end', () => {
  const candidate = proposal({
    authorizationMode: 'break_glass',
    reasonCode: 'confirmed_key_compromise',
    proposerAssurance: 'hardware',
  });
  const receipt = resolvePluginPackagePublisherRevocationProposal(
    candidate,
    dispatch(candidate, {
      approvedBy: REQUESTER,
      assurance: 'hardware',
      decisionMode: 'human_confirmation',
    }),
    40,
  );
  assert.deepEqual(receipt.proposer, receipt.confirmer);
  assert.throws(
    () =>
      resolvePluginPackagePublisherRevocationProposal(
        candidate,
        {
          ...dispatch(candidate, {
            approvedBy: REQUESTER,
            assurance: 'hardware',
            decisionMode: 'human_confirmation',
          }),
          approvalAssurance: 'multi_factor',
        },
        40,
      ),
    PluginPackagePublisherRevocationProposalBindingConflictError,
  );
  assert.throws(
    () =>
      proposal({
        authorizationMode: 'break_glass',
        proposerAssurance: 'multi_factor',
      }),
    InvalidPluginPackagePublisherRevocationProposalError,
  );
});

test('rejects client digest injection, proposal drift and dispatch substitution', () => {
  assert.throws(
    () =>
      proposal({
        previousTrustDigest: '0'.repeat(64),
        currentTrustDigest: '1'.repeat(64),
      }),
    InvalidPluginPackagePublisherRevocationProposalError,
  );
  const candidate = proposal();
  assert.throws(
    () =>
      normalizePluginPackagePublisherRevocationProposal({
        ...candidate,
        actionInput: {
          ...candidate.actionInput,
          reasonCode: 'confirmed_key_compromise',
        },
      }),
    InvalidPluginPackagePublisherRevocationProposalError,
  );
  assert.throws(
    () =>
      resolvePluginPackagePublisherRevocationProposal(
        candidate,
        {
          ...dispatch(candidate),
          requestedBy: { type: 'user', id: 'usr_other' },
        },
        40,
      ),
    PluginPackagePublisherRevocationProposalBindingConflictError,
  );
});
