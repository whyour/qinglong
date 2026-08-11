const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  loadPostgresCertificateAuthorityFile,
} = require('@qinglong/cluster-postgres/runtime');
const {
  ClusterWorkerIngressConfigError,
  createClusterWorkerIngressDatabaseOpener,
  createClusterWorkerIngressHttpOptions,
  loadClusterWorkerIngressMutualTls,
  loadClusterWorkerIngressConfig,
} = require('@qinglong/cluster-control/worker-ingress-config');

const FIXTURES = path.join(__dirname, 'fixtures', 'mtls');
const POSTGRES_CA_FILE = path.join(FIXTURES, 'ca-cert.pem');
const POSTGRES_CA_BUNDLE =
  loadPostgresCertificateAuthorityFile(POSTGRES_CA_FILE);
const BASE_ENV = Object.freeze({
  QL3_WORKER_INGRESS_ENABLED: 'true',
  QL_DEPLOYMENT_PROFILE: 'cluster-control',
  QL3_POSTGRES_WORKER_INGRESS_URL:
    'postgresql://ql3_worker_ingress:secret@database.internal:5432/qinglong',
  QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: 'database.internal',
  QL3_WORKER_CREDENTIAL_PEPPER: 'A'.repeat(43),
  QL3_WORKER_ARTIFACT_S3_BUCKET: 'qinglong-worker-artifacts',
  QL3_WORKER_ARTIFACT_S3_REGION: 'us-east-1',
  QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: path.join(
    FIXTURES,
    'server-key.pem',
  ),
  QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE: path.join(
    FIXTURES,
    'server-cert.pem',
  ),
  QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: path.join(FIXTURES, 'ca-cert.pem'),
});

test('disabled Worker ingress does not read database, pepper or TLS paths', () => {
  const reads = [];
  const environment = new Proxy(
    {
      QL3_WORKER_INGRESS_ENABLED: 'false',
      QL_DEPLOYMENT_PROFILE: 'edge',
    },
    {
      get(target, property, receiver) {
        reads.push(property);
        if (
          String(property).includes('POSTGRES') ||
          String(property).includes('TLS') ||
          String(property).includes('WORKER_SECRET')
        ) {
          throw new Error('disabled ingress read protected configuration');
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.deepEqual(loadClusterWorkerIngressConfig(environment), {
    enabled: false,
    profile: 'edge',
  });
  assert.equal(
    reads.some((name) => String(name).includes('POSTGRES')),
    false,
  );
  assert.equal(
    reads.some((name) => String(name).includes('TLS')),
    false,
  );
  assert.equal(
    reads.some((name) => String(name).includes('WORKER_SECRET')),
    false,
  );
});

test('builds exact bounded Worker ingress and least-privilege Pool config', async () => {
  const config = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_HOST: '127.0.0.1',
    QL3_WORKER_INGRESS_PORT: '5901',
    QL3_WORKER_INGRESS_MAX_IN_FLIGHT: '32',
    QL3_WORKER_INGRESS_AUTH_RATE_PER_PEER: '20',
    QL3_WORKER_INGRESS_POSTGRES_MAX_CONNECTIONS: '6',
    QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: 'database.internal',
    QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE: POSTGRES_CA_FILE,
  });
  assert.equal(config.enabled, true);
  assert.deepEqual(config.http, {
    host: '127.0.0.1',
    port: 5901,
    maxBodyBytes: 65_536,
    maxResponseBytes: 65_536,
    maxInFlightRequests: 32,
    authenticationRateWindowMs: 60_000,
    authenticationRatePerPeer: 20,
    authenticationRateGlobal: 1_200,
    authenticationRateMaxPeers: 4_096,
    requestTimeoutMs: 15_000,
    drainTimeoutMs: 10_000,
  });
  assert.deepEqual(config.database, {
    connection: {
      connectionString: BASE_ENV.QL3_POSTGRES_WORKER_INGRESS_URL,
      tls: {
        mode: 'verify-full',
        ca: POSTGRES_CA_BUNDLE,
        servername: 'database.internal',
      },
    },
    pool: {
      applicationName: 'qinglong-worker-ingress',
      maxConnections: 6,
      connectionTimeoutMs: 5_000,
    },
  });
  assert.deepEqual(config.artifact, {
    bucket: 'qinglong-worker-artifacts',
    region: 'us-east-1',
    forcePathStyle: false,
    encryption: { mode: 's3' },
  });
  const http = await createClusterWorkerIngressHttpOptions(
    config,
    Date.UTC(2030, 0, 1),
  );
  assert.equal(Buffer.isBuffer(http.mutualTls.privateKey), true);
  assert.equal(Buffer.isBuffer(http.mutualTls.certificateChain), true);
  assert.equal(http.mutualTls.clientCertificateAuthorities.length, 1);

  const open = createClusterWorkerIngressDatabaseOpener(config, () => {});
  const database = await open();
  await database.close();
});

test('enables only the explicit mounted-files Secret provider', () => {
  const rootDirectory = path.join(
    os.tmpdir(),
    'ql3-worker-secret-values',
  );
  const enabled = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_SECRET_PROVIDER: 'mounted-files',
    QL3_WORKER_SECRET_ROOT_DIRECTORY: rootDirectory,
  });
  assert.deepEqual(enabled.secret, {
    provider: 'mounted-files',
    rootDirectory,
  });
  const disabled = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_SECRET_PROVIDER: 'disabled',
  });
  assert.equal(disabled.secret, undefined);
});

