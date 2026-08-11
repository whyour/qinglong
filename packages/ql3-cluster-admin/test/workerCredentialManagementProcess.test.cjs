const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { readFile, writeFile, chmod, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

const {
  ClusterWorkerCredentialManagementProcessConfigError,
  loadClusterWorkerCredentialManagementProcessConfig,
  startClusterWorkerCredentialManagementProcess,
} = require('@qinglong/cluster-admin/worker-credential-management-process');

const SERVER_KEY = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-key.pem',
);
const SERVER_CERT = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/server-cert.pem',
);
const CLIENT_CA = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/ca-cert.pem',
);
const EMPTY_CRL = resolve(
  __dirname,
  '../../ql3-cluster-control/test/fixtures/mtls/empty-crl.pem',
);
const MANAGEMENT_SERVICE_CERT = resolve(
  __dirname,
  'fixtures/management-service-cert.pem',
);
const NOW_MS = Date.UTC(2030, 0, 1);
const WORKER_ISSUER = 'https://identity.example.test/';
const WORKER_AUDIENCE = 'qinglong3-worker-credential-management';

function workerIdentityFixture() {
  const kid = 'worker-identity-key-1';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyset = {
    schemaVersion: 1,
    generation: 1,
    issuer: WORKER_ISSUER,
    audience: WORKER_AUDIENCE,
    keys: [
      {
        ...publicKey.export({ format: 'jwk' }),
        alg: 'EdDSA',
        kid,
        use: 'sig',
      },
    ],
    revokedKids: [],
    assuranceMappings: [
      {
        acr: 'urn:ql3:mfa',
        assurance: 'multi_factor',
        requiredAmr: ['pwd', 'otp'],
      },
    ],
    constraints: {
      maxAssertionBytes: 8 * 1024,
      maxLifetimeMs: 5 * 60 * 1000,
      maxAuthenticationAgeMs: 5 * 60 * 1000,
      clockSkewMs: 5 * 1000,
    },
  };
  const assertion = (type, purpose) => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', kid, typ: type }),
    ).toString('base64url');
    const now = Math.floor(NOW_MS / 1_000);
    const payload = Buffer.from(
      JSON.stringify({
        acr: 'urn:ql3:mfa',
        amr: ['pwd', 'otp'],
        aud: WORKER_AUDIENCE,
        auth_time: now - 10,
        exp: now + 120,
        iat: now,
        iss: WORKER_ISSUER,
        jti: `worker-process-${purpose}`,
        ql3_purpose: purpose,
        sub: 'worker-operator-1',
      }),
    ).toString('base64url');
    const signed = `${header}.${payload}`;
    return `${signed}.${sign(
      null,
      Buffer.from(signed, 'ascii'),
      privateKey,
    ).toString('base64url')}`;
  };
  return {
    keyset,
    workerAssertion: assertion(
      'ql3-worker-credential-management+jwt',
      'worker-credential-management',
    ),
    pluginAssertion: assertion(
      'ql3-plugin-package-management+jwt',
      'plugin-package-management',
    ),
  };
}

function identityLedgerPool() {
  let row;
  const client = {
    async query(statement, parameters = []) {
      if (statement === 'BEGIN' || statement === 'COMMIT') return { rows: [] };
      if (statement === 'ROLLBACK') return { rows: [] };
      if (statement.includes('INSERT INTO')) {
        row ??= {
          generation: parameters[1],
          digest: parameters[2],
          issuer: parameters[3],
          audience: parameters[4],
          activeKeyIds: JSON.parse(parameters[5]),
          revokedKeyIds: JSON.parse(parameters[6]),
        };
        return { rows: [] };
      }
      if (statement.includes('SELECT generation')) {
        return { rows: row === undefined ? [] : [row] };
      }
      throw new Error('unexpected identity ledger query');
    },
    release() {},
  };
  return {
    async query() {
      throw new Error('construction must not query PostgreSQL');
    },
    async connect() {
      return client;
    },
  };
}

