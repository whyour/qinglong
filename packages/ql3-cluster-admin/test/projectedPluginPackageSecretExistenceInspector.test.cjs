'use strict';

const assert = require('node:assert/strict');
const {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  secretProjectionFileName,
} = require('@qinglong/runtime-core/secret-projection');
const {
  ProjectedPluginPackageSecretExistenceError,
  ProjectedPluginPackageSecretExistenceInspector,
} = require('@qinglong/cluster-admin/plugin-package-secret-existence-inspector');

const SECRET_REF = createSecretRef({
  projectId: 'project-1',
  name: 'api-token',
  version: 3,
});

test('proves an exact projected Secret without reading its bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-secret-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const file = path.join(root, secretProjectionFileName(SECRET_REF));
  await writeFile(file, 'unreadable-to-executor', { mode: 0o000 });

  const inspector = new ProjectedPluginPackageSecretExistenceInspector({
    rootDirectory: root,
  });
  await inspector.assertExists([SECRET_REF]);
  await assert.rejects(
    inspector.assertExists([
      createSecretRef({
        projectId: 'project-1',
        name: 'missing',
        version: 1,
      }),
    ]),
    (error) =>
      error instanceof ProjectedPluginPackageSecretExistenceError &&
      error.reason === 'reference_unavailable',
  );
});

test('accepts an in-root projection symlink and rejects an escape', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-secret-project-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ql3-secret-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await chmod(root, 0o700);
  await chmod(outside, 0o700);
  const name = secretProjectionFileName(SECRET_REF);
  const generation = path.join(root, '..data-v1');
  await mkdir(generation, { mode: 0o700 });
  await writeFile(path.join(generation, name), 'value', { mode: 0o000 });
  await symlink(path.join('..data-v1', name), path.join(root, name));

  const inspector = new ProjectedPluginPackageSecretExistenceInspector({
    rootDirectory: root,
  });
  await inspector.assertExists([SECRET_REF]);

  await rm(path.join(root, name));
  await writeFile(path.join(outside, name), 'value', { mode: 0o000 });
  await symlink(path.join(outside, name), path.join(root, name));
  await assert.rejects(inspector.assertExists([SECRET_REF]));
});

test('rejects duplicate, unversioned and noncanonical references', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ql3-secret-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const inspector = new ProjectedPluginPackageSecretExistenceInspector({
    rootDirectory: root,
  });
  await assert.rejects(inspector.assertExists([SECRET_REF, SECRET_REF]));
  await assert.rejects(
    inspector.assertExists([
      createSecretRef({ projectId: 'project-1', name: 'unversioned' }),
    ]),
  );
  await assert.rejects(inspector.assertExists(['not-a-secret-ref']));
});
