const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createRunAttemptLogRetirementRecord,
  RunAttemptLogRetentionUnavailableError,
} = require('@qinglong/runtime-core/run-attempt-log-retention');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority.js');
const {
  migrateLocalSqliteDatabase,
} = require('../dist/migration/migration.js');
const {
  LocalSqliteRunAttemptLogRetentionRepository,
} = require('../dist/run/runAttemptLogRetentionRepository.js');

async function fixture() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  const authority = new LocalSqliteOperationAuthority(client);
  return {
    client,
    authority,
    repository: new LocalSqliteRunAttemptLogRetentionRepository(authority),
  };
}

function seed(client, index, overrides = {}) {
  const runId = `run_${index}`;
  const attemptId = `attempt_${index}`;
  const artifactId = `local-${index.toString(16).padStart(30, '0')}`;
  client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version, event_sequence,
         priority, created_at_ms, finished_at_ms
       ) VALUES (?, 'prj_default', 'task_1', 'revision_1', 'task_start',
                 'manual', 'runtime', ?, 1, 1, 0, 1, ?)`,
    )
    .run(
      runId,
      overrides.runStatus ?? 'succeeded',
      overrides.finishedAtMs ?? index,
    );
  client
    .prepare(
      `INSERT INTO "RunAttempts" (
         id, run_id, attempt, status, executor_type, log_artifact_id,
         callback_sequence, created_at_ms, finished_at_ms
       ) VALUES (?, ?, 1, ?, ?, ?, 0, 1, ?)`,
    )
    .run(
      attemptId,
      runId,
      overrides.attemptStatus ?? 'succeeded',
      overrides.executorType ?? 'local_process',
      artifactId,
      overrides.finishedAtMs ?? index,
    );
  return { runId, attemptId, artifactId };
}

test('lists only safe terminal Local candidates with a durable cursor', async () => {
  const { client, authority, repository } = await fixture();
  try {
    const one = seed(client, 1);
    const two = seed(client, 2, { attemptStatus: 'lost' });
    const three = seed(client, 3);
    client
      .prepare(
        `INSERT INTO "LocalCompletionReceiptJournal" (
           attempt_id, run_id, state, registered_at_ms, updated_at_ms
         ) VALUES (?, ?, 'pending', 1, 1)`,
      )
      .run(three.attemptId, three.runId);

    const page = await repository.list({ cutoffMs: 100, limit: 1 });
    assert.deepEqual(page.candidates, [
      {
        projectId: 'prj_default',
        runId: one.runId,
        attemptId: one.attemptId,
        logArtifactId: one.artifactId,
        executorType: 'local_process',
        finishedAtMs: 1,
      },
    ]);
    assert.equal(page.truncated, false);
    assert.equal(two.attemptId, 'attempt_2');

    await repository.saveCursor(
      { finishedAtMs: 1, attemptId: one.attemptId },
      101,
    );
    assert.deepEqual(await repository.loadCursor(), {
      finishedAtMs: 1,
      attemptId: one.attemptId,
    });
    await repository.saveCursor(undefined, 102);
    assert.equal(await repository.loadCursor(), undefined);
  } finally {
    await authority.close();
  }
});

test('records exact tombstones idempotently and exposes retired state', async () => {
  const { client, authority, repository } = await fixture();
  try {
    const value = seed(client, 1);
    const record = createRunAttemptLogRetirementRecord({
      projectId: 'prj_default',
      runId: value.runId,
      attemptId: value.attemptId,
      logArtifactId: value.artifactId,
      executorType: 'local_process',
      finishedAtMs: 1,
      eligibleAtMs: 2,
      retiredAtMs: 3,
      disposition: 'deleted',
      byteLength: 7,
      truncation: { truncated: false, maximumBytes: 1024, observedAtMs: 1 },
    });
    assert.equal(await repository.record(record), 'recorded');
    assert.equal(await repository.record(record), 'existing');
    assert.deepEqual(
      await repository.inspect({
        projectId: 'prj_default',
        runId: value.runId,
        attemptId: value.attemptId,
        logArtifactId: value.artifactId,
      }),
      { status: 'retired', record },
    );
    assert.deepEqual(await repository.list({ cutoffMs: 100, limit: 2 }), {
      candidates: [],
      truncated: false,
    });

    client
      .prepare(
        `UPDATE "QingLong3RunAttemptLogArtifactTombstones"
         SET record_digest = ? WHERE attempt_id = ?`,
      )
      .run('0'.repeat(64), value.attemptId);
    await assert.rejects(
      repository.inspect({
        projectId: 'prj_default',
        runId: value.runId,
        attemptId: value.attemptId,
        logArtifactId: value.artifactId,
      }),
      RunAttemptLogRetentionUnavailableError,
    );
  } finally {
    await authority.close();
  }
});

test('refuses to tombstone an attempt while a completion receipt exists', async () => {
  const { client, authority, repository } = await fixture();
  try {
    const value = seed(client, 1);
    client
      .prepare(
        `INSERT INTO "LocalCompletionReceiptJournal" (
           attempt_id, run_id, state, registered_at_ms, updated_at_ms
         ) VALUES (?, ?, 'pending', 1, 1)`,
      )
      .run(value.attemptId, value.runId);
    const record = createRunAttemptLogRetirementRecord({
      projectId: 'prj_default',
      runId: value.runId,
      attemptId: value.attemptId,
      logArtifactId: value.artifactId,
      executorType: 'local_process',
      finishedAtMs: 1,
      eligibleAtMs: 2,
      retiredAtMs: 3,
      disposition: 'already_absent',
      byteLength: 0,
      truncation: { truncated: 'unknown' },
    });
    await assert.rejects(
      repository.record(record),
      RunAttemptLogRetentionUnavailableError,
    );
  } finally {
    await authority.close();
  }
});
