const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidLocalOwnerPepperMaterialGcValueError,
  MAX_LOCAL_OWNER_PEPPER_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
  localOwnerPepperMaterialGcRetentionPolicyDigest,
  normalizeCompleteLocalOwnerPepperMaterialGcCommand,
  normalizePrepareLocalOwnerPepperMaterialGcCommand,
} = require('../dist/local-owner/localOwnerPepperMaterialGc');

const PREPARE_MUTATION_ID = '00000000-0000-4000-8000-000000000901';
const COMPLETE_MUTATION_ID = '00000000-0000-4000-8000-000000000902';

function policy() {
  return {
    version: 1,
    acknowledgementRetentionMs: MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS,
    auditRetentionMs: MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS,
    backupRetentionMs: MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
  };
}

function audit(eventId, requestId, operation, occurredAtMs) {
  return {
    eventId,
    requestId,
    operationId: `owner.pepper.material_gc.${operation}`,
    projectId: null,
    subject: { type: 'system', id: 'owner-pepper-gc' },
    authenticationId: 'local-owner-console',
    outcome: 'allowed',
    reasons: ['pepper_material_gc'],
    fence: null,
    occurredAtMs,
  };
}

function prepareCommand() {
  return {
    mutationId: PREPARE_MUTATION_ID,
    requestId: 'pepper-gc-prepare',
    pepperKeyId: 'owner-key-retired',
    expectedMaterialDigest: 'a'.repeat(64),
    expectedBackupMaterialDigest: 'b'.repeat(64),
    expectedActivePepperKeyId: 'owner-key-active',
    expectedActiveGeneration: 2,
    expectedActiveMaterialDigest: 'c'.repeat(64),
    retentionPolicy: policy(),
    preparedAtMs: 3_000_000_000,
    audit: audit(
      PREPARE_MUTATION_ID,
      'pepper-gc-prepare',
      'prepare',
      3_000_000_000,
    ),
  };
}

test('normalizes exact GC commands and stable minimum retention policy', () => {
  const firstDigest = localOwnerPepperMaterialGcRetentionPolicyDigest(policy());
  const secondDigest = localOwnerPepperMaterialGcRetentionPolicyDigest({
    ...policy(),
  });
  assert.equal(firstDigest, secondDigest);
  assert.match(firstDigest, /^[0-9a-f]{64}$/);

  const prepared = normalizePrepareLocalOwnerPepperMaterialGcCommand(
    prepareCommand(),
  );
  const completed = normalizeCompleteLocalOwnerPepperMaterialGcCommand({
    prepareMutationId: PREPARE_MUTATION_ID,
    mutationId: COMPLETE_MUTATION_ID,
    requestId: 'pepper-gc-complete',
    destructionProofDigest: 'd'.repeat(64),
    completedAtMs: 3_000_000_001,
    audit: audit(
      COMPLETE_MUTATION_ID,
      'pepper-gc-complete',
      'complete',
      3_000_000_001,
    ),
  });
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.retentionPolicy), true);
  assert.equal(Object.isFrozen(completed), true);
});

test('rejects retention below reviewed bounds and above the maximum', () => {
  assert.throws(
    () =>
      localOwnerPepperMaterialGcRetentionPolicyDigest({
        ...policy(),
        acknowledgementRetentionMs: MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS - 1,
      }),
    InvalidLocalOwnerPepperMaterialGcValueError,
  );
  assert.throws(
    () =>
      localOwnerPepperMaterialGcRetentionPolicyDigest({
        ...policy(),
        auditRetentionMs: MAX_LOCAL_OWNER_PEPPER_RETENTION_MS + 1,
      }),
    InvalidLocalOwnerPepperMaterialGcValueError,
  );
});

test('rejects widened commands and audit identities not bound to the mutation', () => {
  assert.throws(
    () =>
      normalizePrepareLocalOwnerPepperMaterialGcCommand({
        ...prepareCommand(),
        force: true,
      }),
    InvalidLocalOwnerPepperMaterialGcValueError,
  );
  const command = prepareCommand();
  assert.throws(
    () =>
      normalizePrepareLocalOwnerPepperMaterialGcCommand({
        ...command,
        audit: {
          ...command.audit,
          authenticationId: 'local-runtime',
        },
      }),
    InvalidLocalOwnerPepperMaterialGcValueError,
  );
});
