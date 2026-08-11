require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const { DataTypes, QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  legacyColumnsMigration,
} = require('../../back/migrations/0001-legacy-columns');
const {
  RUN_ATTEMPT_TABLE,
  RUN_EVENT_TABLE,
  RUN_TABLE,
  runSchemaMigration,
} = require('../../back/migrations/0002-run-schema');
const {
  RUNNING_INSTANCE_ATTEMPT_INDEX,
  RUNNING_INSTANCE_RUN_INDEX,
  RUNNING_INSTANCE_TABLE,
  runningInstanceRunReferenceMigration,
} = require('../../back/migrations/0003-running-instance-run-reference');
const {
  RUN_CANCELLATION_REQUEST_INDEX,
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  RUN_CANCELLATION_DISPATCH_DUE_INDEX,
  RUN_CANCELLATION_DISPATCH_LEASE_INDEX,
  RUN_CANCELLATION_DISPATCH_TABLE,
  runCancellationDispatchMigration,
} = require('../../back/migrations/0005-run-cancellation-dispatch');
const {
  RUN_ATTEMPT_DEADLINE_INDEX,
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const {
  COMPLETION_RECEIPT_JOURNAL_PURGE_INDEX,
  COMPLETION_RECEIPT_JOURNAL_SCAN_INDEX,
  COMPLETION_RECEIPT_JOURNAL_TABLE,
  completionReceiptJournalMigration,
} = require('../../back/migrations/0007-completion-receipt-journal');
const {
  WORKER_REGISTRY_CAPACITY_INDEX,
  WORKER_REGISTRY_LEASE_INDEX,
  WORKER_REGISTRY_TABLE,
  workerRegistryMigration,
} = require('../../back/migrations/0008-worker-registry');
const {
  RUN_DISPATCH_LEASE_EXPIRY_INDEX,
  RUN_DISPATCH_LEASE_TABLE,
  RUN_DISPATCH_LEASE_TOKEN_INDEX,
  RUN_DISPATCH_LEASE_WORKER_INDEX,
  runDispatchLeaseMigration,
} = require('../../back/migrations/0009-run-dispatch-lease');
const { migrations } = require('../../back/migrations');
const { runMigrations } = require('../../back/migrations/runner');

const databases = [];

async function createDatabase() {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  const migrationModel = defineSchemaMigrationModel(database);
  databases.push(database);
  return { database, migrationModel };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

test('runs a migration once and records its checksum', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await queryInterface.createTable('Examples', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
  });

  let calls = 0;
  const migrations = [
    {
      id: '0001-example',
      checksum: 'checksum-v1',
      async up({ queryInterface, transaction }) {
        calls += 1;
        await queryInterface.addColumn(
          'Examples',
          'name',
          { type: DataTypes.STRING },
          { transaction },
        );
      },
    },
  ];

  const options = {
    database,
    migrationModel,
    migrations,
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const description = await queryInterface.describeTable('Examples');
  const applied = await migrationModel.findByPk('0001-example');
  assert.ok(description.name);
  assert.equal(calls, 1);
  assert.equal(applied.checksum, 'checksum-v1');
});

test('rejects a changed checksum for an applied migration', async () => {
  const { database, migrationModel } = await createDatabase();
  const baseOptions = {
    database,
    migrationModel,
    logger: { info() {} },
  };

  await runMigrations({
    ...baseOptions,
    migrations: [
      {
        id: '0001-example',
        checksum: 'checksum-v1',
        async up() {},
      },
    ],
  });

  await assert.rejects(
    runMigrations({
      ...baseOptions,
      migrations: [
        {
          id: '0001-example',
          checksum: 'checksum-v2',
          async up() {},
        },
      ],
    }),
    /Migration checksum mismatch/,
  );
});

test('rolls back the migration record when migration work fails', async () => {
  const { database, migrationModel } = await createDatabase();

  await assert.rejects(
    runMigrations({
      database,
      migrationModel,
      logger: { info() {} },
      migrations: [
        {
          id: '0001-failing',
          checksum: 'checksum-v1',
          async up() {
            throw new Error('migration failed');
          },
        },
      ],
    }),
    /migration failed/,
  );

  assert.equal(await migrationModel.count(), 0);
});

test('rejects duplicate migration ids before touching the database', async () => {
  const { database, migrationModel } = await createDatabase();
  const duplicate = {
    id: '0001-duplicate',
    checksum: 'checksum-v1',
    async up() {},
  };

  await assert.rejects(
    runMigrations({
      database,
      migrationModel,
      migrations: [duplicate, duplicate],
      logger: { info() {} },
    }),
    /Duplicate migration id/,
  );
});

test('upgrades the legacy QingLong tables without swallowing schema errors', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();

  for (const table of ['CrontabViews', 'Subscriptions', 'Crontabs', 'Envs']) {
    await queryInterface.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    });
  }

  const options = {
    database,
    migrationModel,
    migrations: [legacyColumnsMigration],
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const cronViews = await queryInterface.describeTable('CrontabViews');
  const subscriptions = await queryInterface.describeTable('Subscriptions');
  const crontabs = await queryInterface.describeTable('Crontabs');
  const envs = await queryInterface.describeTable('Envs');

  assert.ok(cronViews.filterRelation);
  assert.ok(cronViews.type);
  assert.ok(subscriptions.proxy);
  assert.ok(subscriptions.autoAddCron);
  assert.ok(subscriptions.autoDelCron);
  assert.ok(crontabs.sub_id);
  assert.ok(crontabs.extra_schedules);
  assert.ok(crontabs.task_before);
  assert.ok(crontabs.task_after);
  assert.ok(crontabs.log_name);
  assert.ok(crontabs.allow_multiple_instances);
  assert.ok(crontabs.work_dir);
  assert.ok(envs.isPinned);
  assert.ok(envs.labels);
  assert.equal(await migrationModel.count(), 1);
});

