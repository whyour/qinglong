const assert = require('node:assert/strict');
const fs = require('node:fs');
const { generateKeyPairSync } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  ClusterPluginPackageRecoveryProcessConfigError,
  loadClusterPluginPackageRegistryCredentialFile,
  loadClusterPluginPackagePublisherTrustFile,
  loadClusterPluginPackageRecoveryProcessConfig,
  runClusterPluginPackageRecoveryProcess,
} = require('@qinglong/cluster-admin/plugin-package-recovery-process');

function environment(overrides = {}) {
  return {
    QL3_CLUSTER_IDENTITY: 'cluster-production-001',
    QL3_KUBERNETES_NAMESPACE: 'qinglong3-system',
    QL3_PLUGIN_PACKAGE_OCI_REGISTRIES: 'ghcr.io,registry.example.com:5443',
    QL3_PLUGIN_PACKAGE_PUBLISHER_TRUST_FILE: '/trust/publishers.json',
    QL3_PLUGIN_PACKAGE_OCI_TIMEOUT_MS: '12000',
    QL3_PLUGIN_PACKAGE_RECOVERY_PAGE_SIZE: '8',
    QL3_PLUGIN_PACKAGE_RECOVERY_MAX_PAGES: '4',
    QL3_POSTGRES_PACKAGE_EXECUTOR_URL:
      'postgresql://ql3_package_executor:secret@postgres/qinglong',
    QL3_POSTGRES_TLS_MODE: 'disable',
    QL3_POSTGRES_ALLOW_INSECURE: 'true',
    ...overrides,
  };
}

test('loads one explicit Package-executor-only recovery process configuration', () => {
  const config = loadClusterPluginPackageRecoveryProcessConfig(environment());
  assert.equal(config.clusterIdentity, 'cluster-production-001');
  assert.equal(config.namespace, 'qinglong3-system');
  assert.equal(config.publisherTrustAuthorityId, 'cluster');
  assert.deepEqual(config.allowedRegistries, [
    'ghcr.io',
    'registry.example.com:5443',
  ]);
  assert.equal(config.requestTimeoutMs, 12_000);
  assert.equal(config.pageSize, 8);
  assert.equal(config.maxPages, 4);
  assert.equal(config.database.pool.maxConnections, 1);
  assert.equal(config.database.connection.tls.mode, 'disable');
  assert.equal('QL3_POSTGRES_RUNTIME_URL' in config.database.connection, false);
});

test('rejects runtime credentials, duplicate registries and implicit insecure PostgreSQL', async () => {
  for (const invalid of [
    environment({
      QL3_POSTGRES_PACKAGE_EXECUTOR_URL: undefined,
      QL3_POSTGRES_RUNTIME_URL:
        'postgresql://ql3_runtime:secret@postgres/qinglong',
    }),
    environment({
      QL3_PLUGIN_PACKAGE_OCI_REGISTRIES: 'ghcr.io,ghcr.io',
    }),
    environment({
      QL3_POSTGRES_ALLOW_INSECURE: undefined,
    }),
  ]) {
    assert.throws(
      () => loadClusterPluginPackageRecoveryProcessConfig(invalid),
      ClusterPluginPackageRecoveryProcessConfigError,
    );
  }

  let touched = false;
  await assert.rejects(
    runClusterPluginPackageRecoveryProcess({
      environment: environment({
        QL3_PLUGIN_PACKAGE_RECOVERY_MAX_PAGES: '65',
      }),
      openDatabase: async () => {
        touched = true;
        throw new Error('must not open');
      },
      api: {},
      stageAuthority: {},
    }),
    ClusterPluginPackageRecoveryProcessConfigError,
  );
  assert.equal(touched, false);
});

test('loads a bounded read-only publisher trust file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-publisher-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'publishers.json');
  const { publicKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schema: 'qinglong/plugin-package-publisher-trust@v1',
      keys: [
        {
          publisher: 'packages.example.com',
          keyId: 'release-2026',
          publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
          notBeforeMs: 100,
          notAfterMs: 10_000,
        },
      ],
    }),
    { mode: 0o444 },
  );
  fs.chmodSync(filePath, 0o444);
  const trust = loadClusterPluginPackagePublisherTrustFile(filePath);
  assert.equal(trust.size, 1);

  fs.chmodSync(filePath, 0o666);
  assert.throws(
    () => loadClusterPluginPackagePublisherTrustFile(filePath),
    /read-only regular file/,
  );
});

