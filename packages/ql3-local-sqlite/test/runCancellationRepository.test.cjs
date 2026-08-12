const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  RunCancellationFenceRejectedError,
  RunCancellationNotFoundError,
  RunCancellationUnavailableError,
} = require('@qinglong/runtime-core/run-cancellation');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority.js');
const {
  LocalSqliteRunCancellationRepository,
} = require('../dist/run/runCancellationRepository.js');
const { migrateLocalSqlitePath } = require('../dist/migration/migration.js');

const NOW = 1_800_000_000_000;
const EVENT_ID = '018f0000-0000-7000-8000-000000000001';

function seed(client, runId = 'run-1', status = 'running') {
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
         "project_id", "subject_type", "subject_id", "version", "state",
         "role", "mutation_id", "changed_by_type", "changed_by_id",
         "created_at_ms"
       ) VALUES ('default', 'user', 'user-1', 1, 'active', 'operator',
                 'grant-operator', 'user', 'user-1', ?)`,
    )
    .run(NOW - 1_000);
  client
    .prepare(
      `INSERT INTO "Runs" (
         "id", "project_id", "task_id", "task_revision", "trigger_type",
         "execution_origin", "execution_owner", "status", "version",
         "event_sequence", "priority", "created_at_ms"
       ) VALUES (?, 'default', 'task-1', 'revision-1', 'manual', 'manual',
                 'runtime', ?, 1, 0, 0, ?)`,
    )
    .run(runId, status, NOW - 500);
}

function command(overrides = {}) {
  return {
    projectId: 'default',
    runId: 'run-1',
    mutationId: 'mutation-1',
    eventId: EVENT_ID,
    subject: { type: 'user', id: 'user-1' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    ...overrides,
  };
}

function auditedCommand(overrides = {}) {
  const now = Date.now();
  return {
    projectId: 'default',
    runId: 'run-1',
    mutationId: '018f0000-0000-4000-8000-000000000010',
    eventId: '018f0000-0000-4000-8000-000000000011',
    requestId: 'local-run-stop-request',
    auditEventId: '018f0000-0000-4000-8000-000000000012',
    principal: {
      subject: { type: 'user', id: 'user-1' },
      authenticationId: 'local-console:run-stop',
      authenticatedAtMs: now - 1_000,
      expiresAtMs: now + 60_000,
      assurance: 'local_console',
    },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    ...overrides,
  };
}

async function fixture(t, status = 'running') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-run-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  const client = new DatabaseSync(databasePath);
  client.exec('PRAGMA foreign_keys = ON');
  seed(client, 'run-1', status);
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  return {
    client,
    authority,
    repository: new LocalSqliteRunCancellationRepository(authority, () => NOW),
  };
}

test('atomically publishes one durable cancellation intent and exact replay', async (t) => {
  const { client, repository } = await fixture(t);
  assert.deepEqual(await repository.requestUserCancellation(command()), {
    status: 'accepted',
    projectId: 'default',
    runId: 'run-1',
    runStatus: 'running',
    runVersion: 2,
    eventSequence: 1,
    cancelRequestedAtMs: NOW,
    cancelReason: 'user',
  });
  assert.equal(
    (
      await repository.requestUserCancellation(
        command({ eventId: '018f0000-0000-7000-8000-000000000002' }),
      )
    ).status,
    'already_requested',
  );
  assert.deepEqual(
    client
      .prepare(
        `SELECT "type", "dedupe_key" AS "dedupeKey", "actor_type" AS "actorType"
         FROM "RunEvents" WHERE "run_id" = 'run-1'`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        type: 'run.cancel_requested',
        dedupeKey: 'user-cancel:mutation-1',
        actorType: 'user',
      },
    ],
  );
});

test('atomically binds strong management cancellation to one allowed audit', async (t) => {
  const { authority, client } = await fixture(t);
  let fenceChecks = 0;
  const repository = new LocalSqliteRunCancellationRepository(
    authority,
    Date.now,
    {
      beforeMutation(subject) {
        assert.deepEqual(subject, { type: 'user', id: 'user-1' });
        fenceChecks += 1;
      },
    },
  );
  const value = auditedCommand();
  const accepted = await repository.requestUserCancellationAudited(value);
  assert.equal(accepted.status, 'accepted');
  assert.equal(
    (await repository.requestUserCancellationAudited(value)).status,
    'already_requested',
  );
  assert.equal(fenceChecks, 2);
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT "operation_id" AS "operationId", outcome, reasons_json AS "reasonsJson"
           FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
        )
        .get(value.auditEventId),
    },
    {
      operationId: 'run.stop',
      outcome: 'allowed',
      reasonsJson: '["role_grant","strong_authentication"]',
    },
  );
});

test('rolls cancellation back when the authenticated credential fence changes', async (t) => {
  const { authority, client } = await fixture(t);
  const repository = new LocalSqliteRunCancellationRepository(
    authority,
    Date.now,
    {
      beforeMutation() {
        throw new Error('credential changed');
      },
    },
  );
  await assert.rejects(
    repository.requestUserCancellationAudited(auditedCommand()),
    (error) =>
      error instanceof RunCancellationFenceRejectedError &&
      error.reason === 'authorization_changed',
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT "cancel_requested_at_ms" AS "cancelRequestedAtMs",
                  (SELECT count(*) FROM "QingLong3SecurityAuditEvents") AS audits
           FROM "Runs" WHERE "id" = 'run-1'`,
        )
        .get(),
    },
    { cancelRequestedAtMs: null, audits: 0 },
  );
});

