'use strict';

const assert = require('node:assert/strict');
const {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  ClusterMountedSecretProvider,
  ClusterMountedSecretProviderError,
  clusterMountedSecretFileName,
  createClusterMountedSecretProvider,
} = require('@qinglong/cluster-control/mounted-secret-provider');

const SECRET_REF = createSecretRef({
  projectId: 'project-1',
  name: 'api-token',
});
const VERSIONED_SECRET_REF = createSecretRef({
  projectId: 'project-1',
  name: 'certificate',
  version: 3,
});
const ENVIRONMENT_BUNDLE_REF = createSecretRef({
  projectId: 'project-1',
  name: 'legacy-env-bundle',
  version: 4,
});

function authority(secretRefs = [SECRET_REF]) {
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
    environmentBundleRefs: [],
  };
}

async function privateFile(file, value, mode = 0o400) {
  await writeFile(file, value);
  await chmod(file, mode);
}

test('maps canonical SecretRef to a stable path-free Kubernetes key', () => {
  const first = clusterMountedSecretFileName(SECRET_REF);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(clusterMountedSecretFileName(SECRET_REF), first);
  assert.notEqual(clusterMountedSecretFileName(VERSIONED_SECRET_REF), first);
  assert.throws(
    () => clusterMountedSecretFileName('not-a-secret-ref'),
    ClusterMountedSecretProviderError,
  );
});

test('resolves every request again and observes atomic material rotation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-mounted-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const file = path.join(root, clusterMountedSecretFileName(SECRET_REF));
  await privateFile(file, 'generation-one');

  const provider = await createClusterMountedSecretProvider({
    rootDirectory: root,
  });
  const first = await provider.resolve(authority());
  assert.deepEqual(first.values, [
    { secretRef: SECRET_REF, value: 'generation-one' },
  ]);
  assert.deepEqual(first.environmentBundles, []);
  await first.dispose();

  const replacement = `${file}.replacement`;
  await privateFile(replacement, 'generation-two');
  await rename(replacement, file);
  const second = await provider.resolve(authority());
  assert.deepEqual(second.values, [
    { secretRef: SECRET_REF, value: 'generation-two' },
  ]);
  await second.dispose();
  await second.dispose();
});

test('accepts an in-root projected-volume symlink and rejects escapes or unsafe bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-projected-secret-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ql3-outside-secret-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await chmod(root, 0o700);
  const generation = path.join(root, '..data-generation-1');
  await mkdir(generation, { mode: 0o700 });
  const name = clusterMountedSecretFileName(SECRET_REF);
  await privateFile(path.join(generation, name), 'projected-value', 0o440);
  await symlink(path.join('..data-generation-1', name), path.join(root, name));

  const provider = new ClusterMountedSecretProvider({ rootDirectory: root });
  const projected = await provider.resolve(authority());
  assert.equal(projected.values[0].value, 'projected-value');
  await projected.dispose();

  await rm(path.join(root, name));
  await privateFile(path.join(outside, name), 'escaped-value');
  await symlink(path.join(outside, name), path.join(root, name));
  await assert.rejects(
    provider.resolve(authority()),
    ClusterMountedSecretProviderError,
  );

  await rm(path.join(root, name));
  await privateFile(path.join(root, name), 'world-readable', 0o444);
  await assert.rejects(
    provider.resolve(authority()),
    ClusterMountedSecretProviderError,
  );

  await rm(path.join(root, name));
  await privateFile(path.join(root, name), Buffer.from([0xff]), 0o400);
  await assert.rejects(
    provider.resolve(authority()),
    ClusterMountedSecretProviderError,
  );
});

test('fails readiness for a missing or symlinked provider root', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'ql3-secret-root-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'target');
  const link = path.join(parent, 'link');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  await assert.rejects(
    createClusterMountedSecretProvider({ rootDirectory: link }),
    ClusterMountedSecretProviderError,
  );
  await assert.rejects(
    createClusterMountedSecretProvider({
      rootDirectory: path.join(parent, 'missing'),
    }),
    ClusterMountedSecretProviderError,
  );
});

test('delivers one larger opaque environment bundle without widening normal Secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-mounted-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const value = JSON.stringify({
    schema: 'qinglong/environment-bundle@v1',
    entries: [{ name: 'LEGACY_VALUE', value: 'x'.repeat(20 * 1024) }],
  });
  await privateFile(
    path.join(root, clusterMountedSecretFileName(ENVIRONMENT_BUNDLE_REF)),
    value,
  );
  const provider = await createClusterMountedSecretProvider({
    rootDirectory: root,
  });
  const resolution = await provider.resolve({
    ...authority([]),
    environmentBundleRefs: [ENVIRONMENT_BUNDLE_REF],
  });
  assert.deepEqual(resolution.values, []);
  assert.deepEqual(resolution.environmentBundles, [
    { secretRef: ENVIRONMENT_BUNDLE_REF, value },
  ]);
  await resolution.dispose();

  await privateFile(
    path.join(root, clusterMountedSecretFileName(SECRET_REF)),
    'x'.repeat(16 * 1024 + 1),
  );
  await assert.rejects(provider.resolve(authority()), /material_unavailable/);
});