function enabledEnvironment(paths, overrides = {}) {
  return {
    QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED: 'true',
    QL3_PROFILE: 'cluster-admin',
    QL3_WORKER_CREDENTIAL_MANAGEMENT_HOST: '127.0.0.1',
    QL3_WORKER_CREDENTIAL_MANAGEMENT_PORT: '8444',
    QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_CERT_FILE: paths.certificateFile,
    QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_KEY_FILE: paths.privateKeyFile,
    QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CA_FILE:
      paths.clientCertificateAuthorityFile,
    QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CRL_FILE:
      paths.clientCertificateRevocationListFile,
    QL3_WORKER_CREDENTIAL_MANAGEMENT_IDENTITY_KEYSET_FILE:
      paths.identityKeysetFile,
    QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_URL:
      'postgresql://ql3_worker_credential_manager:secret@postgres.example.test/ql3',
    QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_TLS_MODE: 'disable',
    QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

function readiness() {
  return {
    ready: true,
    writablePrimary: true,
    serverVersionNum: 180004,
    serverMajor: 18,
    currentUser: 'ql3_worker_credential_manager',
    contractName: 'control-core',
    contractVersion: 49,
    migrationIds: ['pg-0050-worker-credential-management-boundary'],
  };
}

function identities() {
  let reloads = 0;
  return {
    get reloads() {
      return reloads;
    },
    provider: {
      async reload() {
        reloads += 1;
        return {
          schemaVersion: 1,
          generation: 7,
          digest: 'worker-keyset-digest',
          issuer: 'https://identity.example.test/',
          audience: 'qinglong3-worker-credential-management',
          activeKeyIds: ['identity-key-7'],
          revokedKeyIds: ['identity-key-6'],
        };
      },
      bind() {
        throw new Error('HTTP stub must not authenticate');
      },
    },
  };
}

async function tlsFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ql3-worker-manager-'));
  const paths = {
    certificateFile: join(directory, 'tls.crt'),
    privateKeyFile: join(directory, 'tls.key'),
    clientCertificateAuthorityFile: join(directory, 'client-ca.crt'),
    clientCertificateRevocationListFile: join(directory, 'client.crl'),
    identityKeysetFile: join(directory, 'keyset.json'),
  };
  try {
    await writeFile(paths.certificateFile, await readFile(SERVER_CERT), {
      mode: 0o644,
    });
    await writeFile(paths.privateKeyFile, await readFile(SERVER_KEY), {
      mode: 0o640,
    });
    await writeFile(
      paths.clientCertificateAuthorityFile,
      await readFile(CLIENT_CA),
      { mode: 0o644 },
    );
    await writeFile(
      paths.clientCertificateRevocationListFile,
      await readFile(EMPTY_CRL),
      { mode: 0o644 },
    );
    await writeFile(paths.identityKeysetFile, '{}\n', { mode: 0o644 });
    return await run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('disabled Worker manager reads no profile, TLS or PostgreSQL authority', async () => {
  const reads = [];
  const environment = new Proxy(
    { QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED: 'false' },
    {
      get(target, property) {
        reads.push(property);
        if (property === 'QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED') {
          return target[property];
        }
        throw new Error(`disabled config read ${String(property)}`);
      },
    },
  );
  let opened = 0;
  const runtime = await startClusterWorkerCredentialManagementProcess({
    environment,
    async openDatabase() {
      opened += 1;
      throw new Error('must not open');
    },
  });
  assert.equal(runtime.status, 'disabled');
  assert.equal(opened, 0);
  assert.deepEqual(reads, ['QL3_WORKER_CREDENTIAL_MANAGEMENT_ENABLED']);
  await runtime.close();
});

test('loads one explicit Worker manager-only HTTPS and database configuration', () => {
  const config = loadClusterWorkerCredentialManagementProcessConfig(
    enabledEnvironment({
      certificateFile: '/run/ql3-worker-manager/tls.crt',
      privateKeyFile: '/run/ql3-worker-manager/tls.key',
      clientCertificateAuthorityFile:
        '/run/ql3-worker-manager/client-ca.crt',
      clientCertificateRevocationListFile:
        '/run/ql3-worker-manager/client.crl',
      identityKeysetFile: '/run/ql3-worker-manager/keyset.json',
    }),
  );
  assert.equal(config.enabled, true);
  assert.equal(config.profile, 'cluster-admin');
  assert.equal(config.port, 8444);
  assert.equal(
    config.clientCertificateAuthorityFile,
    '/run/ql3-worker-manager/client-ca.crt',
  );
  assert.equal(
    config.clientCertificateRevocationListFile,
    '/run/ql3-worker-manager/client.crl',
  );
  assert.equal(config.database.connection.tls.mode, 'disable');
  assert.equal(config.database.pool.maxConnections, 2);
  assert.equal(
    config.database.pool.applicationName,
    'qinglong3-worker-credential-manager',
  );
  assert.deepEqual(config.quota, {
    windowMs: 60_000,
    planLimit: 30,
    proposeLimit: 30,
    decideLimit: 60,
    inspectLimit: 600,
  });
  assert.equal(config.planLifetimeMs, 15 * 60_000);
  assert.equal(config.approvalLifetimeMs, 15 * 60_000);
});

test('rejects profile drift, implicit insecure PostgreSQL and unsafe bounds', () => {
  const paths = {
    certificateFile: '/run/ql3-worker-manager/tls.crt',
    privateKeyFile: '/run/ql3-worker-manager/tls.key',
    clientCertificateAuthorityFile:
      '/run/ql3-worker-manager/client-ca.crt',
    clientCertificateRevocationListFile:
      '/run/ql3-worker-manager/client.crl',
    identityKeysetFile: '/run/ql3-worker-manager/keyset.json',
  };
  for (const environment of [
    enabledEnvironment(paths, { QL3_PROFILE: 'cluster-control' }),
    enabledEnvironment(paths, {
      QL3_POSTGRES_WORKER_CREDENTIAL_MANAGER_ALLOW_INSECURE: 'false',
    }),
    enabledEnvironment(paths, {
      QL3_WORKER_CREDENTIAL_MANAGEMENT_TLS_KEY_FILE: 'relative.key',
    }),
    enabledEnvironment(paths, {
      QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CA_FILE: 'relative-ca.crt',
    }),
    enabledEnvironment(paths, {
      QL3_WORKER_CREDENTIAL_MANAGEMENT_CLIENT_CRL_FILE: 'relative.crl',
    }),
    enabledEnvironment(paths, {
      QL3_WORKER_CREDENTIAL_MANAGEMENT_INSPECT_QUOTA: '1001',
    }),
  ]) {
    assert.throws(
      () => loadClusterWorkerCredentialManagementProcessConfig(environment),
      ClusterWorkerCredentialManagementProcessConfigError,
    );
  }
});

test('starts after manager readiness and identity validation then closes in order', async () => {
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
    const runtime = await startClusterWorkerCredentialManagementProcess({
      environment: enabledEnvironment(paths),
      identities: identity.provider,
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
          address: { host: '127.0.0.1', port: 9444 },
          availabilityStatus: () => 'ready',
          withdraw() {},
          async close() {
            order.push('http.close');
          },
        };
      },
      now: () => NOW_MS,
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
    assert.deepEqual(runtime.identity.activeKeyIds, ['identity-key-7']);
    assert.equal(runtime.database.contractVersion, 49);

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

test('assembles the default Worker identity purpose without accepting Plugin assertions', async () => {
  await tlsFixture(async (paths) => {
    const identity = workerIdentityFixture();
    await writeFile(
      paths.identityKeysetFile,
      `${JSON.stringify(identity.keyset)}\n`,
      { mode: 0o644 },
    );
    const pool = identityLedgerPool();
    let capturedIdentities;
    const runtime = await startClusterWorkerCredentialManagementProcess({
      environment: enabledEnvironment(paths),
      async openDatabase() {
        return { pool, async close() {} };
      },
      async assertReady() {
        return readiness();
      },
      async startHttp(options) {
        capturedIdentities = options.identities;
        return {
          status: 'active',
          address: { host: '127.0.0.1', port: 9444 },
          availabilityStatus: () => 'ready',
          withdraw() {},
          async close() {},
        };
      },
      now: () => NOW_MS,
    });

    assert.ok(capturedIdentities);
    assert.deepEqual(
      (await capturedIdentities.bind(identity.workerAssertion).authenticate())
        .subject,
      { type: 'user', id: 'worker-operator-1' },
    );
    await assert.rejects(
      capturedIdentities.bind(identity.pluginAssertion).authenticate(),
      { code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID' },
    );
    await runtime.close();
  });
});

test('closes manager database when readiness or HTTP startup fails', async () => {
  await tlsFixture(async (paths) => {
    for (const failureAt of ['readiness', 'http']) {
      let closes = 0;
      await assert.rejects(
        startClusterWorkerCredentialManagementProcess({
          environment: enabledEnvironment(paths),
          identities: identities().provider,
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

test('rejects publicly readable private TLS authority before listener start', async () => {
  await tlsFixture(async (paths) => {
    await chmod(paths.privateKeyFile, 0o644);
    let starts = 0;
    await assert.rejects(
      startClusterWorkerCredentialManagementProcess({
        environment: enabledEnvironment(paths),
        identities: identities().provider,
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
      ClusterWorkerCredentialManagementProcessConfigError,
    );
    assert.equal(starts, 0);
  });
});

test('accepts a bounded client CA overlap bundle before listener start', async () => {
  await tlsFixture(async (paths) => {
    await writeFile(
      paths.clientCertificateAuthorityFile,
      Buffer.concat([
        await readFile(CLIENT_CA),
        await readFile(MANAGEMENT_SERVICE_CERT),
      ]),
      { mode: 0o644 },
    );
    let starts = 0;
    const runtime = await startClusterWorkerCredentialManagementProcess({
      environment: enabledEnvironment(paths),
      identities: identities().provider,
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
        return {
          status: 'active',
          address: { host: '127.0.0.1', port: 9444 },
          availabilityStatus: () => 'ready',
          withdraw() {},
          async close() {},
        };
      },
      now: () => NOW_MS,
    });
    assert.equal(starts, 1);
    await runtime.close();
  });
});

test('rejects malformed or unbounded client trust before listener start', async () => {
  await tlsFixture(async (paths) => {
    const authority = await readFile(CLIENT_CA);
    const leaf = await readFile(SERVER_CERT);
    const revocationList = await readFile(EMPTY_CRL);
    const invalidConfigurations = [
      {
        authority: Buffer.concat([authority, authority]),
        revocationList,
      },
      {
        authority: Buffer.concat([authority, Buffer.from('unexpected\n')]),
        revocationList,
      },
      { authority: leaf, revocationList },
      {
        authority: Buffer.concat(Array.from({ length: 17 }, () => authority)),
        revocationList,
      },
      {
        authority,
        revocationList: Buffer.concat([revocationList, revocationList]),
      },
      {
        authority,
        revocationList: Buffer.from(
          '-----BEGIN X509 CRL-----\ninvalid\n-----END X509 CRL-----\n',
        ),
      },
      {
        authority,
        revocationList,
        now: Date.UTC(2050, 0, 1),
      },
      { authority, revocationList, now: -1 },
    ];
    for (const invalid of invalidConfigurations) {
      await writeFile(paths.clientCertificateAuthorityFile, invalid.authority, {
        mode: 0o644,
      });
      await writeFile(
        paths.clientCertificateRevocationListFile,
        invalid.revocationList,
        { mode: 0o644 },
      );
      let starts = 0;
      let closes = 0;
      await assert.rejects(
        startClusterWorkerCredentialManagementProcess({
          environment: enabledEnvironment(paths),
          identities: identities().provider,
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
            return readiness();
          },
          async startHttp() {
            starts += 1;
            throw new Error('must not start');
          },
          now: () => invalid.now ?? NOW_MS,
        }),
        ClusterWorkerCredentialManagementProcessConfigError,
      );
      assert.equal(starts, 0);
      assert.equal(closes, 1);
    }
  });
});
