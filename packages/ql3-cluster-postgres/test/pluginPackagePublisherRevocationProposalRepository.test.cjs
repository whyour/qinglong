const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  createPluginPackagePublisherRevocationProposal,
  PluginPackagePublisherRevocationProposalConflictError,
} = require('@qinglong/runtime-core/plugin-package-publisher-revocation-proposal');
const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  PostgresPluginPackagePublisherRevocationProposalRepository,
} = require('../dist/plugin-package/publisher/pluginPackagePublisherRevocationProposalRepository');

const SUBJECT = Object.freeze({ type: 'user', id: 'usr_owner' });
const FENCE = Object.freeze({ projectVersion: 4, bindingVersion: 7 });

function proposal() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const trustSnapshot = createPluginPackagePublisherTrustSnapshot([
    {
      publisher: 'publisher-a.example',
      keyId: 'key-a',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      notBeforeMs: 1,
      notAfterMs: 10_000,
    },
  ]);
  return createPluginPackagePublisherRevocationProposal({
    actionRef: 'publisher-revoke:publisher-a.example:key-a',
    authorityProjectId: 'cluster-trust-authority',
    trustAuthorityId: 'cluster',
    trustGeneration: 1,
    trustSnapshot,
    publisher: 'publisher-a.example',
    keyId: 'key-a',
    authorizationMode: 'dual_control',
    reasonCode: 'suspected_key_compromise',
    proposedBy: SUBJECT,
    proposerAssurance: 'multi_factor',
    proposalFence: FENCE,
    createdAtMs: 100,
  });
}

function audit(candidate, overrides = {}) {
  return {
    eventId: '32000000-0000-4000-8000-000000000001',
    requestId: candidate.actionRef,
    operationId: 'plugin_package.publisher_revocation.propose',
    projectId: candidate.projectId,
    subject: candidate.proposedBy,
    authenticationId: 'auth-owner',
    outcome: 'allowed',
    reasons: ['publisher_revocation_proposal'],
    fence: candidate.proposalFence,
    occurredAtMs: candidate.createdAtMs,
    ...overrides,
  };
}

function fixture(candidate, trustOverrides = {}) {
  let storedProposal = null;
  let storedAudit = null;
  let signerLocks = 0;
  const query = async (text, values = []) => {
    if (text.includes('pg_advisory_xact_lock(hashtextextended')) {
      signerLocks += 1;
      assert.deepEqual(values, [
        JSON.stringify([
          candidate.actionInput.publisher,
          candidate.actionInput.keyId,
        ]),
        774635229,
      ]);
      return { rows: [{}], rowCount: 1 };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_revocation_proposals"',
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
        'FROM "ql3"."plugin_package_publisher_trust_heads"',
      )
    ) {
      return {
        rows: [
          {
            generation:
              trustOverrides.generation ??
              candidate.actionInput.trustGeneration,
            effectiveTrustDigest:
              trustOverrides.effectiveTrustDigest ??
              candidate.actionInput.previousTrustDigest,
          },
        ],
      };
    }
    if (text.includes('lock_approval_policy_fence')) {
      return { rows: [{ matches: true }] };
    }
    if (
      text.includes(
        'INSERT INTO\n           "ql3"."plugin_package_publisher_revocation_proposals"',
      )
    ) {
      storedProposal = JSON.parse(values[20]);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
      storedAudit = audit(candidate);
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
    new PostgresPluginPackagePublisherRevocationProposalRepository({
    query,
    async connect() {
      return client;
    },
  });
  repository.signerLocks = () => signerLocks;
  return repository;
}

test('persists and exactly replays a generation-fenced revocation proposal', async () => {
  const candidate = proposal();
  const repository = fixture(candidate);
  const created = await repository.createProposal({
    proposal: candidate,
    audit: audit(candidate),
  });
  assert.equal(created.status, 'created');
  assert.equal(repository.signerLocks(), 1);
  const replay = await repository.createProposal({
    proposal: candidate,
    audit: audit(candidate),
  });
  assert.equal(replay.status, 'existing');
  assert.equal(repository.signerLocks(), 1);
  assert.deepEqual(
    await repository.findProposalByActionRef(candidate.actionRef),
    candidate,
  );
});

test('rejects stale trust generations and mismatched audit authority', async () => {
  const candidate = proposal();
  await assert.rejects(
    fixture(candidate, { generation: 2 }).createProposal({
      proposal: candidate,
      audit: audit(candidate),
    }),
    PluginPackagePublisherRevocationProposalConflictError,
  );
  assert.throws(
    () =>
      fixture(candidate).createProposal({
        proposal: candidate,
        audit: audit(candidate, {
          reasons: ['client_supplied_transition'],
        }),
      }),
    PluginPackagePublisherRevocationProposalConflictError,
  );
});
