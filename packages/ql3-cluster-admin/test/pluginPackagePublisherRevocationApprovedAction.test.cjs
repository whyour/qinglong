const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createApprovedActionExecution,
  claimApprovedActionExecution,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  createPluginPackagePublisherRevocationProposal,
} = require('@qinglong/runtime-core/plugin-package-publisher-revocation-proposal');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  ClusterPluginPackagePublisherRevocationApprovedActionHandler,
} = require('../dist/plugin-package/publisher/pluginPackagePublisherRevocationApprovedAction');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_security' });
const SYSTEM = Object.freeze({ type: 'system', id: 'cluster_package_executor' });
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function proposal() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return createPluginPackagePublisherRevocationProposal({
    actionRef: 'publisher-revoke:publisher-a.example:key-a',
    authorityProjectId: 'cluster-trust-authority',
    trustAuthorityId: 'cluster',
    trustGeneration: 1,
    trustSnapshot: createPluginPackagePublisherTrustSnapshot([
      {
        publisher: 'publisher-a.example',
        keyId: 'key-a',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        notBeforeMs: 1,
        notAfterMs: 10_000,
      },
    ]),
    publisher: 'publisher-a.example',
    keyId: 'key-a',
    authorizationMode: 'dual_control',
    reasonCode: 'suspected_key_compromise',
    proposedBy: REQUESTER,
    proposerAssurance: 'multi_factor',
    proposalFence: FENCE,
    createdAtMs: 5,
  });
}

function dispatch(candidate) {
  const action = {
    permission: candidate.permission,
    actionType: candidate.actionType,
    actionRef: candidate.actionRef,
    actionDigest: candidate.actionDigest,
    previewDigest: candidate.previewDigest,
  };
  const pending = createApprovalRequest({
    id: 'approval-publisher-revoke',
    projectId: candidate.projectId,
    action,
    risk: 'critical',
    decisionMode: 'separation_of_duty',
    requestedBy: REQUESTER,
    requestedAtMs: 10,
    expiresAtMs: 1_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-publisher-revoke',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REVIEWER,
      authenticationId: 'auth-reviewer',
      authenticatedAtMs: 15,
      expiresAtMs: 500,
      assurance: 'multi_factor',
    },
    decidedAtMs: 20,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-publisher-revoke',
    dispatchId: 'dispatch-publisher-revoke',
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  }).dispatch;
}

function execution(approvedDispatch) {
  const baseline = createApprovedActionExecution(approvedDispatch, 5);
  const claimed = claimApprovedActionExecution(baseline, {
    owner: 'publisher-executor',
    leaseToken: 'lease-publisher-revoke',
    nowMs: 31,
    leaseDurationMs: 1_000,
  });
  assert.equal(claimed.status, 'leased');
  return startApprovedActionExecution(
    { dispatch: approvedDispatch, execution: claimed },
    {
    dispatchId: approvedDispatch.id,
    approvalRequestId: approvedDispatch.approvalRequestId,
    actionDigest: approvedDispatch.action.actionDigest,
    owner: 'publisher-executor',
    leaseToken: 'lease-publisher-revoke',
    expectedVersion: claimed.version,
    startedAtMs: 40,
    },
  );
}

test('inspects authority and executes the exact approved revocation receipt', async () => {
  const candidate = proposal();
  const approvedDispatch = dispatch(candidate);
  const started = execution(approvedDispatch);
  const receipts = [];
  const handler =
    new ClusterPluginPackagePublisherRevocationApprovedActionHandler(
      {
        async findProposalByActionRef() {
          return candidate;
        },
        async createProposal() {
          throw new Error('must not create');
        },
      },
      {
        async run(receipt) {
          receipts.push(receipt);
          return {
            safeToAdmit: true,
            receiptDigest: receipt.receiptDigest,
            impactDigest: 'a'.repeat(64),
          };
        },
      },
    );
  assert.deepEqual(await handler.inspect(approvedDispatch), {
    status: 'ready',
    actionDigest: candidate.actionDigest,
  });
  const result = await handler.execute({
    dispatch: approvedDispatch,
    execution: started,
    idempotencyKey: 'publisher-revoke-attempt',
    fence: {
      owner: started.leaseOwner,
      leaseToken: started.leaseToken,
      version: started.version,
    },
  });
  assert.deepEqual(result, {
    outcome: 'succeeded',
    resultCode: 'publisher_revocation_converged',
    resultDigest: 'a'.repeat(64),
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].mutationId, approvedDispatch.id);
  assert.equal(receipts[0].revokedAtMs, started.startedAtMs);
});

test('blocks missing proposals and incomplete quarantine convergence', async () => {
  const candidate = proposal();
  const approvedDispatch = dispatch(candidate);
  const missing =
    new ClusterPluginPackagePublisherRevocationApprovedActionHandler(
      {
        async findProposalByActionRef() {
          return null;
        },
        async createProposal() {
          throw new Error('must not create');
        },
      },
      { async run() { throw new Error('must not run'); } },
    );
  assert.deepEqual(await missing.inspect(approvedDispatch), {
    status: 'blocked',
    resultCode: 'publisher_revocation_proposal_missing',
  });

  const started = execution(approvedDispatch);
  const incomplete =
    new ClusterPluginPackagePublisherRevocationApprovedActionHandler(
      {
        async findProposalByActionRef() {
          return candidate;
        },
        async createProposal() {
          throw new Error('must not create');
        },
      },
      {
        async run(receipt) {
          return {
            safeToAdmit: false,
            receiptDigest: receipt.receiptDigest,
            impactDigest: 'b'.repeat(64),
          };
        },
      },
    );
  assert.deepEqual(
    await incomplete.execute({
      dispatch: approvedDispatch,
      execution: started,
      idempotencyKey: 'publisher-revoke-attempt',
      fence: {
        owner: started.leaseOwner,
        leaseToken: started.leaseToken,
        version: started.version,
      },
    }),
    {
      outcome: 'indeterminate',
      resultCode: 'publisher_revocation_convergence_incomplete',
    },
  );
});
