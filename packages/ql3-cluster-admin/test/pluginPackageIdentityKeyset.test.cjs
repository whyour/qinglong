const assert = require('node:assert/strict');
const { chmod, mkdtemp, rename, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');
const { test } = require('node:test');

const {
  ClusterPluginPackageIdentityKeysetUnavailableError,
  createClusterPluginPackageIdentityKeysetFile,
  createClusterWorkerCredentialIdentityKeysetFile,
  createClusterAutomationIdentityKeysetFile,
  createClusterApprovalIdentityKeysetFile,
  createClusterModelProviderCredentialIdentityKeysetFile,
  createClusterRunIdentityKeysetFile,
  createClusterSecurityAdministrationIdentityKeysetFile,
} = require('@qinglong/cluster-admin/plugin-package-identity-keyset');

const NOW_MS = 1_700_000_000_000;
const ISSUER = 'https://identity.example.test/';
const AUDIENCE = 'qinglong3-package-management';

function reviewedKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: 'jwk' }),
      alg: 'EdDSA',
      kid,
      use: 'sig',
    },
  };
}

function keyset(generation, keys, revokedKids = []) {
  return {
    schemaVersion: 1,
    generation,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys: keys.map((key) => key.publicJwk),
    revokedKids,
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
}

function assertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-plugin-package-management+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: AUDIENCE,
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `assertion-${key.kid}`,
      ql3_purpose: 'plugin-package-management',
      sub: 'user-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function workerAssertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-worker-credential-management+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: 'qinglong3-worker-credential-management',
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `worker-assertion-${key.kid}`,
      ql3_purpose: 'worker-credential-management',
      sub: 'worker-operator-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function automationAssertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-automation-management+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: 'qinglong3-automation-management',
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `automation-assertion-${key.kid}`,
      ql3_purpose: 'automation-management',
      sub: 'automation-operator-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function approvalAssertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-approval-management+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: 'qinglong3-approval-management',
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `approval-assertion-${key.kid}`,
      ql3_purpose: 'approval-management',
      sub: 'approval-owner-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function providerCredentialAssertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-model-provider-credential-management+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: 'qinglong3-model-provider-credential-management',
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `provider-credential-assertion-${key.kid}`,
      ql3_purpose: 'model-provider-credential-management',
      sub: 'provider-credential-operator-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function runAssertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-run-management+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: 'qinglong3-run-management',
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `run-assertion-${key.kid}`,
      ql3_purpose: 'run-management',
      sub: 'run-operator-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

function securityAdministrationAssertion(key, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({
      alg: 'EdDSA',
      kid: key.kid,
      typ: 'ql3-security-administration+jwt',
    }),
  ).toString('base64url');
  const now = Math.floor(NOW_MS / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      acr: 'urn:ql3:mfa',
      amr: ['pwd', 'otp'],
      aud: 'qinglong3-security-administration',
      auth_time: now - 10,
      exp: now + 120,
      iat: now,
      iss: ISSUER,
      jti: `security-administration-assertion-${key.kid}`,
      ql3_purpose: 'security-administration',
      sub: 'security-owner-1',
      ...overrides,
    }),
  ).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${sign(
    null,
    Buffer.from(signed, 'ascii'),
    key.privateKey,
  ).toString('base64url')}`;
}

async function atomicWrite(filePath, document) {
  const nextPath = `${filePath}.next`;
  await writeFile(nextPath, `${JSON.stringify(document)}\n`, { mode: 0o644 });
  await rename(nextPath, filePath);
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ql3-identity-keyset-'));
  const filePath = join(directory, 'keyset.json');
  try {
    return await run({ directory, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('loads one bounded keyset and authenticates through the current generation', async () => {
  await fixture(async ({ filePath }) => {
    const first = reviewedKey('issuer-key-1');
    await atomicWrite(filePath, keyset(1, [first]));
    const provider = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });

    assert.deepEqual(await provider.reload(), {
      schemaVersion: 1,
      generation: 1,
      digest: (await provider.reload()).digest,
      issuer: ISSUER,
      audience: AUDIENCE,
      activeKeyIds: ['issuer-key-1'],
      revokedKeyIds: [],
    });
    const principal = await provider.bind(assertion(first)).authenticate();
    assert.deepEqual(principal.subject, { type: 'user', id: 'user-1' });
    assert.equal(principal.assurance, 'multi_factor');
  });
});

test('loads a Worker credential keyset with a distinct assertion purpose', async () => {
  await fixture(async ({ filePath }) => {
    const key = reviewedKey('worker-identity-key-1');
    await atomicWrite(filePath, {
      ...keyset(1, [key]),
      audience: 'qinglong3-worker-credential-management',
    });
    const provider = createClusterWorkerCredentialIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });

    const principal = await provider.bind(workerAssertion(key)).authenticate();
    assert.deepEqual(principal.subject, {
      type: 'user',
      id: 'worker-operator-1',
    });
    await assert.rejects(
      provider
        .bind(
          assertion(key, {
            aud: 'qinglong3-worker-credential-management',
          }),
        )
        .authenticate(),
      { code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID' },
    );
  });
});

test('loads an automation keyset with a purpose isolated from other management planes', async () => {
  await fixture(async ({ filePath }) => {
    const key = reviewedKey('automation-identity-key-1');
    await atomicWrite(filePath, {
      ...keyset(1, [key]),
      audience: 'qinglong3-automation-management',
    });
    const provider = createClusterAutomationIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    const principal = await provider
      .bind(automationAssertion(key))
      .authenticate();
    assert.deepEqual(principal.subject, {
      type: 'user',
      id: 'automation-operator-1',
    });
    await assert.rejects(provider.bind(workerAssertion(key)).authenticate(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
    });
    await assert.rejects(provider.bind(assertion(key)).authenticate(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
    });
  });
});

test('loads an Approval keyset isolated by type, purpose and audience', async () => {
  await fixture(async ({ filePath }) => {
    const key = reviewedKey('approval-identity-key-1');
    await atomicWrite(filePath, {
      ...keyset(1, [key]),
      audience: 'qinglong3-approval-management',
    });
    const provider = createClusterApprovalIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    const principal = await provider
      .bind(approvalAssertion(key))
      .authenticate();
    assert.deepEqual(principal.subject, {
      type: 'user',
      id: 'approval-owner-1',
    });
    await assert.rejects(
      provider.bind(automationAssertion(key)).authenticate(),
      {
        code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
      },
    );
    await assert.rejects(provider.bind(assertion(key)).authenticate(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
    });
  });
});

test('loads a provider credential keyset isolated by type, purpose and audience', async () => {
  await fixture(async ({ filePath }) => {
    const key = reviewedKey('provider-credential-identity-key-1');
    await atomicWrite(filePath, {
      ...keyset(1, [key]),
      audience: 'qinglong3-model-provider-credential-management',
    });
    const provider = createClusterModelProviderCredentialIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    const principal = await provider
      .bind(providerCredentialAssertion(key))
      .authenticate();
    assert.deepEqual(principal.subject, {
      type: 'user',
      id: 'provider-credential-operator-1',
    });
    await assert.rejects(
      provider.bind(automationAssertion(key)).authenticate(),
      { code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID' },
    );
    await assert.rejects(
      provider
        .bind(
          providerCredentialAssertion(key, {
            ql3_purpose: 'automation-management',
          }),
        )
        .authenticate(),
      { code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID' },
    );
  });
});

test('loads a Run keyset isolated from every other management purpose', async () => {
  await fixture(async ({ filePath }) => {
    const key = reviewedKey('run-identity-key-1');
    await atomicWrite(filePath, {
      ...keyset(1, [key]),
      audience: 'qinglong3-run-management',
    });
    const provider = createClusterRunIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    const principal = await provider.bind(runAssertion(key)).authenticate();
    assert.deepEqual(principal.subject, {
      type: 'user',
      id: 'run-operator-1',
    });
    await assert.rejects(provider.bind(approvalAssertion(key)).authenticate(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
    });
    await assert.rejects(
      provider
        .bind(runAssertion(key, { ql3_purpose: 'approval-management' }))
        .authenticate(),
      { code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID' },
    );
  });
});

test('loads a Security Administration keyset isolated from other management purposes', async () => {
  await fixture(async ({ filePath }) => {
    const key = reviewedKey('security-administration-key-1');
    await atomicWrite(filePath, {
      ...keyset(1, [key]),
      audience: 'qinglong3-security-administration',
    });
    const provider = createClusterSecurityAdministrationIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    const principal = await provider
      .bind(securityAdministrationAssertion(key))
      .authenticate();
    assert.deepEqual(principal.subject, {
      type: 'user',
      id: 'security-owner-1',
    });
    await assert.rejects(provider.bind(runAssertion(key)).authenticate(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
    });
    await assert.rejects(
      provider
        .bind(
          securityAdministrationAssertion(key, {
            ql3_purpose: 'run-management',
          }),
        )
        .authenticate(),
      { code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID' },
    );
  });
});

test('supports overlap rotation then immediately revokes the previous key', async () => {
  await fixture(async ({ filePath }) => {
    const first = reviewedKey('issuer-key-1');
    const second = reviewedKey('issuer-key-2');
    await atomicWrite(filePath, keyset(1, [first]));
    const provider = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    await provider.reload();

    await atomicWrite(filePath, keyset(2, [first, second]));
    assert.deepEqual((await provider.reload()).activeKeyIds, [
      'issuer-key-1',
      'issuer-key-2',
    ]);
    assert.equal(
      (await provider.bind(assertion(second)).authenticate()).subject.id,
      'user-1',
    );

    await atomicWrite(filePath, keyset(3, [first, second], ['issuer-key-1']));
    assert.deepEqual(await provider.reload(), {
      schemaVersion: 1,
      generation: 3,
      digest: (await provider.reload()).digest,
      issuer: ISSUER,
      audience: AUDIENCE,
      activeKeyIds: ['issuer-key-2'],
      revokedKeyIds: ['issuer-key-1'],
    });
    await assert.rejects(provider.bind(assertion(first)).authenticate(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_ASSERTION_INVALID',
    });
    assert.equal(
      (await provider.bind(assertion(second)).authenticate()).subject.id,
      'user-1',
    );
  });
});

test('rejects generation rollback, same-generation rewrite and implicit removal', async () => {
  await fixture(async ({ filePath }) => {
    const first = reviewedKey('issuer-key-1');
    const second = reviewedKey('issuer-key-2');
    await atomicWrite(filePath, keyset(1, [first]));
    const provider = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    await provider.reload();

    await atomicWrite(filePath, keyset(1, [first, second]));
    await assert.rejects(provider.reload(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE',
    });

    await atomicWrite(filePath, keyset(2, [first, second]));
    await provider.reload();
    await atomicWrite(filePath, keyset(3, [second]));
    await assert.rejects(provider.reload(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE',
    });

    await atomicWrite(filePath, keyset(1, [first]));
    await assert.rejects(provider.reload(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE',
    });
  });
});

test('keeps revocation append-only and rejects stale fallback on file failure', async () => {
  await fixture(async ({ filePath }) => {
    const first = reviewedKey('issuer-key-1');
    const second = reviewedKey('issuer-key-2');
    await atomicWrite(filePath, keyset(1, [first, second]));
    const provider = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
    });
    await provider.reload();
    await atomicWrite(filePath, keyset(2, [first, second], ['issuer-key-1']));
    await provider.reload();

    await atomicWrite(filePath, keyset(3, [first, second]));
    await assert.rejects(provider.reload(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE',
    });

    await atomicWrite(filePath, keyset(3, [first, second], ['issuer-key-1']));
    await chmod(filePath, 0o666);
    await assert.rejects(
      provider.bind(assertion(second)).authenticate(),
      ClusterPluginPackageIdentityKeysetUnavailableError,
    );
  });
});

test('rechecks one durable ledger across unchanged files and fresh replicas', async () => {
  await fixture(async ({ filePath }) => {
    const first = reviewedKey('issuer-key-1');
    const second = reviewedKey('issuer-key-2');
    let minimumGeneration = 1;
    const observations = [];
    const ledger = {
      async observe(snapshot) {
        observations.push(snapshot);
        if (snapshot.generation < minimumGeneration) {
          throw new Error('durable generation rollback');
        }
        minimumGeneration = snapshot.generation;
      },
    };
    await atomicWrite(filePath, keyset(1, [first]));
    const firstReplica = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
      ledger,
    });
    await firstReplica.reload();
    await firstReplica.reload();
    assert.equal(observations.length, 2);

    await atomicWrite(filePath, keyset(2, [first, second], ['issuer-key-1']));
    await firstReplica.reload();
    assert.equal(minimumGeneration, 2);

    await atomicWrite(filePath, keyset(1, [first]));
    const restartedReplica = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      now: () => NOW_MS,
      ledger,
    });
    await assert.rejects(
      restartedReplica.reload(),
      ClusterPluginPackageIdentityKeysetUnavailableError,
    );

    await atomicWrite(filePath, keyset(2, [first, second], ['issuer-key-1']));
    minimumGeneration = 3;
    await assert.rejects(
      firstReplica.bind(assertion(second)).authenticate(),
      ClusterPluginPackageIdentityKeysetUnavailableError,
    );
  });
});

test('rejects malformed, private and oversized trust documents', async () => {
  await fixture(async ({ filePath }) => {
    const first = reviewedKey('issuer-key-1');
    const provider = createClusterPluginPackageIdentityKeysetFile({
      filePath,
      maxFileBytes: 4 * 1024,
      now: () => NOW_MS,
    });

    await atomicWrite(filePath, {
      ...keyset(1, [first]),
      keys: [{ ...first.publicJwk, d: 'private' }],
    });
    await assert.rejects(provider.reload(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE',
    });

    await writeFile(filePath, Buffer.alloc(4 * 1024 + 1, 0x20), {
      mode: 0o644,
    });
    await assert.rejects(provider.reload(), {
      code: 'CLUSTER_PLUGIN_PACKAGE_IDENTITY_KEYSET_UNAVAILABLE',
    });
  });
});
