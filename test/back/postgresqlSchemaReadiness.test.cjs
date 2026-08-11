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
  assertPostgresSchemaReady,
} = require('../../back/migrations/postgresql/schemaReadiness');

function validHistory() {
  return postgresqlMainMigrationStream.migrations.map((migration, index) => ({
    streamId: 'postgresql-main',
    dialect: 'postgresql',
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
}

function validPrivileges() {
  const expected = {
    schema_migrations: [true, false, false, false],
    schema_capabilities: [true, false, false, false],
    runs: [true, true, true, false],
    run_attempts: [true, true, true, false],
    run_events: [true, true, false, false],
    run_retry_policies: [true, true, true, false],
  };
  return Object.entries(expected).map(
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

function queryable(overrides = {}) {
  const contract = postgresqlControlSchemaContract;
  return {
    async query(text) {
      if (text.includes("current_setting('server_version_num')")) {
        return {
          rows: [
            {
              serverVersionNum: overrides.serverVersionNum ?? '160014',
              currentUser: 'ql3_runtime',
              inRecovery: overrides.inRecovery ?? false,
              transactionReadOnly: overrides.transactionReadOnly ?? 'off',
            },
          ],
        };
      }
      if (text.includes('FROM "ql3"."schema_migrations"')) {
        return { rows: overrides.history ?? validHistory() };
      }
      if (text.includes('FROM "ql3"."schema_capabilities"')) {
        return {
          rows: [
            overrides.capability ?? {
              contractName: 'control-core',
              contractVersion: 2,
              migrationId: 'pg-0003-run-retry-policy',
              capabilities: { run_core: 1, run_retry_policy: 1 },
            },
          ],
        };
      }
      if (text.includes('FROM information_schema.columns')) {
        const rows = contract.tables.flatMap((table) =>
          table.columns.map((columnName) => ({
            tableName: table.name,
            columnName,
          })),
        );
        if (overrides.extraTable) {
          rows.push({ tableName: overrides.extraTable, columnName: 'id' });
        }
        return { rows };
      }
      if (text.includes('FROM pg_indexes')) {
        return {
          rows: [
            ...contract.indexes.map((indexName) => ({ indexName })),
            ...(overrides.extraIndex
              ? [{ indexName: overrides.extraIndex }]
              : []),
          ],
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
            ...(overrides.extraConstraint
              ? [
                  {
                    constraintName: overrides.extraConstraint,
                    constraintType: 'check',
                  },
                ]
              : []),
          ],
        };
      }
      if (text.includes('FROM pg_catalog.pg_roles')) {
        return {
          rows: [
            {
              canLogin: true,
              superuser: overrides.superuser ?? false,
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
        return {
          rows: [
            {
              schemaUsage: true,
              schemaCreate: overrides.schemaCreate ?? false,
            },
          ],
        };
      }
      if (text.includes('has_table_privilege')) {
        return { rows: overrides.privileges ?? validPrivileges() };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

test('accepts the exact PostgreSQL control schema and least-privilege runtime role', async () => {
  const report = await assertPostgresSchemaReady(queryable());
  assert.deepEqual(report, {
    ready: true,
    writablePrimary: true,
    serverVersionNum: 160014,
    serverMajor: 16,
    currentUser: 'ql3_runtime',
    contractName: 'control-core',
    contractVersion: 2,
    migrationIds: [
      'pg-0001-schema-capability',
      'pg-0002-run-core',
      'pg-0003-run-retry-policy',
    ],
  });
});

test('rejects a standby or read-only endpoint before schema inspection', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ inRecovery: true })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_not_writable_primary' &&
      error.facts.includes('in-recovery:true'),
  );
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ transactionReadOnly: 'on' })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_not_writable_primary' &&
      error.facts.includes('transaction-read-only:on'),
  );
});

test('rejects unsupported server versions and capability drift', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ serverVersionNum: '150018' })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'server_version_unsupported',
  );
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        capability: {
          contractName: 'control-core',
          contractVersion: 3,
          migrationId: 'pg-0003-run-retry-policy',
          capabilities: { run_core: 1, run_retry_policy: 1 },
        },
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'capability_invalid',
  );
});

test('rejects unknown ql3 objects and an over-privileged runtime role', async () => {
  await assert.rejects(
    assertPostgresSchemaReady(
      queryable({
        extraTable: 'plugin_state',
        extraIndex: 'plugin_state_pkey',
        extraConstraint: 'plugin_state_payload_check',
      }),
    ),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'schema_contract_invalid' &&
      error.facts.includes('unknown-table:plugin_state') &&
      error.facts.includes('unknown-check:plugin_state_payload_check'),
  );
  await assert.rejects(
    assertPostgresSchemaReady(queryable({ schemaCreate: true })),
    (error) =>
      error instanceof PostgresSchemaReadinessError &&
      error.code === 'runtime_role_invalid',
  );
});

test('preserves database availability errors for the outer readiness layer', async () => {
  const unavailable = new Error('database unavailable');
  let calls = 0;
  await assert.rejects(
    assertPostgresSchemaReady({
      async query() {
        calls += 1;
        if (calls === 1) {
          return {
            rows: [
              {
                serverVersionNum: '160014',
                currentUser: 'ql3_runtime',
                inRecovery: false,
                transactionReadOnly: 'off',
              },
            ],
          };
        }
        throw unavailable;
      },
    }),
    (error) => error === unavailable,
  );
});
