const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { test } = require('node:test');

const {
  RunManualRetryNotFoundError,
} = require('@qinglong/runtime-core/run-manual-retry');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  runLocalRunRetryCommandFile,
} = require('../dist/run-management/runRetryCommand.js');
const {
  auditRows,
  localManagementFixture,
  writeCommand,
} = require('./localManagementFixture.cjs');

function uuid(value) {
  return `019f9200-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

async function createFailedSource(value) {
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
  });
  let started;
  try {
    const task = (
      await runtime.taskDefinitions.appendTaskDefinitionRevision({
        projectId: 'default',
        taskId: 'retry-product-task',
        expectedRevision: null,
        mutationId: uuid(1),
        name: 'Retry product task',
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/bin/echo',
              args: ['retry-product'],
            },
          },
        },
        labels: {},
        enabled: true,
        occurredAtMs: value.now,
      })
    ).definition;
    started = await (
      await runtime.taskStartRepository()
    ).startTask({
      projectId: 'default',
      taskId: task.taskId,
      mutationId: uuid(2),
      expectedRevision: task.revision,
      expectedContentDigest: task.contentDigest,
      runId: uuid(3),
      attemptId: uuid(4),
      createdEventId: uuid(5),
      queuedEventId: uuid(6),
      subject: { type: 'user', id: 'automation-user' },
      policyFence: { projectVersion: 1, bindingVersion: 1 },
    });
  } finally {
    await runtime.close();
  }
  const database = new DatabaseSync(value.databasePath);
  try {
    database
      .prepare(
        `UPDATE "Runs"
            SET "status" = 'failed', "version" = 3, "event_sequence" = 3,
                "finished_at_ms" = ?, "error_code" = 'PRODUCT_TEST_FAILURE',
                "error_summary" = 'failed'
          WHERE "id" = ?`,
      )
      .run(value.now + 10, started.runId);
    database
      .prepare(
        `UPDATE "RunAttempts"
            SET "status" = 'failed', "finished_at_ms" = ?,
                "error_code" = 'PRODUCT_TEST_FAILURE',
                "error_summary" = 'failed'
          WHERE "id" = ?`,
      )
      .run(value.now + 10, started.attemptId);
    database
      .prepare(
        `INSERT INTO "RunEvents" (
           "id", "run_id", "sequence", "type", "dedupe_key",
           "actor_type", "actor_id", "attempt_id", "payload",
           "created_at_ms"
         ) VALUES (?, ?, 3, 'run.failed', 'product-test-failed', 'executor',
                   'product-test', ?, '{}', ?)`,
      )
      .run(uuid(7), started.runId, started.attemptId, value.now + 10);
  } finally {
    database.close();
  }
  return started;
}

function request(value, sourceRunId, overrides = {}) {
  return {
    projectId: 'default',
    sourceRunId,
    mutationId: uuid(10),
    expectedRunVersion: 3,
    expectedRunStatus: 'failed',
    requestId: 'local-run-retry-product-1',
    auditEventId: uuid(11),
    failureAuditEventId: uuid(12),
    occurredAtMs: value.now,
    ...overrides,
  };
}

test('runs a strongly authenticated manual retry and exactly replays it', async (t) => {
  const value = await localManagementFixture(t);
  const source = await createFailedSource(value);
  const commandFile = writeCommand(
    value,
    'run.retry',
    request(value, source.runId),
    'run-retry',
  );

  const accepted = await runLocalRunRetryCommandFile(commandFile);
  assert.equal(accepted.schemaVersion, 1);
  assert.equal(accepted.operation, 'run.retry');
  assert.equal(accepted.retry.status, 'accepted');
  assert.equal(accepted.retry.retryOfRunId, source.runId);
  assert.equal(accepted.retry.runStatus, 'queued');

  const replay = await runLocalRunRetryCommandFile(commandFile);
  assert.equal(replay.retry.status, 'existing');
  assert.equal(replay.retry.runId, accepted.retry.runId);
  assert.deepEqual(
    auditRows(value.databasePath)
      .filter(({ operationId }) => operationId === 'run.retry')
      .map((row) => ({ ...row })),
    [
      {
        eventId: uuid(11),
        operationId: 'run.retry',
        outcome: 'allowed',
        reasonsJson: '["role_grant","strong_authentication"]',
      },
    ],
  );
});

test('audits a missing source without creating Run state', async (t) => {
  const value = await localManagementFixture(t);
  const commandFile = writeCommand(
    value,
    'run.retry',
    request(value, 'missing-run', {
      mutationId: uuid(20),
      requestId: 'local-run-retry-missing',
      auditEventId: uuid(21),
      failureAuditEventId: uuid(22),
    }),
    'run-retry-missing',
  );
  await assert.rejects(
    runLocalRunRetryCommandFile(commandFile),
    RunManualRetryNotFoundError,
  );
  assert.deepEqual(
    auditRows(value.databasePath)
      .filter(({ operationId }) => operationId === 'run.retry')
      .map((row) => ({ ...row })),
    [
      {
        eventId: uuid(22),
        operationId: 'run.retry',
        outcome: 'denied',
        reasonsJson: '["run_not_found"]',
      },
    ],
  );
});

test('binary exposes only the private command-file retry interface', () => {
  const cli = path.join(
    __dirname,
    '..',
    'dist',
    'run-management',
    'runManagementCli.js',
  );
  const help = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.equal(
    help.stdout.trim(),
    [
      'Usage: ql3-run retry --command-file /absolute/private-command.json',
      '       ql3-run stop --command-file /absolute/private-command.json',
    ].join('\n'),
  );
  const invalid = spawnSync(process.execPath, [cli, 'retry'], {
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 64);
  assert.equal(
    JSON.parse(invalid.stderr).code,
    'LOCAL_RUN_MANAGEMENT_CLI_USAGE_INVALID',
  );
});
