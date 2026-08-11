const assert = require('node:assert/strict');
const {
  mkdtemp,
  mkdir,
  chmod,
  symlink,
  unlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  ProjectedModelProviderSecretMaterialUnavailableError,
  createProjectedModelProviderSecretMaterialProvider,
  projectedModelProviderSecretFileName,
} = require('../dist/model-provider-credential/projectedModelProviderSecretMaterial.js');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');

const SECRET_REF = createSecretRef({
  projectId: 'project-a',
  name: 'openai-token',
});

async function generation(root, name, value, mode = 0o440) {
  const directory = join(root, name);
  await mkdir(directory);
  const path = join(
    directory,
    projectedModelProviderSecretFileName(SECRET_REF),
  );
  await writeFile(path, value, { mode });
  await chmod(path, mode);
}

async function atomicProjection(root, activeGeneration) {
  const fileName = projectedModelProviderSecretFileName(SECRET_REF);
  await symlink(activeGeneration, join(root, '..data'));
  await symlink(join('..data', fileName), join(root, fileName));
}

test('projected credential material follows atomic rotation and wipes owned bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ql3-ai-credential-'));
  await generation(root, '..data-one', 'token-one');
  await generation(root, '..data-two', 'token-two');
  await atomicProjection(root, '..data-one');
  const provider = await createProjectedModelProviderSecretMaterialProvider({
    rootDirectory: root,
  });

  const first = await provider.resolveProjectSecretMaterial({
    projectId: 'project-a',
    secretRef: SECRET_REF,
  });
  assert.equal(Buffer.from(first.bytes).toString('utf8'), 'token-one');
  const owned = first.bytes;
  await first.dispose();
  assert.deepEqual([...owned], Array(9).fill(0));

  await unlink(join(root, '..data'));
  await symlink('..data-two', join(root, '..data'));
  const second = await provider.resolveProjectSecretMaterial({
    projectId: 'project-a',
    secretRef: SECRET_REF,
  });
  assert.equal(Buffer.from(second.bytes).toString('utf8'), 'token-two');
  await second.dispose();
});

test('projected credential material rejects Project drift and writable material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ql3-ai-credential-'));
  await generation(root, '..data-one', 'unsafe-token', 0o640);
  await atomicProjection(root, '..data-one');
  const provider = await createProjectedModelProviderSecretMaterialProvider({
    rootDirectory: root,
  });
  await assert.rejects(
    provider.resolveProjectSecretMaterial({
      projectId: 'project-b',
      secretRef: SECRET_REF,
    }),
    ProjectedModelProviderSecretMaterialUnavailableError,
  );
  await assert.rejects(
    provider.resolveProjectSecretMaterial({
      projectId: 'project-a',
      secretRef: SECRET_REF,
    }),
    ProjectedModelProviderSecretMaterialUnavailableError,
  );
});

test('projected credential material rejects symlink root', async () => {
  const direct = await mkdtemp(join(tmpdir(), 'ql3-ai-credential-'));
  const parent = await mkdtemp(join(tmpdir(), 'ql3-ai-credential-link-'));
  const linked = join(parent, 'root');
  await symlink(direct, linked);
  await assert.rejects(
    createProjectedModelProviderSecretMaterialProvider({
      rootDirectory: linked,
    }),
    ProjectedModelProviderSecretMaterialUnavailableError,
  );
});
