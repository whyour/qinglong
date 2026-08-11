const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  LocalOwnerPepperKeyringFileProvider,
  localOwnerPepperKeyPath,
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const {
  destroyLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody/destructive');
const {
  openLocalSqlitePepperGcDatabase,
} = require('@qinglong/local-sqlite/pepper-gc');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS,
  MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
} = require('@qinglong/runtime-core/local-owner-pepper-material-gc');
const {
  LocalOwnerPepperMaterialGcMaterialUnavailableError,
  openLocalOwnerPepperMaterialGc,
} = require('../dist/security-maintenance/pepperGc');

const RETIRED_KEY_ID = 'owner-key-retired';
const ACTIVE_KEY_ID = 'owner-key-active';
const REQUESTED_AT_MS = 3_000_000_000;

function policy() {
  return {
    version: 1,
    acknowledgementRetentionMs: MIN_LOCAL_OWNER_PEPPER_ACK_RETENTION_MS,
    auditRetentionMs: MIN_LOCAL_OWNER_PEPPER_AUDIT_RETENTION_MS,
    backupRetentionMs: MIN_LOCAL_OWNER_PEPPER_BACKUP_RETENTION_MS,
  };
}

function request() {
  return {
    prepareMutationId: '00000000-0000-4000-8000-000000000801',
    prepareRequestId: 'pepper-gc-prepare',
    completeMutationId: '00000000-0000-4000-8000-000000000802',
    completeRequestId: 'pepper-gc-complete',
    pepperKeyId: RETIRED_KEY_ID,
  };
}

function audit(eventId, requestId, operation) {
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
    occurredAtMs: REQUESTED_AT_MS,
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-pepper-gc-e2e-'));
  const keyringDirectory = path.join(root, 'keyring');
  const backupDirectory = path.join(root, 'backup');
  const databasePath = path.join(root, 'qinglong3.sqlite');
  fs.mkdirSync(keyringDirectory, { mode: 0o700 });
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retiredRuntime = provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId: RETIRED_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 41),
  });
  const retiredBackup = provisionLocalOwnerPepperKey({
    keyringDirectory: backupDirectory,
    pepperKeyId: RETIRED_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 41),
  });
  const activeRuntime = provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId: ACTIVE_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 43),
  });
  const activeBackup = provisionLocalOwnerPepperKey({
    keyringDirectory: backupDirectory,
    pepperKeyId: ACTIVE_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 43),
  });
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
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
      retiredRuntime.digest,
      retiredBackup.digest,
      '00000000-0000-4000-8000-000000000811',
      '00000000-0000-4000-8000-000000000812',
      '00000000-0000-4000-8000-000000000813',
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
      activeRuntime.digest,
      activeBackup.digest,
      '00000000-0000-4000-8000-000000000821',
      '00000000-0000-4000-8000-000000000822',
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
      '00000000-0000-4000-8000-000000000812',
      RETIRED_KEY_ID,
      retiredRuntime.digest,
      retiredBackup.digest,
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
      '00000000-0000-4000-8000-000000000822',
      RETIRED_KEY_ID,
      ACTIVE_KEY_ID,
      activeRuntime.digest,
      activeBackup.digest,
    );
  client.close();
  return {
    databasePath,
    keyringDirectory,
    backupDirectory,
    retiredRuntime,
    retiredBackup,
    activeRuntime,
  };
}

function openOptions(fixture) {
  return {
    databasePath: fixture.databasePath,
    profile: 'edge',
    keyringDirectory: fixture.keyringDirectory,
    backupDirectory: fixture.backupDirectory,
    retentionPolicy: policy(),
  };
}

