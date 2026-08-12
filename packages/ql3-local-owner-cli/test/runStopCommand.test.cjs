const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { test } = require('node:test');

const {
  RunCancellationNotFoundError,
} = require('@qinglong/runtime-core/run-cancellation');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  runLocalRunStopCommandFile,
} = require('../dist/run-management/runStopCommand.js');
const {
  auditRows,
  localManagementFixture,
  writeCommand,
} = require('./localManagementFixture.cjs');

function uuid(value) {
  return `019f9300-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

async function createRunningSource(value, suffix = 1) {
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  try {
    const task = (
      await runtime.taskDefinitions.appendTaskDefinitionRevision({
        projectId: 'default',
        taskId: `stop-product-task-${suffix}`,
        expectedRevision: null,
        mutationId: uuid(10 + suffix),
        name: 'Stop product task',
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/bin/echo',
              args: ['stop-product'],
            },
          },
        },
        labels: {},
        enabled: true,
        occurredAtMs: value.now,
      })
    ).definition;
    return await (
      await runtime.taskStartRepository()
    ).startTask({
      projectId: 'default',
      taskId: task.taskId,
      mutationId: uuid(20 + suffix),
      expectedRevision: task.revision,
      expectedContentDigest: task.contentDigest,
      runId: uuid(30 + suffix),
      attemptId: uuid(40 + suffix),
      createdEventId: uuid(50 + suffix),
      queuedEventId: uuid(60 + suffix),
      subject: { type: 'user', id: 'automation-user' },
      policyFence: { projectVersion: 1, bindingVersion: 1 },
    });
  } finally {
    await runtime.close();
  }
}

function request(value, runId, overrides = {}) {
  return {
    projectId: 'default',
    runId,
    mutationId: uuid(100),
    requestId: 'local-run-stop-product-1',
    auditEventId: uuid(101),
    failureAuditEventId: uuid(102),
    occurredAtMs: value.now,
    ...overrides,
  };
}

test('strongly stops one Local Run and replays through the unified CLI', async (t) => {
  const value = await localManagementFixture(t);
  const source = await createRunningSource(value);
  const commandFile = writeCommand(
    value,
    'run.stop',
    request(value, source.runId),
    'run-stop',
  );

  const accepted = await runLocalRunStopCommandFile(commandFile);
  assert.equal(accepted.schemaVersion, 1);
  assert.equal(accepted.operation, 'run.stop');
  assert.equal(accepted.stop.status, 'accepted');
  assert.equal(accepted.stop.runId, source.runId);
  assert.equal(accepted.stop.cancelReason, 'user');

  const cli = path.join(
    __dirname,
    '..',
    'dist',
    'run-management',
    'runManagementCli.js',
  );
  const replay = spawnSync(
    process.execPath,
    [cli, 'stop', '--command-file', commandFile],
    { encoding: 'utf8' },
  );
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).stop.status, 'already_requested');

  assert.deepEqual(
    auditRows(value.databasePath)
      .filter(({ operationId }) => operationId === 'run.stop')
      .map((row) => ({ ...row })),
    [
      {
        eventId: uuid(101),
        operationId: 'run.stop',
        outcome: 'allowed',
        reasonsJson: '["role_grant","strong_authentication"]',
      },
    ],
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT "cancel_reason" AS "cancelReason",
                    (SELECT count(*) FROM "RunEvents"
                      WHERE "run_id" = ? AND "type" = 'run.cancel_requested')
                      AS "eventCount"
             FROM "Runs" WHERE "id" = ?`,
          )
          .get(source.runId, source.runId),
      },
      { cancelReason: 'user', eventCount: 1 },
    );
  } finally {
    database.close();
  }
});

test('audits a missing stop target without creating Run state', async (t) => {
  const value = await localManagementFixture(t);
  const commandFile = writeCommand(
    value,
    'run.stop',
    request(value, 'missing-run', {
      mutationId: uuid(110),
      requestId: 'local-run-stop-missing',
      auditEventId: uuid(111),
      failureAuditEventId: uuid(112),
    }),
    'run-stop-missing',
  );
  await assert.rejects(
    runLocalRunStopCommandFile(commandFile),
    RunCancellationNotFoundError,
  );
  assert.deepEqual(
    auditRows(value.databasePath)
      .filter(({ operationId }) => operationId === 'run.stop')
      .map((row) => ({ ...row })),
    [
      {
        eventId: uuid(112),
        operationId: 'run.stop',
        outcome: 'denied',
        reasonsJson: '["run_not_found"]',
      },
    ],
  );
});

test('denies a Viewer and preserves the running Run', async (t) => {
  const value = await localManagementFixture(t);
  const source = await createRunningSource(value, 2);
  const policyDatabase = new DatabaseSync(value.databasePath);
  try {
    policyDatabase
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES ('default', 'user', 'automation-user', 2, 'active', 'viewer',
                   'run-stop-viewer-binding', 'user', 'automation-user', ?)`,
      )
      .run(value.now + 1);
  } finally {
    policyDatabase.close();
  }
  const commandFile = writeCommand(
    value,
    'run.stop',
    request(value, source.runId, {
      mutationId: uuid(120),
      requestId: 'local-run-stop-viewer',
      auditEventId: uuid(121),
      failureAuditEventId: uuid(122),
    }),
    'run-stop-viewer',
  );
  await assert.rejects(
    runLocalRunStopCommandFile(commandFile),
    (error) => error?.code === 'LOCAL_RUN_STOP_COMMAND_AUTHORIZATION_REJECTED',
  );
  assert.deepEqual(
    auditRows(value.databasePath)
      .filter(({ operationId }) => operationId === 'run.stop')
      .map((row) => ({ ...row })),
    [
      {
        eventId: uuid(122),
        operationId: 'run.stop',
        outcome: 'denied',
        reasonsJson: '["run_stop_fence_rejected"]',
      },
    ],
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT "cancel_requested_at_ms" AS value FROM "Runs" WHERE "id" = ?`,
        )
        .get(source.runId).value,
      null,
    );
  } finally {
    database.close();
  }
});