test('creates the Run aggregate schema with stable uniqueness constraints', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  const options = {
    database,
    migrationModel,
    migrations: [runSchemaMigration],
    logger: { info() {} },
  };

  await runMigrations(options);
  await runMigrations(options);

  const runs = await queryInterface.describeTable(RUN_TABLE);
  const attempts = await queryInterface.describeTable(RUN_ATTEMPT_TABLE);
  const events = await queryInterface.describeTable(RUN_EVENT_TABLE);

  for (const column of [
    'id',
    'project_id',
    'task_id',
    'task_revision',
    'legacy_cron_id',
    'execution_origin',
    'execution_owner',
    'status',
    'version',
    'event_sequence',
    'created_at_ms',
  ]) {
    assert.ok(runs[column], `missing Runs.${column}`);
  }
  for (const column of [
    'id',
    'run_id',
    'attempt',
    'status',
    'executor_type',
    'callback_token_hash',
    'callback_sequence',
    'created_at_ms',
  ]) {
    assert.ok(attempts[column], `missing RunAttempts.${column}`);
  }
  for (const column of [
    'id',
    'run_id',
    'sequence',
    'type',
    'dedupe_key',
    'actor_type',
    'payload',
    'created_at_ms',
  ]) {
    assert.ok(events[column], `missing RunEvents.${column}`);
  }

  const runId = '019f70a0-0000-7000-8000-000000000001';
  const attemptId = '019f70a0-0000-7000-8000-000000000002';
  const baseRun = {
    id: runId,
    project_id: 'default',
    task_id: 'legacy-cron:1',
    task_revision: 'revision-1',
    trigger_type: 'manual',
    execution_origin: 'manual',
    execution_owner: 'legacy',
    status: 'created',
    version: 0,
    event_sequence: 0,
    priority: 0,
    created_at_ms: 1_750_000_000_000,
  };

  await queryInterface.bulkInsert(RUN_TABLE, [
    { ...baseRun, idempotency_key: 'manual-request-1' },
  ]);
  await queryInterface.bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: attemptId,
      run_id: runId,
      attempt: 1,
      status: 'claimed',
      executor_type: 'legacy_local',
      callback_sequence: 0,
      created_at_ms: 1_750_000_000_000,
    },
  ]);
  await queryInterface.bulkInsert(RUN_EVENT_TABLE, [
    {
      id: '019f70a0-0000-7000-8000-000000000003',
      run_id: runId,
      sequence: 1,
      type: 'run.created',
      dedupe_key: 'create',
      actor_type: 'compatibility',
      attempt_id: attemptId,
      payload: JSON.stringify({ source: 'migration-test' }),
      created_at_ms: 1_750_000_000_000,
    },
  ]);

  await assert.rejects(
    queryInterface.bulkInsert(RUN_TABLE, [
      {
        ...baseRun,
        id: '019f70a0-0000-7000-8000-000000000004',
        idempotency_key: 'manual-request-1',
      },
    ]),
  );
  await assert.rejects(
    queryInterface.bulkInsert(RUN_TABLE, [
      {
        ...baseRun,
        id: '019f70a0-0000-7000-8000-000000000007',
        version: -1,
        idempotency_key: 'manual-request-2',
      },
    ]),
  );
  await assert.rejects(
    queryInterface.bulkInsert(RUN_ATTEMPT_TABLE, [
      {
        id: '019f70a0-0000-7000-8000-000000000005',
        run_id: runId,
        attempt: 1,
        status: 'claimed',
        executor_type: 'legacy_local',
        callback_sequence: 0,
        created_at_ms: 1_750_000_000_000,
      },
    ]),
  );
  await assert.rejects(
    queryInterface.bulkInsert(RUN_EVENT_TABLE, [
      {
        id: '019f70a0-0000-7000-8000-000000000006',
        run_id: runId,
        sequence: 2,
        type: 'run.created',
        dedupe_key: 'create',
        actor_type: 'compatibility',
        payload: '{}',
        created_at_ms: 1_750_000_000_001,
      },
    ]),
  );

  assert.equal(await migrationModel.count(), 1);
});

