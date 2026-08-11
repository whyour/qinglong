const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  claimApprovedActionExecution,
  createApprovedActionExecution,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  PluginPackagePublisherTrustTransitionConflictError,
  createPluginPackagePublisherTrustTransitionProposal,
  resolvePluginPackagePublisherTrustTransitionProposal,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal');
const {
  ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler,
} = require('../dist/plugin-package/publisher/pluginPackagePublisherTrustTransitionApprovedAction');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_security' });
const SYSTEM = Object.freeze({
  type: 'system',
  id: 'cluster_package_executor',
});
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function definition(keyId, notAfterMs = 20_000) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    publisher: 'publisher-a.example',
    keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: 1,
    notAfterMs,
  };
}

function authority(mode) {
  const oldDefinition = definition('key-old');
  const newDefinition = definition('key-new', 30_000);
  const currentSnapshot =
    createPluginPackagePublisherTrustSnapshot(
      mode === 'overlap_add'
        ? [oldDefinition]
        : [oldDefinition, newDefinition],
    );
  return createPluginPackagePublisherTrustTransitionProposal({
    actionRef:
      mode === 'overlap_add'
        ? 'publisher-overlap:publisher-a.example:key-new'
        : 'publisher-retire:publisher-a.example:key-old',
    authorityProjectId: 'cluster-trust-authority',
    trustAuthorityId: 'cluster',
    trustGeneration: 3,
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
}

function approvedDispatch(candidate) {
  const action = {
    permission: candidate.permission,
    actionType: candidate.actionType,
    actionRef: candidate.actionRef,
    actionDigest: candidate.actionDigest,
    previewDigest: candidate.previewDigest,
  };
  const pending = createApprovalRequest({
    id: `approval-${candidate.actionInput.mode}`,
    projectId: candidate.projectId,
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
    decisionId: `decision-${candidate.actionInput.mode}`,
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
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: `consume-${candidate.actionInput.mode}`,
    dispatchId: `dispatch-${candidate.actionInput.mode}`,
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 120,
    authorizationFence: FENCE,
  }).dispatch;
}

function startedExecution(dispatch) {
  const baseline = createApprovedActionExecution(dispatch, 5);
  const claimed = claimApprovedActionExecution(baseline, {
    owner: 'publisher-trust-executor',
    leaseToken: `lease-${dispatch.id}`,
    nowMs: 121,
    leaseDurationMs: 1_000,
  });
  assert.equal(claimed.status, 'leased');
  return startApprovedActionExecution(
    { dispatch, execution: claimed },
    {
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      actionDigest: dispatch.action.actionDigest,
      owner: 'publisher-trust-executor',
      leaseToken: `lease-${dispatch.id}`,
      expectedVersion: claimed.version,
      startedAtMs: 130,
    },
  );
}

function proposalRepository(candidate) {
  return {
    async findProposalByActionRef() {
      return candidate;
    },
    async createProposal() {
      throw new Error('must not create');
    },
  };
}

test('executes exact overlap-add and safe-retire Approved Actions', async () => {
  for (const mode of ['overlap_add', 'safe_retire']) {
    const created = authority(mode);
    const dispatch = approvedDispatch(created.proposal);
    const execution = startedExecution(dispatch);
    const calls = [];
    const handler =
      new ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler(
        mode,
        proposalRepository(created.proposal),
        {
          async applyApprovedTransition(input) {
            calls.push(input);
            const receipt =
              resolvePluginPackagePublisherTrustTransitionProposal(
                created.proposal,
                input.dispatch,
                input.executedAtMs,
                mode === 'safe_retire' ? 0 : null,
              );
            return {
              status: 'created',
              receipt,
              head: {
                generation: receipt.currentGeneration,
                effectiveTrustDigest: receipt.currentTrustDigest,
              },
            };
          },
        },
      );

    assert.deepEqual(await handler.inspect(dispatch), {
      status: 'ready',
      actionDigest: created.proposal.actionDigest,
    });
    assert.deepEqual(
      await handler.execute({
        dispatch,
        execution,
        idempotencyKey: dispatch.id,
        fence: {
          owner: execution.leaseOwner,
          leaseToken: execution.leaseToken,
          version: execution.version,
        },
      }),
      {
        outcome: 'succeeded',
        resultCode:
          mode === 'overlap_add'
            ? 'publisher_trust_overlap_added'
            : 'publisher_trust_key_retired',
        resultDigest:
          resolvePluginPackagePublisherTrustTransitionProposal(
            created.proposal,
            dispatch,
            execution.startedAtMs,
            mode === 'safe_retire' ? 0 : null,
          ).receiptDigest,
      },
    );
    assert.deepEqual(calls, [
      {
        dispatch,
        executedAtMs: execution.startedAtMs,
      },
    ]);
  }
});

test('blocks missing or mismatched proposals and rejects stale execution fences', async () => {
  const created = authority('overlap_add');
  const dispatch = approvedDispatch(created.proposal);
  const missing =
    new ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler(
      'overlap_add',
      proposalRepository(null),
      { async applyApprovedTransition() { throw new Error('must not run'); } },
    );
  assert.deepEqual(await missing.inspect(dispatch), {
    status: 'blocked',
    resultCode: 'publisher_trust_transition_proposal_missing',
  });

  const wrongMode =
    new ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler(
      'safe_retire',
      proposalRepository(created.proposal),
      { async applyApprovedTransition() { throw new Error('must not run'); } },
    );
  assert.deepEqual(await wrongMode.inspect(dispatch), {
    status: 'blocked',
    resultCode: 'publisher_trust_transition_proposal_rejected',
  });

  const execution = startedExecution(dispatch);
  const conflict =
    new ClusterPluginPackagePublisherTrustTransitionApprovedActionHandler(
      'overlap_add',
      proposalRepository(created.proposal),
      {
        async applyApprovedTransition() {
          throw new PluginPackagePublisherTrustTransitionConflictError();
        },
      },
    );
  assert.deepEqual(
    await conflict.execute({
      dispatch,
      execution,
      idempotencyKey: dispatch.id,
      fence: {
        owner: execution.leaseOwner,
        leaseToken: execution.leaseToken,
        version: execution.version + 1,
      },
    }),
    {
      outcome: 'failed',
      resultCode: 'publisher_trust_transition_execution_rejected',
    },
  );
  assert.deepEqual(
    await conflict.execute({
      dispatch,
      execution,
      idempotencyKey: dispatch.id,
      fence: {
        owner: execution.leaseOwner,
        leaseToken: execution.leaseToken,
        version: execution.version,
      },
    }),
    {
      outcome: 'failed',
      resultCode: 'publisher_trust_transition_conflict',
    },
  );
});
