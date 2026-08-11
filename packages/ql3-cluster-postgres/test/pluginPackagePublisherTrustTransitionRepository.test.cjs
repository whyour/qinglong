const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  approvalRequestDigest,
  approvedActionDispatchDigest,
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackagePublisherTrustHead,
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  createPluginPackagePublisherTrustTransitionProposal,
  PluginPackagePublisherTrustTransitionConflictError,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal');
const {
  PostgresPluginPackagePublisherTrustTransitionRepository,
} = require('../dist/plugin-package/publisher/pluginPackagePublisherTrustTransitionRepository');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_security' });
const SYSTEM = Object.freeze({
  type: 'system',
  id: 'cluster_package_executor',
});
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function authority(mode = 'overlap_add') {
  const oldPair = generateKeyPairSync('ed25519');
  const newPair = generateKeyPairSync('ed25519');
  const oldDefinition = {
    publisher: 'publisher-a.example',
    keyId: 'key-old',
    publicKeyPem: oldPair.publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    notBeforeMs: 1,
    notAfterMs: 10_000,
  };
  const newDefinition = {
    publisher: 'publisher-a.example',
    keyId: 'key-new',
    publicKeyPem: newPair.publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    notBeforeMs: 1,
    notAfterMs: 20_000,
  };
  const currentSnapshot =
    createPluginPackagePublisherTrustSnapshot(
      mode === 'overlap_add'
        ? [oldDefinition]
        : [oldDefinition, newDefinition],
    );
  const created =
    createPluginPackagePublisherTrustTransitionProposal({
      actionRef:
        mode === 'overlap_add'
          ? 'publisher-overlap:publisher-a.example:key-new'
          : 'publisher-retire:publisher-a.example:key-old',
      authorityProjectId: 'cluster-trust-authority',
      trustAuthorityId: 'cluster',
      trustGeneration: 1,
      mode,
      trustSnapshot: currentSnapshot,
      ...(mode === 'overlap_add'
        ? {
            materialSnapshot:
              createPluginPackagePublisherTrustSnapshot([
                oldDefinition,
                newDefinition,
              ]),
          }
        : {}),
      publisher: 'publisher-a.example',
      keyId: mode === 'overlap_add' ? 'key-new' : 'key-old',
      proposedBy: REQUESTER,
      proposerAssurance: 'multi_factor',
      proposalFence: FENCE,
      createdAtMs: 100,
    });
  const action = {
    permission: created.proposal.permission,
    actionType: created.proposal.actionType,
    actionRef: created.proposal.actionRef,
    actionDigest: created.proposal.actionDigest,
    previewDigest: created.proposal.previewDigest,
  };
  const pending = createApprovalRequest({
    id: `approval-${mode}`,
    projectId: created.proposal.projectId,
    action,
    risk: 'critical',
    decisionMode: 'separation_of_duty',
    requestedBy: REQUESTER,
    requestedAtMs: 100,
    expiresAtMs: 1_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: `decision-${mode}`,
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REVIEWER,
      authenticationId: 'auth-reviewer',
      authenticatedAtMs: 101,
      expiresAtMs: 900,
      assurance: 'multi_factor',
    },
    decidedAtMs: 110,
    authorizationFence: FENCE,
  });
  const consumed = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: `consume-${mode}`,
    dispatchId: `dispatch-${mode}`,
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 120,
    authorizationFence: FENCE,
  });
  return {
    ...created,
    currentSnapshot,
    approval: consumed.request,
    dispatch: consumed.dispatch,
    initialHead: createPluginPackagePublisherTrustHead(
      'cluster',
      currentSnapshot,
      50,
    ),
  };
}

function fixture(value, options = {}) {
  let head = value.initialHead;
  let receipt = null;
  let signerLocks = 0;
  const query = async (text, values = []) => {
    if (
      text.includes(
        'FROM "ql3"."approved_action_dispatches" AS dispatch',
      )
    ) {
      return {
        rows: [
          {
            proposalJson: value.proposal,
            proposalDigest: value.proposal.proposalDigest,
            dispatchJson: value.dispatch,
            dispatchDigest: approvedActionDispatchDigest(value.dispatch),
            approvalJson: value.approval,
            approvalDigest: approvalRequestDigest(value.approval),
          },
        ],
      };
    }
    if (text.includes('pg_advisory_xact_lock(hashtextextended')) {
      signerLocks += 1;
      return { rows: [{}], rowCount: 1 };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_trust_transition_receipts"',
      )
    ) {
      return {
        rows: receipt
          ? [
              {
                receiptJson: receipt,
                receiptDigest: receipt.receiptDigest,
              },
            ]
          : [],
      };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_trust_heads" AS head',
      )
    ) {
      return {
        rows: [
          {
            headJson: head,
            headDigest: head.headDigest,
            effectiveSnapshotJson: value.currentSnapshot,
            effectiveSnapshotDigest:
              value.currentSnapshot.snapshotDigest,
            candidateSnapshotJson: value.candidateSnapshot,
            candidateSnapshotDigest:
              value.candidateSnapshot.snapshotDigest,
          },
        ],
      };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_trust_heads"',
      )
    ) {
      return {
        rows: [{ headJson: head, headDigest: head.headDigest }],
      };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_provenance" AS provenance',
      )
    ) {
      return {
        rows: options.matchingInstall
          ? [{ installationId: 'install-old' }]
          : [],
      };
    }
    if (
      text.includes(
        'UPDATE "ql3"."plugin_package_publisher_trust_heads"',
      )
    ) {
      head = JSON.parse(values[5]);
      return { rows: [], rowCount: 1 };
    }
    if (
      text.includes(
        '"ql3"."plugin_package_publisher_trust_transition_receipts" (',
      )
    ) {
      receipt = JSON.parse(values[16]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  const repository =
    new PostgresPluginPackagePublisherTrustTransitionRepository({
      query,
      async connect() {
        return client;
      },
    });
  repository.signerLocks = () => signerLocks;
  repository.head = () => head;
  return repository;
}

test('atomically advances overlap trust and exactly replays its receipt', async () => {
  const value = authority();
  const repository = fixture(value);
  const created = await repository.applyApprovedTransition({
    dispatch: value.dispatch,
    executedAtMs: 130,
  });
  assert.equal(created.status, 'created');
  assert.equal(created.receipt.mode, 'overlap_add');
  assert.equal(created.receipt.retirementMatchingInstallations, null);
  assert.equal(created.head.generation, 2);
  assert.equal(
    created.head.effectiveTrustDigest,
    value.candidateSnapshot.snapshotDigest,
  );

  const replay = await repository.applyApprovedTransition({
    dispatch: value.dispatch,
    executedAtMs: 130,
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.receipt.receiptDigest, created.receipt.receiptDigest);
  assert.equal(repository.signerLocks(), 2);
});

test('blocks safe retirement while a current installation uses the signer', async () => {
  const value = authority('safe_retire');
  await assert.rejects(
    fixture(value, { matchingInstall: true }).applyApprovedTransition({
      dispatch: value.dispatch,
      executedAtMs: 130,
    }),
    PluginPackagePublisherTrustTransitionConflictError,
  );
});