test('creates a bounded completion receipt journal linked to Run Attempts', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await runMigrations({
    database,
    migrationModel,
    migrations: [runSchemaMigration, completionReceiptJournalMigration],
    logger: { info() {} },
  });

  const columns = await queryInterface.describeTable(
    COMPLETION_RECEIPT_JOURNAL_TABLE,
  );
  for (const column of [
    'attempt_id',
    'run_id',
    'state',
    'quarantine_ref',
    'purge_after_ms',
    'registered_at_ms',
    'updated_at_ms',
  ]) {
    assert.ok(columns[column], `missing journal.${column}`);
  }
  const indexes = new Set(
    (await queryInterface.showIndex(COMPLETION_RECEIPT_JOURNAL_TABLE)).map(
      (index) => index.name,
    ),
  );
  assert.ok(indexes.has(COMPLETION_RECEIPT_JOURNAL_SCAN_INDEX));
  assert.ok(indexes.has(COMPLETION_RECEIPT_JOURNAL_PURGE_INDEX));

  await assert.rejects(
    queryInterface.bulkInsert(COMPLETION_RECEIPT_JOURNAL_TABLE, [
      {
        attempt_id: '019f70a0-0000-7000-8000-000000000099',
        run_id: '019f70a0-0000-7000-8000-000000000098',
        state: 'pending',
        registered_at_ms: 1,
        updated_at_ms: 1,
      },
    ]),
    /FOREIGN KEY|constraint/i,
  );
});

test('creates the durable fenced Worker registry and bounded lookup indexes', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await runMigrations({
    database,
    migrationModel,
    migrations: [workerRegistryMigration],
    logger: { info() {} },
  });

  const columns = await queryInterface.describeTable(WORKER_REGISTRY_TABLE);
  for (const column of [
    'id',
    'session_id',
    'generation',
    'status',
    'version',
    'capabilities_json',
    'capabilities_hash',
    'max_concurrent_runs',
    'available_slots',
    'registered_at_ms',
    'last_heartbeat_at_ms',
    'lease_expires_at_ms',
    'updated_at_ms',
  ]) {
    assert.ok(columns[column], `missing workers.${column}`);
  }
  const indexes = new Set(
    (await queryInterface.showIndex(WORKER_REGISTRY_TABLE)).map(
      (index) => index.name,
    ),
  );
  assert.ok(indexes.has(WORKER_REGISTRY_LEASE_INDEX));
  assert.ok(indexes.has(WORKER_REGISTRY_CAPACITY_INDEX));

  await assert.rejects(
    queryInterface.bulkInsert(WORKER_REGISTRY_TABLE, [
      {
        id: 'worker-invalid',
        session_id: '019f7500-0000-7000-8000-000000000001',
        generation: 0,
        status: 'online',
        version: 0,
        capabilities_json: '{}',
        capabilities_hash: 'a'.repeat(64),
        max_concurrent_runs: 1,
        available_slots: 1,
        registered_at_ms: 1,
        last_heartbeat_at_ms: 1,
        lease_expires_at_ms: 2,
        updated_at_ms: 1,
      },
    ]),
    /constraint/i,
  );
});

