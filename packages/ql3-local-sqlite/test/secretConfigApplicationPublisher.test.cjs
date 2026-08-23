const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const { migrateLocalSqlitePath } = require('../dist/migration/migration');
const {
  openLocalSqliteAdoptionDatabase,
} = require('@qinglong/local-sqlite/adoption');
const {
  LocalSecretConfigApplicationConflictError,
  openLocalSqliteSecretConfigApplicationDatabase,
} = require('@qinglong/local-sqlite/secret-config-application');

const SUBJECT = Object.freeze({ type: 'user', id: 'local-owner' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
const ADOPTION_MUTATION = '12345678-1234-4123-8123-123456789abc';
const APPLICATION_MUTATION = '87654321-4321-4123-8123-cba987654321';
const SECRET_MUTATION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function digest(character) {
  return character.repeat(64);
}

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-secret-config-application-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'qinglong3.sqlite');
}

async function preparedDatabase(t) {
  const databasePath = fixture(t);
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const client = new DatabaseSync(databasePath);
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
    "project_id", "subject_type", "subject_id", "version", "state", "role",
    "mutation_id", "changed_by_type", "changed_by_id", "created_at_ms"
  ) VALUES ('default', 'user', 'local-owner', 1, 'active', 'owner',
    'secret-config-owner-binding', 'user', 'local-owner', 1)`,
    )
    .run();
  client.close();

  const adoption = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  await adoption.publisher.publish({
    mutationId: ADOPTION_MUTATION,
    decisionId: '019f7200-0000-7000-8000-000000000001',
    projectId: 'default',
    profile: 'edge',
    planDigest: digest('1'),
    inventoryDigest: digest('2'),
    decisionDigest: digest('3'),
    receiptDigest: digest('4'),
    authorizationFileDigest: digest('5'),
    rowCount: 1,
    skippedCount: 0,
    subject: SUBJECT,
    fence: FENCE,
    audit: {
      eventId: ADOPTION_MUTATION,
      requestId: 'automation-adoption',
      operationId: 'task.adopt',
      projectId: 'default',
      subject: SUBJECT,
      authenticationId: 'local-console:review',
      outcome: 'allowed',
      reasons: ['project_role_allowed'],
      fence: FENCE,
      occurredAtMs: 100,
    },
    candidates: [
      {
        rowOrdinal: 1,
        sourceDigest: digest('6'),
        task: {
          taskId: 'legacy-cron:1',
          name: 'Legacy Task',
          kind: 'command',
          spec: {
            schema: 'qinglong/command@v1',
            config: {
              command: { kind: 'argv', file: '/bin/echo', args: ['legacy'] },
            },
          },
          labels: { source: 'legacy-adoption' },
          enabled: true,
        },
        triggers: [
          {
            triggerId: 'legacy-cron:1:cron:1',
            spec: {
              schema: 'qinglong/cron@v1',
              config: {
                expression: '0 0 * * *',
                timezone: 'UTC',
                misfirePolicy: 'skip',
              },
            },
            enabled: true,
          },
        ],
      },
    ],
    confirmExternalAuthority() {},
    createdAtMs: 100,
  });
  await adoption.close();
  return databasePath;
}

function applicationCommand(confirmExternalAuthority = () => {}) {
  return {
    mutationId: APPLICATION_MUTATION,
    projectId: 'default',
    profile: 'edge',
    secretConfigPlanDigest: digest('7'),
    decisionDigest: digest('8'),
    candidateSetDigest: digest('9'),
    automationAdoptionSetDigest: digest('a'),
    subject: SUBJECT,
    fence: FENCE,
    audit: {
      eventId: APPLICATION_MUTATION,
      requestId: 'secret-config-application',
      operationId: 'secret-config.apply',
      projectId: 'default',
      subject: SUBJECT,
      authenticationId: 'local-console:review',
      outcome: 'allowed',
      reasons: ['project_role_allowed'],
      fence: FENCE,
      occurredAtMs: 200,
    },
    secrets: [
      {
        ordinal: 1,
        disposition: 'active_binding',
        candidateDigest: digest('b'),
        sourceSetDigest: digest('c'),
        environmentName: 'LEGACY_TOKEN',
        envelope: {
          projectId: 'default',
          name: 'legacy-db-env-bbbbbbbbbbbbbbbb',
          version: 1,
          mutationId: SECRET_MUTATION,
          keyId: 'active-key',
          algorithm: 'aes-256-gcm',
          nonce: Buffer.alloc(12, 1).toString('base64url'),
          ciphertext: Buffer.from('ciphertext').toString('base64url'),
          authTag: Buffer.alloc(16, 2).toString('base64url'),
          createdAtMs: 200,
        },
        audit: {
          eventId: SECRET_MUTATION,
          requestId: 'secret-config-application',
          operationId: 'secret.create',
          projectId: 'default',
          subject: SUBJECT,
          authenticationId: 'local-console:review',
          outcome: 'allowed',
          reasons: ['project_role_allowed'],
          fence: FENCE,
          occurredAtMs: 200,
        },
      },
    ],
    appliedAtMs: 200,
    confirmExternalAuthority,
  };
}

test('atomically binds Secret, Task, dispatch, Trigger, schedule and replay ledger', async (t) => {
  const databasePath = await preparedDatabase(t);
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  const command = applicationCommand();
  const inserted = await database.publisher.publish(command);
  assert.equal(inserted.status, 'inserted');
  assert.equal(inserted.application.receipt.activeBindingCount, 1);
  assert.equal(inserted.application.receipt.taskCount, 1);
  assert.equal(inserted.application.receipt.triggerCount, 1);
  assert.equal((await database.publisher.publish(command)).status, 'existing');
  await database.close();

  const client = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    client
      .prepare(
        `SELECT "current_revision" AS revision FROM "QingLong3TaskDefinitions" WHERE "task_id" = 'legacy-cron:1'`,
      )
      .get().revision,
    2,
  );
  assert.equal(
    client
      .prepare(
        `SELECT "current_revision" AS revision FROM "QingLong3Triggers" WHERE "trigger_id" = 'legacy-cron:1:cron:1'`,
      )
      .get().revision,
    2,
  );
  assert.equal(
    client
      .prepare(
        `SELECT "trigger_revision" AS revision FROM "QingLong3LocalTriggerSchedules" WHERE "trigger_id" = 'legacy-cron:1:cron:1'`,
      )
      .get().revision,
    2,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3LocalSecretEnvelopes" WHERE "secret_name" = 'legacy-db-env-bbbbbbbbbbbbbbbb'`,
      )
      .get().count,
    1,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3LocalTaskExecutionRevisions" WHERE "task_id" = 'legacy-cron:1' AND "task_revision" LIKE 'qltd:v1:2:%'`,
      )
      .get().count,
    1,
  );
  client.close();
});

