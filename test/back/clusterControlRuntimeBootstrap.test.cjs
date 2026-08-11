require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  postgresqlMainMigrationStream,
} = require('../../back/migrations/postgresql');
const {
  postgresqlControlSchemaContract,
} = require('../../back/migrations/postgresql/schemaContract');
const {
  PostgresSchemaReadinessError,
} = require('../../back/migrations/postgresql/schemaReadiness');
const {
  PostgresRunRepository,
} = require('../../back/runtime/adapters/postgresql/runRepository');
const {
  bootstrapClusterControlRuntime,
} = require('../../back/runtime/adapters/postgresql/clusterControlRuntimeBootstrap');

function migrationHistory() {
  return postgresqlMainMigrationStream.migrations.map((migration, index) => ({
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
}

function runtimePrivileges() {
  const privileges = {
    schema_migrations: [true, false, false, false],
    schema_capabilities: [true, false, false, false],
    runs: [true, true, true, false],
    run_attempts: [true, true, true, false],
    run_events: [true, true, false, false],
    run_retry_policies: [true, true, true, false],
  };
  return Object.entries(privileges).map(
    ([
      tableName,
      [selectAllowed, insertAllowed, updateAllowed, deleteAllowed],
    ]) => ({
      tableName,
      selectAllowed,
      insertAllowed,
      updateAllowed,
      deleteAllowed,
      isOwner: false,
    }),
  );
}

function databaseResource(events, overrides = {}) {
  const contract = postgresqlControlSchemaContract;
  const pool = {
    async query(text) {
      events.push(
        `query:${
          events.filter((event) => event.startsWith('query:')).length + 1
        }`,
      );
      if (text.includes("current_setting('server_version_num')")) {
        return {
          rows: [
            {
              serverVersionNum: overrides.serverVersionNum ?? '160014',
              currentUser: 'ql3_runtime',
              inRecovery: false,
              transactionReadOnly: 'off',
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."schema_migrations"')) {
        return { rows: migrationHistory() };
      }
      if (text.includes('FROM "ql3"."schema_capabilities"')) {
        return {
          rows: [
            {
              contractName: contract.contractName,
              contractVersion: contract.contractVersion,
              migrationId: contract.migrationId,
              capabilities: contract.capabilities,
            },
          ],
        };
      }
      if (text.includes('FROM information_schema.columns')) {
        return {
          rows: contract.tables.flatMap((table) =>
            table.columns.map((columnName) => ({
              tableName: table.name,
              columnName,
            })),
          ),
        };
      }
      if (text.includes('FROM pg_indexes')) {
        return {
          rows: contract.indexes.map((indexName) => ({ indexName })),
        };
      }
      if (text.includes('FROM pg_constraint')) {
        return {
          rows: [
            ...contract.checks.map((constraintName) => ({
              constraintName,
              constraintType: 'check',
            })),
            ...contract.foreignKeys.map((constraintName) => ({
              constraintName,
              constraintType: 'foreign_key',
            })),
          ],
        };
      }
      if (text.includes('FROM pg_catalog.pg_roles')) {
        return {
          rows: [
            {
              canLogin: true,
              superuser: false,
              createDatabase: false,
              createRole: false,
              replication: false,
              bypassRowLevelSecurity: false,
              databaseConnect: true,
            },
          ],
        };
      }
      if (text.includes('has_schema_privilege')) {
        return { rows: [{ schemaUsage: true, schemaCreate: false }] };
      }
      if (text.includes('has_table_privilege')) {
        return { rows: runtimePrivileges() };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async connect() {
      throw new Error('Repository connections are not used during bootstrap');
    },
  };
  return {
    pool,
    async close() {
      events.push('close-database');
      if (overrides.closeError) throw overrides.closeError;
    },
  };
}

function activationStack(
  events,
  recovery = { safe: true, remaining: 0, failed: 0 },
) {
  return {
    async reconcile() {
      events.push('reconcile');
      return recovery;
    },
    async startLifecycles() {
      events.push('start-lifecycles');
      return true;
    },
    installAdmission() {
      events.push('install-admission');
      return () => events.push('dispose-admission');
    },
    async stop() {
      events.push('stop-stack');
      return 'stopped';
    },
  };
}

function bootstrapOptions(events, overrides = {}) {
  return {
    enabled: true,
    profile: 'cluster-control',
    async openDatabase() {
      events.push('open-database');
      return databaseResource(events);
    },
    create({ evidence, runs }) {
      events.push('create-stack');
      assert.equal(evidence.contractVersion, 2);
      assert.equal(runs instanceof PostgresRunRepository, true);
      return activationStack(events);
    },
    audit(record) {
      events.push(`audit:${record.state}`);
    },
    ...overrides,
  };
}

test('disabled and wrong-profile bootstrap never opens PostgreSQL', async () => {
  const disabledEvents = [];
  const disabled = await bootstrapClusterControlRuntime(
    bootstrapOptions(disabledEvents, { enabled: false }),
  );
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabledEvents, ['audit:disabled']);

  const wrongProfileEvents = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(wrongProfileEvents, { profile: 'edge' }),
    ),
    /cannot activate cluster-control/,
  );
  assert.deepEqual(wrongProfileEvents, []);
});

test('readiness failure closes the database before returning the root error', async () => {
  const events = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(events, {
        async openDatabase() {
          events.push('open-database');
          return databaseResource(events, { serverVersionNum: '150018' });
        },
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_version_unsupported',
  );
  assert.equal(events.includes('create-stack'), false);
  assert.deepEqual(events.slice(-2), ['audit:failed', 'close-database']);
});

test('opens once, assembles after readiness, and closes after stack shutdown', async () => {
  const events = [];
  const result = await bootstrapClusterControlRuntime(bootstrapOptions(events));
  assert.equal(result.status, 'active');
  assert.equal(events.filter((event) => event === 'open-database').length, 1);
  assert.ok(events.indexOf('create-stack') > events.lastIndexOf('query:7'));
  const first = result.stop();
  assert.equal(first, result.stop());
  assert.equal(await first, 'stopped');
  assert.deepEqual(events.slice(-4), [
    'dispose-admission',
    'stop-stack',
    'audit:stopped',
    'close-database',
  ]);
});

test('unsafe recovery stops the stack and closes the database', async () => {
  const events = [];
  await assert.rejects(
    bootstrapClusterControlRuntime(
      bootstrapOptions(events, {
        create({ runs }) {
          events.push('create-stack');
          assert.equal(runs instanceof PostgresRunRepository, true);
          return activationStack(events, {
            safe: false,
            remaining: 1,
            failed: 0,
          });
        },
      }),
    ),
    /did not converge safely/,
  );
  assert.equal(events.includes('install-admission'), false);
  assert.deepEqual(events.slice(-3), [
    'stop-stack',
    'audit:failed',
    'close-database',
  ]);
});

test('database close failure does not skip stack shutdown and remains idempotent', async () => {
  const events = [];
  const closeError = new Error('database close failed');
  const result = await bootstrapClusterControlRuntime(
    bootstrapOptions(events, {
      async openDatabase() {
        events.push('open-database');
        return databaseResource(events, { closeError });
      },
    }),
  );
  const first = result.stop();
  assert.equal(first, result.stop());
  await assert.rejects(first, (error) => error === closeError);
  assert.deepEqual(events.slice(-4), [
    'dispose-admission',
    'stop-stack',
    'audit:stopped',
    'close-database',
  ]);
});
