const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createLocalTriggerCommandRunner,
  runLocalTriggerCommandFile,
} = require('@qinglong/local-owner-cli/trigger-command');
const {
  runLocalTaskDefinitionCommandFile,
} = require('@qinglong/local-owner-cli/task-definition-command');
const {
  createLocalTriggerAdministrationService,
} = require('@qinglong/local-admin/trigger-administration');
const {
  openLocalSqliteTriggerAdministrationDatabase,
} = require('@qinglong/local-sqlite/trigger-administration');
const {
  auditRows,
  localManagementFixture,
  taskPutRequest,
  writeCommand,
} = require('./localManagementFixture.cjs');

async function createTask(value, suffix = '1') {
  const result = await runLocalTaskDefinitionCommandFile(
    writeCommand(
      value,
      'task.put',
      taskPutRequest(value, suffix),
      `task-create-${suffix}`,
    ),
  );
  return result.task;
}

function triggerPutRequest(value, task, suffix, overrides = {}) {
  return {
    projectId: 'default',
    triggerId: 'trigger-product-entry',
    expectedRevision: null,
    mutationId: `94000000-0000-4000-8000-00000000000${suffix}`,
    requestId: `trigger-put-${suffix}`,
    failureAuditEventId: `95000000-0000-4000-8000-00000000000${suffix}`,
    taskId: task.taskId,
    taskRevision: task.revision,
    taskContentDigest: task.contentDigest,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '*/5 * * * *',
        timezone: 'Etc/UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
    occurredAtMs: value.now + 1,
    ...overrides,
  };
}

test('creates, exactly replays, disables, inspects and lists a Trigger', async (t) => {
  const value = await localManagementFixture(t);
  const task = await createTask(value);
  const createRequest = triggerPutRequest(value, task, '1');
  const createPath = writeCommand(
    value,
    'trigger.put',
    createRequest,
    'trigger-create',
  );
  const created = await runLocalTriggerCommandFile(createPath);
  assert.equal(created.status, 'created');
  assert.equal(created.trigger.revision, 1);
  assert.equal(created.trigger.enabled, true);
  assert.equal(created.trigger.schema, 'qinglong/cron@v1');
  assert.equal(created.trigger.taskContentDigest, task.contentDigest);
  assert.doesNotMatch(JSON.stringify(created), /expression|timezone/);
  assert.equal(
    (await runLocalTriggerCommandFile(createPath)).status,
    'existing',
  );

  const disabled = await runLocalTriggerCommandFile(
    writeCommand(
      value,
      'trigger.put',
      triggerPutRequest(value, task, '2', {
        expectedRevision: 1,
        mutationId: '94000000-0000-4000-8000-000000000002',
        failureAuditEventId: '95000000-0000-4000-8000-000000000002',
        requestId: 'trigger-put-2',
        enabled: false,
        occurredAtMs: value.now + 2,
      }),
      'trigger-disable',
    ),
  );
  assert.equal(disabled.status, 'updated');
  assert.equal(disabled.trigger.revision, 2);
  assert.equal(disabled.trigger.enabled, false);

  const inspected = await runLocalTriggerCommandFile(
    writeCommand(
      value,
      'trigger.inspect',
      {
        projectId: 'default',
        triggerId: 'trigger-product-entry',
        requestId: 'trigger-inspect-1',
        auditEventId: '96000000-0000-4000-8000-000000000001',
        failureAuditEventId: '97000000-0000-4000-8000-000000000001',
      },
      'trigger-inspect',
    ),
  );
  assert.equal(inspected.found, true);
  assert.equal(inspected.trigger.revision, 2);
  assert.equal(Object.hasOwn(inspected.trigger, 'spec'), false);

  const listed = await runLocalTriggerCommandFile(
    writeCommand(
      value,
      'trigger.list',
      {
        projectId: 'default',
        requestId: 'trigger-list-1',
        auditEventId: '96000000-0000-4000-8000-000000000002',
        failureAuditEventId: '97000000-0000-4000-8000-000000000002',
        limit: 1,
      },
      'trigger-list',
    ),
  );
  assert.equal(listed.triggers.length, 1);
  assert.equal(listed.triggers[0].triggerId, 'trigger-product-entry');
  assert.equal(listed.nextCursor, null);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3TriggerRevisions"')
        .get().count,
      2,
    );
    assert.equal(
      database
        .prepare(
          'SELECT trigger_revision AS revision FROM "QingLong3LocalTriggerSchedules"',
        )
        .get().revision,
      2,
    );
  } finally {
    database.close();
  }
  assert.deepEqual(
    auditRows(value.databasePath)
      .filter((row) => row.operationId.startsWith('trigger.'))
      .map((row) => [row.operationId, row.outcome]),
    [
      ['trigger.create', 'allowed'],
      ['trigger.update', 'allowed'],
      ['trigger.read', 'allowed'],
      ['trigger.read', 'allowed'],
    ],
  );
});

