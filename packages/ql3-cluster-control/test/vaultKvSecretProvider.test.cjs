'use strict';

const assert = require('node:assert/strict');
const { chmod, mkdtemp, rename, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  ClusterVaultKvSecretProvider,
  ClusterVaultKvSecretProviderError,
  normalizeClusterVaultKvSecretProviderOptions,
} = require('@qinglong/cluster-control/vault-kv-secret-provider');
const {
  secretProjectionFileName,
} = require('@qinglong/runtime-core/secret-projection');

const SECRET_REF = createSecretRef({
  projectId: 'project-1',
  name: 'api-token',
});
const SECOND_SECRET_REF = createSecretRef({
  projectId: 'project-1',
  name: 'certificate',
  version: 3,
});
const ENVIRONMENT_BUNDLE_REF = createSecretRef({
  projectId: 'project-1',
  name: 'legacy-env-bundle',
  version: 4,
});

function authority(secretRefs = [SECRET_REF], environmentBundleRefs = []) {
  return {
    workerId: 'worker-1',
    workerSessionId: '018f0000-0000-7000-8000-000000000001',
    workerGeneration: 1,
    runId: 'run-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    executionDigest: 'a'.repeat(64),
    offerId: 'offer-1',
    leaseGeneration: 1,
    leaseVersion: 1,
    secretRefs,
    environmentBundleRefs,
  };
}

function lookup(policy = 'ql3-worker-secret-read', overrides = {}) {
  return {
    data: {
      policies: [policy],
      orphan: true,
      renewable: false,
      type: 'service',
      ttl: 600,
      ...overrides,
    },
  };
}

function envelope(secretRef, value, overrides = {}) {
  return {
    data: {
      data: {
        schemaVersion: 1,
        secretRefDigest: secretProjectionFileName(secretRef),
        encoding: 'base64',
        value: Buffer.from(value).toString('base64'),
        ...overrides,
      },
      metadata: {
        deletion_time: '',
        destroyed: false,
        version: 1,
      },
    },
  };
}

async function projectedFile(file, value, mode) {
  await writeFile(file, value);
  await chmod(file, mode);
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ql3-vault-kv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const caFile = path.join(directory, 'ca.pem');
  const tokenFile = path.join(directory, 'token');
  await projectedFile(caFile, 'x'.repeat(64), 0o440);
  await projectedFile(tokenFile, 'token-generation-one\n', 0o440);
  return {
    directory,
    caFile,
    tokenFile,
    options: {
      endpoint: 'https://vault.internal:8200',
      caFile,
      tokenFile,
      kvMount: 'worker-secrets',
      pathPrefix: 'values/production',
      expectedPolicy: 'ql3-worker-secret-read',
      maximumTokenTtlSeconds: 900,
      requestTimeoutMs: 5000,
      maximumConcurrency: 2,
    },
  };
}

test('normalizes only a pinned HTTPS Vault KV v2 authority', async (t) => {
  const { options } = await fixture(t);
  assert.deepEqual(
    normalizeClusterVaultKvSecretProviderOptions({
      ...options,
      namespace: 'organization/team-a',
    }),
    {
      ...options,
      endpoint: 'https://vault.internal:8200/',
      caRootDirectory: path.dirname(options.caFile),
      caFileName: path.basename(options.caFile),
      tokenRootDirectory: path.dirname(options.tokenFile),
      tokenFileName: path.basename(options.tokenFile),
      namespace: 'organization/team-a',
    },
  );
  for (const invalid of [
    { ...options, endpoint: 'http://vault.internal:8200' },
    { ...options, endpoint: 'https://user@vault.internal:8200' },
    { ...options, endpoint: 'https://vault.internal:8200/v1' },
    { ...options, caFile: 'relative.pem' },
    { ...options, kvMount: '../secret' },
    { ...options, pathPrefix: 'values//production' },
    { ...options, maximumTokenTtlSeconds: 3601 },
    { ...options, maximumConcurrency: 9 },
  ]) {
    assert.throws(
      () => normalizeClusterVaultKvSecretProviderOptions(invalid),
      ClusterVaultKvSecretProviderError,
    );
  }
});

