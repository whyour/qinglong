const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createLocalTaskDefinitionCommandRunner,
  runLocalTaskDefinitionCommandFile,
} = require('@qinglong/local-owner-cli/task-definition-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const {
  createLocalTaskDefinitionAdministrationService,
} = require('@qinglong/local-admin/task-definition-administration');
const {
  openLocalSqliteTaskDefinitionAdministrationDatabase,
} = require('@qinglong/local-sqlite/task-definition-administration');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');

const CREDENTIAL_ID = 'task-owner';
const PEPPER_KEY_ID = 'task-owner-v1';
const PEPPER = Buffer.alloc(32, 121).toString('base64url');
const CREDENTIAL_SECRET = Buffer.alloc(32, 122).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, CREDENTIAL_SECRET);

async function fixture(t, { role = 'owner' } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-task-command-'),
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
    randomBytes: () => Buffer.alloc(32, 121),
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
        'f'.repeat(64),
        '81000000-0000-4000-8000-000000000001',
        '81000000-0000-4000-8000-000000000002',
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
        '81000000-0000-4000-8000-000000000002',
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
         ) VALUES ('user', 'task-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'task-user', ?, ?, ?, ?)`,
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
           'default', 'user', 'task-user', 1, 'active', ?,
           'task-owner-binding', 'user', 'task-user', ?
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

function putRequest(value, suffix, overrides = {}) {
  return {
    projectId: 'default',
    taskId: 'task-product-entry',
    expectedRevision: null,
    mutationId: `82000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `task-put-${suffix}`,
    failureAuditEventId: `83000000-0000-4000-8000-00000000000${suffix}`,
    name: 'Product task',
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: {
          kind: 'argv',
          file: '/bin/echo',
          args: ['private-argument-not-output'],
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

test('creates, exactly replays, disables, inspects and lists a TaskDefinition', async (t) => {
  const value = await fixture(t);
  const createPath = writeCommand(
    value,
    'task.put',
    putRequest(value, '1'),
    'create',
  );
  const created = await runLocalTaskDefinitionCommandFile(createPath);
  assert.equal(created.status, 'created');
  assert.equal(created.task.revision, 1);
  assert.equal(created.task.enabled, true);
  assert.equal(created.task.schema, 'qinglong/command@v1');
  assert.doesNotMatch(JSON.stringify(created), /private-argument-not-output/);
  assert.equal(
    (await runLocalTaskDefinitionCommandFile(createPath)).status,
    'existing',
  );

  const updatePath = writeCommand(
    value,
    'task.put',
    putRequest(value, '2', {
      expectedRevision: 1,
      mutationId: '82000000-0000-4000-8000-000000000002',
      failureAuditEventId: '83000000-0000-4000-8000-000000000002',
      requestId: 'task-put-2',
      name: 'Product task disabled',
      enabled: false,
      occurredAtMs: value.now + 1,
    }),
    'disable',
  );
  const updated = await runLocalTaskDefinitionCommandFile(updatePath);
  assert.equal(updated.status, 'updated');
  assert.equal(updated.task.revision, 2);
  assert.equal(updated.task.enabled, false);

  const inspected = await runLocalTaskDefinitionCommandFile(
    writeCommand(
      value,
      'task.inspect',
      {
        projectId: 'default',
        taskId: 'task-product-entry',
        requestId: 'task-inspect-1',
        auditEventId: '84000000-0000-4000-8000-000000000001',
        failureAuditEventId: '85000000-0000-4000-8000-000000000001',
      },
      'inspect',
    ),
  );
  assert.equal(inspected.found, true);
  assert.equal(inspected.task.revision, 2);
  assert.equal(Object.hasOwn(inspected.task, 'spec'), false);

  const listed = await runLocalTaskDefinitionCommandFile(
    writeCommand(
      value,
      'task.list',
      {
        projectId: 'default',
        requestId: 'task-list-1',
        auditEventId: '84000000-0000-4000-8000-000000000002',
        failureAuditEventId: '85000000-0000-4000-8000-000000000002',
        limit: 1,
      },
      'list',
    ),
  );
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].taskId, 'task-product-entry');
  assert.equal(listed.nextCursor, null);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitionRevisions"',
        )
        .get().count,
      2,
    );
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3LocalTaskExecutionRevisions"',
        )
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
  assert.deepEqual(
    auditRows(value.databasePath).map((row) => [row.operationId, row.outcome]),
    [
      ['task.create', 'allowed'],
      ['task.update', 'allowed'],
      ['task.read', 'allowed'],
      ['task.read', 'allowed'],
    ],
  );
});

test('allows an operator to manage tasks but rejects a viewer atomically', async (t) => {
  const operator = await fixture(t, { role: 'operator' });
  assert.equal(
    (
      await runLocalTaskDefinitionCommandFile(
        writeCommand(
          operator,
          'task.put',
          putRequest(operator, '3'),
          'operator-create',
        ),
      )
    ).status,
    'created',
  );

  const viewer = await fixture(t, { role: 'viewer' });
  await assert.rejects(
    runLocalTaskDefinitionCommandFile(
      writeCommand(
        viewer,
        'task.put',
        putRequest(viewer, '4'),
        'viewer-create',
      ),
    ),
    { code: 'LOCAL_TASK_DEFINITION_ADMINISTRATION_FORBIDDEN' },
  );
  const database = new DatabaseSync(viewer.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitions"')
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
  assert.deepEqual(
    auditRows(viewer.databasePath).map((row) => [row.operationId, row.outcome]),
    [['task.create', 'denied']],
  );
});

test('rechecks the credential and Policy fence inside the Task transaction', async (t) => {
  const value = await fixture(t);
  const runner = createLocalTaskDefinitionCommandRunner({
    openDatabase: openLocalSqliteTaskDefinitionAdministrationDatabase,
    authenticate: require('@qinglong/local-owner-console/authenticated-command')
      .establishAuthenticatedLocalCommand,
    now: Date.now,
    createService(projectPolicy, mutations, source, audit, options) {
      const fencedMutations = {
        async appendAuthorizedTaskDefinitionRevision(mutation) {
          const competing = new DatabaseSync(value.databasePath);
          try {
            competing
              .prepare(
                `INSERT INTO "QingLong3ProjectRoleBindings" (
                   "project_id", "subject_type", "subject_id", "version",
                   "state", "role", "mutation_id", "changed_by_type",
                   "changed_by_id", "created_at_ms"
                 ) VALUES (
                   'default', 'user', 'task-user', 2, 'revoked', NULL,
                   'task-race-revoke', 'user', 'task-user', ?
                 )`,
              )
              .run(value.now + 5);
          } finally {
            competing.close();
          }
          return mutations.appendAuthorizedTaskDefinitionRevision(mutation);
        },
      };
      return createLocalTaskDefinitionAdministrationService(
        projectPolicy,
        fencedMutations,
        source,
        audit,
        options,
      );
    },
  });
  const request = putRequest(value, '5');
  await assert.rejects(
    runner.run(writeCommand(value, 'task.put', request, 'fenced-create')),
    { code: 'TASK_DEFINITION_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitions"')
        .get().count,
      0,
    );
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3SecurityAuditEvents" WHERE event_id = ?',
        )
        .get(request.mutationId).count,
      0,
    );
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3SecurityAuditEvents" WHERE event_id = ?',
        )
        .get(request.failureAuditEventId).count,
      1,
    );
  } finally {
    database.close();
  }
});

test('rejects mutation drift without adding a revision or changing its allowed audit', async (t) => {
  const value = await fixture(t);
  const original = putRequest(value, '6');
  await runLocalTaskDefinitionCommandFile(
    writeCommand(value, 'task.put', original, 'original'),
  );
  await assert.rejects(
    runLocalTaskDefinitionCommandFile(
      writeCommand(
        value,
        'task.put',
        {
          ...original,
          name: 'drifted replay',
          failureAuditEventId: '83000000-0000-4000-8000-000000000007',
        },
        'drifted',
      ),
    ),
    { code: 'TASK_DEFINITION_CONFLICT' },
  );
  await assert.rejects(
    runLocalTaskDefinitionCommandFile(
      writeCommand(
        value,
        'task.put',
        {
          ...original,
          requestId: 'task-put-audit-drift',
          failureAuditEventId: '83000000-0000-4000-8000-000000000009',
        },
        'audit-drifted',
      ),
    ),
    { code: 'TASK_DEFINITION_ADMINISTRATION_MUTATION_CONFLICT' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          'SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitionRevisions"',
        )
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
  assert.deepEqual(
    auditRows(value.databasePath).map((row) => [row.eventId, row.outcome]),
    [
      [original.mutationId, 'allowed'],
      ['83000000-0000-4000-8000-000000000007', 'denied'],
      ['83000000-0000-4000-8000-000000000009', 'denied'],
    ],
  );
});

test('requires a private command file and exposes one exact CLI surface', async (t) => {
  const value = await fixture(t);
  const commandPath = writeCommand(
    value,
    'task.put',
    putRequest(value, '8'),
    'broad',
  );
  fs.chmodSync(commandPath, 0o644);
  await assert.rejects(runLocalTaskDefinitionCommandFile(commandPath), {
    code: 'LOCAL_TASK_DEFINITION_COMMAND_CONFIGURATION_INVALID',
  });

  const cliPath = path.resolve(
    __dirname,
    '../dist/automation-management/taskDefinitionCli.js',
  );
  const help = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-task run --command-file /);
  const invalid = spawnSync(process.execPath, [cliPath, 'list'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.equal(
    JSON.parse(invalid.stderr).code,
    'LOCAL_TASK_DEFINITION_CLI_USAGE_INVALID',
  );
});