test('creates attempt-scoped Run dispatch leases with Worker fencing indexes', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await runMigrations({
    database,
    migrationModel,
    migrations: [
      runSchemaMigration,
      workerRegistryMigration,
      runDispatchLeaseMigration,
    ],
    logger: { info() {} },
  });

  const columns = await queryInterface.describeTable(RUN_DISPATCH_LEASE_TABLE);
  for (const column of [
    'attempt_id',
    'run_id',
    'status',
    'version',
    'lease_generation',
    'worker_id',
    'worker_session_id',
    'worker_generation',
    'lease_token',
    'expires_at_ms',
    'completed_at_ms',
  ]) {
    assert.ok(columns[column], `missing ${RUN_DISPATCH_LEASE_TABLE}.${column}`);
  }
  const indexes = await queryInterface.showIndex(RUN_DISPATCH_LEASE_TABLE);
  assert.ok(
    indexes.some((index) => index.name === RUN_DISPATCH_LEASE_EXPIRY_INDEX),
  );
  assert.ok(
    indexes.some((index) => index.name === RUN_DISPATCH_LEASE_WORKER_INDEX),
  );
  assert.ok(
    indexes.some(
      (index) => index.name === RUN_DISPATCH_LEASE_TOKEN_INDEX && index.unique,
    ),
  );
  await assert.rejects(
    database.query(
      `INSERT INTO ${RUN_DISPATCH_LEASE_TABLE} (
        attempt_id, run_id, status, version, lease_generation,
        worker_id, worker_session_id, worker_generation, lease_token,
        acquired_at_ms, renewed_at_ms, expires_at_ms, updated_at_ms
      ) VALUES (
        'missing-attempt', 'missing-run', 'leased', -1, 0,
        'missing-worker', '019f7800-0000-7000-8000-000000000001', 0,
        'lease_token_abcdefghijklmnopqrstuvwxyz0123456789', 1, 1, 2, 1
      )`,
    ),
  );
});

test('adds stable Run references to legacy RunningInstance rows', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await queryInterface.createTable(RUNNING_INSTANCE_TABLE, {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    cron_id: { type: DataTypes.INTEGER, allowNull: false },
    pid: { type: DataTypes.INTEGER, allowNull: true },
    log_path: { type: DataTypes.STRING, allowNull: true },
    started_at: { type: DataTypes.INTEGER, allowNull: false },
    finished_at: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.INTEGER, allowNull: false },
    exit_code: { type: DataTypes.INTEGER, allowNull: true },
  });
  await queryInterface.bulkInsert(RUNNING_INSTANCE_TABLE, [
    { cron_id: 7, started_at: 1_750_000_000, status: 1 },
  ]);

  const options = {
    database,
    migrationModel,
    migrations: [runningInstanceRunReferenceMigration],
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const columns = await queryInterface.describeTable(RUNNING_INSTANCE_TABLE);
  assert.ok(columns.run_id);
  assert.ok(columns.attempt_id);
  assert.equal(columns.run_id.allowNull, true);
  assert.equal(columns.attempt_id.allowNull, true);
  const indexNames = new Set(
    (await queryInterface.showIndex(RUNNING_INSTANCE_TABLE)).map(
      (index) => index.name,
    ),
  );
  assert.ok(indexNames.has(RUNNING_INSTANCE_RUN_INDEX));
  assert.ok(indexNames.has(RUNNING_INSTANCE_ATTEMPT_INDEX));

  const fixture = database.define(
    'RunningInstanceMigrationFixture',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      cron_id: DataTypes.INTEGER,
      run_id: DataTypes.STRING(36),
      attempt_id: DataTypes.STRING(36),
      started_at: DataTypes.INTEGER,
      status: DataTypes.INTEGER,
    },
    { tableName: RUNNING_INSTANCE_TABLE, timestamps: false },
  );
  const legacyRow = await fixture.findByPk(1, { raw: true });
  assert.equal(legacyRow.run_id, null);
  assert.equal(legacyRow.attempt_id, null);

  const runId = '019f7110-0000-7000-8000-000000000001';
  const attemptId = '019f7110-0000-7000-8000-000000000002';
  await queryInterface.bulkInsert(RUNNING_INSTANCE_TABLE, [
    {
      cron_id: 7,
      run_id: runId,
      attempt_id: attemptId,
      started_at: 1_750_000_001,
      status: 0,
    },
  ]);
  await assert.rejects(
    queryInterface.bulkInsert(RUNNING_INSTANCE_TABLE, [
      {
        cron_id: 7,
        run_id: runId,
        attempt_id: attemptId,
        started_at: 1_750_000_002,
        status: 0,
      },
    ]),
  );
  assert.equal(await migrationModel.count(), 1);
});