test('loads discrete operator-managed Worker ingress credentials', () => {
  const {
    QL3_POSTGRES_WORKER_INGRESS_URL: _connectionString,
    ...withoutConnectionString
  } = BASE_ENV;
  const config = loadClusterWorkerIngressConfig({
    ...withoutConnectionString,
    QL3_POSTGRES_WORKER_INGRESS_HOST: 'ql3-postgres-rw.qinglong3-system.svc',
    QL3_POSTGRES_WORKER_INGRESS_PORT: '5432',
    QL3_POSTGRES_WORKER_INGRESS_DATABASE: 'qinglong',
    QL3_POSTGRES_WORKER_INGRESS_USER: 'ql3_worker_ingress',
    QL3_POSTGRES_WORKER_INGRESS_PASSWORD: 'operator-secret',
  });
  assert.deepEqual(config.database.connection, {
    host: 'ql3-postgres-rw.qinglong3-system.svc',
    port: 5432,
    database: 'qinglong',
    user: 'ql3_worker_ingress',
    password: 'operator-secret',
    tls: {
      mode: 'verify-full',
      servername: 'database.internal',
    },
  });
});

test('requires explicit mTLS files and a second gate for insecure PostgreSQL', () => {
  for (const environment of [
    { ...BASE_ENV, QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: 'relative.pem' },
    {
      ...BASE_ENV,
      QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: undefined,
    },
    {
      ...BASE_ENV,
      QL3_WORKER_INGRESS_POSTGRES_TLS_SERVERNAME: '127.0.0.1',
    },
    { ...BASE_ENV, QL3_WORKER_INGRESS_TLS_CLIENT_CRL_FILE: 'relative.pem' },
    { ...BASE_ENV, QL3_WORKER_CREDENTIAL_PEPPER: 'weak' },
    { ...BASE_ENV, QL3_WORKER_INGRESS_MAX_IN_FLIGHT: '257' },
    { ...BASE_ENV, QL3_WORKER_INGRESS_POSTGRES_MAX_CONNECTIONS: '17' },
    {
      ...BASE_ENV,
      QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE: 'relative-ca.pem',
    },
    {
      ...BASE_ENV,
      QL3_WORKER_INGRESS_POSTGRES_TLS_MODE: 'disable',
    },
    {
      ...BASE_ENV,
      QL3_POSTGRES_WORKER_INGRESS_URL:
        'postgresql://database/qinglong?sslmode=disable',
    },
    {
      ...BASE_ENV,
      QL3_POSTGRES_WORKER_INGRESS_HOST: 'database.internal',
    },
    { ...BASE_ENV, QL3_WORKER_ARTIFACT_S3_BUCKET: 'Invalid_Bucket' },
    { ...BASE_ENV, QL3_WORKER_ARTIFACT_S3_REGION: 'invalid region' },
    {
      ...BASE_ENV,
      QL3_WORKER_ARTIFACT_S3_ENDPOINT: 'http://minio.internal:9000',
    },
    {
      ...BASE_ENV,
      QL3_WORKER_ARTIFACT_S3_ENCRYPTION: 'kms',
    },
    {
      ...BASE_ENV,
      QL3_WORKER_ARTIFACT_S3_KMS_KEY_ID: 'unexpected',
    },
    {
      ...BASE_ENV,
      QL3_WORKER_SECRET_PROVIDER: 'vault',
    },
    {
      ...BASE_ENV,
      QL3_WORKER_SECRET_PROVIDER: 'mounted-files',
    },
    {
      ...BASE_ENV,
      QL3_WORKER_SECRET_PROVIDER: 'mounted-files',
      QL3_WORKER_SECRET_ROOT_DIRECTORY: 'relative/secrets',
    },
  ]) {
    assert.throws(
      () => loadClusterWorkerIngressConfig(environment),
      ClusterWorkerIngressConfigError,
    );
  }
  const config = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_POSTGRES_TLS_MODE: 'disable',
    QL3_WORKER_INGRESS_POSTGRES_ALLOW_INSECURE: 'true',
  });
  assert.deepEqual(config.database.connection.tls, { mode: 'disable' });
  const minio = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_ARTIFACT_S3_ENDPOINT: 'http://minio.internal:9000',
    QL3_WORKER_ARTIFACT_S3_ALLOW_INSECURE: 'true',
    QL3_WORKER_ARTIFACT_S3_FORCE_PATH_STYLE: 'true',
    QL3_WORKER_ARTIFACT_S3_PREFIX: 'tenant-a/worker-artifacts',
    QL3_WORKER_ARTIFACT_S3_ENCRYPTION: 'kms',
    QL3_WORKER_ARTIFACT_S3_KMS_KEY_ID: 'alias/qinglong-worker-artifacts',
  });
  assert.deepEqual(minio.artifact, {
    bucket: 'qinglong-worker-artifacts',
    region: 'us-east-1',
    prefix: 'tenant-a/worker-artifacts',
    endpoint: 'http://minio.internal:9000',
    forcePathStyle: true,
    encryption: {
      mode: 'kms',
      keyId: 'alias/qinglong-worker-artifacts',
    },
  });
  assert.throws(
    () =>
      loadClusterWorkerIngressConfig({
        ...BASE_ENV,
        QL3_WORKER_INGRESS_POSTGRES_TLS_MODE: 'disable',
        QL3_WORKER_INGRESS_POSTGRES_ALLOW_INSECURE: 'true',
        QL3_WORKER_INGRESS_POSTGRES_TLS_CA_FILE: POSTGRES_CA_FILE,
      }),
    ClusterWorkerIngressConfigError,
  );
});

