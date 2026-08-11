const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const {
  loadPostgresCertificateAuthorityFile,
} = require('@qinglong/cluster-postgres/runtime');
const {
  ClusterControlConfigError,
  createClusterControlDatabaseBinding,
  loadClusterControlConfig,
} = require('@qinglong/cluster-control/config');

const CA_FILE = path.join(__dirname, 'fixtures', 'mtls', 'ca-cert.pem');
const CA_BUNDLE = loadPostgresCertificateAuthorityFile(CA_FILE);

const BASE_ENV = Object.freeze({
  QL3_CLUSTER_CONTROL_ENABLED: 'true',
  QL_DEPLOYMENT_PROFILE: 'cluster-control',
  QL3_POSTGRES_RUNTIME_URL:
    'postgresql://ql3_runtime:secret@database.internal:5432/qinglong',
  QL3_POSTGRES_TLS_SERVERNAME: 'database.internal',
  QL3_API_CREDENTIAL_PEPPER: 'A'.repeat(43),
});

test('disabled configuration does not read PostgreSQL credentials', () => {
  const reads = [];
  const environment = new Proxy(
    {
      QL3_CLUSTER_CONTROL_ENABLED: 'false',
      QL_DEPLOYMENT_PROFILE: 'standalone',
    },
    {
      get(target, property, receiver) {
        reads.push(property);
        if (
          property === 'QL3_POSTGRES_RUNTIME_URL' ||
          property === 'QL3_API_CREDENTIAL_PEPPER'
        ) {
          throw new Error('credential must not be read');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.deepEqual(loadClusterControlConfig(environment), {
    enabled: false,
    profile: 'standalone',
  });
  assert.equal(reads.includes('QL3_POSTGRES_RUNTIME_URL'), false);
  assert.equal(reads.includes('QL3_API_CREDENTIAL_PEPPER'), false);
});

test('enabled configuration requires the exact cluster-control profile', () => {
  assert.throws(
    () =>
      loadClusterControlConfig({
        ...BASE_ENV,
        QL_DEPLOYMENT_PROFILE: 'standalone',
      }),
    ClusterControlConfigError,
  );
  assert.throws(
    () =>
      loadClusterControlConfig({
        ...BASE_ENV,
        QL3_CLUSTER_CONTROL_ENABLED: 'yes',
      }),
    ClusterControlConfigError,
  );
});

test('builds an exact runtime-only TLS-verified Pool configuration', async () => {
  const config = loadClusterControlConfig({
    ...BASE_ENV,
    QL3_CLUSTER_HTTP_HOST: '127.0.0.1',
    QL3_CLUSTER_HTTP_PORT: '5900',
    QL3_CLUSTER_HTTP_MAX_IN_FLIGHT: '32',
    QL3_CLUSTER_AUTH_RATE_WINDOW_MS: '30000',
    QL3_CLUSTER_AUTH_RATE_PER_PEER: '20',
    QL3_CLUSTER_AUTH_RATE_GLOBAL: '200',
    QL3_CLUSTER_AUTH_RATE_MAX_PEERS: '512',
    QL3_POSTGRES_MAX_CONNECTIONS: '12',
    QL3_POSTGRES_TLS_SERVERNAME: 'database.internal',
    QL3_POSTGRES_TLS_CA_FILE: CA_FILE,
  });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.http, {
    host: '127.0.0.1',
    port: 5900,
    maxBodyBytes: 1024 * 1024,
    maxInFlightRequests: 32,
    authenticationRateWindowMs: 30_000,
    authenticationRatePerPeer: 20,
    authenticationRateGlobal: 200,
    authenticationRateMaxPeers: 512,
    requestTimeoutMs: 15_000,
    drainTimeoutMs: 10_000,
  });
  assert.deepEqual(config.database, {
    connection: {
      connectionString: BASE_ENV.QL3_POSTGRES_RUNTIME_URL,
      tls: {
        mode: 'verify-full',
        ca: CA_BUNDLE,
        servername: 'database.internal',
      },
    },
    pool: {
      applicationName: 'qinglong-cluster-runtime',
      maxConnections: 12,
      connectionTimeoutMs: 5_000,
    },
  });
  assert.deepEqual(config.security, {
    apiCredentialPepper: BASE_ENV.QL3_API_CREDENTIAL_PEPPER,
  });

  const binding = createClusterControlDatabaseBinding(config);
  assert.equal(binding.availability.status, 'available');
  const database = await binding.openDatabase();
  await database.close();
});

test('loads discrete operator-managed runtime credentials without a DSN copy', () => {
  const {
    QL3_POSTGRES_RUNTIME_URL: _connectionString,
    ...withoutConnectionString
  } = BASE_ENV;
  const config = loadClusterControlConfig({
    ...withoutConnectionString,
    QL3_POSTGRES_RUNTIME_HOST: 'ql3-postgres-rw.qinglong3-system.svc',
    QL3_POSTGRES_RUNTIME_PORT: '5432',
    QL3_POSTGRES_RUNTIME_DATABASE: 'qinglong',
    QL3_POSTGRES_RUNTIME_USER: 'ql3_runtime',
    QL3_POSTGRES_RUNTIME_PASSWORD: 'operator-secret',
  });
  assert.deepEqual(config.database.connection, {
    host: 'ql3-postgres-rw.qinglong3-system.svc',
    port: 5432,
    database: 'qinglong',
    user: 'ql3_runtime',
    password: 'operator-secret',
    tls: {
      mode: 'verify-full',
      servername: 'database.internal',
    },
  });
});

test('requires a second explicit gate before disabling PostgreSQL TLS', () => {
  assert.throws(
    () =>
      loadClusterControlConfig({
        ...BASE_ENV,
        QL3_POSTGRES_TLS_MODE: 'disable',
      }),
    /requires QL3_POSTGRES_ALLOW_INSECURE=true/,
  );
  const config = loadClusterControlConfig({
    ...BASE_ENV,
    QL3_POSTGRES_TLS_MODE: 'disable',
    QL3_POSTGRES_ALLOW_INSECURE: 'true',
  });
  assert.deepEqual(config.database.connection.tls, { mode: 'disable' });
});

test('rejects TLS query overrides, missing credentials and unbounded values', () => {
  for (const environment of [
    {
      ...BASE_ENV,
      QL3_POSTGRES_RUNTIME_URL:
        'postgresql://database.internal/qinglong?sslmode=disable',
    },
    { ...BASE_ENV, QL3_POSTGRES_TLS_SERVERNAME: undefined },
    { ...BASE_ENV, QL3_POSTGRES_TLS_SERVERNAME: '127.0.0.1' },
    { ...BASE_ENV, QL3_POSTGRES_TLS_CA_FILE: 'relative-ca.pem' },
    {
      ...BASE_ENV,
      QL3_POSTGRES_TLS_MODE: 'disable',
      QL3_POSTGRES_ALLOW_INSECURE: 'true',
      QL3_POSTGRES_TLS_CA_FILE: CA_FILE,
    },
    { ...BASE_ENV, QL3_POSTGRES_RUNTIME_URL: '' },
    {
      ...BASE_ENV,
      QL3_POSTGRES_RUNTIME_HOST: 'database.internal',
    },
    { ...BASE_ENV, QL3_POSTGRES_MAX_CONNECTIONS: '65' },
    { ...BASE_ENV, QL3_CLUSTER_HTTP_MAX_BODY_BYTES: '99999999' },
    { ...BASE_ENV, QL3_CLUSTER_AUTH_RATE_WINDOW_MS: '99999999' },
    { ...BASE_ENV, QL3_CLUSTER_AUTH_RATE_PER_PEER: '0' },
    { ...BASE_ENV, QL3_CLUSTER_AUTH_RATE_GLOBAL: '1000001' },
    { ...BASE_ENV, QL3_CLUSTER_AUTH_RATE_MAX_PEERS: '65537' },
    { ...BASE_ENV, QL3_API_CREDENTIAL_PEPPER: 'weak' },
  ]) {
    assert.throws(
      () => loadClusterControlConfig(environment),
      ClusterControlConfigError,
    );
  }
});
