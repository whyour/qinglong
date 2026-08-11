require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
  runSchemaMigration,
} = require('../../back/migrations/0002-run-schema');
const {
  COMPLETION_RECEIPT_JOURNAL_TABLE,
  completionReceiptJournalMigration,
} = require('../../back/migrations/0007-completion-receipt-journal');
const {
  LOCAL_ARTIFACT_RETENTION_TABLE,
  localArtifactRetentionMigration,
} = require('../../back/migrations/0015-local-artifact-retention');
const {
  LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
  localArtifactMaintenanceCursorMigration,
} = require('../../back/migrations/0016-local-artifact-maintenance-cursor');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LocalArtifactFileRetirementStore,
  UnsafeLocalArtifactRetirementError,
} = require('../../back/runtime/adapters/fs/localArtifactFileRetirementStore');
const {
  LegacySequelizeLocalArtifactRetentionRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/localArtifactRetentionRepository');
const {
  LegacySequelizeLocalArtifactRetentionCheckpointStore,
} = require('../../back/runtime/adapters/legacy-sequelize/localArtifactRetentionCheckpointStore');
const {
  LocalArtifactRetentionService,
} = require('../../back/runtime/application/localArtifactRetentionService');
const {
  localExecutionArtifactId,
} = require('../../back/runtime/domain/localExecutionArtifact');
const {
  encodeLocalArtifactTruncationFact,
} = require('../../back/runtime/domain/localArtifactTruncation');

const DAY_MS = 24 * 60 * 60_000;
const OBSERVED_AT_MS = 1_800_000_000_000;

function identity(index) {
  const suffix = String(index).padStart(12, '0');
  return {
    runId: `019f7400-0000-7000-8000-${suffix}`,
    attemptId: `019f7401-0000-7000-8000-${suffix}`,
  };
}

function artifactId(index) {
  const ids = identity(index);
  return localExecutionArtifactId({
    ...ids,
    projectId: 'default',
    taskId: `task-${index}`,
    taskRevision: 'revision-1',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1,
    attemptCreatedAtMs: 1,
  });
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-retention-'));
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true, mode: 0o700 });
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      runSchemaMigration,
      completionReceiptJournalMigration,
      localArtifactRetentionMigration,
      localArtifactMaintenanceCursorMigration,
    ],
    logger: { info() {} },
  });
  return {
    root,
    artifacts,
    database,
    repository: new LegacySequelizeLocalArtifactRetentionRepository(database),
    checkpoints: new LegacySequelizeLocalArtifactRetentionCheckpointStore(
      database,
    ),
    files: new LocalArtifactFileRetirementStore(artifacts),
  };
}

async function seedAttempt(
  context,
  index,
  {
    finishedAtMs = OBSERVED_AT_MS - 10 * DAY_MS,
    runStatus = 'succeeded',
    attemptStatus = 'succeeded',
    executionOwner = 'runtime',
    executorType = 'local_process',
    logArtifactId = artifactId(index),
  } = {},
) {
  const ids = identity(index);
  const query = context.database.getQueryInterface();
  await query.bulkInsert(RUN_TABLE, [
    {
      id: ids.runId,
      project_id: 'default',
      task_id: `task-${index}`,
      task_revision: 'revision-1',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: executionOwner,
      status: runStatus,
      version: 1,
      event_sequence: 1,
      priority: 0,
      created_at_ms: finishedAtMs - 1_000,
      finished_at_ms: runStatus === 'running' ? null : finishedAtMs,
    },
  ]);
  await query.bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: ids.attemptId,
      run_id: ids.runId,
      attempt: 1,
      status: attemptStatus,
      executor_type: executorType,
      log_artifact_id: logArtifactId,
      callback_sequence: 0,
      created_at_ms: finishedAtMs - 1_000,
      finished_at_ms: attemptStatus === 'running' ? null : finishedAtMs,
    },
  ]);
  return { ...ids, logArtifactId, finishedAtMs };
}

