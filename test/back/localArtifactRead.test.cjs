require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
  runSchemaMigration,
} = require('../../back/migrations/0002-run-schema');
const {
  LOCAL_ARTIFACT_RETENTION_TABLE,
  localArtifactRetentionMigration,
} = require('../../back/migrations/0015-local-artifact-retention');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LocalArtifactByteRangeReader,
  UnsafeLocalArtifactReadTargetError,
} = require('../../back/runtime/adapters/fs/localArtifactByteRangeReader');
const {
  LocalArtifactTruncationFactStore,
  localArtifactTruncationFactFileName,
} = require('../../back/runtime/adapters/fs/localArtifactTruncationFactStore');
const {
  LegacySequelizeLocalArtifactReadMetadataRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/localArtifactReadMetadataRepository');
const {
  LocalArtifactReadEvidenceConflictError,
  LocalArtifactReadService,
} = require('../../back/runtime/application/localArtifactReadService');
const {
  MAX_LOCAL_ARTIFACT_READ_BYTES,
} = require('../../back/runtime/domain/artifactRead');
const {
  encodeLocalArtifactTruncationFact,
} = require('../../back/runtime/domain/localArtifactTruncation');

const RUN_ID = '019f7600-0000-7000-8000-000000000001';
const ATTEMPT_ID = '019f7600-0000-7000-8000-000000000002';
const LOG_ARTIFACT_ID = `local-${'e'.repeat(30)}`;
const PROJECT_ID = 'project-a';
const SUBJECT = Object.freeze({ type: 'user', id: 'user-1' });
const RANGE = Object.freeze({ offset: 2, length: 4 });
const METADATA = Object.freeze({
  projectId: PROJECT_ID,
  runId: RUN_ID,
  attemptId: ATTEMPT_ID,
  logArtifactId: LOG_ARTIFACT_ID,
});

function request(overrides = {}) {
  return {
    subject: SUBJECT,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    logArtifactId: LOG_ARTIFACT_ID,
    range: RANGE,
    ...overrides,
  };
}

async function temporaryArtifactRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql3-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  return root;
}

