const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

const CREDENTIAL_ID = 'automation-owner';
const PEPPER_KEY_ID = 'automation-owner-v1';
const PEPPER = Buffer.alloc(32, 101).toString('base64url');
const CREDENTIAL_SECRET = Buffer.alloc(32, 102).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, CREDENTIAL_SECRET);

async function localManagementFixture(t, { role = 'owner' } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-automation-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
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
        'f'.repeat(64),
        '91000000-0000-4000-8000-000000000001',
        '91000000-0000-4000-8000-000000000002',
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
        '91000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        pepperSummary.digest,
        'f'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'automation-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'automation-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        secretDigest,
        now - 1_000,
        now - 1_000,
        now + 10 * 60 * 1_000,
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
           'default', 'user', 'automation-user', 1, 'active', ?,
           'automation-owner-binding', 'user', 'automation-user', ?
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
    now,
    options: {
      deploymentRoot,
      databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory,
      credentialFilePath,
    },
  };
}

function writeCommand(value, operation, request, name) {
  const filePath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation,
      options: value.options,
      request,
    })}\n`,
    { mode: 0o600 },
  );
  return filePath;
}

function taskPutRequest(value, suffix, overrides = {}) {
  return {
    projectId: 'default',
    taskId: 'task-trigger-product',
    expectedRevision: null,
    mutationId: `92000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `automation-task-put-${suffix}`,
    failureAuditEventId: `93000000-0000-4000-8000-00000000000${suffix}`,
    name: 'Trigger product task',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: {
          kind: 'argv',
          file: '/bin/echo',
          args: ['not-returned'],
        },
      },
    },
    labels: { owner: 'product' },
    enabled: true,
    occurredAtMs: value.now,
    ...overrides,
  };
}

function auditRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT event_id AS "eventId", operation_id AS "operationId",
                outcome, reasons_json AS "reasonsJson"
         FROM "QingLong3SecurityAuditEvents" ORDER BY occurred_at_ms, event_id`,
      )
      .all();
  } finally {
    database.close();
  }
}

module.exports = {
  auditRows,
  localManagementFixture,
  taskPutRequest,
  writeCommand,
};