test('revalidates the short-lived token and reads digest paths without a cache', async (t) => {
  const { options, tokenFile, directory } = await fixture(t);
  const requests = [];
  let generation = 1;
  let active = 0;
  let maximumActive = 0;
  const values = new Map([
    [secretProjectionFileName(SECRET_REF), () => `token-${generation}`],
    [secretProjectionFileName(SECOND_SECRET_REF), () => 'certificate-value'],
    [
      secretProjectionFileName(ENVIRONMENT_BUNDLE_REF),
      () =>
        JSON.stringify({
          schema: 'qinglong/environment-bundle@v1',
          entries: [{ name: 'LEGACY_VALUE', value: `bundle-${generation}` }],
        }),
    ],
  ]);
  const provider = new ClusterVaultKvSecretProvider(options, {
    async request(request, material) {
      requests.push({ ...request, token: material.token });
      if (request.path === '/v1/auth/token/lookup-self') return lookup();
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const digest = request.path.split('/').at(-1);
      const selected = values.get(digest);
      assert.ok(selected, 'only digest-derived reviewed paths are requested');
      const secretRef =
        digest === secretProjectionFileName(SECRET_REF)
          ? SECRET_REF
          : digest === secretProjectionFileName(SECOND_SECRET_REF)
          ? SECOND_SECRET_REF
          : ENVIRONMENT_BUNDLE_REF;
      return envelope(secretRef, selected());
    },
  });
  await provider.verify();
  const first = await provider.resolve(
    authority([SECRET_REF, SECOND_SECRET_REF], [ENVIRONMENT_BUNDLE_REF]),
  );
  assert.deepEqual(first.values, [
    { secretRef: SECRET_REF, value: 'token-1' },
    { secretRef: SECOND_SECRET_REF, value: 'certificate-value' },
  ]);
  assert.equal(first.environmentBundles[0].secretRef, ENVIRONMENT_BUNDLE_REF);
  assert.match(first.environmentBundles[0].value, /bundle-1/);
  await first.dispose();
  await first.dispose();
  assert.equal(maximumActive, 2);

  generation = 2;
  const replacement = path.join(directory, 'token.replacement');
  await projectedFile(replacement, 'token-generation-two\n', 0o440);
  await rename(replacement, tokenFile);
  const second = await provider.resolve(authority());
  assert.deepEqual(second.values, [
    { secretRef: SECRET_REF, value: 'token-2' },
  ]);
  await second.dispose();
  assert.equal(
    requests.filter(({ path: requestPath }) =>
      requestPath.endsWith(secretProjectionFileName(SECRET_REF)),
    ).length,
    2,
  );
  assert.equal(requests.at(-2).token, 'token-generation-two');
  assert.equal(
    requests.some(({ path: requestPath }) =>
      requestPath.includes(encodeURIComponent(SECRET_REF)),
    ),
    false,
  );
});

test('preserves an authorized empty Secret value', async (t) => {
  const { options } = await fixture(t);
  const provider = new ClusterVaultKvSecretProvider(options, {
    request(request) {
      return Promise.resolve(
        request.path === '/v1/auth/token/lookup-self'
          ? lookup()
          : envelope(SECRET_REF, ''),
      );
    },
  });
  const resolution = await provider.resolve(authority());
  assert.deepEqual(resolution.values, [{ secretRef: SECRET_REF, value: '' }]);
  await resolution.dispose();
});

test('fails closed for broad tokens, unsafe projections and untrusted material', async (t) => {
  const { options, tokenFile } = await fixture(t);
  const broad = new ClusterVaultKvSecretProvider(options, {
    request(request) {
      return Promise.resolve(
        request.path === '/v1/auth/token/lookup-self'
          ? lookup('ql3-worker-secret-read', {
              policies: ['default', 'ql3-worker-secret-read'],
            })
          : envelope(SECRET_REF, 'not-reached'),
      );
    },
  });
  await assert.rejects(
    broad.verify(),
    (error) =>
      error instanceof ClusterVaultKvSecretProviderError &&
      error.reason === 'authentication_unavailable',
  );

  const mismatched = new ClusterVaultKvSecretProvider(options, {
    request(request) {
      return Promise.resolve(
        request.path === '/v1/auth/token/lookup-self'
          ? lookup()
          : envelope(SECRET_REF, 'private-value', {
              secretRefDigest: 'f'.repeat(64),
            }),
      );
    },
  });
  await assert.rejects(
    mismatched.resolve(authority()),
    (error) =>
      error instanceof ClusterVaultKvSecretProviderError &&
      error.reason === 'material_unavailable' &&
      error.message.includes('private-value') === false,
  );

  await chmod(tokenFile, 0o666);
  const unsafe = new ClusterVaultKvSecretProvider(options, {
    request() {
      throw new Error('unsafe token must fail before transport');
    },
  });
  await assert.rejects(
    unsafe.verify(),
    (error) =>
      error instanceof ClusterVaultKvSecretProviderError &&
      error.reason === 'trust_unavailable',
  );
  await assert.rejects(
    mismatched.resolve({ ...authority(), projectId: 'other-project' }),
    ClusterVaultKvSecretProviderError,
  );
});