async function writeArtifact(root, value = '0123456789') {
  const directory = path.join(root, LOG_ARTIFACT_ID.slice(6, 8));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${LOG_ARTIFACT_ID}.log`);
  await fs.writeFile(target, value, { mode: 0o600 });
  return { directory, target };
}

function fact(quotaReached) {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    logArtifactId: LOG_ARTIFACT_ID,
    maximumBytes: 64 * 1024,
    quotaReached,
    observedAtMs: 1_800_000_000_000,
  };
}

function service(overrides = {}) {
  return new LocalArtifactReadService(
    overrides.metadata ?? {
      async find() {
        return METADATA;
      },
    },
    overrides.authorizer ?? {
      async authorize() {
        return 'allow';
      },
    },
    overrides.bytes ?? {
      async read() {
        return {
          status: 'available',
          content: Buffer.from('2345'),
          start: 2,
          endExclusive: 6,
          totalBytes: 10,
          nextOffset: 6,
        };
      },
    },
    overrides.facts ?? {
      async read() {
        return null;
      },
    },
  );
}

test('validates bounded range before metadata or policy side effects', async () => {
  const calls = [];
  const reader = service({
    metadata: {
      async find() {
        calls.push('metadata');
        return METADATA;
      },
    },
    authorizer: {
      async authorize() {
        calls.push('authorize');
        return 'allow';
      },
    },
    bytes: {
      async read() {
        calls.push('bytes');
        return { status: 'missing' };
      },
    },
    facts: {
      async read() {
        calls.push('facts');
        return null;
      },
    },
  });
  await assert.rejects(
    reader.read(
      request({
        range: { offset: 0, length: MAX_LOCAL_ARTIFACT_READ_BYTES + 1 },
      }),
    ),
    /length is invalid/,
  );
  assert.deepEqual(calls, []);
});

test('never touches file or truncation evidence before artifact.read allows it', async () => {
  const calls = [];
  const reader = service({
    metadata: {
      async find(input) {
        calls.push(['metadata', input]);
        return METADATA;
      },
    },
    authorizer: {
      async authorize(input) {
        calls.push(['authorize', input]);
        return 'deny';
      },
    },
    bytes: {
      async read() {
        calls.push(['bytes']);
        throw new Error('must not read');
      },
    },
    facts: {
      async read() {
        calls.push(['facts']);
        throw new Error('must not read');
      },
    },
  });
  assert.deepEqual(await reader.read(request()), {
    status: 'forbidden',
    effect: 'deny',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'metadata');
  assert.deepEqual(calls[1], [
    'authorize',
    {
      action: 'artifact.read',
      subject: SUBJECT,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    },
  ]);
});

test('returns not_found without policy or file probes for an unbound Artifact', async () => {
  const calls = [];
  const reader = service({
    metadata: {
      async find() {
        calls.push('metadata');
        return null;
      },
    },
    authorizer: {
      async authorize() {
        calls.push('authorize');
        return 'allow';
      },
    },
    bytes: {
      async read() {
        calls.push('bytes');
        return { status: 'missing' };
      },
    },
    facts: {
      async read() {
        calls.push('facts');
        return null;
      },
    },
  });
  assert.deepEqual(await reader.read(request()), { status: 'not_found' });
  assert.deepEqual(calls, ['metadata']);
});

test('reads a bounded file snapshot and preserves true, false and unknown truncation', async (t) => {
  const root = await temporaryArtifactRoot(t);
  const { directory } = await writeArtifact(root);
  const bytes = new LocalArtifactByteRangeReader(root);
  const facts = new LocalArtifactTruncationFactStore(root);
  const factTarget = path.join(
    directory,
    localArtifactTruncationFactFileName(LOG_ARTIFACT_ID),
  );

  const reader = service({ bytes, facts });
  const unknown = await reader.read(request());
  assert.equal(unknown.status, 'available');
  assert.equal(unknown.content.toString(), '2345');
  assert.deepEqual(
    {
      start: unknown.start,
      endExclusive: unknown.endExclusive,
      totalBytes: unknown.totalBytes,
      nextOffset: unknown.nextOffset,
      truncation: unknown.truncation,
    },
    {
      start: 2,
      endExclusive: 6,
      totalBytes: 10,
      nextOffset: 6,
      truncation: { truncated: 'unknown' },
    },
  );

  for (const quotaReached of [false, true]) {
    await fs.writeFile(
      factTarget,
      encodeLocalArtifactTruncationFact(fact(quotaReached)),
      { mode: 0o600 },
    );
    const result = await reader.read(request());
    assert.deepEqual(result.truncation, {
      truncated: quotaReached,
      maximumBytes: 64 * 1024,
      observedAtMs: 1_800_000_000_000,
    });
  }
});

test('returns retained without touching files and resolves an ENOENT retirement race', async () => {
  const retention = Object.freeze({
    disposition: 'deleted',
    finishedAtMs: 100,
    eligibleAtMs: 200,
    bytesReclaimed: 10,
    recordedAtMs: 300,
  });
  let fileReads = 0;
  let factReads = 0;
  const alreadyRetained = service({
    metadata: {
      async find() {
        return { ...METADATA, retention };
      },
    },
    bytes: {
      async read() {
        fileReads += 1;
        return { status: 'missing' };
      },
    },
    facts: {
      async read() {
        factReads += 1;
        return null;
      },
    },
  });
  const retained = await alreadyRetained.read(request());
  assert.equal(retained.status, 'retained');
  assert.deepEqual(retained.retention, retention);
  assert.deepEqual(retained.truncation, { truncated: 'unknown' });
  assert.equal(fileReads, 0);
  assert.equal(factReads, 0);

  let lookups = 0;
  const raced = service({
    metadata: {
      async find() {
        lookups += 1;
        return lookups === 1 ? METADATA : { ...METADATA, retention };
      },
    },
    bytes: {
      async read() {
        fileReads += 1;
        return { status: 'missing' };
      },
    },
    facts: {
      async read() {
        factReads += 1;
        return null;
      },
    },
  });
  assert.equal((await raced.read(request())).status, 'retained');
  assert.equal(lookups, 2);
  assert.equal(fileReads, 1);
  assert.equal(factReads, 0);
});

test('distinguishes unexplained missing content and rejects drifted fact identity', async () => {
  const missing = service({
    bytes: {
      async read() {
        return { status: 'missing' };
      },
    },
    facts: {
      async read() {
        return fact(true);
      },
    },
  });
  const result = await missing.read(request());
  assert.equal(result.status, 'missing');
  assert.deepEqual(result.truncation, {
    truncated: true,
    maximumBytes: 64 * 1024,
    observedAtMs: 1_800_000_000_000,
  });

  const drifted = service({
    facts: {
      async read() {
        return {
          ...fact(false),
          attemptId: '019f7600-0000-7000-8000-000000000099',
        };
      },
    },
  });
  await assert.rejects(
    drifted.read(request()),
    LocalArtifactReadEvidenceConflictError,
  );
});

test('file reader refuses symlink files and shard escapes', async (t) => {
  const root = await temporaryArtifactRoot(t);
  const directory = path.join(root, LOG_ARTIFACT_ID.slice(6, 8));
  await fs.mkdir(directory, { mode: 0o700 });
  const outside = path.join(root, 'outside.log');
  await fs.writeFile(outside, 'outside');
  const target = path.join(directory, `${LOG_ARTIFACT_ID}.log`);
  await fs.symlink(outside, target);
  const reader = new LocalArtifactByteRangeReader(root);
  await assert.rejects(
    reader.read(LOG_ARTIFACT_ID, RANGE),
    UnsafeLocalArtifactReadTargetError,
  );
  await fs.unlink(target);
  await fs.rmdir(directory);
  await fs.symlink(path.dirname(outside), directory);
  await assert.rejects(
    reader.read(LOG_ARTIFACT_ID, RANGE),
    UnsafeLocalArtifactReadTargetError,
  );
});

async function setupDatabase(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [runSchemaMigration, localArtifactRetentionMigration],
    logger: { info() {} },
  });
  return database;
}

async function seedMetadata(database, overrides = {}) {
  const values = {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    logArtifactId: LOG_ARTIFACT_ID,
    executionOwner: 'runtime',
    executorType: 'local_process',
    ...overrides,
  };
  const query = database.getQueryInterface();
  await query.bulkInsert(RUN_TABLE, [
    {
      id: values.runId,
      project_id: values.projectId,
      task_id: 'task-1',
      task_revision: 'revision-1',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: values.executionOwner,
      status: 'succeeded',
      version: 1,
      event_sequence: 1,
      priority: 0,
      created_at_ms: 1,
      finished_at_ms: 100,
    },
  ]);
  await query.bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: values.attemptId,
      run_id: values.runId,
      attempt: 1,
      status: 'succeeded',
      executor_type: values.executorType,
      log_artifact_id: values.logArtifactId,
      callback_sequence: 0,
      created_at_ms: 1,
      finished_at_ms: 100,
    },
  ]);
  return values;
}

test('SQLite metadata binds project, runtime owner, local executor and tombstone', async (t) => {
  const database = await setupDatabase(t);
  const values = await seedMetadata(database);
  const repository = new LegacySequelizeLocalArtifactReadMetadataRepository(
    database,
  );
  assert.equal(
    await repository.find({
      projectId: 'other-project',
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
    null,
  );
  assert.deepEqual(
    await repository.find({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
    METADATA,
  );
  await database
    .getQueryInterface()
    .bulkInsert(LOCAL_ARTIFACT_RETENTION_TABLE, [
      {
        attempt_id: values.attemptId,
        log_artifact_id: values.logArtifactId,
        finished_at_ms: 100,
        eligible_at_ms: 200,
        disposition: 'deleted',
        bytes_reclaimed: 10,
        recorded_at_ms: 300,
      },
    ]);
  const retained = await repository.find({
    projectId: PROJECT_ID,
    runId: RUN_ID,
    logArtifactId: LOG_ARTIFACT_ID,
  });
  assert.deepEqual(retained.retention, {
    disposition: 'deleted',
    finishedAtMs: 100,
    eligibleAtMs: 200,
    bytesReclaimed: 10,
    recordedAtMs: 300,
  });
});

test('SQLite metadata excludes legacy owner and non-local executor', async (t) => {
  const legacyDatabase = await setupDatabase(t);
  await seedMetadata(legacyDatabase, { executionOwner: 'legacy' });
  const legacy = new LegacySequelizeLocalArtifactReadMetadataRepository(
    legacyDatabase,
  );
  assert.equal(
    await legacy.find({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
    null,
  );

  const remoteDatabase = await setupDatabase(t);
  await seedMetadata(remoteDatabase, { executorType: 'remote_worker' });
  const remote = new LegacySequelizeLocalArtifactReadMetadataRepository(
    remoteDatabase,
  );
  assert.equal(
    await remote.find({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
    null,
  );
});

test('SQLite metadata rejects a tombstone bound to a different Artifact', async (t) => {
  const database = await setupDatabase(t);
  const values = await seedMetadata(database);
  await database
    .getQueryInterface()
    .bulkInsert(LOCAL_ARTIFACT_RETENTION_TABLE, [
      {
        attempt_id: values.attemptId,
        log_artifact_id: `local-${'f'.repeat(30)}`,
        finished_at_ms: 100,
        eligible_at_ms: 200,
        disposition: 'already_absent',
        bytes_reclaimed: 0,
        recorded_at_ms: 300,
      },
    ]);
  const repository = new LegacySequelizeLocalArtifactReadMetadataRepository(
    database,
  );
  await assert.rejects(
    repository.find({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
    /metadata is corrupt or ambiguous/,
  );
});

test('SQLite metadata rejects a tombstone with drifted Attempt completion time', async (t) => {
  const database = await setupDatabase(t);
  const values = await seedMetadata(database);
  await database
    .getQueryInterface()
    .bulkInsert(LOCAL_ARTIFACT_RETENTION_TABLE, [
      {
        attempt_id: values.attemptId,
        log_artifact_id: values.logArtifactId,
        finished_at_ms: 101,
        eligible_at_ms: 200,
        disposition: 'deleted',
        bytes_reclaimed: 10,
        recorded_at_ms: 300,
      },
    ]);
  const repository = new LegacySequelizeLocalArtifactReadMetadataRepository(
    database,
  );
  await assert.rejects(
    repository.find({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      logArtifactId: LOG_ARTIFACT_ID,
    }),
    /metadata is corrupt or ambiguous/,
  );
});