test('keeps process authority off the cluster-admin root', () => {
  const root = require('@qinglong/cluster-admin');
  const manifest = require('../package.json');
  assert.equal(root.runClusterPluginPackageRecoveryProcess, undefined);
  assert.equal(
    manifest.bin['ql3-plugin-package-recover'],
    'dist/plugin-package/recovery/pluginPackageRecoveryCli.js',
  );
});

test('binds an optional registry credential file without enabling ambient credentials', () => {
  const publicConfig = loadClusterPluginPackageRecoveryProcessConfig(
    environment(),
  );
  assert.equal(publicConfig.registryCredentialFile, undefined);
  const privateConfig = loadClusterPluginPackageRecoveryProcessConfig(
    environment({
      QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE:
        '/var/run/secrets/qinglong3/registry/credentials.json',
    }),
  );
  assert.equal(
    privateConfig.registryCredentialFile,
    '/var/run/secrets/qinglong3/registry/credentials.json',
  );
  assert.throws(
    () =>
      loadClusterPluginPackageRecoveryProcessConfig(
        environment({
          QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE: 'credentials.json',
        }),
      ),
    ClusterPluginPackageRecoveryProcessConfigError,
  );
});

test('loads exact basic and bearer registry credentials and disposes retained bytes', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-registry-credentials-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'credentials.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schema: 'qinglong/plugin-package-registry-credentials@v1',
      credentials: [
        {
          registry: 'ghcr.io',
          scheme: 'bearer',
          token: 'token.value-1',
        },
        {
          registry: 'registry.example.com:5443',
          scheme: 'basic',
          username: 'ql3-admin',
          password: 'private-password',
        },
      ],
    }),
    { mode: 0o440 },
  );
  fs.chmodSync(filePath, 0o440);
  const credentials = loadClusterPluginPackageRegistryCredentialFile(filePath, [
    'ghcr.io',
    'registry.example.com:5443',
  ]);
  assert.equal(credentials.authorizationFor('ghcr.io'), 'Bearer token.value-1');
  assert.equal(
    credentials.authorizationFor('registry.example.com:5443'),
    `Basic ${Buffer.from('ql3-admin:private-password').toString('base64')}`,
  );
  assert.equal(credentials.authorizationFor('registry.example.com'), undefined);
  credentials.dispose();
  assert.equal(credentials.authorizationFor('ghcr.io'), undefined);
  credentials.dispose();
});

test('rejects overbroad, duplicate and publicly readable registry credentials', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-invalid-registry-credentials-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'credentials.json');
  const write = (credentials, mode = 0o440) => {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schema: 'qinglong/plugin-package-registry-credentials@v1',
        credentials,
      }),
      { mode },
    );
    fs.chmodSync(filePath, mode);
  };
  write([
    {
      registry: 'not-allowed.example.com',
      scheme: 'bearer',
      token: 'private-token',
    },
  ]);
  assert.throws(
    () => loadClusterPluginPackageRegistryCredentialFile(filePath, ['ghcr.io']),
    /binding is invalid/,
  );

  write([
    {
      registry: 'ghcr.io',
      scheme: 'bearer',
      token: 'private-token',
    },
    {
      registry: 'ghcr.io',
      scheme: 'basic',
      username: 'owner',
      password: 'private-password',
    },
  ]);
  assert.throws(
    () => loadClusterPluginPackageRegistryCredentialFile(filePath, ['ghcr.io']),
    /binding is invalid/,
  );

  write(
    [
      {
        registry: 'ghcr.io',
        scheme: 'bearer',
        token: 'private-token',
      },
    ],
    0o444,
  );
  assert.throws(
    () => loadClusterPluginPackageRegistryCredentialFile(filePath, ['ghcr.io']),
    /private regular file/,
  );
});
