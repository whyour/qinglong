const assert = require('node:assert/strict');
const {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const {
  ClusterAdministrationKubernetesInputStageError,
  stageClusterAdministrationKubernetesInputs,
} = require('../dist/security-administration/clusterAdministrationKubernetesInputStage.js');

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function projectedInput() {
  const root = mkdtempSync(join(tmpdir(), 'ql3-security-admin-stage-'));
  roots.push(root);
  const sourceDirectory = join(root, 'projected');
  const versionDirectory = join(sourceDirectory, '..2026_08_25_00_00_00');
  mkdirSync(versionDirectory, { mode: 0o700, recursive: true });
  const inputs = {
    'command.json': '{"schemaVersion":1,"operation":"audit.list"}\n',
    'assertion.jwt': 'signed.assertion.value',
    'keyset.json': '{"keys":[]}',
    pepper: 'A'.repeat(43),
  };
  for (const [name, value] of Object.entries(inputs)) {
    const versionFile = join(versionDirectory, name);
    writeFileSync(versionFile, value, { mode: 0o440 });
    symlinkSync(join('..data', name), join(sourceDirectory, name));
  }
  symlinkSync('..2026_08_25_00_00_00', join(sourceDirectory, '..data'));
  return {
    root,
    sourceDirectory,
    targetDirectory: join(root, 'private-input'),
    deliveryDirectory: join(root, 'private-delivery'),
    inputs,
  };
}

function mode(filePath) {
  return lstatSync(filePath).mode & 0o777;
}

test('copies a Kubernetes projected Secret into a private immutable input boundary', () => {
  const fixture = projectedInput();

  const result = stageClusterAdministrationKubernetesInputs({
    sourceDirectory: fixture.sourceDirectory,
    targetDirectory: fixture.targetDirectory,
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    component: 'qinglong3-security-administration-kubernetes-input-stage',
    stagedFileCount: 4,
    deliveryDirectoryPrepared: false,
  });
  assert.equal(mode(fixture.targetDirectory), 0o700);
  for (const [name, value] of Object.entries(fixture.inputs)) {
    const target = join(fixture.targetDirectory, name);
    assert.equal(mode(target), 0o600);
    assert.equal(readFileSync(target, 'utf8'), value);
    assert.equal(lstatSync(target).isSymbolicLink(), false);
  }
  assert.equal(
    JSON.stringify(result).includes('signed.assertion.value'),
    false,
  );
  assert.equal(JSON.stringify(result).includes('A'.repeat(43)), false);
});

test('prepares a private persistent delivery directory without weakening it', () => {
  const fixture = projectedInput();

  const first = stageClusterAdministrationKubernetesInputs({
    sourceDirectory: fixture.sourceDirectory,
    targetDirectory: fixture.targetDirectory,
    deliveryDirectory: fixture.deliveryDirectory,
  });

  assert.equal(first.deliveryDirectoryPrepared, true);
  assert.equal(mode(fixture.deliveryDirectory), 0o700);

  const secondTarget = join(fixture.root, 'second-private-input');
  const second = stageClusterAdministrationKubernetesInputs({
    sourceDirectory: fixture.sourceDirectory,
    targetDirectory: secondTarget,
    deliveryDirectory: fixture.deliveryDirectory,
  });
  assert.equal(second.deliveryDirectoryPrepared, true);
  assert.equal(mode(fixture.deliveryDirectory), 0o700);
});

test('rejects a projected input symlink that escapes the Secret authority', () => {
  const fixture = projectedInput();
  const external = join(fixture.root, 'external-command.json');
  writeFileSync(external, 'outside', { mode: 0o400 });
  unlinkSync(join(fixture.sourceDirectory, 'command.json'));
  symlinkSync(external, join(fixture.sourceDirectory, 'command.json'));

  assert.throws(
    () =>
      stageClusterAdministrationKubernetesInputs({
        sourceDirectory: fixture.sourceDirectory,
        targetDirectory: fixture.targetDirectory,
      }),
    (error) =>
      error instanceof ClusterAdministrationKubernetesInputStageError &&
      /escapes/.test(error.message),
  );
  assert.throws(() => lstatSync(fixture.targetDirectory));
});

test('rejects source material readable by every local process', () => {
  const fixture = projectedInput();
  chmodSync(resolve(fixture.sourceDirectory, '..data', 'assertion.jwt'), 0o444);

  assert.throws(
    () =>
      stageClusterAdministrationKubernetesInputs({
        sourceDirectory: fixture.sourceDirectory,
        targetDirectory: fixture.targetDirectory,
      }),
    /file authority is invalid/,
  );
  assert.throws(() => lstatSync(fixture.targetDirectory));
});

test('never replaces an existing private input directory', () => {
  const fixture = projectedInput();
  mkdirSync(fixture.targetDirectory, { mode: 0o700 });
  const sentinel = join(fixture.targetDirectory, 'sentinel');
  writeFileSync(sentinel, 'preserve', { mode: 0o600 });

  assert.throws(
    () =>
      stageClusterAdministrationKubernetesInputs({
        sourceDirectory: fixture.sourceDirectory,
        targetDirectory: fixture.targetDirectory,
      }),
    /must not already exist/,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
});

test('CLI emits only bounded content-free failures', () => {
  const cli = join(
    __dirname,
    '../dist/security-administration/clusterAdministrationKubernetesInputStageCli.js',
  );
  const sensitive = 'ql3c_private-token-material';

  const result = spawnSync(
    process.execPath,
    [cli, `--source=/${sensitive}`, '--target=relative'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 64);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes(sensitive), false);
  assert.deepEqual(JSON.parse(result.stderr), {
    schemaVersion: 1,
    component: 'qinglong3-security-administration-kubernetes-input-stage',
    event: 'stage_failed',
    name: 'ClusterAdministrationKubernetesInputStageError',
    code: 'QL3_CLUSTER_ADMINISTRATION_KUBERNETES_INPUT_STAGE_INVALID',
  });
});