test('rolls every database mutation back when the commit authority changes', async (t) => {
  const databasePath = await preparedDatabase(t);
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  let checks = 0;
  await assert.rejects(
    database.publisher.publish(
      applicationCommand(() => {
        checks += 1;
        if (checks === 2) throw new Error('instance head drifted');
      }),
    ),
    /unavailable/,
  );
  await database.close();
  const client = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3SecretConfigApplications"`,
      )
      .get().count,
    0,
  );
  assert.equal(
    client
      .prepare(
        `SELECT "current_revision" AS revision FROM "QingLong3TaskDefinitions" WHERE "task_id" = 'legacy-cron:1'`,
      )
      .get().revision,
    1,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3LocalSecretEnvelopes" WHERE "secret_name" = 'legacy-db-env-bbbbbbbbbbbbbbbb'`,
      )
      .get().count,
    0,
  );
  client.close();
});

test('fails closed on occupied Secret without advancing Task or Trigger heads', async (t) => {
  const databasePath = await preparedDatabase(t);
  const client = new DatabaseSync(databasePath);
  client
    .prepare(
      `INSERT INTO "QingLong3LocalSecretEnvelopes" ("project_id", "secret_name", "version", "mutation_id", "key_id", "algorithm", "nonce", "ciphertext", "auth_tag", "created_at_ms") VALUES ('default', 'legacy-db-env-bbbbbbbbbbbbbbbb', 1, '11111111-2222-4333-8444-555555555555', 'other-key', 'aes-256-gcm', ?, ?, ?, 150)`,
    )
    .run(Buffer.alloc(12), Buffer.from('occupied'), Buffer.alloc(16));
  client.close();
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  await assert.rejects(
    database.publisher.publish(applicationCommand()),
    LocalSecretConfigApplicationConflictError,
  );
  await database.close();
  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    inspected
      .prepare(
        `SELECT "current_revision" AS revision FROM "QingLong3TaskDefinitions" WHERE "task_id" = 'legacy-cron:1'`,
      )
      .get().revision,
    1,
  );
  assert.equal(
    inspected
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3SecretConfigApplications"`,
      )
      .get().count,
    0,
  );
  inspected.close();
});

test('rejects incomplete Trigger provenance and rolls the streamed transaction back', async (t) => {
  const databasePath = await preparedDatabase(t);
  const client = new DatabaseSync(databasePath);
  client.prepare(`DELETE FROM "QingLong3LegacyAdoptionTriggers"`).run();
  client.close();
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  await assert.rejects(
    database.publisher.publish(applicationCommand()),
    LocalSecretConfigApplicationConflictError,
  );
  await database.close();
  const inspected = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    inspected
      .prepare(
        `SELECT "current_revision" AS revision FROM "QingLong3TaskDefinitions" WHERE "task_id" = 'legacy-cron:1'`,
      )
      .get().revision,
    1,
  );
  assert.equal(
    inspected
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3SecretConfigApplicationTasks"`,
      )
      .get().count,
    0,
  );
  inspected.close();
});

test('rejects replay after the durable Trigger schedule drifts', async (t) => {
  const databasePath = await preparedDatabase(t);
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  const command = applicationCommand();
  await database.publisher.publish(command);
  await database.close();
  const client = new DatabaseSync(databasePath);
  client
    .prepare(
      `UPDATE "QingLong3LocalTriggerSchedules" SET "trigger_revision" = 1 WHERE "trigger_id" = 'legacy-cron:1:cron:1'`,
    )
    .run();
  client.close();
  const reopened = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  await assert.rejects(
    reopened.publisher.publish(command),
    LocalSecretConfigApplicationConflictError,
  );
  await reopened.close();
});

test('rejects empty applications and Secret timestamps outside the application instant', async (t) => {
  const databasePath = await preparedDatabase(t);
  const database = await openLocalSqliteSecretConfigApplicationDatabase({
    databasePath,
    profile: 'edge',
  });
  assert.throws(
    () => database.publisher.publish({ ...applicationCommand(), secrets: [] }),
    LocalSecretConfigApplicationConflictError,
  );
  const command = applicationCommand();
  command.secrets[0].envelope.createdAtMs = command.appliedAtMs - 1;
  assert.throws(
    () => database.publisher.publish(command),
    LocalSecretConfigApplicationConflictError,
  );
  await database.close();
});
