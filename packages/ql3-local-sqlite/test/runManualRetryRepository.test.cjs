'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  RunManualRetryFenceRejectedError,
  RunManualRetryRateLimitedError,
} = require('@qinglong/runtime-core/run-manual-retry');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority.js');
const {
  LocalSqliteRunManualRetryRepository,
} = require('../dist/run/runManualRetryRepository.js');

function uuid(value) {
  return `019f9100-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function definition(index) {
  return {
    projectId: 'default',
    taskId: `retry-task-${index}`,
    expectedRevision: null,
    mutationId: uuid(100 + index),
    name: `Retry Task ${index}`,
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: [String(index)] },
      },
    },
    labels: {},
    enabled: true,
    occurredAtMs: 1_000 + index,
  };
}

function retryCommand(source, index, overrides = {}) {
  const now = Date.now();
  return {
    projectId: 'default',
    sourceRunId: source.runId,
    mutationId: uuid(200 + index),
    expectedRunVersion: 3,
    expectedRunStatus: 'failed',
    runId: uuid(300 + index * 10),
    attemptId: uuid(301 + index * 10),
    createdEventId: uuid(302 + index * 10),
    queuedEventId: uuid(303 + index * 10),
    auditEventId: uuid(304 + index * 10),
    requestId: `manual-run-retry-${index}`,
    principal: {
      subject: { type: 'user', id: 'user-1' },
      authenticationId: 'local_console:proof-1',
      authenticatedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      assurance: 'local_console',
    },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    ...overrides,
  };
}

async function fixture(t, { rateLimit = 4, beforeMutation } = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-manual-run-retry-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const setup = new DatabaseSync(databasePath);
  setup
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
         "project_id", "subject_type", "subject_id", "version", "state",
         "role", "mutation_id", "changed_by_type", "changed_by_id",
         "created_at_ms"
       ) VALUES ('default', 'user', 'user-1', 1, 'active', 'operator',
                 'grant-run-retry', 'user', 'user-1', 1)`,
    )
    .run();
  setup.close();

  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  const sources = [];
  for (let index = 1; index <= 2; index += 1) {
    const task = (
      await runtime.taskDefinitions.appendTaskDefinitionRevision(
        definition(index),
      )
    ).definition;
    const start = await (
      await runtime.taskStartRepository()
    ).startTask({
      projectId: 'default',
      taskId: task.taskId,
      mutationId: uuid(400 + index),
      expectedRevision: task.revision,
      expectedContentDigest: task.contentDigest,
      runId: uuid(500 + index * 10),
      attemptId: uuid(501 + index * 10),
      createdEventId: uuid(502 + index * 10),
      queuedEventId: uuid(503 + index * 10),
      subject: { type: 'user', id: 'user-1' },
      policyFence: { projectVersion: 1, bindingVersion: 1 },
    });
    sources.push({ runId: start.runId, attemptId: start.attemptId, task });
  }
  await runtime.close();

  const terminal = new DatabaseSync(databasePath);
  for (const [index, source] of sources.entries()) {
    terminal
      .prepare(
        `UPDATE "Runs"
            SET "status" = 'failed', "version" = 3, "event_sequence" = 3,
                "finished_at_ms" = ?, "error_code" = 'TEST_FAILURE',
                "error_summary" = 'failed before manual retry'
          WHERE "id" = ?`,
      )
      .run(2_000 + index, source.runId);
    terminal
      .prepare(
        `UPDATE "RunAttempts"
            SET "status" = 'failed', "finished_at_ms" = ?,
                "error_code" = 'TEST_FAILURE', "error_summary" = 'failed'
          WHERE "id" = ?`,
      )
      .run(2_000 + index, source.attemptId);
    terminal
      .prepare(
        `INSERT INTO "RunEvents" (
           "id", "run_id", "sequence", "type", "dedupe_key",
           "actor_type", "actor_id", "attempt_id", "payload",
           "created_at_ms"
         ) VALUES (?, ?, 3, 'run.failed', ?, 'executor', 'test', ?, '{}', ?)`,
      )
      .run(
        uuid(600 + index),
        source.runId,
        `test-failed:${source.runId}`,
        source.attemptId,
        2_000 + index,
      );
  }
  terminal.close();

  const client = new DatabaseSync(databasePath);
  const authority = new LocalSqliteOperationAuthority(client);
  const repository = new LocalSqliteRunManualRetryRepository(authority, {
    rateLimit,
    ...(beforeMutation === undefined ? {} : { beforeMutation }),
  });
  t.after(() => authority.close());
  return { databasePath, repository, sources };
}

