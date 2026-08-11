const assert = require('node:assert/strict');
const { readFile, writeFile, chmod, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterPluginPackageManagementProcessConfigError,
  loadClusterPluginPackageManagementProcessConfig,
  startClusterPluginPackageManagementProcess,
} = require('@qinglong/cluster-admin/plugin-package-management-process');

const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);

function enabledEnvironment(paths, overrides = {}) {
  return {
    QL3_PLUGIN_PACKAGE_MANAGEMENT_ENABLED: 'true',
    QL3_PROFILE: 'cluster-admin',
    QL3_PLUGIN_PACKAGE_MANAGEMENT_HOST: '127.0.0.1',
    QL3_PLUGIN_PACKAGE_MANAGEMENT_PORT: '8443',
    QL3_PLUGIN_PACKAGE_MANAGEMENT_TLS_CERT_FILE: paths.certificateFile,
    QL3_PLUGIN_PACKAGE_MANAGEMENT_TLS_KEY_FILE: paths.privateKeyFile,
    QL3_PLUGIN_PACKAGE_MANAGEMENT_IDENTITY_KEYSET_FILE:
      paths.identityKeysetFile,
    QL3_PLUGIN_PACKAGE_PUBLISHER_TRUST_FILE: paths.publisherTrustFile,
    QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_PROJECT_ID:
      'cluster-trust-authority',
    QL3_POSTGRES_PACKAGE_MANAGER_URL:
      'postgresql://ql3_package_manager:secret@postgres.example.test/ql3',
    QL3_POSTGRES_PACKAGE_MANAGER_TLS_MODE: 'disable',
    QL3_POSTGRES_PACKAGE_MANAGER_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

function publisherAuthority() {
  const snapshot = {
    schema: 'qinglong/plugin-package-publisher-trust-snapshot@v1',
    keys: [
      {
        publisher: 'publisher-a.example',
        keyId: 'key-a',
        publicKeyDigest: 'a'.repeat(64),
        notBeforeMs: 1,
        notAfterMs: 10_000,
      },
    ],
    snapshotDigest: 'b'.repeat(64),
  };
  const head = {
    schema: 'qinglong/plugin-package-publisher-trust-head@v1',
    authorityId: 'cluster',
    generation: 1,
    baseSnapshotDigest: snapshot.snapshotDigest,
    effectiveTrustDigest: snapshot.snapshotDigest,
    updatedAtMs: 1_000,
    headDigest: 'c'.repeat(64),
  };
  return {
    publisherTrustEvidence: { registry: {}, snapshot },
    async observePublisherTrust(_pool, input) {
      assert.equal(input.authorityId, 'cluster');
      assert.deepEqual(input.snapshot, snapshot);
      return {
        status: 'created',
        head,
        effectiveSnapshot: snapshot,
      };
    },
  };
}

function readiness() {
  return {
    ready: true,
    writablePrimary: true,
    serverVersionNum: 180004,
    serverMajor: 18,
    currentUser: 'ql3_package_manager',
    contractName: 'control-core',
    contractVersion: 24,
    migrationIds: ['pg-0025-plugin-package-materialized-revisions'],
  };
}

function identities(overrides = {}) {
  let reloads = 0;
  return {
    get reloads() {
      return reloads;
    },
    provider: {
      async reload() {
        reloads += 1;
        if (overrides.reload) return overrides.reload();
        return {
          schemaVersion: 1,
          generation: 4,
          digest: 'keyset-digest',
          issuer: 'https://identity.example.test/',
          audience: 'qinglong3-package-management',
          activeKeyIds: ['identity-key-2'],
          revokedKeyIds: ['identity-key-1'],
        };
      },
      bind() {
        throw new Error('HTTP stub must not authenticate');
      },
    },
  };
}

async function tlsFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ql3-management-process-'));
  const paths = {
    certificateFile: join(directory, 'tls.crt'),
    privateKeyFile: join(directory, 'tls.key'),
    identityKeysetFile: join(directory, 'keyset.json'),
    publisherTrustFile: join(directory, 'publisher-trust.json'),
  };
  try {
    await writeFile(paths.certificateFile, await readFile(SERVER_CERT), {
      mode: 0o644,
    });
    await writeFile(paths.privateKeyFile, await readFile(SERVER_KEY), {
      mode: 0o640,
    });
    await writeFile(paths.identityKeysetFile, '{}\n', { mode: 0o644 });
    await writeFile(paths.publisherTrustFile, '{}\n', { mode: 0o644 });
    return await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('disabled gate reads no profile, trust, TLS or PostgreSQL authority', async () => {
  const reads = [];
  const environment = new Proxy(
    { QL3_PLUGIN_PACKAGE_MANAGEMENT_ENABLED: 'false' },
    {
      get(target, property) {
        reads.push(property);
        if (property === 'QL3_PLUGIN_PACKAGE_MANAGEMENT_ENABLED') {
          return target[property];
        }
        throw new Error(`disabled config read ${String(property)}`);
      },
    },
  );
  let opened = 0;
  const runtime = await startClusterPluginPackageManagementProcess({
    environment,
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
  });
  assert.equal(runtime.status, 'disabled');
  assert.equal(opened, 0);
  assert.deepEqual(reads, ['QL3_PLUGIN_PACKAGE_MANAGEMENT_ENABLED']);
  await runtime.close();
});

test('loads one explicit manager-only HTTPS and database configuration', () => {
  const paths = {
    certificateFile: '/run/ql3-management/tls.crt',
    privateKeyFile: '/run/ql3-management/tls.key',
    identityKeysetFile: '/run/ql3-management/keyset.json',
    publisherTrustFile: '/run/ql3-management/publisher-trust.json',
  };
  const config = loadClusterPluginPackageManagementProcessConfig(
    enabledEnvironment(paths),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.profile, 'cluster-admin');
  assert.equal(config.port, 8443);
  assert.equal(config.database.connection.tls.mode, 'disable');
  assert.equal(config.database.pool.maxConnections, 2);
  assert.equal(
    config.database.pool.applicationName,
    'qinglong3-plugin-package-manager',
  );
  assert.equal(config.http.maxConnections, 64);
  assert.equal(config.http.maxConcurrentRequests, 32);
  assert.equal(config.http.maxRateLimitPeers, 1024);
  assert.deepEqual(config.quota, {
    windowMs: 60_000,
    proposeLimit: 30,
    decideLimit: 60,
    inspectLimit: 600,
  });
  assert.deepEqual(config.publisherTrust, {
    file: '/run/ql3-management/publisher-trust.json',
    authorityProjectId: 'cluster-trust-authority',
    authorityId: 'cluster',
    observerId: 'cluster-package-manager',
  });
});

test('rejects profile drift, implicit insecure PostgreSQL and unsafe files', () => {
  const paths = {
    certificateFile: '/run/ql3-management/tls.crt',
    privateKeyFile: '/run/ql3-management/tls.key',
    identityKeysetFile: '/run/ql3-management/keyset.json',
    publisherTrustFile: '/run/ql3-management/publisher-trust.json',
  };
  for (const environment of [
    enabledEnvironment(paths, { QL3_PROFILE: 'cluster-control' }),
    enabledEnvironment(paths, {
      QL3_POSTGRES_PACKAGE_MANAGER_ALLOW_INSECURE: 'false',
    }),
    enabledEnvironment(paths, {
      QL3_PLUGIN_PACKAGE_MANAGEMENT_TLS_KEY_FILE: 'relative.key',
    }),
  ]) {
    assert.throws(
      () => loadClusterPluginPackageManagementProcessConfig(environment),
      ClusterPluginPackageManagementProcessConfigError,
    );
  }
});

test('rejects configured request and connection ceilings above hard bounds', () => {
  for (const overrides of [
    {
      QL3_PLUGIN_PACKAGE_MANAGEMENT_MAX_BODY_BYTES: String(256 * 1024 + 1),
    },
    { QL3_PLUGIN_PACKAGE_MANAGEMENT_MAX_CONNECTIONS: '513' },
    { QL3_PLUGIN_PACKAGE_MANAGEMENT_INSPECT_QUOTA: '1001' },
  ]) {
    assert.throws(
      () =>
        loadClusterPluginPackageManagementProcessConfig(
          enabledEnvironment(
            {
              certificateFile: '/run/ql3-management/tls.crt',
              privateKeyFile: '/run/ql3-management/tls.key',
              identityKeysetFile: '/run/ql3-management/keyset.json',
              publisherTrustFile:
                '/run/ql3-management/publisher-trust.json',
            },
            overrides,
          ),
        ),
      ClusterPluginPackageManagementProcessConfigError,
    );
  }
});

test('starts only after Package manager readiness and keyset validation then closes in order', async () => {
  await tlsFixture(async (paths) => {
    const order = [];
    const identity = identities();
    const pool = {
      async query() {
        throw new Error('construction must not query PostgreSQL');
      },
      async connect() {
        throw new Error('construction must not acquire PostgreSQL');
      },
    };
    let privateKey;
    let httpOptions;
    const runtime = await startClusterPluginPackageManagementProcess({
      environment: enabledEnvironment(paths),
      identities: identity.provider,
      ...publisherAuthority(),
      async openDatabase() {
        order.push('database.open');
        return {
          pool,
          async close() {
            order.push('database.close');
          },
        };
      },
      async assertReady(observedPool) {
        order.push('database.ready');
        assert.equal(observedPool, pool);
        return readiness();
      },
      async startHttp(options) {
        order.push('http.start');
        httpOptions = options;
        privateKey = options.tls.privateKey;
        assert.equal(
          privateKey.some((value) => value !== 0),
          true,
        );
        return {
          status: 'active',
          address: { host: '127.0.0.1', port: 9443 },
          availabilityStatus: () => 'ready',
          withdraw() {},
          async close() {
            order.push('http.close');
          },
        };
      },
      now: () => 1_000,
    });

    assert.equal(runtime.status, 'active');
    assert.deepEqual(order, ['database.open', 'database.ready', 'http.start']);
    assert.equal(identity.reloads, 1);
    assert.equal(
      privateKey.every((value) => value === 0),
      true,
    );
    assert.equal(typeof httpOptions.transport.execute, 'function');
    assert.equal(httpOptions.identities, identity.provider);
    assert.deepEqual(runtime.identity.activeKeyIds, ['identity-key-2']);
    assert.equal(runtime.database.contractVersion, 24);

    await Promise.all([runtime.close(), runtime.close()]);
    assert.deepEqual(order, [
      'database.open',
      'database.ready',
      'http.start',
      'http.close',
      'database.close',
    ]);
  });
});

test('closes the Package manager database when readiness or HTTP startup fails', async () => {
  await tlsFixture(async (paths) => {
    for (const failureAt of ['readiness', 'http']) {
      let closes = 0;
      const identity = identities();
      await assert.rejects(
        startClusterPluginPackageManagementProcess({
          environment: enabledEnvironment(paths),
          identities: identity.provider,
          ...publisherAuthority(),
          async openDatabase() {
            return {
              pool: {
                async query() {
                  throw new Error('must not query');
                },
                async connect() {
                  throw new Error('must not connect');
                },
              },
              async close() {
                closes += 1;
              },
            };
          },
          async assertReady() {
            if (failureAt === 'readiness') {
              throw new Error('readiness failed');
            }
            return readiness();
          },
          async startHttp() {
            throw new Error('HTTP failed');
          },
        }),
        new RegExp(`${failureAt} failed`, 'i'),
      );
      assert.equal(closes, 1);
    }
  });
});

test('rejects publicly readable private TLS authority before opening a listener', async () => {
  await tlsFixture(async (paths) => {
    await chmod(paths.privateKeyFile, 0o644);
    let starts = 0;
    await assert.rejects(
      startClusterPluginPackageManagementProcess({
        environment: enabledEnvironment(paths),
        identities: identities().provider,
        ...publisherAuthority(),
        async openDatabase() {
          return {
            pool: {
              async query() {
                throw new Error('must not query');
              },
              async connect() {
                throw new Error('must not connect');
              },
            },
            async close() {},
          };
        },
        async assertReady() {
          return readiness();
        },
        async startHttp() {
          starts += 1;
          throw new Error('must not start');
        },
      }),
      ClusterPluginPackageManagementProcessConfigError,
    );
    assert.equal(starts, 0);
  });
});

test('clears loaded private key bytes when certificate loading fails', async () => {
  await tlsFixture(async (paths) => {
    const privateKeyBytes = await readFile(paths.privateKeyFile);
    await chmod(paths.certificateFile, 0o666);
    const originalAllocate = Buffer.alloc;
    let privateKeyStorage;
    Buffer.alloc = function allocate(size, ...rest) {
      const bytes = originalAllocate.call(Buffer, size, ...rest);
      if (size === privateKeyBytes.length + 1 && !privateKeyStorage) {
        privateKeyStorage = bytes;
      }
      return bytes;
    };
    try {
      await assert.rejects(
        startClusterPluginPackageManagementProcess({
          environment: enabledEnvironment(paths),
          identities: identities().provider,
          ...publisherAuthority(),
          async openDatabase() {
            return {
              pool: {
                async query() {
                  throw new Error('must not query');
                },
                async connect() {
                  throw new Error('must not connect');
                },
              },
              async close() {},
            };
          },
          async assertReady() {
            return readiness();
          },
          async startHttp() {
            throw new Error('must not start');
          },
        }),
        ClusterPluginPackageManagementProcessConfigError,
      );
    } finally {
      Buffer.alloc = originalAllocate;
    }
    assert.ok(privateKeyStorage);
    assert.equal(
      privateKeyStorage.every((value) => value === 0),
      true,
    );
  });
});
