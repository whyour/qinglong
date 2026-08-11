const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  runLocalSecretCommandFile,
} = require('@qinglong/local-owner-cli/secret-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const {
  LocalSecretKeyringFileProvider,
  provisionLocalSecretKeyring,
} = require('@qinglong/local-secret');
const {
  createLocalSecretAdministrationService,
} = require('@qinglong/local-admin/secret-administration');
const {
  openLocalSqliteSecretAdministrationDatabase,
} = require('@qinglong/local-sqlite/secret-administration');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalSecretAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/local-secret-administration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const { parseSecretRef } = require('@qinglong/runtime-core/secret-reference');

const CREDENTIAL_ID = 'secret-owner';
const PEPPER_KEY_ID = 'secret-owner-v1';
const PEPPER = Buffer.alloc(32, 101).toString('base64url');
const CREDENTIAL_SECRET = Buffer.alloc(32, 102).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, CREDENTIAL_SECRET);

async function fixture(t, { role = 'owner' } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-secret-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  const secretKeyringPath = path.join(
    deploymentRoot,
    'local-secret-keyring.json',
  );
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  await provisionLocalSecretKeyring(secretKeyringPath);
  const pepperSummary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 101),
  });
  const now = Date.now();
  const secretDigest = apiCredentialSecretDigest(
    PEPPER,
    CREDENTIAL_ID,
    CREDENTIAL_SECRET,
  );
  const notBeforeAtMs = now - 1_000;
  const expiresAtMs = now + 10 * 60 * 1_000;
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'd'.repeat(64),
        '61000000-0000-4000-8000-000000000001',
        '61000000-0000-4000-8000-000000000002',
        now - 2_000,
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '61000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'd'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'owner-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'owner-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        secretDigest,
        now - 1_000,
        notBeforeAtMs,
        expiresAtMs,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (
           'default', 'user', 'owner-user', 1, 'active', ?,
           'secret-owner-binding', 'user', 'owner-user', ?
         )`,
      )
      .run(role, now - 500);
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    deploymentRoot,
    commandsDirectory,
    databasePath,
    credentialFilePath,
    ownerPepperKeyringDirectory,
    secretKeyringPath,
    pepperSummary,
    now,
    fence: {
      credentialId: CREDENTIAL_ID,
      credentialVersion: 1,
      pepperKeyId: PEPPER_KEY_ID,
      materialDigest: pepperSummary.digest,
      subjectType: 'user',
      subjectId: 'owner-user',
      secretDigest,
      notBeforeAtMs,
      expiresAtMs,
    },
    options: {
      deploymentRoot,
      databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory,
      credentialFilePath,
      secretKeyringPath,
    },
  };
}

function secretValueFile(value, plaintext, name) {
  const filePath = path.join(value.commandsDirectory, `${name}.value.json`);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-secret-value',
      value: plaintext,
    })}\n`,
    { mode: 0o600 },
  );
  return filePath;
}

function commandFile(value, request, name) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'secret.put',
      options: value.options,
      request,
    })}\n`,
    { mode: 0o600 },
  );
  return commandPath;
}

function request(value, suffix, expectedCurrentVersion, secretValueFilePath) {
  return {
    projectId: 'default',
    name: 'API_TOKEN',
    secretValueFilePath,
    mutationId: `62000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `secret-command-${suffix}`,
    failureAuditEventId: `63000000-0000-4000-8000-00000000000${suffix}`,
    expectedCurrentVersion,
  };
}

