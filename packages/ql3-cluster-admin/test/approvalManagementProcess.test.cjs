const assert = require('node:assert/strict');
const { readFile, writeFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterApprovalManagementProcessConfigError,
  loadClusterApprovalManagementProcessConfig,
  startClusterApprovalManagementProcess,
} = require('@qinglong/cluster-admin/approval-management-process');

const FIXTURES = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls',
);
const NOW_MS = Date.UTC(2030, 0, 1);

function enabledEnvironment(paths, overrides = {}) {
  return {
    QL3_APPROVAL_MANAGEMENT_ENABLED: 'true',
    QL3_PROFILE: 'cluster-admin',
    QL3_APPROVAL_MANAGEMENT_HOST: '127.0.0.1',
    QL3_APPROVAL_MANAGEMENT_PORT: '8447',
    QL3_APPROVAL_MANAGEMENT_TLS_CERT_FILE: paths.certificateFile,
    QL3_APPROVAL_MANAGEMENT_TLS_KEY_FILE: paths.privateKeyFile,
    QL3_APPROVAL_MANAGEMENT_CLIENT_CA_FILE:
      paths.clientCertificateAuthorityFile,
    QL3_APPROVAL_MANAGEMENT_CLIENT_CRL_FILE:
      paths.clientCertificateRevocationListFile,
    QL3_APPROVAL_MANAGEMENT_IDENTITY_KEYSET_FILE: paths.identityKeysetFile,
    QL3_POSTGRES_APPROVAL_MANAGER_URL:
      'postgresql://ql3_approval_manager:secret@postgres.example.test/ql3',
    QL3_POSTGRES_APPROVAL_MANAGER_TLS_MODE: 'disable',
    QL3_POSTGRES_APPROVAL_MANAGER_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

async function tlsFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ql3-approval-manager-'));
  const paths = {
    certificateFile: join(directory, 'tls.crt'),
    privateKeyFile: join(directory, 'tls.key'),
    clientCertificateAuthorityFile: join(directory, 'client-ca.crt'),
    clientCertificateRevocationListFile: join(directory, 'client.crl'),
    identityKeysetFile: join(directory, 'keyset.json'),
  };
  try {
    await writeFile(
      paths.certificateFile,
      await readFile(join(FIXTURES, 'server-cert.pem')),
      { mode: 0o644 },
    );
    await writeFile(
      paths.privateKeyFile,
      await readFile(join(FIXTURES, 'server-key.pem')),
      { mode: 0o640 },
    );
    await writeFile(
      paths.clientCertificateAuthorityFile,
      await readFile(join(FIXTURES, 'ca-cert.pem')),
      { mode: 0o644 },
    );
    await writeFile(
      paths.clientCertificateRevocationListFile,
      await readFile(join(FIXTURES, 'empty-crl.pem')),
      { mode: 0o644 },
    );
    await writeFile(paths.identityKeysetFile, '{}\n', { mode: 0o644 });
    return await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('disabled Approval manager acquires no PostgreSQL or file authority', async () => {
  let opened = 0;
  const runtime = await startClusterApprovalManagementProcess({
    environment: { QL3_APPROVAL_MANAGEMENT_ENABLED: 'false' },
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
  });
  assert.equal(runtime.status, 'disabled');
  assert.equal(opened, 0);
  await runtime.close();
});

test('loads bounded low-footprint Approval-only HTTPS and PostgreSQL configuration', async () => {
  await tlsFixture(async (paths) => {
    const config = loadClusterApprovalManagementProcessConfig(
      enabledEnvironment(paths),
    );
    assert.equal(config.enabled, true);
    assert.equal(config.port, 8447);
    assert.equal(config.database.pool.maxConnections, 2);
    assert.equal(
      config.database.pool.applicationName,
      'qinglong3-approval-manager',
    );
    assert.equal(config.http.maxConnections, 32);
    assert.equal(config.http.maxConcurrentRequests, 16);
    assert.match(
      config.database.connection.connectionString,
      /^postgresql:\/\/ql3_approval_manager:/,
    );
    assert.equal(config.database.connection.tls.mode, 'disable');
  });
  assert.throws(
    () =>
      loadClusterApprovalManagementProcessConfig({
        QL3_APPROVAL_MANAGEMENT_ENABLED: 'true',
        QL3_PROFILE: 'cluster-admin',
        QL3_POSTGRES_APPROVAL_MANAGER_TLS_MODE: 'disable',
      }),
    ClusterApprovalManagementProcessConfigError,
  );
});

test('starts after dedicated readiness and identity validation then closes in order', async () => {
  await tlsFixture(async (paths) => {
    const order = [];
    let privateKey;
    let transport;
    let httpClosed = 0;
    let databaseClosed = 0;
    const pool = {
      async query() {
        throw new Error('repositories must remain lazy during composition');
      },
      async connect() {
        throw new Error('repositories must remain lazy during composition');
      },
    };
    const runtime = await startClusterApprovalManagementProcess({
      environment: enabledEnvironment(paths),
      now: () => NOW_MS,
      async openDatabase() {
        order.push('open');
        return {
          pool,
          async close() {
            order.push('database-close');
            databaseClosed += 1;
          },
        };
      },
      async assertReady(candidate) {
        order.push('ready');
        assert.equal(candidate, pool);
        return {
          ready: true,
          writablePrimary: true,
          serverVersionNum: 180004,
          serverMajor: 18,
          currentUser: 'ql3_approval_manager',
          contractName: 'control-core',
          contractVersion: 53,
          migrationIds: ['pg-0054-approval-management-boundary'],
        };
      },
      identities: {
        async reload() {
          order.push('identity');
          return {
            schemaVersion: 1,
            generation: 3,
            digest: 'identity-digest',
            issuer: 'https://identity.example.test/',
            audience: 'qinglong3-approval-management',
            activeKeyIds: ['key-3'],
            revokedKeyIds: ['key-2'],
          };
        },
        bind() {
          throw new Error('HTTP stub does not authenticate');
        },
      },
      async startHttp(options) {
        order.push('http');
        privateKey = options.tls.privateKey;
        transport = options.transport;
        assert.ok(options.tls.clientCertificateAuthority);
        assert.ok(options.tls.clientCertificateRevocationList);
        return {
          status: 'active',
          address: { host: options.host, port: options.port },
          availabilityStatus: () => 'ready',
          withdraw() {},
          async close() {
            order.push('http-close');
            httpClosed += 1;
          },
        };
      },
    });
    assert.equal(runtime.status, 'active');
    assert.deepEqual(order, ['open', 'ready', 'identity', 'http']);
    assert.equal(typeof transport.execute, 'function');
    assert.equal(privateKey.every((byte) => byte === 0), true);
    assert.equal(runtime.database.contractVersion, 53);
    await Promise.all([runtime.close(), runtime.close()]);
    assert.equal(httpClosed, 1);
    assert.equal(databaseClosed, 1);
    assert.deepEqual(order.slice(-2), ['http-close', 'database-close']);
  });
});
