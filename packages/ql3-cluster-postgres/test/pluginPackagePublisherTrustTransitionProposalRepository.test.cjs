const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  approvalRequestDigest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  createPluginPackagePublisherTrustTransitionProposal,
  PluginPackagePublisherTrustTransitionConflictError,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust-transition-proposal');
const {
  PostgresPluginPackagePublisherTrustTransitionProposalRepository,
} = require('../dist/plugin-package/publisher/pluginPackagePublisherTrustTransitionProposalRepository');

const SUBJECT = Object.freeze({ type: 'user', id: 'usr_owner' });
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function transition() {
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
    createPluginPackagePublisherTrustSnapshot([oldDefinition]);
  const materialSnapshot =
    createPluginPackagePublisherTrustSnapshot([
      oldDefinition,
      newDefinition,
    ]);
  const created =
    createPluginPackagePublisherTrustTransitionProposal({
      actionRef: 'publisher-overlap:publisher-a.example:key-new',
      authorityProjectId: 'cluster-trust-authority',
      trustAuthorityId: 'cluster',
      trustGeneration: 1,
      mode: 'overlap_add',
      trustSnapshot: currentSnapshot,
      materialSnapshot,
      publisher: 'publisher-a.example',
      keyId: 'key-new',
      proposedBy: SUBJECT,
      proposerAssurance: 'multi_factor',
      proposalFence: FENCE,
      createdAtMs: 100,
    });
  return {
    ...created,
    currentSnapshot,
  };
}

function audit(proposal, overrides = {}) {
  return {
    eventId: '33000000-0000-4000-8000-000000000001',
    requestId: proposal.actionRef,
    operationId: 'plugin_package.publisher_trust_transition.propose',
    projectId: proposal.projectId,
    subject: proposal.proposedBy,
    authenticationId: 'auth-owner',
    outcome: 'allowed',
    reasons: ['publisher_trust_transition_proposal'],
    fence: proposal.proposalFence,
    occurredAtMs: proposal.createdAtMs,
    ...overrides,
  };
}

