const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const rootExport = require('@qinglong/cluster-control');
const {
  CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA,
  ClusterCopilotFailureDiagnosisOutputProjectedKeyring,
  ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError,
  InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError,
  canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest,
  createClusterCopilotFailureDiagnosisOutputProjectedKeyring,
  normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest,
} = require('@qinglong/cluster-control/failure-diagnosis-output-keyring');

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(label = 'ql3-copilot-output-keyring-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function manifest(activeKeyId, keys) {
  return Object.freeze({
    schema:
      CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_KEYRING_MANIFEST_SCHEMA,
    activeKeyId,
    keys: Object.freeze(keys),
  });
}

async function publish(root, generationName, value, mode = 0o440) {
  const generation = path.join(root, generationName);
  await fs.mkdir(generation, { mode: 0o750 });
  const target = path.join(generation, 'keyring.json');
  await fs.writeFile(
    target,
    canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest(value),
    { mode },
  );
  await fs.chmod(target, mode);
  const next = path.join(root, '..data-next');
  await fs.symlink(generationName, next);
  await fs.rename(next, path.join(root, '..data'));
  try {
    await fs.symlink('..data/keyring.json', path.join(root, 'keyring.json'));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

test('projected Copilot output keyring rotates active material without caching', async () => {
  const root = await tempRoot();
  const keyOne = Buffer.alloc(32, 0x31);
  const keyTwo = Buffer.alloc(32, 0x32);
  await publish(
    root,
    '..2026_08_15_01',
    manifest('copilot-output-one', {
      'copilot-output-one': keyOne.toString('base64url'),
    }),
  );
  const provider =
    await createClusterCopilotFailureDiagnosisOutputProjectedKeyring({
      rootDirectory: root,
    });
  const first = await provider.active();
  assert.equal(first.keyId, 'copilot-output-one');
  assert.deepEqual(Buffer.from(first.key), keyOne);
  first.key.fill(0);

  await publish(
    root,
    '..2026_08_15_02',
    manifest('copilot-output-two', {
      'copilot-output-one': keyOne.toString('base64url'),
      'copilot-output-two': keyTwo.toString('base64url'),
    }),
  );
  const second = await provider.active();
  assert.equal(second.keyId, 'copilot-output-two');
  assert.deepEqual(Buffer.from(second.key), keyTwo);
  second.key.fill(0);
  const historical = await provider.resolve('copilot-output-one');
  assert.ok(historical);
  assert.deepEqual(Buffer.from(historical.key), keyOne);
  historical.key.fill(0);
  assert.equal(await provider.resolve('missing-key'), null);

  const summary = await provider.verify();
  assert.deepEqual(summary.keyIds, [
    'copilot-output-one',
    'copilot-output-two',
  ]);
  assert.equal(summary.activeKeyId, 'copilot-output-two');
  assert.match(summary.projectionDigest, /^[0-9a-f]{64}$/);
});

test('manifest rejects missing active, wrong domains and non-canonical material', () => {
  const key = Buffer.alloc(32, 0x41).toString('base64url');
  assert.throws(
    () =>
      normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest({
        ...manifest('missing-key', { 'copilot-output-one': key }),
      }),
    InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError,
  );
  assert.throws(
    () =>
      normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest({
        ...manifest('copilot-output-one', { 'copilot-output-one': key }),
        schema: 'qinglong/cluster-tool-invocation-projected-keyring@v1',
      }),
    InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError,
  );
  assert.throws(
    () =>
      normalizeClusterCopilotFailureDiagnosisOutputKeyringManifest(
        manifest('copilot-output-one', {
          'copilot-output-one': Buffer.alloc(31, 0x41).toString('base64url'),
        }),
      ),
    InvalidClusterCopilotFailureDiagnosisOutputKeyringManifestError,
  );
  assert.equal(
    rootExport.ClusterCopilotFailureDiagnosisOutputProjectedKeyring,
    undefined,
  );
});

test('projected Copilot output keyring rejects writable and escaping files', async () => {
  const writableRoot = await tempRoot();
  const key = Buffer.alloc(32, 0x51).toString('base64url');
  await publish(
    writableRoot,
    '..2026_08_15_01',
    manifest('copilot-output-one', { 'copilot-output-one': key }),
    0o640,
  );
  await assert.rejects(
    () =>
      new ClusterCopilotFailureDiagnosisOutputProjectedKeyring({
        rootDirectory: writableRoot,
      }).verify(),
    ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError,
  );

  const escapeRoot = await tempRoot();
  const outsideRoot = await tempRoot('ql3-copilot-output-outside-');
  const outsideFile = path.join(outsideRoot, 'keyring.json');
  await fs.writeFile(
    outsideFile,
    canonicalClusterCopilotFailureDiagnosisOutputKeyringManifest(
      manifest('copilot-output-one', { 'copilot-output-one': key }),
    ),
    { mode: 0o440 },
  );
  await fs.chmod(outsideFile, 0o440);
  await fs.symlink(outsideFile, path.join(escapeRoot, 'keyring.json'));
  await assert.rejects(
    () =>
      new ClusterCopilotFailureDiagnosisOutputProjectedKeyring({
        rootDirectory: escapeRoot,
      }).verify(),
    ClusterCopilotFailureDiagnosisOutputProjectedKeyringUnavailableError,
  );
});
