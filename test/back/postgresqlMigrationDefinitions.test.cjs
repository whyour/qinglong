require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  postgresqlMainMigrationStream,
} = require('../../back/migrations/postgresql');
const {
  postgresqlControlSchemaContract,
} = require('../../back/migrations/postgresql/schemaContract');

const BANNED_CLUSTER_SCHEMA_NAMES = [
  'crontabs',
  'envs',
  'subscriptions',
  'runninginstances',
  'completionreceiptjournals',
  'localexecutioncontextrecipes',
  'localsecretenvelopes',
  'localartifactretentioncheckpoints',
  'projectownerbootstrapchallenges',
  'legacypanelidentitybindings',
];

function tableDefinitionSql(statements, tableName) {
  const qualifiedName = `"ql3"."${tableName}"`;
  return statements
    .filter(
      (statement) =>
        statement.includes(qualifiedName) &&
        (/^CREATE TABLE /.test(statement) || /^ALTER TABLE /.test(statement)),
    )
    .join('\n');
}

test('defines the immutable PostgreSQL capability and Run core stream', async () => {
  assert.equal(postgresqlMainMigrationStream.id, 'postgresql-main');
  assert.equal(postgresqlMainMigrationStream.dialect, 'postgresql');
  assert.equal(
    postgresqlMainMigrationStream.migrationIdScheme,
    'postgres-prefixed',
  );
  assert.equal(postgresqlMainMigrationStream.checksumScheme, 'sha256');
  assert.deepEqual(
    postgresqlMainMigrationStream.migrations.map(({ id }) => id),
    [
      'pg-0001-schema-capability',
      'pg-0002-run-core',
      'pg-0003-run-retry-policy',
    ],
  );
  for (const migration of postgresqlMainMigrationStream.migrations) {
    assert.match(migration.checksum, /^[0-9a-f]{64}$/);
  }
});

test('keeps local-only and legacy tables out of the cluster baseline', async () => {
  const statements = [];
  for (const migration of postgresqlMainMigrationStream.migrations) {
    await migration.up({
      async query(statement) {
        statements.push(statement);
        return { rows: [] };
      },
    });
  }
  const canonical = statements.join('\n').toLowerCase();
  for (const table of BANNED_CLUSTER_SCHEMA_NAMES) {
    assert.equal(canonical.includes(table.toLowerCase()), false, table);
  }
  for (const table of [
    'schema_capabilities',
    'runs',
    'run_attempts',
    'run_events',
    'run_retry_policies',
  ]) {
    assert.match(canonical, new RegExp(`"ql3"\\."${table}"`));
  }
  assert.match(canonical, /deferrable initially deferred/);
  assert.match(canonical, /'control-core'/);
  assert.match(canonical, /'pg-0003-run-retry-policy'/);
  assert.match(canonical, /"run_core":1,"run_retry_policy":1/);
});

test('keeps the reviewed SQL and readiness schema contract in lockstep', async () => {
  const statements = [];
  for (const migration of postgresqlMainMigrationStream.migrations) {
    await migration.up({
      async query(statement) {
        statements.push(statement);
        return { rows: [] };
      },
    });
  }
  const canonical = statements.join('\n');
  for (const table of postgresqlControlSchemaContract.tables) {
    if (table.name === 'schema_migrations') continue;
    const definition = tableDefinitionSql(statements, table.name);
    assert.match(definition, new RegExp(`"ql3"\\."${table.name}"`));
    for (const column of table.columns) {
      assert.match(definition, new RegExp(`\\b${column}\\b`));
    }
  }
  for (const index of postgresqlControlSchemaContract.indexes) {
    if (index.endsWith('_pkey')) continue;
    assert.match(canonical, new RegExp(`CREATE (?:UNIQUE )?INDEX ${index}\\b`));
  }
  assert.doesNotMatch(canonical, /CREATE TABLE IF NOT EXISTS/);
  assert.doesNotMatch(canonical, /CREATE INDEX IF NOT EXISTS/);
});

test('freezes every published PostgreSQL migration checksum', () => {
  assert.deepEqual(
    postgresqlMainMigrationStream.migrations.map(({ id, checksum }) => ({
      id,
      checksum,
    })),
    [
      {
        id: 'pg-0001-schema-capability',
        checksum:
          '9e3499e3bcdfe3d7b2559e64ea7bbf236a8a11ba32d6a45af131034887d5a8ab',
      },
      {
        id: 'pg-0002-run-core',
        checksum:
          '5b59a7f9323746e49c6c321e89007f553a0751f25d16ffd23c3ae37dd87f76e4',
      },
      {
        id: 'pg-0003-run-retry-policy',
        checksum:
          '621792cde917cc86809bbebff389443e790bdba60f73d04f7a1dc97a0ebf72db',
      },
    ],
  );
});

test('advances capability v2 only from the exact v1 predecessor', async () => {
  const statements = [];
  await postgresqlMainMigrationStream.migrations.at(-1).up({
    async query(statement) {
      statements.push(statement);
      return { rows: [] };
    },
  });
  const capability = statements.at(-1);
  assert.match(capability, /contract_version = 1/);
  assert.match(capability, /migration_id = 'pg-0002-run-core'/);
  assert.match(capability, /capabilities = '\{"run_core":1\}'::jsonb/);
  assert.match(capability, /IF NOT FOUND THEN/);
  assert.match(capability, /RAISE EXCEPTION/);
});