test('adds durable cancellation requests without rewriting legacy Run rows', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await runMigrations({
    database,
    migrationModel,
    migrations: [runSchemaMigration],
    logger: { info() {} },
  });

  const runId = '019f7110-0000-7000-8000-000000000004';
  await queryInterface.bulkInsert(RUN_TABLE, [
    {
      id: runId,
      project_id: 'default',
      task_id: 'legacy-cron:7',
      task_revision: 'revision-7',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: 'runtime',
      status: 'running',
      version: 3,
      event_sequence: 3,
      priority: 0,
      created_at_ms: 1_750_000_000_000,
      started_at_ms: 1_750_000_000_010,
    },
  ]);

  const options = {
    database,
    migrationModel,
    migrations: [runSchemaMigration, runCancellationRequestMigration],
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const columns = await queryInterface.describeTable(RUN_TABLE);
  assert.ok(columns.cancel_requested_at_ms);
  assert.ok(columns.cancel_reason);
  assert.equal(columns.cancel_requested_at_ms.allowNull, true);
  assert.equal(columns.cancel_reason.allowNull, true);
  const indexNames = new Set(
    (await queryInterface.showIndex(RUN_TABLE)).map((index) => index.name),
  );
  assert.ok(indexNames.has(RUN_CANCELLATION_REQUEST_INDEX));

  const [legacyRow] = await database.query(
    `SELECT cancel_requested_at_ms, cancel_reason FROM ${RUN_TABLE} WHERE id = :runId`,
    {
      replacements: { runId },
      type: QueryTypes.SELECT,
    },
  );
  assert.equal(legacyRow.cancel_requested_at_ms, null);
  assert.equal(legacyRow.cancel_reason, null);
  assert.equal(await migrationModel.count(), 2);
});

test('adds nullable Attempt deadlines without rewriting existing attempts', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await runMigrations({
    database,
    migrationModel,
    migrations: [runSchemaMigration],
    logger: { info() {} },
  });

  const runId = '019f7110-0000-7000-8000-000000000014';
  const attemptId = '019f7110-0000-7000-8000-000000000015';
  await queryInterface.bulkInsert(RUN_TABLE, [
    {
      id: runId,
      project_id: 'default',
      task_id: 'legacy-cron:8',
      task_revision: 'revision-8',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: 'runtime',
      status: 'dispatching',
      version: 2,
      event_sequence: 2,
      priority: 0,
      created_at_ms: 1_750_000_000_000,
    },
  ]);
  await queryInterface.bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: attemptId,
      run_id: runId,
      attempt: 1,
      status: 'starting',
      executor_type: 'local_process',
      callback_sequence: 0,
      created_at_ms: 1_750_000_000_000,
    },
  ]);

  const options = {
    database,
    migrationModel,
    migrations: [runSchemaMigration, runAttemptDeadlineMigration],
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const columns = await queryInterface.describeTable(RUN_ATTEMPT_TABLE);
  assert.ok(columns.deadline_at_ms);
  assert.equal(columns.deadline_at_ms.allowNull, true);
  const indexNames = new Set(
    (await queryInterface.showIndex(RUN_ATTEMPT_TABLE)).map(
      (index) => index.name,
    ),
  );
  assert.ok(indexNames.has(RUN_ATTEMPT_DEADLINE_INDEX));
  const [legacyAttempt] = await database.query(
    `SELECT deadline_at_ms FROM ${RUN_ATTEMPT_TABLE} WHERE id = :attemptId`,
    {
      replacements: { attemptId },
      type: QueryTypes.SELECT,
    },
  );
  assert.equal(legacyAttempt.deadline_at_ms, null);
  assert.equal(await migrationModel.count(), 2);
});

