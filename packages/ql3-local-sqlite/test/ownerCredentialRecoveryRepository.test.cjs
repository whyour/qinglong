const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  REVOKED_API_CREDENTIAL_DIGEST,
} = require('@qinglong/runtime-core/api-credential-administration');
const {
  LocalOwnerCredentialRecoveryInProgressError,
  LocalOwnerCredentialRecoveryMutationConflictError,
  LocalOwnerCredentialRecoveryNotAcknowledgedError,
} = require('@qinglong/runtime-core/local-owner-credential-recovery');
const { openLocalSqliteBootstrapDatabase } = require('../dist/storage/bootstrap');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');

const SUBJECT_ID = `usr_${'a'.repeat(22)}`;
const PREVIOUS_CREDENTIAL_ID = `own_${'b'.repeat(22)}`;
const PEPPER_KEY_ID = 'owner-key-1';

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-owner-recovery-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

async function prepared(t) {
  const databasePath = fixture(t);
  const options = { databasePath, profile: 'edge' };
  await migrateLocalSqlitePath(options);
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  client
    .prepare(
      `INSERT INTO "QingLong3IdentitySubjects" (
         subject_type, subject_id, status, version, created_at_ms, updated_at_ms
       ) VALUES ('user', ?, 'active', 1, 100, 100)`,
    )
    .run(SUBJECT_ID);
  client
    .prepare(
      `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
         pepper_key_id, material_digest, backup_digest, state, version,
         register_mutation_id, activate_mutation_id, registered_at_ms,
         activated_at_ms
       ) VALUES (?, ?, ?, 'active', 2, ?, ?, 90, 95)`,
    )
    .run(
      PEPPER_KEY_ID,
      '1'.repeat(64),
      '2'.repeat(64),
      '00000000-0000-4000-8000-000000000091',
      '00000000-0000-4000-8000-000000000092',
    );
  client
    .prepare(
      `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
         generation, mutation_id, expected_generation, previous_pepper_key_id,
         active_pepper_key_id, material_digest, backup_digest, activated_at_ms
       ) VALUES (1, ?, 0, NULL, ?, ?, ?, 95)`,
    )
    .run(
      '00000000-0000-4000-8000-000000000092',
      PEPPER_KEY_ID,
      '1'.repeat(64),
      '2'.repeat(64),
    );
  client
    .prepare(
      `INSERT INTO "QingLong3ApiCredentials" (
         credential_id, version, state, subject_type, subject_id,
         secret_digest, created_at_ms, not_before_at_ms, expires_at_ms
       ) VALUES (?, 1, 'active', 'user', ?, ?, 100, 100, 100000)`,
    )
    .run(PREVIOUS_CREDENTIAL_ID, SUBJECT_ID, '3'.repeat(64));
  client
    .prepare(
      `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
         credential_id, credential_version, pepper_key_id
       ) VALUES (?, 1, ?)`,
    )
    .run(PREVIOUS_CREDENTIAL_ID, PEPPER_KEY_ID);
  client.close();
  return { options, databasePath };
}

function audit(eventId, requestId, operationId, occurredAtMs) {
  return {
    eventId,
    requestId,
    operationId,
    projectId: null,
    subject: { type: 'system', id: 'owner-credential-recovery' },
    authenticationId: 'local-owner-console',
    outcome: 'allowed',
    reasons: ['credential_recovery'],
    fence: null,
    occurredAtMs,
  };
}

function issueCommand(index = 1) {
  const mutationId = `00000000-0000-4000-8000-0000000001${String(
    index,
  ).padStart(2, '0')}`;
  const requestId = `recover-issue-${index}`;
  const replacementCredential = {
    credentialId: `own_${String(index).repeat(22)}`,
    version: 1,
    pepperKeyId: PEPPER_KEY_ID,
    state: 'active',
    subject: { type: 'user', id: SUBJECT_ID },
    subjectStatus: 'active',
    secretDigest: String(index).repeat(64),
    createdAtMs: 1000 + index,
    notBeforeAtMs: 1000 + index,
    expiresAtMs: 10000 + index,
  };
  return {
    mutationId,
    requestId,
    previousCredentialId: PREVIOUS_CREDENTIAL_ID,
    expectedPreviousVersion: 1,
    replacementCredential,
    mutation: {
      mutationId,
      operation: 'issue',
      credentialId: replacementCredential.credentialId,
      credentialVersion: 1,
      expectedPreviousVersion: 0,
      changedBy: { type: 'system', id: 'owner-credential-recovery' },
      createdAtMs: replacementCredential.createdAtMs,
    },
    audit: audit(
      mutationId,
      requestId,
      'credential.issue',
      replacementCredential.createdAtMs,
    ),
  };
}

