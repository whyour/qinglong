const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalOwnerPepperMaterialGcInProgressError,
  LocalOwnerPepperMaterialGcMutationConflictError,
  LocalOwnerPepperMaterialGcReferenceConflictError,
  LocalOwnerPepperMaterialGcRetentionPendingError,
  MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
} = require('@qinglong/runtime-core/local-owner-pepper-material-gc');
const { openLocalSqlitePepperGcDatabase } = require('../dist/maintenance/pepperGc');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');

const RETIRED_KEY_ID = 'owner-key-retired';
const ACTIVE_KEY_ID = 'owner-key-active';
const RETIRED_DIGEST = '1'.repeat(64);
const ACTIVE_DIGEST = '2'.repeat(64);
const PREPARED_AT_MS = 3_000_000_000;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-pepper-gc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

async function preparedDatabase(t, futureReference = false) {
  const databasePath = fixture(t);
  const options = { databasePath, profile: 'edge' };
  await migrateLocalSqlitePath(options);
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  client
    .prepare(
      `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
         pepper_key_id, material_digest, backup_digest, state, version,
         register_mutation_id, activate_mutation_id, retire_mutation_id,
         registered_at_ms, activated_at_ms, retired_at_ms
       ) VALUES (?, ?, ?, 'retired', 3, ?, ?, ?, 10, 50, 100)`,
    )
    .run(
      RETIRED_KEY_ID,
      RETIRED_DIGEST,
      RETIRED_DIGEST,
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000014',
    );
  client
    .prepare(
      `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
         pepper_key_id, material_digest, backup_digest, state, version,
         register_mutation_id, activate_mutation_id, registered_at_ms,
         activated_at_ms
       ) VALUES (?, ?, ?, 'active', 2, ?, ?, 60, 100)`,
    )
    .run(
      ACTIVE_KEY_ID,
      ACTIVE_DIGEST,
      ACTIVE_DIGEST,
      '00000000-0000-4000-8000-000000000021',
      '00000000-0000-4000-8000-000000000022',
    );
  client
    .prepare(
      `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
         generation, mutation_id, expected_generation,
         previous_pepper_key_id, active_pepper_key_id,
         material_digest, backup_digest, activated_at_ms
       ) VALUES (1, ?, 0, NULL, ?, ?, ?, 50)`,
    )
    .run(
      '00000000-0000-4000-8000-000000000012',
      RETIRED_KEY_ID,
      RETIRED_DIGEST,
      RETIRED_DIGEST,
    );
  client
    .prepare(
      `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
         generation, mutation_id, expected_generation,
         previous_pepper_key_id, active_pepper_key_id,
         material_digest, backup_digest, activated_at_ms
       ) VALUES (2, ?, 1, ?, ?, ?, ?, 100)`,
    )
    .run(
      '00000000-0000-4000-8000-000000000022',
      RETIRED_KEY_ID,
      ACTIVE_KEY_ID,
      ACTIVE_DIGEST,
      ACTIVE_DIGEST,
    );
  if (futureReference) {
    const subjectId = `usr_${'g'.repeat(22)}`;
    const credentialId = `own_${'h'.repeat(22)}`;
    client
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           subject_type, subject_id, status, version, created_at_ms, updated_at_ms
         ) VALUES ('user', ?, 'active', 1, 200, 200)`,
      )
      .run(subjectId);
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           credential_id, version, state, subject_type, subject_id,
           secret_digest, created_at_ms, not_before_at_ms, expires_at_ms
         ) VALUES (?, 1, 'active', 'user', ?, ?, 200, 3500000000, 4000000000)`,
      )
      .run(credentialId, subjectId, '3'.repeat(64));
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           credential_id, credential_version, pepper_key_id
         ) VALUES (?, 1, ?)`,
      )
      .run(credentialId, RETIRED_KEY_ID);
  }
  client.close();
  return options;
}

function policy() {
  return {
    version: 1,
    acknowledgementRetentionMs: MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS,
    auditRetentionMs: MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS,
    backupRetentionMs: MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
  };
}

function audit(mutationId, requestId, operation, occurredAtMs) {
  return {
    eventId: mutationId,
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

function prepareCommand(index = 1, preparedAtMs = PREPARED_AT_MS) {
  const mutationId = `00000000-0000-4000-8000-0000000006${String(
    index,
  ).padStart(2, '0')}`;
  const requestId = `pepper-gc-prepare-${index}`;
  return {
    mutationId,
    requestId,
    pepperKeyId: RETIRED_KEY_ID,
    expectedMaterialDigest: RETIRED_DIGEST,
    expectedBackupMaterialDigest: RETIRED_DIGEST,
    expectedActivePepperKeyId: ACTIVE_KEY_ID,
    expectedActiveGeneration: 2,
    expectedActiveMaterialDigest: ACTIVE_DIGEST,
    retentionPolicy: policy(),
    preparedAtMs,
    audit: audit(mutationId, requestId, 'prepare', preparedAtMs),
  };
}

function completeCommand(prepare) {
  const mutationId = '00000000-0000-4000-8000-000000000701';
  const requestId = 'pepper-gc-complete-1';
  const completedAtMs = PREPARED_AT_MS + 1;
  return {
    prepareMutationId: prepare.mutationId,
    mutationId,
    requestId,
    destructionProofDigest: '4'.repeat(64),
    completedAtMs,
    audit: audit(mutationId, requestId, 'complete', completedAtMs),
  };
}

test('prepares and completes one exact idempotent GC ledger', async (t) => {
  const options = await preparedDatabase(t);
  const database = await openLocalSqlitePepperGcDatabase(options);
  t.after(() => database.close());
  const prepare = prepareCommand();
  const inserted = await database.materialGc.prepare(prepare);
  assert.equal(inserted.status, 'inserted');
  assert.equal(inserted.record.state, 'prepared');
  assert.equal(
    inserted.record.retentionEligibleAtMs,
    100 + MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
  );
  assert.equal((await database.materialGc.prepare(prepare)).status, 'existing');

  const complete = completeCommand(prepare);
  assert.equal(
    (await database.materialGc.complete(complete)).record.state,
    'completed',
  );
  assert.equal(
    (await database.materialGc.complete(complete)).status,
    'existing',
  );
});

test('rejects retention, future references and concurrent open GC', async (t) => {
  const retentionOptions = await preparedDatabase(t);
  const retentionDatabase = await openLocalSqlitePepperGcDatabase(
    retentionOptions,
  );
  t.after(() => retentionDatabase.close());
  await assert.rejects(
    retentionDatabase.materialGc.prepare(prepareCommand(1, 1_000)),
    LocalOwnerPepperMaterialGcRetentionPendingError,
  );

  const referenceOptions = await preparedDatabase(t, true);
  const referenceDatabase = await openLocalSqlitePepperGcDatabase(
    referenceOptions,
  );
  t.after(() => referenceDatabase.close());
  await assert.rejects(
    referenceDatabase.materialGc.prepare(prepareCommand()),
    LocalOwnerPepperMaterialGcReferenceConflictError,
  );

  const concurrentOptions = await preparedDatabase(t);
  const first = await openLocalSqlitePepperGcDatabase(concurrentOptions);
  const second = await openLocalSqlitePepperGcDatabase(concurrentOptions);
  t.after(() => Promise.all([first.close(), second.close()]));
  await first.materialGc.prepare(prepareCommand(1));
  await assert.rejects(
    second.materialGc.prepare(prepareCommand(2)),
    LocalOwnerPepperMaterialGcInProgressError,
  );
});

test('rejects a backup digest that is not bound to the retired catalog row', async (t) => {
  const options = await preparedDatabase(t);
  const database = await openLocalSqlitePepperGcDatabase(options);
  t.after(() => database.close());
  await assert.rejects(
    database.materialGc.prepare({
      ...prepareCommand(),
      expectedBackupMaterialDigest: '9'.repeat(64),
    }),
    LocalOwnerPepperMaterialGcMutationConflictError,
  );
  assert.equal(
    await database.materialGc.resolve(prepareCommand().mutationId),
    null,
  );
});