test('creates, replays and rotates an encrypted Secret without echoing material', async (t) => {
  const value = await fixture(t);
  const firstPlaintext = 'first-secret-never-echo';
  const secondPlaintext = 'rotated-secret-never-echo';
  const firstFile = commandFile(
    value,
    request(value, '1', 0, secretValueFile(value, firstPlaintext, 'first')),
    'create',
  );
  const created = await runLocalSecretCommandFile(firstFile);
  assert.deepEqual(created, {
    schemaVersion: 1,
    operation: 'secret.put',
    status: 'inserted',
    version: 1,
    secretRef: created.secretRef,
  });
  assert.deepEqual(parseSecretRef(created.secretRef), {
    projectId: 'default',
    name: 'API_TOKEN',
    version: 1,
  });
  assert.equal((await runLocalSecretCommandFile(firstFile)).status, 'existing');

  const secondFile = commandFile(
    value,
    request(value, '2', 1, secretValueFile(value, secondPlaintext, 'second')),
    'rotate',
  );
  const rotated = await runLocalSecretCommandFile(secondFile);
  assert.equal(rotated.status, 'inserted');
  assert.equal(rotated.version, 2);
  assert.deepEqual(parseSecretRef(rotated.secretRef), {
    projectId: 'default',
    name: 'API_TOKEN',
    version: 2,
  });

  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/security-management/secretCli.js'),
      'run',
      '--command-file',
      secondFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'existing');
  for (const sensitive of [TOKEN, firstPlaintext, secondPlaintext]) {
    assert.equal(JSON.stringify(created).includes(sensitive), false);
    assert.equal(child.stdout.includes(sensitive), false);
    assert.equal(child.stderr.includes(sensitive), false);
  }

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const secrets = database
      .prepare(
        `SELECT version, ciphertext
           FROM "QingLong3LocalSecretEnvelopes"
          WHERE project_id = 'default' AND secret_name = 'API_TOKEN'
          ORDER BY version`,
      )
      .all();
    assert.deepEqual(
      secrets.map((entry) => entry.version),
      [1, 2],
    );
    const ciphertext = secrets
      .map((entry) => Buffer.from(entry.ciphertext).toString('utf8'))
      .join('');
    assert.equal(ciphertext.includes(firstPlaintext), false);
    assert.equal(ciphertext.includes(secondPlaintext), false);
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM "QingLong3SecurityAuditEvents"
            WHERE operation_id IN ('secret.create', 'secret.rotate')
              AND outcome = 'allowed'`,
        )
        .get().count,
      2,
    );
  } finally {
    database.close();
  }
});

test('rejects a non-private value file and records only a low-sensitive failure', async (t) => {
  const value = await fixture(t);
  const plaintext = 'must-not-appear-in-audit';
  const secretFile = secretValueFile(value, plaintext, 'public');
  fs.chmodSync(secretFile, 0o644);
  const command = commandFile(
    value,
    request(value, '3', 0, secretFile),
    'public-value',
  );
  await assert.rejects(runLocalSecretCommandFile(command), {
    code: 'LOCAL_SECRET_COMMAND_CONFIGURATION_INVALID',
  });
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT outcome, reasons_json
           FROM "QingLong3SecurityAuditEvents"
          WHERE event_id = ?`,
      )
      .get('63000000-0000-4000-8000-000000000003');
    assert.deepEqual(
      { ...row },
      {
        outcome: 'denied',
        reasons_json: '["secret_value_rejected"]',
      },
    );
    assert.equal(JSON.stringify(row).includes(plaintext), false);
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM "QingLong3LocalSecretEnvelopes"`,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('keeps viewer policy denied and never touches the Secret key', async (t) => {
  const value = await fixture(t, { role: 'viewer' });
  const command = commandFile(
    value,
    request(
      value,
      '4',
      0,
      secretValueFile(value, 'viewer-cannot-write', 'viewer'),
    ),
    'viewer',
  );
  await assert.rejects(runLocalSecretCommandFile(command), {
    code: 'LOCAL_SECRET_ADMINISTRATION_FORBIDDEN',
  });
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT outcome FROM "QingLong3SecurityAuditEvents"
            WHERE event_id = ?`,
        )
        .get('62000000-0000-4000-8000-000000000004').outcome,
      'denied',
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM "QingLong3LocalSecretEnvelopes"`,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('rejects a revoked credential before Secret materialization', async (t) => {
  const value = await fixture(t);
  const database = new DatabaseSync(value.databasePath);
  try {
    database
      .prepare(
        `UPDATE "QingLong3ApiCredentials"
            SET state = 'revoked'
          WHERE credential_id = ? AND version = 1`,
      )
      .run(CREDENTIAL_ID);
  } finally {
    database.close();
  }
  const command = commandFile(
    value,
    request(
      value,
      '5',
      0,
      secretValueFile(value, 'revoked-cannot-write', 'revoked'),
    ),
    'revoked',
  );
  await assert.rejects(runLocalSecretCommandFile(command), {
    code: 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED',
  });
  const read = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      read
        .prepare(
          `SELECT outcome FROM "QingLong3SecurityAuditEvents"
            WHERE event_id = ?`,
        )
        .get('63000000-0000-4000-8000-000000000005').outcome,
      'authentication_rejected',
    );
    assert.equal(
      read
        .prepare(
          `SELECT COUNT(*) AS count FROM "QingLong3LocalSecretEnvelopes"`,
        )
        .get().count,
      0,
    );
  } finally {
    read.close();
  }
});

test('rechecks the credential fence inside the Secret write transaction', async (t) => {
  const value = await fixture(t);
  const database = await openLocalSqliteSecretAdministrationDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  t.after(() => database.close());
  database.activateUserCredentialFence(value.fence);
  const mutator = new DatabaseSync(value.databasePath);
  try {
    mutator
      .prepare(
        `UPDATE "QingLong3ApiCredentials"
            SET state = 'revoked'
          WHERE credential_id = ? AND version = 1`,
      )
      .run(CREDENTIAL_ID);
  } finally {
    mutator.close();
  }
  const service = createLocalSecretAdministrationService(
    database.projectPolicy,
    database.localSecretAdministration,
    database.securityAudit,
    new LocalSecretKeyringFileProvider(value.secretKeyringPath),
  );
  await assert.rejects(
    service.put({
      projectId: 'default',
      name: 'ATOMIC_FENCE',
      plaintext: 'must-not-commit',
      mutationId: '62000000-0000-4000-8000-000000000006',
      requestId: 'secret-command-atomic-fence',
      expectedCurrentVersion: 0,
      principal: {
        subject: { type: 'user', id: 'owner-user' },
        authenticationId: 'local_secret:atomic-fence',
        authenticatedAtMs: value.now - 1_000,
        expiresAtMs: value.now + 60_000,
        assurance: 'local_console',
      },
    }),
    LocalSecretAuthorizationFenceConflictError,
  );
  const read = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      read
        .prepare(
          `SELECT COUNT(*) AS count
             FROM "QingLong3LocalSecretEnvelopes"
            WHERE secret_name = 'ATOMIC_FENCE'`,
        )
        .get().count,
      0,
    );
  } finally {
    read.close();
  }
});