function acknowledgement(command, overrides = {}) {
  return {
    issueMutationId: command.mutationId,
    requestId: command.requestId,
    credentialId: command.replacementCredential.credentialId,
    factDigest: command.replacementCredential.secretDigest,
    deliveryDigest: 'd'.repeat(64),
    acknowledgedAtMs: 1100,
    ...overrides,
  };
}

function completeCommand(issue, index = 1) {
  const mutationId = `00000000-0000-4000-8000-0000000002${String(
    index,
  ).padStart(2, '0')}`;
  const requestId = `recover-complete-${index}`;
  const revokedCredential = {
    credentialId: PREVIOUS_CREDENTIAL_ID,
    version: 2,
    pepperKeyId: PEPPER_KEY_ID,
    state: 'revoked',
    subject: { type: 'user', id: SUBJECT_ID },
    subjectStatus: 'active',
    secretDigest: REVOKED_API_CREDENTIAL_DIGEST,
    createdAtMs: 1200,
    notBeforeAtMs: 1200,
    expiresAtMs: 1201,
  };
  return {
    issueMutationId: issue.mutationId,
    mutationId,
    requestId,
    expectedPreviousVersion: 1,
    revokedCredential,
    mutation: {
      mutationId,
      operation: 'revoke',
      credentialId: PREVIOUS_CREDENTIAL_ID,
      credentialVersion: 2,
      expectedPreviousVersion: 1,
      changedBy: { type: 'system', id: 'owner-credential-recovery' },
      createdAtMs: 1200,
    },
    audit: audit(mutationId, requestId, 'credential.revoke', 1200),
  };
}

test('keeps the old credential active until exact delivery acknowledgement', async (t) => {
  const { options } = await prepared(t);
  const database = await openLocalSqliteBootstrapDatabase(options);
  t.after(() => database.close());
  const issue = issueCommand();

  assert.equal(
    (await database.ownerCredentialRecovery.issue(issue)).status,
    'inserted',
  );
  assert.equal(
    (await database.ownerCredentialRecovery.issue(issue)).status,
    'existing',
  );
  assert.equal(
    (await database.apiCredentials.resolve(PREVIOUS_CREDENTIAL_ID)).state,
    'active',
  );
  await assert.rejects(
    database.ownerCredentialRecovery.complete(completeCommand(issue)),
    LocalOwnerCredentialRecoveryNotAcknowledgedError,
  );
  assert.equal(
    (await database.apiCredentials.resolve(PREVIOUS_CREDENTIAL_ID)).state,
    'active',
  );

  const ack = acknowledgement(issue);
  assert.equal(
    (await database.ownerCredentialRecovery.acknowledge(ack)).recovery.state,
    'acknowledged',
  );
  assert.equal(
    (await database.ownerCredentialRecovery.acknowledge(ack)).status,
    'existing',
  );
  assert.equal(
    (await database.apiCredentials.resolve(PREVIOUS_CREDENTIAL_ID)).state,
    'active',
  );

  const completed = await database.ownerCredentialRecovery.complete(
    completeCommand(issue),
  );
  assert.equal(completed.recovery.state, 'completed');
  assert.equal(
    (await database.apiCredentials.resolve(PREVIOUS_CREDENTIAL_ID)).state,
    'revoked',
  );
  assert.equal(
    (
      await database.apiCredentials.resolve(
        issue.replacementCredential.credentialId,
      )
    ).state,
    'active',
  );
  assert.equal(
    (await database.ownerPepper.inspectReferences(PEPPER_KEY_ID, 1300))
      .currentCredentialReferences,
    1,
  );
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000301',
    pepperKeyId: 'owner-key-2',
    materialDigest: '4'.repeat(64),
    backupDigest: '5'.repeat(64),
    registeredAtMs: 1301,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000302',
    pepperKeyId: 'owner-key-2',
    expectedGeneration: 1,
    expectedActivePepperKeyId: PEPPER_KEY_ID,
    activatedAtMs: 1302,
  });
  assert.deepEqual(
    await database.ownerPepper.inspectReferences(PEPPER_KEY_ID, 20000),
    {
      pepperKeyId: PEPPER_KEY_ID,
      inspectedAtMs: 20000,
      currentCredentialReferences: 0,
      inFlightRecoveryReferences: 0,
      historicalCredentialReferences: 3,
      runtimeReferencesClear: true,
    },
  );
});