function fixture(value, trustOverrides = {}) {
  const snapshots = new Map([
    [value.currentSnapshot.snapshotDigest, value.currentSnapshot],
  ]);
  let storedProposal = null;
  let storedAudit = null;
  let signerLocks = 0;
  const query = async (text, values = []) => {
    if (text.includes('pg_advisory_xact_lock(hashtextextended')) {
      signerLocks += 1;
      assert.deepEqual(values, [
        JSON.stringify([
          value.proposal.actionInput.publisher,
          value.proposal.actionInput.keyId,
        ]),
        774635229,
      ]);
      return { rows: [{}], rowCount: 1 };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_trust_transition_proposals"',
      )
    ) {
      return {
        rows: storedProposal
          ? [
              {
                proposalJson: storedProposal,
                proposalDigest: storedProposal.proposalDigest,
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
            generation:
              trustOverrides.generation ??
              value.proposal.actionInput.trustGeneration,
            effectiveTrustDigest:
              trustOverrides.effectiveTrustDigest ??
              value.proposal.actionInput.previousTrustDigest,
            snapshotJson: value.currentSnapshot,
            snapshotDigest: value.currentSnapshot.snapshotDigest,
          },
        ],
      };
    }
    if (
      text.includes(
        'INSERT INTO "ql3"."plugin_package_publisher_trust_snapshots"',
      )
    ) {
      const existed = snapshots.has(values[0]);
      if (!existed) snapshots.set(values[0], JSON.parse(values[4]));
      return { rows: [], rowCount: existed ? 0 : 1 };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_trust_snapshots"',
      )
    ) {
      const snapshot = snapshots.get(values[0]);
      return {
        rows: snapshot
          ? [
              {
                snapshotJson: snapshot,
                snapshotDigest: snapshot.snapshotDigest,
              },
            ]
          : [],
      };
    }
    if (text.includes('lock_approval_policy_fence')) {
      return { rows: [{ matches: true }] };
    }
    if (
      text.includes(
        '"ql3"."plugin_package_publisher_trust_transition_proposals" (',
      )
    ) {
      storedProposal = JSON.parse(values[19]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
      storedAudit = audit(value.proposal);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM "ql3"."security_audit_events"')) {
      return {
        rows: storedAudit
          ? [
              {
                eventId: storedAudit.eventId,
                requestId: storedAudit.requestId,
                operationId: storedAudit.operationId,
                projectId: storedAudit.projectId,
                subjectType: storedAudit.subject.type,
                subjectId: storedAudit.subject.id,
                authenticationId: storedAudit.authenticationId,
                outcome: storedAudit.outcome,
                reasons: storedAudit.reasons,
                projectVersion: storedAudit.fence.projectVersion,
                bindingVersion: storedAudit.fence.bindingVersion,
                occurredAtMs: storedAudit.occurredAtMs,
              },
            ]
          : [],
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  const repository =
    new PostgresPluginPackagePublisherTrustTransitionProposalRepository({
      query,
      async connect() {
        return client;
      },
    });
  repository.signerLocks = () => signerLocks;
  repository.snapshots = () => snapshots;
  return repository;
}

test('persists candidate material and exactly replays an overlap proposal', async () => {
  const value = transition();
  const repository = fixture(value);
  const command = {
    proposal: value.proposal,
    candidateSnapshot: value.candidateSnapshot,
    audit: audit(value.proposal),
  };
  const created = await repository.createProposal(command);
  assert.equal(created.status, 'created');
  assert.equal(repository.signerLocks(), 1);
  assert.deepEqual(
    repository.snapshots().get(value.candidateSnapshot.snapshotDigest),
    value.candidateSnapshot,
  );

  const replay = await repository.createProposal(command);
  assert.equal(replay.status, 'existing');
  assert.equal(repository.signerLocks(), 1);
  assert.deepEqual(
    await repository.findProposalByActionRef(value.proposal.actionRef),
    value.proposal,
  );
});

test('rejects stale trust generations and client-shaped candidate drift', async () => {
  const value = transition();
  await assert.rejects(
    fixture(value, { generation: 2 }).createProposal({
      proposal: value.proposal,
      candidateSnapshot: value.candidateSnapshot,
      audit: audit(value.proposal),
    }),
    PluginPackagePublisherTrustTransitionConflictError,
  );
  assert.throws(
    () =>
      fixture(value).createProposal({
        proposal: value.proposal,
        candidateSnapshot: value.currentSnapshot,
        audit: audit(value.proposal),
      }),
    PluginPackagePublisherTrustTransitionConflictError,
  );
});

test('lists only separation-of-duty approvals from the durable JSON record', async () => {
  const value = transition();
  const pending = createApprovalRequest({
    id: 'approval-trust-transition-list',
    projectId: value.proposal.projectId,
    action: {
      permission: value.proposal.permission,
      actionType: value.proposal.actionType,
      actionRef: value.proposal.actionRef,
      actionDigest: value.proposal.actionDigest,
      previewDigest: value.proposal.previewDigest,
    },
    risk: 'critical',
    decisionMode: 'separation_of_duty',
    requestedBy: SUBJECT,
    requestedAtMs: 100,
    expiresAtMs: 10_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-trust-transition-list',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: { type: 'user', id: 'usr_reviewer' },
      authenticationId: 'auth-reviewer',
      authenticatedAtMs: 100,
      expiresAtMs: 10_000,
      assurance: 'multi_factor',
    },
    decidedAtMs: 101,
    authorizationFence: FENCE,
  });
  let inspectedSql = '';
  const repository =
    new PostgresPluginPackagePublisherTrustTransitionProposalRepository({
      async query(text) {
        inspectedSql = text;
        return {
          rows: [
            {
              requestJson: approved,
              requestDigest: approvalRequestDigest(approved),
            },
          ],
          rowCount: 1,
        };
      },
      async connect() {
        throw new Error('listApprovedRequests must not open a transaction');
      },
    });
  assert.deepEqual(await repository.listApprovedRequests(4), [approved]);
  assert.match(
    inspectedSql,
    /request\.request_json ->> 'decisionMode'/,
  );
  assert.doesNotMatch(inspectedSql, /request\.decision_mode/);
});