test('destroys runtime and backup material then replays from durable absence', async (t) => {
  const prepared = await fixture(t);
  const authority = await openLocalOwnerPepperMaterialGc(openOptions(prepared));
  t.after(() => authority.close());
  const first = await authority.collect(request());
  assert.equal(first.status, 'inserted');
  assert.equal(first.record.state, 'completed');
  assert.equal(first.runtimeMaterial.status, 'destroyed');
  assert.equal(first.backupMaterial.status, 'destroyed');
  assert.equal(
    fs.existsSync(
      localOwnerPepperKeyPath(prepared.keyringDirectory, RETIRED_KEY_ID),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      localOwnerPepperKeyPath(prepared.backupDirectory, RETIRED_KEY_ID),
    ),
    false,
  );
  assert.ok(
    new LocalOwnerPepperKeyringFileProvider(prepared.keyringDirectory).resolve(
      ACTIVE_KEY_ID,
    ),
  );

  const replay = await authority.collect(request());
  assert.equal(replay.status, 'existing');
  assert.equal(replay.runtimeMaterial.status, 'absent');
  assert.equal(replay.backupMaterial.status, 'absent');
  assert.equal(
    replay.record.destructionProofDigest,
    first.record.destructionProofDigest,
  );
});

test('recovers after runtime deletion but before backup deletion and completion', async (t) => {
  const prepared = await fixture(t);
  const command = request();
  const database = await openLocalSqlitePepperGcDatabase({
    databasePath: prepared.databasePath,
    profile: 'edge',
  });
  await database.materialGc.prepare({
    mutationId: command.prepareMutationId,
    requestId: command.prepareRequestId,
    pepperKeyId: command.pepperKeyId,
    expectedMaterialDigest: prepared.retiredRuntime.digest,
    expectedBackupMaterialDigest: prepared.retiredBackup.digest,
    expectedActivePepperKeyId: ACTIVE_KEY_ID,
    expectedActiveGeneration: 2,
    expectedActiveMaterialDigest: prepared.activeRuntime.digest,
    retentionPolicy: policy(),
    preparedAtMs: REQUESTED_AT_MS,
    audit: audit(
      command.prepareMutationId,
      command.prepareRequestId,
      'prepare',
    ),
  });
  await database.close();
  destroyLocalOwnerPepperKey({
    keyringDirectory: prepared.keyringDirectory,
    pepperKeyId: RETIRED_KEY_ID,
    materialRole: 'runtime',
    expectedMaterialDigest: prepared.retiredRuntime.digest,
    prepareMutationId: command.prepareMutationId,
  });

  const authority = await openLocalOwnerPepperMaterialGc(openOptions(prepared));
  t.after(() => authority.close());
  const recovered = await authority.collect(command);
  assert.equal(recovered.record.state, 'completed');
  assert.equal(recovered.runtimeMaterial.status, 'absent');
  assert.equal(recovered.backupMaterial.status, 'destroyed');
});

test('fails before prepare when the active independent backup is missing', async (t) => {
  const prepared = await fixture(t);
  fs.unlinkSync(
    localOwnerPepperKeyPath(prepared.backupDirectory, ACTIVE_KEY_ID),
  );
  const authority = await openLocalOwnerPepperMaterialGc(openOptions(prepared));
  t.after(() => authority.close());
  await assert.rejects(
    authority.collect(request()),
    LocalOwnerPepperMaterialGcMaterialUnavailableError,
  );
  assert.equal(
    fs.existsSync(
      localOwnerPepperKeyPath(prepared.keyringDirectory, RETIRED_KEY_ID),
    ),
    true,
  );
});

test('rejects caller-controlled time before opening a destructive operation', async (t) => {
  const prepared = await fixture(t);
  const authority = await openLocalOwnerPepperMaterialGc(openOptions(prepared));
  t.after(() => authority.close());
  await assert.rejects(
    authority.collect({
      ...request(),
      requestedAtMs: Number.MAX_SAFE_INTEGER,
    }),
    /request shape is invalid/,
  );
  assert.equal(
    fs.existsSync(
      localOwnerPepperKeyPath(prepared.keyringDirectory, RETIRED_KEY_ID),
    ),
    true,
  );
});
