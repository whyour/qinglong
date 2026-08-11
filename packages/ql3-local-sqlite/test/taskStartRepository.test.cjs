'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  TaskStartFenceRejectedError,
  TaskStartNotFoundError,
  TaskStartUnavailableError,
} = require('@qinglong/runtime-core/task-start');
const {
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');

const NOW = 1_800_000_000_000;
const IDS = [
  '019f7300-0000-7000-8000-000000000101',
  '019f7300-0000-7000-8000-000000000102',
  '019f7300-0000-7000-8000-000000000103',
  '019f7300-0000-7000-8000-000000000104',
];

function definition(index = 1, overrides = {}) {
  return {
    projectId: 'default',
    taskId: `task-${index}`,
    expectedRevision: null,
    mutationId: `019f7300-0000-7000-8000-${String(index).padStart(12, '0')}`,
    name: `Task ${index}`,
    kind: 'command',
    spec: {
      schema: 'qinglong/command@v1',
      config: {
        command: { kind: 'argv', file: '/bin/echo', args: [String(index)] },
      },
    },
    labels: {},
    enabled: true,
    occurredAtMs: 100 + index,
    ...overrides,
  };
}

function command(record, overrides = {}) {
  return {
    projectId: 'default',
    taskId: record.taskId,
    mutationId: '019f7300-0000-7000-8000-000000000100',
    expectedRevision: record.revision,
    expectedContentDigest: record.contentDigest,
    runId: IDS[0],
    attemptId: IDS[1],
    createdEventId: IDS[2],
    queuedEventId: IDS[3],
    subject: { type: 'user', id: 'user-1' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    ...overrides,
  };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-task-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const client = new DatabaseSync(databasePath);
  client.prepare(`
    INSERT INTO "QingLong3ProjectRoleBindings" (
      "project_id", "subject_type", "subject_id", "version", "state",
      "role", "mutation_id", "changed_by_type", "changed_by_id",
      "created_at_ms"
    ) VALUES ('default', 'user', 'user-1', 1, 'active', 'operator',
              'grant-operator', 'user', 'user-1', ?)
  `).run(NOW - 1_000);
  client.close();
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath,
    profile: 'edge',
  });
  t.after(() => runtime.close());
  const repository = await runtime.taskStartRepository();
  return { databasePath, runtime, repository };
}

test('atomically creates queued Run, claimed Attempt and two Events, then replays', async (t) => {
  const { databasePath, runtime, repository } = await fixture(t);
  const record = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(definition())
  ).definition;
  const accepted = await repository.startTask(command(record));
  assert.deepEqual(accepted, {
    status: 'accepted',
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 1,
    taskContentDigest: record.contentDigest,
    runId: IDS[0],
    attemptId: IDS[1],
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'local_process',
    executionRevisionDigest: accepted.executionRevisionDigest,
    createdAtMs: accepted.createdAtMs,
  });
  assert.match(accepted.executionRevisionDigest, /^[0-9a-f]{64}$/);

  const replay = await repository.startTask(command(record, {
    runId: '019f7300-0000-7000-8000-000000000201',
    attemptId: '019f7300-0000-7000-8000-000000000202',
    createdEventId: '019f7300-0000-7000-8000-000000000203',
    queuedEventId: '019f7300-0000-7000-8000-000000000204',
  }));
  assert.equal(replay.status, 'existing');
  assert.equal(replay.runId, IDS[0]);
  assert.equal(replay.attemptId, IDS[1]);

  const client = new DatabaseSync(databasePath, { readOnly: true });
  t.after(() => client.close());
  assert.deepEqual({ ...client.prepare(`
    SELECT "status", "version", "event_sequence" AS "eventSequence",
           "execution_origin" AS "executionOrigin",
           "trigger_type" AS "triggerType"
    FROM "Runs" WHERE "id" = ?
  `).get(IDS[0]) }, {
    status: 'queued',
    version: 2,
    eventSequence: 2,
    executionOrigin: 'manual',
    triggerType: 'task_start',
  });
  assert.equal(client.prepare(
    `SELECT COUNT(*) AS count FROM "RunEvents" WHERE "run_id" = ?`,
  ).get(IDS[0]).count, 2);
});

test('serializes concurrent retries to one durable Run', async (t) => {
  const { runtime, repository } = await fixture(t);
  const record = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(definition())
  ).definition;
  const [left, right] = await Promise.all([
    repository.startTask(command(record)),
    repository.startTask(command(record, {
      runId: '019f7300-0000-7000-8000-000000000301',
      attemptId: '019f7300-0000-7000-8000-000000000302',
      createdEventId: '019f7300-0000-7000-8000-000000000303',
      queuedEventId: '019f7300-0000-7000-8000-000000000304',
    })),
  ]);
  assert.deepEqual([left.status, right.status].sort(), ['accepted', 'existing']);
  assert.equal(left.runId, right.runId);
});

test('rejects missing, changed, disabled and conflicting Task fences', async (t) => {
  const { runtime, repository } = await fixture(t);
  const record = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(definition())
  ).definition;
  await assert.rejects(
    repository.startTask(command({ ...record, taskId: 'missing' })),
    TaskStartNotFoundError,
  );
  await assert.rejects(
    repository.startTask(command(record, { expectedRevision: 2 })),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'definition_changed',
  );
  const disabled = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(
      definition(2, { enabled: false }),
    )
  ).definition;
  await assert.rejects(
    repository.startTask(command(disabled, {
      taskId: disabled.taskId,
      mutationId: '019f7300-0000-7000-8000-000000000400',
    })),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'task_disabled',
  );

  await repository.startTask(command(record));
  await assert.rejects(
    repository.startTask(command(record, {
      expectedContentDigest: 'f'.repeat(64),
      runId: '019f7300-0000-7000-8000-000000000401',
      attemptId: '019f7300-0000-7000-8000-000000000402',
      createdEventId: '019f7300-0000-7000-8000-000000000403',
      queuedEventId: '019f7300-0000-7000-8000-000000000404',
    })),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'mutation_conflict',
  );
});

test('fails closed after authorization revocation or execution revision loss', async (t) => {
  const { databasePath, runtime, repository } = await fixture(t);
  const first = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(definition())
  ).definition;
  const client = new DatabaseSync(databasePath);
  client.prepare(`
    INSERT INTO "QingLong3ProjectRoleBindings" (
      "project_id", "subject_type", "subject_id", "version", "state",
      "role", "mutation_id", "changed_by_type", "changed_by_id",
      "created_at_ms"
    ) VALUES ('default', 'user', 'user-1', 2, 'revoked', NULL,
              'revoke-operator', 'user', 'user-1', ?)
  `).run(NOW - 100);
  await assert.rejects(
    repository.startTask(command(first)),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'authorization_changed',
  );
  client.prepare(
    `DELETE FROM "QingLong3ProjectRoleBindings" WHERE "version" = 2`,
  ).run();
  const second = (
    await runtime.taskDefinitions.appendTaskDefinitionRevision(definition(2))
  ).definition;
  client.prepare(`
    DELETE FROM "QingLong3LocalTaskExecutionRevisions"
    WHERE "project_id" = ? AND "task_id" = ?
  `).run('default', second.taskId);
  client.close();
  await assert.rejects(
    repository.startTask(command(second, {
      taskId: second.taskId,
      mutationId: '019f7300-0000-7000-8000-000000000500',
    })),
    TaskStartUnavailableError,
  );
});