async function writeArtifact(context, logArtifactId, value = 'artifact-value') {
  const directory = path.join(context.artifacts, logArtifactId.slice(6, 8));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${logArtifactId}.log`);
  await fs.writeFile(target, value, { mode: 0o600 });
  return { directory, target, bytes: Buffer.byteLength(value) };
}

function retentionService(context, overrides = {}) {
  return new LocalArtifactRetentionService(
    overrides.repository ?? context.repository,
    overrides.files ?? context.files,
    overrides.capacity ?? {
      async inspect() {
        return {
          availableBytes: BigInt(1024 * 1024),
          totalBytes: BigInt(2 * 1024 * 1024),
        };
      },
    },
    {
      normalRetentionMs: overrides.normalRetentionMs ?? 7 * DAY_MS,
      pressureRetentionMs: overrides.pressureRetentionMs ?? DAY_MS,
      minimumFreeBytes: overrides.minimumFreeBytes ?? 64 * 1024,
      pageSize: overrides.pageSize ?? 16,
      maximumDeletions: overrides.maximumDeletions ?? 8,
      clock: { now: () => OBSERVED_AT_MS },
    },
  );
}

test('selects only settled runtime-owned terminal local Artifacts', async (t) => {
  const context = await setup(t);
  const eligible = await seedAttempt(context, 1);
  await seedAttempt(context, 2, { runStatus: 'running' });
  await seedAttempt(context, 3, { attemptStatus: 'running' });
  await seedAttempt(context, 4, { executionOwner: 'legacy' });
  await seedAttempt(context, 5, { executorType: 'docker' });
  await seedAttempt(context, 6, { logArtifactId: 'legacy-log-not-local' });
  const receiptBlocked = await seedAttempt(context, 7);
  await seedAttempt(context, 8, {
    runStatus: 'lost',
    attemptStatus: 'lost',
  });
  await context.database
    .getQueryInterface()
    .bulkInsert(COMPLETION_RECEIPT_JOURNAL_TABLE, [
      {
        attempt_id: receiptBlocked.attemptId,
        run_id: receiptBlocked.runId,
        state: 'pending',
        registered_at_ms: 1,
        updated_at_ms: 1,
      },
    ]);

  const page = await context.repository.list({
    cutoffMs: OBSERVED_AT_MS - 7 * DAY_MS,
    limit: 16,
  });
  assert.deepEqual(page.candidates, [
    {
      attemptId: eligible.attemptId,
      logArtifactId: eligible.logArtifactId,
      finishedAtMs: eligible.finishedAtMs,
    },
  ]);
  await context.database
    .getQueryInterface()
    .bulkDelete(COMPLETION_RECEIPT_JOURNAL_TABLE, {
      attempt_id: receiptBlocked.attemptId,
    });
  assert.equal(
    (await context.repository.list({ cutoffMs: OBSERVED_AT_MS, limit: 16 }))
      .candidates.length,
    2,
  );
});

test('uses pressure retention, deletes durably, and records an immutable tombstone', async (t) => {
  const context = await setup(t);
  const candidate = await seedAttempt(context, 1, {
    finishedAtMs: OBSERVED_AT_MS - 2 * DAY_MS,
  });
  const artifact = await writeArtifact(context, candidate.logArtifactId);
  const normal = await retentionService(context).sweep();
  assert.equal(normal.pressure, false);
  assert.equal(normal.candidatesScanned, 0);
  assert.equal((await fs.stat(artifact.target)).size, artifact.bytes);

  const pressure = retentionService(context, {
    capacity: {
      async inspect() {
        return { availableBytes: BigInt(1), totalBytes: BigInt(1024) };
      },
    },
  });
  const result = await pressure.sweep();
  assert.deepEqual(
    {
      status: result.status,
      pressure: result.pressure,
      retentionMs: result.retentionMs,
      recordsWritten: result.recordsWritten,
      bytesReclaimed: result.bytesReclaimed,
    },
    {
      status: 'complete',
      pressure: true,
      retentionMs: DAY_MS,
      recordsWritten: 1,
      bytesReclaimed: artifact.bytes,
    },
  );
  await assert.rejects(fs.lstat(artifact.target), /ENOENT/);
  const tombstone = await context.database
    .getQueryInterface()
    .select(null, LOCAL_ARTIFACT_RETENTION_TABLE, {
      where: { attempt_id: candidate.attemptId },
      plain: true,
    });
  assert.equal(tombstone.disposition, 'deleted');
  assert.equal(Number(tombstone.bytes_reclaimed), artifact.bytes);
  assert.equal((await pressure.sweep()).candidatesScanned, 0);
});

test('recovers a crash between file deletion and tombstone persistence', async (t) => {
  const context = await setup(t);
  const candidate = await seedAttempt(context, 1);
  const artifact = await writeArtifact(context, candidate.logArtifactId);
  let recordCalls = 0;
  const crashing = retentionService(context, {
    repository: {
      list: (options) => context.repository.list(options),
      async record() {
        recordCalls += 1;
        throw new Error('simulated database outage');
      },
    },
  });
  const failed = await crashing.sweep();
  assert.equal(failed.entries[0].outcome, 'record_failed');
  assert.equal(failed.entries[0].bytesReclaimed, artifact.bytes);
  assert.equal(recordCalls, 1);
  await assert.rejects(fs.lstat(artifact.target), /ENOENT/);

  const recovered = await retentionService(context).sweep();
  assert.equal(recovered.entries[0].outcome, 'already_absent');
  assert.equal(recovered.recordsWritten, 1);
  assert.equal(
    await context.database
      .getQueryInterface()
      .rawSelect(
        LOCAL_ARTIFACT_RETENTION_TABLE,
        { where: { attempt_id: candidate.attemptId } },
        ['disposition'],
      ),
    'already_absent',
  );
});

test('enforces a deletion budget and resumes from a stable cursor', async (t) => {
  const context = await setup(t);
  for (let index = 1; index <= 3; index += 1) {
    const candidate = await seedAttempt(context, index);
    await writeArtifact(context, candidate.logArtifactId, `artifact-${index}`);
  }
  const service = retentionService(context, {
    pageSize: 3,
    maximumDeletions: 2,
  });
  const first = await service.sweep();
  assert.equal(first.status, 'deletion_budget_exhausted');
  assert.equal(first.recordsWritten, 2);
  assert.deepEqual(first.nextCursor, {
    finishedAtMs: OBSERVED_AT_MS - 10 * DAY_MS,
    attemptId: identity(2).attemptId,
  });
  const second = await service.sweep(first.nextCursor);
  assert.equal(second.status, 'complete');
  assert.equal(second.recordsWritten, 1);
  const [count] = await context.database.query(
    `SELECT COUNT(*) AS count FROM "${LOCAL_ARTIFACT_RETENTION_TABLE}"`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(count.count, 3);
});

test('removes a stale quota FIFO but refuses symlink or non-file targets', async (t) => {
  const context = await setup(t);
  const logArtifactId = artifactId(1);
  const artifact = await writeArtifact(context, logArtifactId);
  const fifo = path.join(artifact.directory, `.${logArtifactId}.log.fifo`);
  await new Promise((resolve, reject) => {
    require('node:child_process').execFile(
      'mkfifo',
      ['-m', '600', fifo],
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const truncation = path.join(
    artifact.directory,
    `.${logArtifactId}.log.truncated.json`,
  );
  const truncationTemporary = path.join(
    artifact.directory,
    `.${logArtifactId}.log.truncated.tmp`,
  );
  await fs.writeFile(
    truncation,
    encodeLocalArtifactTruncationFact({
      schemaVersion: 1,
      ...identity(1),
      logArtifactId,
      maximumBytes: 64 * 1024,
      quotaReached: true,
      observedAtMs: OBSERVED_AT_MS,
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(truncationTemporary, 'partial', { mode: 0o600 });
  assert.equal(
    (await context.files.retire(logArtifactId)).disposition,
    'deleted',
  );
  await assert.rejects(fs.lstat(fifo), /ENOENT/);
  await assert.rejects(fs.lstat(truncation), /ENOENT/);
  await assert.rejects(fs.lstat(truncationTemporary), /ENOENT/);

  const outside = path.join(context.root, 'outside');
  await fs.writeFile(outside, 'outside');
  await fs.writeFile(artifact.target, 'replacement');
  await fs.unlink(artifact.target);
  await fs.symlink(outside, artifact.target);
  await assert.rejects(
    context.files.retire(logArtifactId),
    UnsafeLocalArtifactRetirementError,
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
});

test('treats a missing Artifact shard as already absent', async (t) => {
  const context = await setup(t);
  assert.deepEqual(await context.files.retire(artifactId(1)), {
    disposition: 'already_absent',
    bytesReclaimed: 0,
  });
});

test('rejects invalid capacity and pages before touching Artifact files', async (t) => {
  const context = await setup(t);
  const candidate = await seedAttempt(context, 1);
  const artifact = await writeArtifact(context, candidate.logArtifactId);
  let retireCalls = 0;
  const files = {
    async retire() {
      retireCalls += 1;
      return { disposition: 'deleted', bytesReclaimed: artifact.bytes };
    },
  };
  await assert.rejects(
    retentionService(context, {
      files,
      capacity: {
        async inspect() {
          return { availableBytes: BigInt(2), totalBytes: BigInt(1) };
        },
      },
    }).sweep(),
    /capacity snapshot is invalid/,
  );
  assert.equal(retireCalls, 0);

  const invalidPage = retentionService(context, {
    files,
    repository: {
      async list() {
        return {
          candidates: [candidate],
          truncated: true,
        };
      },
      async record() {
        throw new Error('record must remain unreachable');
      },
    },
  });
  await assert.rejects(invalidPage.sweep(), /resume cursor is inconsistent/);
  assert.equal(retireCalls, 0);
  assert.equal((await fs.stat(artifact.target)).size, artifact.bytes);
});

test('persists and fences the retention resume cursor without idle rewrites', async (t) => {
  const context = await setup(t);
  const cursor = {
    finishedAtMs: OBSERVED_AT_MS - DAY_MS,
    attemptId: identity(1).attemptId,
  };
  assert.deepEqual(await context.checkpoints.load(), { version: 0 });
  assert.equal(
    await context.checkpoints.compareAndSet({
      expectedVersion: 0,
      cursor,
      updatedAtMs: OBSERVED_AT_MS,
    }),
    true,
  );
  assert.deepEqual(await context.checkpoints.load(), {
    version: 1,
    cursor,
  });
  assert.equal(
    await context.checkpoints.compareAndSet({
      expectedVersion: 0,
      updatedAtMs: OBSERVED_AT_MS,
    }),
    false,
  );
  assert.equal(
    await context.checkpoints.compareAndSet({
      expectedVersion: 1,
      updatedAtMs: OBSERVED_AT_MS + 1,
    }),
    true,
  );
  assert.deepEqual(await context.checkpoints.load(), { version: 2 });
  assert.equal(
    await context.database
      .getQueryInterface()
      .rawSelect(
        LOCAL_ARTIFACT_MAINTENANCE_CURSOR_TABLE,
        { where: { scope: 'retention' } },
        ['version'],
      ),
    2,
  );
});

test('serializes concurrent initial cursor claims', async (t) => {
  const context = await setup(t);
  const competing = new LegacySequelizeLocalArtifactRetentionCheckpointStore(
    context.database,
  );
  const cursor = {
    finishedAtMs: OBSERVED_AT_MS - DAY_MS,
    attemptId: identity(1).attemptId,
  };
  const results = await Promise.all([
    context.checkpoints.compareAndSet({
      expectedVersion: 0,
      cursor,
      updatedAtMs: OBSERVED_AT_MS,
    }),
    competing.compareAndSet({
      expectedVersion: 0,
      cursor,
      updatedAtMs: OBSERVED_AT_MS,
    }),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.deepEqual(await context.checkpoints.load(), { version: 1, cursor });
});

test('refuses a symlink truncation fact before deleting its Artifact', async (t) => {
  const context = await setup(t);
  const logArtifactId = artifactId(1);
  const artifact = await writeArtifact(context, logArtifactId);
  const outside = path.join(context.root, 'outside-truncation');
  await fs.writeFile(outside, 'outside');
  const truncation = path.join(
    artifact.directory,
    `.${logArtifactId}.log.truncated.json`,
  );
  await fs.symlink(outside, truncation);
  await assert.rejects(
    context.files.retire(logArtifactId),
    UnsafeLocalArtifactRetirementError,
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
  assert.equal((await fs.stat(artifact.target)).size, artifact.bytes);
});

test('preserves the truncation fact when log deletion fails', async (t) => {
  const context = await setup(t);
  const logArtifactId = artifactId(1);
  const artifact = await writeArtifact(context, logArtifactId);
  const truncation = path.join(
    artifact.directory,
    `.${logArtifactId}.log.truncated.json`,
  );
  await fs.writeFile(
    truncation,
    encodeLocalArtifactTruncationFact({
      schemaVersion: 1,
      ...identity(1),
      logArtifactId,
      maximumBytes: 64 * 1024,
      quotaReached: true,
      observedAtMs: OBSERVED_AT_MS,
    }),
    { mode: 0o600 },
  );
  await fs.chmod(artifact.directory, 0o500);
  try {
    await assert.rejects(context.files.retire(logArtifactId));
  } finally {
    await fs.chmod(artifact.directory, 0o700);
  }
  assert.equal((await fs.stat(artifact.target)).size, artifact.bytes);
  assert.ok((await fs.stat(truncation)).isFile());
});