test('allows an operator to manage Triggers but rejects a viewer atomically', async (t) => {
  const operator = await localManagementFixture(t, { role: 'operator' });
  const operatorTask = await createTask(operator, '3');
  assert.equal(
    (
      await runLocalTriggerCommandFile(
        writeCommand(
          operator,
          'trigger.put',
          triggerPutRequest(operator, operatorTask, '3'),
          'operator-trigger-create',
        ),
      )
    ).status,
    'created',
  );

  const viewer = await localManagementFixture(t, { role: 'viewer' });
  const database = new DatabaseSync(viewer.databasePath);
  try {
    const {
      requestId: _requestId,
      failureAuditEventId: _failureAuditEventId,
      ...task
    } = taskPutRequest(viewer, '4');
    database
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitions" (
           "project_id", "task_id", "current_revision", "created_at_ms", "updated_at_ms"
         ) VALUES ('default', ?, 1, ?, ?)`,
      )
      .run(task.taskId, viewer.now, viewer.now);
    const {
      createTaskDefinitionRecord,
    } = require('@qinglong/runtime-core/task-definition');
    const record = createTaskDefinitionRecord(task, viewer.now);
    database
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" (
           "project_id", "task_id", "revision", "mutation_id", "name",
           "description", "kind", "spec_json", "labels_json", "enabled",
           "content_digest", "created_at_ms"
         ) VALUES (?, ?, 1, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        record.projectId,
        record.taskId,
        record.mutationId,
        record.name,
        record.kind,
        JSON.stringify(record.spec),
        JSON.stringify(record.labels),
        record.contentDigest,
        record.updatedAtMs,
      );
    await assert.rejects(
      runLocalTriggerCommandFile(
        writeCommand(
          viewer,
          'trigger.put',
          triggerPutRequest(viewer, record, '4'),
          'viewer-trigger-create',
        ),
      ),
      { code: 'LOCAL_TRIGGER_ADMINISTRATION_FORBIDDEN' },
    );
  } finally {
    database.close();
  }
  const reader = new DatabaseSync(viewer.databasePath, { readOnly: true });
  try {
    assert.equal(
      reader.prepare('SELECT COUNT(*) AS count FROM "QingLong3Triggers"').get()
        .count,
      0,
    );
  } finally {
    reader.close();
  }
});

test('rechecks the credential and RoleBinding fence inside the Trigger transaction', async (t) => {
  const value = await localManagementFixture(t);
  const task = await createTask(value, '5');
  const runner = createLocalTriggerCommandRunner({
    openDatabase: openLocalSqliteTriggerAdministrationDatabase,
    authenticate: require('@qinglong/local-owner-console/authenticated-command')
      .establishAuthenticatedLocalCommand,
    now: Date.now,
    createService(projectPolicy, mutations, source, audit, options) {
      const fencedMutations = {
        async appendAuthorizedTriggerRevision(mutation) {
          const competing = new DatabaseSync(value.databasePath);
          try {
            competing
              .prepare(
                `INSERT INTO "QingLong3ProjectRoleBindings" (
                   "project_id", "subject_type", "subject_id", "version",
                   "state", "role", "mutation_id", "changed_by_type",
                   "changed_by_id", "created_at_ms"
                 ) VALUES (
                   'default', 'user', 'automation-user', 2, 'revoked', NULL,
                   'trigger-race-revoke', 'user', 'automation-user', ?
                 )`,
              )
              .run(value.now + 5);
          } finally {
            competing.close();
          }
          return mutations.appendAuthorizedTriggerRevision(mutation);
        },
      };
      return createLocalTriggerAdministrationService(
        projectPolicy,
        fencedMutations,
        source,
        audit,
        options,
      );
    },
  });
  const request = triggerPutRequest(value, task, '5');
  await assert.rejects(
    runner.run(
      writeCommand(value, 'trigger.put', request, 'trigger-fenced-create'),
    ),
    { code: 'TRIGGER_ADMINISTRATION_AUTHORIZATION_FENCE_CONFLICT' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3Triggers"')
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
  } finally {
    database.close();
  }
});

test('rejects Trigger and audit replay drift without adding revisions', async (t) => {
  const value = await localManagementFixture(t);
  const task = await createTask(value, '6');
  const original = triggerPutRequest(value, task, '6');
  await runLocalTriggerCommandFile(
    writeCommand(value, 'trigger.put', original, 'trigger-original'),
  );
  await assert.rejects(
    runLocalTriggerCommandFile(
      writeCommand(
        value,
        'trigger.put',
        {
          ...original,
          spec: {
            ...original.spec,
            config: { ...original.spec.config, expression: '*/10 * * * *' },
          },
          failureAuditEventId: '95000000-0000-4000-8000-000000000007',
        },
        'trigger-drifted',
      ),
    ),
    { code: 'TRIGGER_CONFLICT' },
  );
  await assert.rejects(
    runLocalTriggerCommandFile(
      writeCommand(
        value,
        'trigger.put',
        {
          ...original,
          requestId: 'trigger-audit-drift',
          failureAuditEventId: '95000000-0000-4000-8000-000000000008',
        },
        'trigger-audit-drifted',
      ),
    ),
    { code: 'TRIGGER_ADMINISTRATION_MUTATION_CONFLICT' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM "QingLong3TriggerRevisions"')
        .get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test('requires a private Trigger command file and exposes one exact CLI', async (t) => {
  const value = await localManagementFixture(t);
  const task = await createTask(value, '8');
  const commandPath = writeCommand(
    value,
    'trigger.put',
    triggerPutRequest(value, task, '8'),
    'trigger-broad',
  );
  fs.chmodSync(commandPath, 0o644);
  await assert.rejects(runLocalTriggerCommandFile(commandPath), {
    code: 'LOCAL_TRIGGER_COMMAND_CONFIGURATION_INVALID',
  });

  const cliPath = path.resolve(
    __dirname,
    '../dist/automation-management/triggerCli.js',
  );
  const help = spawnSync(process.execPath, [cliPath, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-trigger run --command-file /);
  const invalid = spawnSync(process.execPath, [cliPath, 'list'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.equal(
    JSON.parse(invalid.stderr).code,
    'LOCAL_TRIGGER_CLI_USAGE_INVALID',
  );
});
