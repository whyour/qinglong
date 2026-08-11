const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  ApiCredentialUnavailableError,
} = require('@qinglong/runtime-core/api-credential');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  openLocalSqliteBootstrapDatabase,
} = require('@qinglong/local-sqlite/bootstrap');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  LocalOwnerPepperKeyringFileProvider,
  provisionLocalOwnerPepperKey,
  restoreLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console/pepper-custody');
const {
  LocalIdentityAuthenticationConfigurationError,
  LocalIdentityAuthenticationUnavailableError,
  createLocalIdentityAuthenticator,
  createLocalIdentityKeyringAuthenticator,
} = require('@qinglong/local-owner-console/identity-authentication');

const NOW = 1_800_000_000_000;
const PEPPER = Buffer.alloc(32, 7).toString('base64url');
const SECRET = Buffer.alloc(32, 11).toString('base64url');
const CREDENTIAL_ID = 'fresh-owner';
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-identity-'),
  );
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return databasePath;
}

function seed(databasePath, options = {}) {
  const client = new DatabaseSync(databasePath);
  try {
    const materialDigest = createHash('sha256')
      .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
      .update(PEPPER, 'utf8')
      .digest('hex');
    if (options.recoveryRequired) {
      client
        .prepare(
          `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
             "pepper_key_id", "state", "version", "registered_at_ms"
           ) VALUES ('legacy-v1', 'recovery_required', 1, 0)`,
        )
        .run();
    } else {
      client
        .prepare(
          `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
             "pepper_key_id", "material_digest", "backup_digest", "state",
             "version", "register_mutation_id", "activate_mutation_id",
             "registered_at_ms", "activated_at_ms"
           ) VALUES (
             'legacy-v1', ?, ?, 'active', 2,
             '00000000-0000-4000-8000-000000000091',
             '00000000-0000-4000-8000-000000000092', ?, ?
           )`,
        )
        .run(materialDigest, 'b'.repeat(64), NOW - 2_000, NOW - 1_500);
      client
        .prepare(
          `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
             "generation", "mutation_id", "expected_generation",
             "previous_pepper_key_id", "active_pepper_key_id",
             "material_digest", "backup_digest", "activated_at_ms"
           ) VALUES (
             1, '00000000-0000-4000-8000-000000000092', 0,
             NULL, 'legacy-v1', ?, ?, ?
           )`,
        )
        .run(materialDigest, 'b'.repeat(64), NOW - 1_500);
    }
    client
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'user-01', ?, 1, ?, ?)`,
      )
      .run(options.subjectStatus ?? 'active', NOW - 1_000, NOW - 1_000);
    client
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, ?, 'user', 'user-01', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        options.state ?? 'active',
        apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        NOW - 1_000,
        options.notBeforeAtMs ?? NOW - 1_000,
        options.expiresAtMs ?? NOW + 600_000,
      );
    if (!options.omitPepperBinding) {
      client
        .prepare(
          `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
             "credential_id", "credential_version", "pepper_key_id"
           ) VALUES (?, 1, 'legacy-v1')`,
        )
        .run(CREDENTIAL_ID);
    }
  } finally {
    client.close();
  }
}

test('authenticates one stable local User through the shared SQLite authority', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  seed(databasePath);
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  const authenticator = createLocalIdentityAuthenticator(
    runtime.apiCredentials,
    PEPPER,
    { now: () => NOW },
  );
  const principal = await authenticator.authenticate(TOKEN);
  assert.deepEqual(principal, {
    subject: { type: 'user', id: 'user-01' },
    authenticationId: 'local_credential:fresh-owner:1',
    authenticatedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    assurance: 'single_factor',
  });
  const authentication = await authenticator.authenticateCredential(TOKEN);
  assert.deepEqual(authentication, {
    principal,
    credentialId: CREDENTIAL_ID,
    credentialVersion: 1,
  });
  await runtime.close();
});

test('authenticates through the runtime catalog and bounded POSIX keyring', async (t) => {
  const databasePath = fixture(t);
  const keyringDirectory = path.join(path.dirname(databasePath), 'keyring');
  fs.mkdirSync(keyringDirectory, { mode: 0o700 });
  provisionLocalOwnerPepperKey({
    keyringDirectory,
    pepperKeyId: 'legacy-v1',
    randomBytes: () => Buffer.alloc(32, 7),
  });
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  seed(databasePath);
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  const authenticator = createLocalIdentityKeyringAuthenticator(
    runtime.apiCredentials,
    runtime.ownerPepper,
    new LocalOwnerPepperKeyringFileProvider(keyringDirectory),
    { now: () => NOW },
  );
  assert.equal(
    (await authenticator.authenticate(TOKEN))?.subject.id,
    'user-01',
  );
  await runtime.close();
  await assert.rejects(
    authenticator.authenticate(TOKEN),
    LocalIdentityAuthenticationUnavailableError,
  );
});

test('restores a recovery-required legacy key before explicit activation', async (t) => {
  const databasePath = fixture(t);
  const keyringDirectory = path.join(path.dirname(databasePath), 'keyring');
  const backupDirectory = path.join(path.dirname(databasePath), 'backup');
  fs.mkdirSync(keyringDirectory, { mode: 0o700 });
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  const backup = provisionLocalOwnerPepperKey({
    keyringDirectory: backupDirectory,
    pepperKeyId: 'legacy-v1',
    randomBytes: () => Buffer.alloc(32, 7),
  });
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  seed(databasePath, { recoveryRequired: true });
  assert.deepEqual(
    restoreLocalOwnerPepperKey({
      keyringDirectory,
      backupDirectory,
      pepperKeyId: 'legacy-v1',
    }),
    backup,
  );

  const bootstrap = await openLocalSqliteBootstrapDatabase({
    databasePath,
    profile: 'edge',
  });
  assert.equal(
    (await bootstrap.ownerPepper.resolveKey('legacy-v1'))?.state,
    'recovery_required',
  );
  await bootstrap.ownerPepper.register({
    mutationId: '00000000-0000-4000-8000-000000000093',
    pepperKeyId: 'legacy-v1',
    materialDigest: backup.digest,
    backupDigest: backup.digest,
    registeredAtMs: NOW - 900,
  });
  await bootstrap.ownerPepper.activate({
    mutationId: '00000000-0000-4000-8000-000000000094',
    pepperKeyId: 'legacy-v1',
    expectedGeneration: 0,
    activatedAtMs: NOW - 800,
  });
  await bootstrap.close();

  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  const authenticator = createLocalIdentityKeyringAuthenticator(
    runtime.apiCredentials,
    runtime.ownerPepper,
    new LocalOwnerPepperKeyringFileProvider(keyringDirectory),
    { now: () => NOW },
  );
  assert.equal(
    (await authenticator.authenticate(TOKEN))?.subject.id,
    'user-01',
  );
  await runtime.close();
});

test('resolves active and retired credential keys through the exact catalog identity', async () => {
  const oldPepper = Buffer.alloc(32, 21).toString('base64url');
  const newPepper = Buffer.alloc(32, 22).toString('base64url');
  const newSecret = Buffer.alloc(32, 23).toString('base64url');
  const digest = (pepper) =>
    createHash('sha256')
      .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
      .update(pepper, 'utf8')
      .digest('hex');
  const records = new Map([
    [
      'owner-old',
      {
        credentialId: 'owner-old',
        version: 1,
        pepperKeyId: 'owner-key-old',
        state: 'active',
        subject: { type: 'user', id: 'user-old' },
        subjectStatus: 'active',
        secretDigest: apiCredentialSecretDigest(oldPepper, 'owner-old', SECRET),
        createdAtMs: NOW - 1_000,
        notBeforeAtMs: NOW - 1_000,
        expiresAtMs: NOW + 60_000,
      },
    ],
    [
      'owner-new',
      {
        credentialId: 'owner-new',
        version: 1,
        pepperKeyId: 'owner-key-new',
        state: 'active',
        subject: { type: 'user', id: 'user-new' },
        subjectStatus: 'active',
        secretDigest: apiCredentialSecretDigest(
          newPepper,
          'owner-new',
          newSecret,
        ),
        createdAtMs: NOW - 500,
        notBeforeAtMs: NOW - 500,
        expiresAtMs: NOW + 60_000,
      },
    ],
  ]);
  const keys = new Map([
    [
      'owner-key-old',
      {
        pepperKeyId: 'owner-key-old',
        materialDigest: digest(oldPepper),
        backupDigest: 'b'.repeat(64),
        state: 'retired',
        version: 3,
        registeredAtMs: NOW - 2_000,
        activatedAtMs: NOW - 1_900,
        retiredAtMs: NOW - 100,
      },
    ],
    [
      'owner-key-new',
      {
        pepperKeyId: 'owner-key-new',
        materialDigest: digest(newPepper),
        backupDigest: 'c'.repeat(64),
        state: 'active',
        version: 2,
        registeredAtMs: NOW - 1_000,
        activatedAtMs: NOW - 100,
      },
    ],
  ]);
  const materials = new Map([
    ['owner-key-old', { pepperKeyId: 'owner-key-old', pepper: oldPepper }],
    ['owner-key-new', { pepperKeyId: 'owner-key-new', pepper: newPepper }],
  ]);
  let materialReads = 0;
  const authenticator = createLocalIdentityKeyringAuthenticator(
    { resolve: async (credentialId) => records.get(credentialId) ?? null },
    { resolveKey: async (pepperKeyId) => keys.get(pepperKeyId) ?? null },
    {
      resolve: async (pepperKeyId) => {
        materialReads += 1;
        return materials.get(pepperKeyId) ?? null;
      },
    },
    { now: () => NOW },
  );

  assert.equal(
    (
      await authenticator.authenticate(
        formatApiCredentialToken('owner-old', SECRET),
      )
    )?.subject.id,
    'user-old',
  );
  assert.equal(
    (
      await authenticator.authenticate(
        formatApiCredentialToken('owner-new', newSecret),
      )
    )?.subject.id,
    'user-new',
  );

  keys.get('owner-key-old').state = 'staged';
  await assert.rejects(
    authenticator.authenticate(formatApiCredentialToken('owner-old', SECRET)),
    LocalIdentityAuthenticationUnavailableError,
  );
  assert.equal(materialReads, 2);
  keys.get('owner-key-old').state = 'retired';
  materials.set('owner-key-old', {
    pepperKeyId: 'owner-key-old',
    pepper: Buffer.alloc(32, 24).toString('base64url'),
  });
  await assert.rejects(
    authenticator.authenticate(formatApiCredentialToken('owner-old', SECRET)),
    LocalIdentityAuthenticationUnavailableError,
  );
});

test('rejects malformed, wrong, inactive and expired credentials', async () => {
  const record = {
    credentialId: CREDENTIAL_ID,
    version: 1,
    pepperKeyId: 'legacy-v1',
    state: 'active',
    subject: { type: 'user', id: 'user-01' },
    subjectStatus: 'active',
    secretDigest: apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
    createdAtMs: NOW - 1_000,
    notBeforeAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
  };
  const repository = { resolve: async () => record };
  const authenticator = createLocalIdentityAuthenticator(repository, PEPPER, {
    now: () => NOW,
  });
  assert.equal(await authenticator.authenticate('not-a-token'), null);
  assert.equal(
    await authenticator.authenticate(
      formatApiCredentialToken(
        CREDENTIAL_ID,
        Buffer.alloc(32, 12).toString('base64url'),
      ),
    ),
    null,
  );
  record.state = 'revoked';
  assert.equal(await authenticator.authenticate(TOKEN), null);
  record.state = 'active';
  record.subjectStatus = 'disabled';
  assert.equal(await authenticator.authenticate(TOKEN), null);
  record.subjectStatus = 'active';
  record.expiresAtMs = NOW;
  assert.equal(await authenticator.authenticate(TOKEN), null);
  record.expiresAtMs = NOW + 60_000;
  record.pepperKeyId = 'other-v1';
  await assert.rejects(
    authenticator.authenticate(TOKEN),
    LocalIdentityAuthenticationUnavailableError,
  );
});

test('maps repository and clock failures to unavailable', async () => {
  const unavailable = createLocalIdentityAuthenticator(
    {
      resolve: async () => {
        throw new ApiCredentialUnavailableError();
      },
    },
    PEPPER,
  );
  await assert.rejects(
    unavailable.authenticate(TOKEN),
    LocalIdentityAuthenticationUnavailableError,
  );

  const badClock = createLocalIdentityAuthenticator(
    {
      resolve: async () => ({
        credentialId: CREDENTIAL_ID,
        version: 1,
        pepperKeyId: 'legacy-v1',
        state: 'active',
        subject: { type: 'user', id: 'user-01' },
        subjectStatus: 'active',
        secretDigest: apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        createdAtMs: 0,
        notBeforeAtMs: 0,
        expiresAtMs: NOW + 60_000,
      }),
    },
    PEPPER,
    { now: () => Number.NaN },
  );
  await assert.rejects(
    badClock.authenticate(TOKEN),
    LocalIdentityAuthenticationUnavailableError,
  );
});

test('shares the runtime close fence and never opens a second connection', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  seed(databasePath);
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  const authenticator = createLocalIdentityAuthenticator(
    runtime.apiCredentials,
    PEPPER,
    { now: () => NOW },
  );
  await runtime.close();
  await assert.rejects(
    authenticator.authenticate(TOKEN),
    LocalIdentityAuthenticationUnavailableError,
  );
});

test('fails closed when credential pepper provenance is missing', async (t) => {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  seed(databasePath, { omitPepperBinding: true });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  const authenticator = createLocalIdentityAuthenticator(
    runtime.apiCredentials,
    PEPPER,
    { now: () => NOW },
  );
  await assert.rejects(
    authenticator.authenticate(TOKEN),
    LocalIdentityAuthenticationUnavailableError,
  );
  await runtime.close();
});

test('rejects weak pepper, widened options and unbounded principal TTL', () => {
  const repository = { resolve: async () => null };
  assert.throws(
    () => createLocalIdentityAuthenticator(repository, 'weak'),
    LocalIdentityAuthenticationConfigurationError,
  );
  assert.throws(
    () =>
      createLocalIdentityAuthenticator(repository, PEPPER, {
        principalTtlMs: 300_001,
      }),
    LocalIdentityAuthenticationConfigurationError,
  );
  assert.throws(
    () =>
      createLocalIdentityAuthenticator(repository, PEPPER, {
        extra: true,
      }),
    LocalIdentityAuthenticationConfigurationError,
  );
});
