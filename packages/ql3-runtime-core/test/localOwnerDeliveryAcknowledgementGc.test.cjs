const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidLocalOwnerDeliveryAcknowledgementGcValueError,
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
  localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest,
  normalizeCompactLocalOwnerDeliveryAcknowledgementCommand,
} = require('../dist/local-owner/localOwnerDeliveryAcknowledgementGc');
const {
  localOwnerSecretDeliveryAcknowledgementSemanticDigest,
} = require('../dist/local-owner/localOwnerBootstrap');

const ACK_MUTATION_ID = '00000000-0000-4000-8000-000000000a01';
const GC_MUTATION_ID = '00000000-0000-4000-8000-000000000a02';
const COMPACTED_AT_MS = 4_000_000_000;

function policy() {
  return {
    version: 1,
    replayRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_REPLAY_RETENTION_MS,
    auditRetentionMs: MIN_LOCAL_OWNER_ACKNOWLEDGEMENT_AUDIT_RETENTION_MS,
  };
}

function command() {
  return {
    mutationId: GC_MUTATION_ID,
    requestId: 'acknowledgement-gc-1',
    acknowledgementMutationId: ACK_MUTATION_ID,
    expectedKind: 'credential',
    expectedDeliveryDigest: 'd'.repeat(64),
    bridgeClearEvidence: {
      kind: 'credential',
      acknowledgementMutationId: ACK_MUTATION_ID,
      inspectedAtMs: COMPACTED_AT_MS,
      evidenceDigest: 'e'.repeat(64),
    },
    retentionPolicy: policy(),
    compactedAtMs: COMPACTED_AT_MS,
    audit: {
      eventId: GC_MUTATION_ID,
      requestId: 'acknowledgement-gc-1',
      operationId: 'owner.delivery_acknowledgement.gc',
      projectId: null,
      subject: { type: 'system', id: 'owner-acknowledgement-gc' },
      authenticationId: 'local-owner-console',
      outcome: 'allowed',
      reasons: ['delivery_acknowledgement_gc'],
      fence: null,
      occurredAtMs: COMPACTED_AT_MS,
    },
  };
}

test('normalizes exact acknowledgement GC policy and bridge-bound command', () => {
  const normalized = normalizeCompactLocalOwnerDeliveryAcknowledgementCommand(
    command(),
  );
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.bridgeClearEvidence), true);
  assert.equal(
    localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest(policy()),
    localOwnerDeliveryAcknowledgementGcRetentionPolicyDigest({ ...policy() }),
  );
});

test('rejects widened commands, weak retention and bridge identity drift', () => {
  assert.throws(
    () =>
      normalizeCompactLocalOwnerDeliveryAcknowledgementCommand({
        ...command(),
        force: true,
      }),
    InvalidLocalOwnerDeliveryAcknowledgementGcValueError,
  );
  assert.throws(
    () =>
      normalizeCompactLocalOwnerDeliveryAcknowledgementCommand({
        ...command(),
        retentionPolicy: { ...policy(), replayRetentionMs: 1 },
      }),
    InvalidLocalOwnerDeliveryAcknowledgementGcValueError,
  );
  assert.throws(
    () =>
      normalizeCompactLocalOwnerDeliveryAcknowledgementCommand({
        ...command(),
        bridgeClearEvidence: {
          ...command().bridgeClearEvidence,
          kind: 'challenge',
        },
      }),
    InvalidLocalOwnerDeliveryAcknowledgementGcValueError,
  );
});

test('acknowledgement semantic digest binds kind-specific identity and time', () => {
  const record = {
    kind: 'credential',
    mutationId: ACK_MUTATION_ID,
    requestId: 'owner-provision-1',
    subjectId: `usr_${'a'.repeat(22)}`,
    credentialId: `own_${'b'.repeat(22)}`,
    factDigest: 'c'.repeat(64),
    ttlMs: 600_000,
    deliveryDigest: 'd'.repeat(64),
    acknowledgedAtMs: 10,
  };
  const digest = localOwnerSecretDeliveryAcknowledgementSemanticDigest(record);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(
    digest,
    localOwnerSecretDeliveryAcknowledgementSemanticDigest({
      ...record,
      acknowledgedAtMs: 11,
    }),
  );
});
