const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const {
  loadPostgresCertificateAuthorityFile,
} = require('@qinglong/cluster-postgres/runtime');
const {
  PostgresMigrationProcessConfigError,
  loadPostgresMigrationProcessConfig,
  runPostgresMigrationProcess,
} = require('@qinglong/cluster-postgres/migration-process');

const CA_FILE = path.resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const CA_BUNDLE = loadPostgresCertificateAuthorityFile(CA_FILE);

const BASE_ENV = Object.freeze({
  QL3_POSTGRES_MIGRATION_URL:
    'postgresql://ql3_migration:do-not-log@postgres-rw.internal:5432/qinglong',
  QL3_POSTGRES_TLS_SERVERNAME: 'postgres-rw.internal',
});

test('builds a TLS-verified single-connection migration configuration', () => {
  assert.deepEqual(
    loadPostgresMigrationProcessConfig({
      ...BASE_ENV,
      QL3_POSTGRES_TLS_CA_FILE: CA_FILE,
    }),
    {
      connection: {
        connectionString: BASE_ENV.QL3_POSTGRES_MIGRATION_URL,
        tls: {
          mode: 'verify-full',
          ca: CA_BUNDLE,
          servername: 'postgres-rw.internal',
        },
      },
      pool: {
        applicationName: 'qinglong3-cluster-migration',
        maxConnections: 1,
        connectionTimeoutMs: 15_000,
      },
    },
  );
});

test('loads a discrete operator-managed migration credential', () => {
  const config = loadPostgresMigrationProcessConfig({
    QL3_POSTGRES_MIGRATION_HOST: 'ql3-postgres-rw.qinglong3-system.svc',
    QL3_POSTGRES_MIGRATION_PORT: '5432',
    QL3_POSTGRES_MIGRATION_DATABASE: 'qinglong',
    QL3_POSTGRES_MIGRATION_USER: 'ql3_migration',
    QL3_POSTGRES_MIGRATION_PASSWORD: 'operator-secret',
    QL3_POSTGRES_TLS_SERVERNAME: 'ql3-postgres-rw.qinglong3-system.svc',
  });
  assert.deepEqual(config.connection, {
    host: 'ql3-postgres-rw.qinglong3-system.svc',
    port: 5432,
    database: 'qinglong',
    user: 'ql3_migration',
    password: 'operator-secret',
    tls: {
      mode: 'verify-full',
      servername: 'ql3-postgres-rw.qinglong3-system.svc',
    },
  });
});

test('requires an explicit second gate before disabling TLS', () => {
  assert.throws(
    () =>
      loadPostgresMigrationProcessConfig({
        ...BASE_ENV,
        QL3_POSTGRES_TLS_MODE: 'disable',
      }),
    PostgresMigrationProcessConfigError,
  );
  assert.deepEqual(
    loadPostgresMigrationProcessConfig({
      ...BASE_ENV,
      QL3_POSTGRES_TLS_MODE: 'disable',
      QL3_POSTGRES_ALLOW_INSECURE: 'true',
    }).connection.tls,
    { mode: 'disable' },
  );
});

test('rejects URL TLS overrides and unbounded identity fields', () => {
  for (const environment of [
    {},
    {
      ...BASE_ENV,
      QL3_POSTGRES_MIGRATION_URL: `${BASE_ENV.QL3_POSTGRES_MIGRATION_URL}?sslmode=disable`,
    },
    {
      ...BASE_ENV,
      QL3_POSTGRES_MIGRATION_HOST: 'postgres-rw.internal',
    },
    { ...BASE_ENV, QL3_POSTGRES_TLS_SERVERNAME: undefined },
    { ...BASE_ENV, QL3_POSTGRES_TLS_SERVERNAME: '127.0.0.1' },
    { ...BASE_ENV, QL3_POSTGRES_TLS_SERVERNAME: 'unsafe/name' },
    { ...BASE_ENV, QL3_POSTGRES_TLS_CA_FILE: 'relative-ca.pem' },
    {
      ...BASE_ENV,
      QL3_POSTGRES_TLS_MODE: 'disable',
      QL3_POSTGRES_ALLOW_INSECURE: 'true',
      QL3_POSTGRES_TLS_CA_FILE: CA_FILE,
    },
    { ...BASE_ENV, QL3_POSTGRES_APPLICATION_NAME: 'x'.repeat(64) },
  ]) {
    assert.throws(
      () => loadPostgresMigrationProcessConfig(environment),
      PostgresMigrationProcessConfigError,
    );
  }
});

test('runs the reviewed stream on one Pool and always closes it', async () => {
  const events = [];
  const pool = { query() {} };
  const result = await runPostgresMigrationProcess({
    environment: BASE_ENV,
    async openDatabase() {
      events.push('open');
      return {
        pool,
        async close() {
          events.push('close');
        },
      };
    },
    async migrate(options) {
      events.push('migrate');
      assert.equal(options.pool, pool);
    },
    emit(record) {
      events.push(record.event);
    },
  });
  assert.equal(result, 'migrated');
  assert.deepEqual(events, [
    'open',
    'migration_started',
    'migrate',
    'migration_completed',
    'close',
  ]);
});

test('preserves migration failure while still closing the Pool', async () => {
  const failure = Object.assign(new Error('migration failed'), {
    code: 'MIGRATION_FAILED',
  });
  const events = [];
  await assert.rejects(
    runPostgresMigrationProcess({
      environment: BASE_ENV,
      async openDatabase() {
        return {
          pool: {},
          async close() {
            events.push('close');
            throw new Error('close failed');
          },
        };
      },
      async migrate() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['close']);
});