test('serializes concurrent recovery and fails closed on acknowledgement drift', async (t) => {
  const { options } = await prepared(t);
  const first = await openLocalSqliteBootstrapDatabase(options);
  const second = await openLocalSqliteBootstrapDatabase(options);
  t.after(() => Promise.all([first.close(), second.close()]));
  const candidates = [issueCommand(1), issueCommand(2)];
  const settled = await Promise.allSettled([
    first.ownerCredentialRecovery.issue(candidates[0]),
    second.ownerCredentialRecovery.issue(candidates[1]),
  ]);
  assert.equal(
    settled.filter(({ status }) => status === 'fulfilled').length,
    1,
  );
  assert.ok(
    settled.find(({ status }) => status === 'rejected').reason instanceof
      LocalOwnerCredentialRecoveryInProgressError,
  );
  const winnerIndex = settled.findIndex(({ status }) => status === 'fulfilled');
  const winner = candidates[winnerIndex];
  await assert.rejects(
    first.ownerCredentialRecovery.acknowledge(
      acknowledgement(winner, {
        deliveryDigest: 'e'.repeat(64),
        factDigest: 'f'.repeat(64),
      }),
    ),
    LocalOwnerCredentialRecoveryMutationConflictError,
  );
  assert.equal(
    (await first.apiCredentials.resolve(PREVIOUS_CREDENTIAL_ID)).state,
    'active',
  );
});

test('keeps future active credentials as runtime pepper references', async (t) => {
  const { options, databasePath } = await prepared(t);
  const futureCredentialId = `own_${'f'.repeat(22)}`;
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  client
    .prepare(
      `INSERT INTO "QingLong3ApiCredentials" (
         credential_id, version, state, subject_type, subject_id,
         secret_digest, created_at_ms, not_before_at_ms, expires_at_ms
       ) VALUES (?, 1, 'active', 'user', ?, ?, 200, 300000, 400000)`,
    )
    .run(futureCredentialId, SUBJECT_ID, '6'.repeat(64));
  client
    .prepare(
      `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
         credential_id, credential_version, pepper_key_id
       ) VALUES (?, 1, ?)`,
    )
    .run(futureCredentialId, PEPPER_KEY_ID);
  client.close();

  const database = await openLocalSqliteBootstrapDatabase(options);
  t.after(() => database.close());
  await database.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000401',
    pepperKeyId: 'owner-key-2',
    materialDigest: '7'.repeat(64),
    backupDigest: '8'.repeat(64),
    registeredAtMs: 300,
  });
  await database.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000402',
    pepperKeyId: 'owner-key-2',
    expectedGeneration: 1,
    expectedActivePepperKeyId: PEPPER_KEY_ID,
    activatedAtMs: 301,
  });

  assert.deepEqual(
    await database.ownerPepper.inspectReferences(PEPPER_KEY_ID, 200000),
    {
      pepperKeyId: PEPPER_KEY_ID,
      inspectedAtMs: 200000,
      currentCredentialReferences: 1,
      inFlightRecoveryReferences: 0,
      historicalCredentialReferences: 2,
      runtimeReferencesClear: false,
    },
  );
  assert.equal(
    (await database.ownerPepper.inspectReferences(PEPPER_KEY_ID, 500000))
      .runtimeReferencesClear,
    true,
  );
});