test('returns terminal and masks missing or cross-Project Runs', async (t) => {
  const { repository } = await fixture(t, 'succeeded');
  assert.deepEqual(await repository.requestUserCancellation(command()), {
    status: 'already_terminal',
    projectId: 'default',
    runId: 'run-1',
    runStatus: 'succeeded',
    runVersion: 1,
    eventSequence: 0,
  });
  await assert.rejects(
    repository.requestUserCancellation(command({ runId: 'missing' })),
    RunCancellationNotFoundError,
  );
  await assert.rejects(
    repository.requestUserCancellation(command({ projectId: 'other' })),
    RunCancellationNotFoundError,
  );
});

test('revalidates the latest RoleBinding inside the mutation transaction', async (t) => {
  const { client, repository } = await fixture(t);
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
         "project_id", "subject_type", "subject_id", "version", "state",
         "role", "mutation_id", "changed_by_type", "changed_by_id",
         "created_at_ms"
       ) VALUES ('default', 'user', 'user-1', 2, 'revoked', NULL,
                 'revoke-operator', 'user', 'user-1', ?)`,
    )
    .run(NOW - 100);
  await assert.rejects(
    repository.requestUserCancellation(command()),
    (error) =>
      error instanceof RunCancellationFenceRejectedError &&
      error.reason === 'authorization_changed',
  );
  assert.equal(
    client
      .prepare(
        `SELECT "cancel_requested_at_ms" AS value FROM "Runs" WHERE "id" = 'run-1'`,
      )
      .get().value,
    null,
  );
});

test('rolls back the Run mutation when Event persistence fails', async (t) => {
  const { client, repository } = await fixture(t);
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         "id", "run_id", "sequence", "type", "dedupe_key", "actor_type",
         "payload", "created_at_ms"
       ) VALUES (?, 'run-1', 1, 'run.started', 'existing', 'system', '{}', ?)`,
    )
    .run(EVENT_ID, NOW - 1);
  await assert.rejects(
    repository.requestUserCancellation(command()),
    RunCancellationUnavailableError,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT "version", "event_sequence" AS "eventSequence",
                  "cancel_requested_at_ms" AS "cancelRequestedAtMs"
           FROM "Runs" WHERE "id" = 'run-1'`,
        )
        .get(),
    },
    { version: 1, eventSequence: 0, cancelRequestedAtMs: null },
  );
});