test('loads bounded CA rollover bundles and optional CRL material', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ql3-mtls-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = await readFile(path.join(FIXTURES, 'ca-cert.pem'));
  const authorityBundle = path.join(directory, 'client-ca-bundle.pem');
  await writeFile(authorityBundle, Buffer.concat([authority, authority]));
  const config = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: authorityBundle,
    QL3_WORKER_INGRESS_TLS_CLIENT_CRL_FILE: path.join(
      FIXTURES,
      'empty-crl.pem',
    ),
  });

  const mutualTls = await loadClusterWorkerIngressMutualTls(
    config,
    Date.UTC(2030, 0, 1),
  );
  assert.equal(mutualTls.clientCertificateAuthorities.length, 2);
  assert.equal(mutualTls.certificateRevocationLists.length, 1);

  await writeFile(
    authorityBundle,
    Buffer.concat([authority, Buffer.from('unexpected trailing data')]),
  );
  await assert.rejects(
    loadClusterWorkerIngressMutualTls(config, Date.UTC(2030, 0, 1)),
    /contains unsupported data/,
  );

  await writeFile(
    authorityBundle,
    Buffer.concat(Array.from({ length: 17 }, () => authority)),
  );
  await assert.rejects(
    loadClusterWorkerIngressMutualTls(config, Date.UTC(2030, 0, 1)),
    /must contain 1 to 16 PEM certificates/,
  );
});

test('rejects unavailable, mismatched and non-CA TLS material', async () => {
  const unavailable = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_TLS_CERTIFICATE_FILE: '/definitely/missing.pem',
  });
  await assert.rejects(
    createClusterWorkerIngressHttpOptions(unavailable, Date.UTC(2030, 0, 1)),
    ClusterWorkerIngressConfigError,
  );

  const mismatched = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_TLS_PRIVATE_KEY_FILE: path.join(
      FIXTURES,
      'client-key.pem',
    ),
  });
  await assert.rejects(
    createClusterWorkerIngressHttpOptions(mismatched, Date.UTC(2030, 0, 1)),
    /does not match/,
  );

  const nonCa = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_TLS_CLIENT_CA_FILE: path.join(
      FIXTURES,
      'client-cert.pem',
    ),
  });
  await assert.rejects(
    createClusterWorkerIngressHttpOptions(nonCa, Date.UTC(2030, 0, 1)),
    /is not a CA/,
  );

  const malformedCrl = loadClusterWorkerIngressConfig({
    ...BASE_ENV,
    QL3_WORKER_INGRESS_TLS_CLIENT_CRL_FILE: path.join(
      FIXTURES,
      'client-cert.pem',
    ),
  });
  await assert.rejects(
    createClusterWorkerIngressHttpOptions(malformedCrl, Date.UTC(2030, 0, 1)),
    /is not a PEM CRL/,
  );
});