test('atomically creates a new linked Run and exactly replays without reopening the source', async (t) => {
  const { databasePath, repository, sources } = await fixture(t);
  const command = retryCommand(sources[0], 1);
  const accepted = await repository.retryRun(command);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.retryOfRunId, sources[0].runId);
  assert.equal(accepted.runStatus, 'queued');
  assert.equal(accepted.executorType, 'local_process');

  const replay = await repository.retryRun({
    ...command,
    runId: uuid(901),
    attemptId: uuid(902),
    createdEventId: uuid(903),
    queuedEventId: uuid(904),
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.runId, accepted.runId);
  assert.equal(replay.attemptId, accepted.attemptId);

  const client = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => client.close());
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT "status", "version", "event_sequence" AS "eventSequence",
              "retry_of_run_id" AS "retryOfRunId",
              "trigger_type" AS "triggerType"
         FROM "Runs" WHERE "id" = ?`,
        )
        .get(accepted.runId),
    },
    {
      status: 'queued',
      version: 2,
      eventSequence: 2,
      retryOfRunId: sources[0].runId,
      triggerType: 'run_manual_retry',
    },
  );
  assert.equal(
    client
      .prepare(`SELECT "status" FROM "Runs" WHERE "id" = ?`)
      .get(sources[0].runId).status,
    'failed',
  );
  assert.equal(
    client
      .prepare(
        `SELECT COUNT(*) AS "count" FROM "RunRetryPolicies" WHERE "run_id" = ?`,
      )
      .get(accepted.runId).count,
    0,
  );
  assert.equal(
    client
      .prepare(
        `SELECT COUNT(*) AS "count" FROM "QingLong3SecurityAuditEvents"
        WHERE "operation_id" = 'run.retry'`,
      )
      .get().count,
    1,
  );
});

test('fails closed for changed, non-terminal, disabled and unauthenticated sources', async (t) => {
  let authenticated = true;
  const { databasePath, repository, sources } = await fixture(t, {
    beforeMutation() {
      if (!authenticated) throw new Error('credential changed');
    },
  });
  await assert.rejects(
    repository.retryRun(retryCommand(sources[0], 1, { expectedRunVersion: 2 })),
    (error) =>
      error instanceof RunManualRetryFenceRejectedError &&
      error.reason === 'source_changed',
  );
  const client = new DatabaseSync(databasePath);
  client
    .prepare(`UPDATE "Runs" SET "status" = 'lost' WHERE "id" = ?`)
    .run(sources[0].runId);
  await assert.rejects(
    repository.retryRun(retryCommand(sources[0], 2)),
    (error) =>
      error instanceof RunManualRetryFenceRejectedError &&
      error.reason === 'source_not_terminal',
  );
  client
    .prepare(`UPDATE "Runs" SET "status" = 'failed' WHERE "id" = ?`)
    .run(sources[0].runId);
  client
    .prepare(
      `UPDATE "QingLong3TaskDefinitionRevisions" SET "enabled" = 0
        WHERE "project_id" = 'default' AND "task_id" = ?`,
    )
    .run(sources[0].task.taskId);
  await assert.rejects(
    repository.retryRun(retryCommand(sources[0], 3)),
    (error) =>
      error instanceof RunManualRetryFenceRejectedError &&
      error.reason === 'task_disabled',
  );
  client.close();
  authenticated = false;
  await assert.rejects(
    repository.retryRun(retryCommand(sources[1], 4)),
    (error) =>
      error instanceof RunManualRetryFenceRejectedError &&
      error.reason === 'authentication_changed',
  );
});

test('uses the durable Run ledger to enforce a bounded per-User rate', async (t) => {
  const { repository, sources } = await fixture(t, { rateLimit: 2 });
  await repository.retryRun(retryCommand(sources[0], 1));
  await repository.retryRun(retryCommand(sources[0], 2));
  await assert.rejects(
    repository.retryRun(retryCommand(sources[1], 3)),
    (error) =>
      error instanceof RunManualRetryRateLimitedError &&
      Number.isSafeInteger(error.retryAfterMs) &&
      error.retryAfterMs > 0 &&
      error.retryAfterMs <= 60_000,
  );
});
