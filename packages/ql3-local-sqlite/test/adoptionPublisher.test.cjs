const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { migrateLocalSqlitePath } = require('../dist/migration/migration');
const {
  LocalLegacyAdoptionAuthorizationFenceConflictError,
  LocalLegacyAdoptionConflictError,
  openLocalSqliteAdoptionDatabase,
} = require('@qinglong/local-sqlite/adoption');

const MUTATION_ID = '12345678-1234-4123-8123-123456789abc';
const DECISION_ID = '019f7200-0000-7000-8000-000000000001';
const SUBJECT = Object.freeze({ type: 'user', id: 'local-owner' });
const DIGEST = 'a'.repeat(64);

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-adoption-publisher-'),
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
         "project_id", "subject_type", "subject_id", "version", "state",
         "role", "mutation_id", "changed_by_type", "changed_by_id",
         "created_at_ms"
       ) VALUES ('default', 'user', 'local-owner', 1, 'active', 'owner',
                 'test-owner-binding', 'user', 'local-owner', 1)`,
    )
    .run();
  client.close();
  return databasePath;
}

function candidate(index, taskId = `legacy-cron:${index}`) {
  return Object.freeze({
    rowOrdinal: index,
    sourceDigest: String(index).padStart(64, '0'),
    task: Object.freeze({
      taskId,
      name: `Legacy Task ${index}`,
      kind: 'command',
      spec: Object.freeze({
        schema: 'qinglong/command@v1',
        config: Object.freeze({
          command: Object.freeze({
            kind: 'argv',
            file: '/bin/echo',
            args: Object.freeze([String(index)]),
          }),
        }),
      }),
      labels: Object.freeze({ source: 'legacy-adoption' }),
      enabled: true,
    }),
    triggers: Object.freeze([
      Object.freeze({
        triggerId: `${taskId}:cron:1`,
        spec: Object.freeze({
          schema: 'qinglong/cron@v1',
          config: Object.freeze({
            expression: `${index} 0 * * *`,
            timezone: 'UTC',
            misfirePolicy: 'skip',
          }),
        }),
        enabled: true,
      }),
    ]),
  });
}

function command(candidates, overrides = {}) {
  return {
    mutationId: MUTATION_ID,
    decisionId: DECISION_ID,
    projectId: 'default',
    profile: 'edge',
    planDigest: DIGEST,
    inventoryDigest: 'b'.repeat(64),
    decisionDigest: 'c'.repeat(64),
    receiptDigest: 'd'.repeat(64),
    authorizationFileDigest: 'e'.repeat(64),
    rowCount: candidates.length,
    skippedCount: 0,
    subject: SUBJECT,
    fence: Object.freeze({ projectVersion: 1, bindingVersion: 1 }),
    audit: Object.freeze({
      eventId: MUTATION_ID,
      requestId: 'legacy-adoption-test',
      operationId: 'task.adopt',
      projectId: 'default',
      subject: SUBJECT,
      authenticationId: 'local-console:adoption-review',
      outcome: 'allowed',
      reasons: Object.freeze(['project_role_allowed']),
      fence: Object.freeze({ projectVersion: 1, bindingVersion: 1 }),
      occurredAtMs: 100,
    }),
    candidates,
    confirmExternalAuthority() {},
    createdAtMs: 100,
    ...overrides,
  };
}

test('publishes tasks, execution facts, triggers, audit and ledger atomically', async (t) => {
  const databasePath = await preparedDatabase(t);
  const adoption = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  const input = command([candidate(1), candidate(2)]);
  const inserted = await adoption.publisher.publish(input);
  assert.equal(inserted.status, 'inserted');
  assert.equal(inserted.adoption.adoptedTaskCount, 2);
  assert.equal(inserted.adoption.adoptedTriggerCount, 2);
  assert.match(inserted.adoption.publicationDigest, /^[0-9a-f]{64}$/);
  assert.equal((await adoption.publisher.publish(input)).status, 'existing');
  await adoption.close();

  const client = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    client
      .prepare('SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitions"')
      .get().count,
    2,
  );
  assert.equal(
    client.prepare('SELECT COUNT(*) AS count FROM "QingLong3Triggers"').get()
      .count,
    2,
  );
  assert.equal(
    client
      .prepare(
        'SELECT COUNT(*) AS count FROM "QingLong3LocalTriggerSchedules" WHERE "next_fire_at_ms" IS NULL',
      )
      .get().count,
    2,
  );
  assert.equal(
    client
      .prepare(
        'SELECT COUNT(*) AS count FROM "QingLong3LocalTaskExecutionRevisions"',
      )
      .get().count,
    2,
  );
  assert.deepEqual(
    client
      .prepare(
        `SELECT task."row_ordinal" AS rowOrdinal,
                task."task_id" AS taskId,
                task."task_revision" AS taskRevision,
                task."trigger_count" AS triggerCount,
                trigger."trigger_ordinal" AS triggerOrdinal,
                trigger."trigger_id" AS triggerId,
                trigger."trigger_revision" AS triggerRevision
         FROM "QingLong3LegacyAdoptionTasks" AS task
         JOIN "QingLong3LegacyAdoptionTriggers" AS trigger
           ON trigger."adoption_mutation_id" = task."adoption_mutation_id"
          AND trigger."row_ordinal" = task."row_ordinal"
         ORDER BY task."row_ordinal", trigger."trigger_ordinal"`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        rowOrdinal: 1,
        taskId: 'legacy-cron:1',
        taskRevision: 1,
        triggerCount: 1,
        triggerOrdinal: 1,
        triggerId: 'legacy-cron:1:cron:1',
        triggerRevision: 1,
      },
      {
        rowOrdinal: 2,
        taskId: 'legacy-cron:2',
        taskRevision: 1,
        triggerCount: 1,
        triggerOrdinal: 1,
        triggerId: 'legacy-cron:2:cron:1',
        triggerRevision: 1,
      },
    ],
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT "operation_id" AS operationId, "outcome" AS outcome
           FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
        )
        .get(MUTATION_ID),
    },
    { operationId: 'task.adopt', outcome: 'allowed' },
  );
  client.close();
});

test('rolls the complete publication back on a later candidate conflict', async (t) => {
  const databasePath = await preparedDatabase(t);
  const adoption = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  await assert.rejects(
    adoption.publisher.publish(
      command([candidate(1, 'duplicate-task'), candidate(2, 'duplicate-task')]),
    ),
    LocalLegacyAdoptionConflictError,
  );
  await adoption.close();

  const client = new DatabaseSync(databasePath, { readOnly: true });
  for (const table of [
    'QingLong3TaskDefinitions',
    'QingLong3Triggers',
    'QingLong3LocalTriggerSchedules',
    'QingLong3LegacyAdoptions',
    'QingLong3LegacyAdoptionTasks',
    'QingLong3LegacyAdoptionTriggers',
    'QingLong3SecurityAuditEvents',
  ]) {
    assert.equal(
      client.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count,
      0,
      table,
    );
  }
  client.close();
});

test('awaits the final external authority check and rolls back on rejection', async (t) => {
  const databasePath = await preparedDatabase(t);
  const adoption = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  let checked = false;
  const authorityFailure = new Error('external authority changed');
  await assert.rejects(
    adoption.publisher.publish(
      command([candidate(1)], {
        async confirmExternalAuthority() {
          await Promise.resolve();
          checked = true;
          throw authorityFailure;
        },
      }),
    ),
    {
      name: 'LocalLegacyAdoptionUnavailableError',
      code: 'LOCAL_LEGACY_ADOPTION_UNAVAILABLE',
      cause: authorityFailure,
    },
  );
  assert.equal(checked, true);
  await adoption.close();

  const client = new DatabaseSync(databasePath, { readOnly: true });
  for (const table of [
    'QingLong3TaskDefinitions',
    'QingLong3Triggers',
    'QingLong3LocalTriggerSchedules',
    'QingLong3LegacyAdoptions',
    'QingLong3LegacyAdoptionTasks',
    'QingLong3LegacyAdoptionTriggers',
    'QingLong3SecurityAuditEvents',
  ]) {
    assert.equal(
      client.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count,
      0,
      table,
    );
  }
  client.close();
});

test('rejects stale authorization fences before any adoption mutation', async (t) => {
  const databasePath = await preparedDatabase(t);
  const client = new DatabaseSync(databasePath);
  client.exec(
    `UPDATE "QingLong3Projects" SET "version" = 2, "updated_at_ms" = 2
     WHERE "id" = 'default'`,
  );
  client.close();
  const adoption = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  await assert.rejects(
    adoption.publisher.publish(command([candidate(1)])),
    LocalLegacyAdoptionAuthorizationFenceConflictError,
  );
  await adoption.close();
});

test('rejects exact replay when durable provenance has drifted', async (t) => {
  const databasePath = await preparedDatabase(t);
  const input = command([candidate(1)]);
  const adoption = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  await adoption.publisher.publish(input);
  await adoption.close();

  const client = new DatabaseSync(databasePath);
  client
    .prepare(
      `UPDATE "QingLong3LegacyAdoptionTasks"
       SET "item_digest" = ? WHERE "adoption_mutation_id" = ?`,
    )
    .run('f'.repeat(64), MUTATION_ID);
  client.close();

  const reopened = await openLocalSqliteAdoptionDatabase({
    databasePath,
    profile: 'edge',
  });
  await assert.rejects(
    reopened.publisher.publish(input),
    LocalLegacyAdoptionConflictError,
  );
  await reopened.close();
});