test('creates a fenced cancellation dispatch lease bound to a Run Attempt', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();
  await runMigrations({
    database,
    migrationModel,
    migrations: [
      runSchemaMigration,
      runCancellationRequestMigration,
      runCancellationDispatchMigration,
    ],
    logger: { info() {} },
  });

  const columns = await queryInterface.describeTable(
    RUN_CANCELLATION_DISPATCH_TABLE,
  );
  for (const column of [
    'run_id',
    'attempt_id',
    'status',
    'version',
    'dispatch_count',
    'next_attempt_at_ms',
    'lease_owner',
    'lease_token',
    'lease_expires_at_ms',
    'last_result',
    'last_dispatched_at_ms',
    'created_at_ms',
    'updated_at_ms',
  ]) {
    assert.ok(columns[column], `missing cancellation dispatch.${column}`);
  }
  const indexNames = new Set(
    (await queryInterface.showIndex(RUN_CANCELLATION_DISPATCH_TABLE)).map(
      (index) => index.name,
    ),
  );
  assert.ok(indexNames.has(RUN_CANCELLATION_DISPATCH_DUE_INDEX));
  assert.ok(indexNames.has(RUN_CANCELLATION_DISPATCH_LEASE_INDEX));

  const runId = '019f7110-0000-7000-8000-000000000011';
  const attemptId = '019f7110-0000-7000-8000-000000000012';
  await queryInterface.bulkInsert(RUN_TABLE, [
    {
      id: runId,
      project_id: 'default',
      task_id: 'legacy-cron:8',
      task_revision: 'revision-8',
      trigger_type: 'manual',
      execution_origin: 'manual',
      execution_owner: 'runtime',
      status: 'running',
      version: 2,
      event_sequence: 2,
      priority: 0,
      created_at_ms: 1_750_000_000_000,
      cancel_requested_at_ms: 1_750_000_000_100,
      cancel_reason: 'user',
    },
  ]);
  await queryInterface.bulkInsert(RUN_ATTEMPT_TABLE, [
    {
      id: attemptId,
      run_id: runId,
      attempt: 1,
      status: 'running',
      executor_type: 'local_process',
      callback_sequence: 0,
      created_at_ms: 1_750_000_000_010,
    },
  ]);
  await queryInterface.bulkInsert(RUN_CANCELLATION_DISPATCH_TABLE, [
    {
      run_id: runId,
      attempt_id: attemptId,
      status: 'pending',
      version: 0,
      dispatch_count: 0,
      next_attempt_at_ms: 1_750_000_000_100,
      created_at_ms: 1_750_000_000_100,
      updated_at_ms: 1_750_000_000_100,
    },
  ]);
  await assert.rejects(
    queryInterface.bulkInsert(RUN_CANCELLATION_DISPATCH_TABLE, [
      {
        run_id: 'missing-run',
        attempt_id: attemptId,
        status: 'pending',
        version: 0,
        dispatch_count: 0,
        created_at_ms: 1_750_000_000_100,
        updated_at_ms: 1_750_000_000_100,
      },
    ]),
  );
  await assert.rejects(
    queryInterface.bulkUpdate(
      RUN_CANCELLATION_DISPATCH_TABLE,
      { version: -1 },
      { run_id: runId },
    ),
  );
});

test('runs the registered migration chain against a legacy database fixture', async () => {
  const { database, migrationModel } = await createDatabase();
  const queryInterface = database.getQueryInterface();

  for (const table of ['CrontabViews', 'Subscriptions', 'Crontabs', 'Envs']) {
    await queryInterface.createTable(table, {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    });
  }

  const options = {
    database,
    migrationModel,
    logger: { info() {} },
  };
  await runMigrations(options);
  await runMigrations(options);

  const tables = new Set(await queryInterface.showAllTables());
  assert.ok(tables.has(RUN_TABLE));
  assert.ok(tables.has(RUN_ATTEMPT_TABLE));
  assert.ok(tables.has(RUN_EVENT_TABLE));
  assert.ok(tables.has(RUN_CANCELLATION_DISPATCH_TABLE));
  assert.equal(await migrationModel.count(), migrations.length);
});
