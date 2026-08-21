const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalDeploymentConfigurationError,
  prepareLocalDeploymentAdoptedBundle,
  verifyLocalDeploymentAdoptedBundle,
} = require('../dist/deployment/localDeployment.js');
const {
  createLocalDataDirectoryApplicationCommit,
} = require('@qinglong/local-sqlite/data-directory-application-commit');
const {
  normalizeLocalApplicationProcessConfig,
} = require('../../ql3-local-application/dist/production-process/processConfig.js');

function rootAcknowledgement() {
  return process.getuid() === 0;
}

function hexDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function prefixedDigest(value) {
  return `sha256:${hexDigest(value)}`;
}

function canonicalDigest(value) {
  return hexDigest(JSON.stringify(value));
}

function writePrivate(filePath, value) {
  fs.writeFileSync(
    filePath,
    typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}

function releaseSelection(managementRoot) {
  const image = `ghcr.io/example/qinglong3-local-application@sha256:${'a'.repeat(
    64,
  )}`;
  const releaseSetDigest = prefixedDigest(`release-set:${image}`);
  const manifestDigest = prefixedDigest(`catalog-manifest:${image}`);
  const consumptionReportDigest = prefixedDigest(`catalog-report:${image}`);
  const unsigned = {
    schemaVersion: 1,
    schema: 'qinglong/local-compose-release-image@v2',
    release: {
      version: '3.0.0-alpha.0',
      sourceRevision: '3'.repeat(40),
      sourceRef: 'refs/tags/v3.0.0-alpha.0',
      scope: 'local',
    },
    releaseSetDigest,
    catalog: {
      schema: 'qinglong/release-catalog-consumption-ceremony@v1',
      sourceRepository: 'example/qinglong',
      workflowIdentity:
        'https://github.com/example/qinglong/.github/workflows/ql3-image-release.yml@refs/tags/v3.0.0-alpha.0',
      immutableReference: `ghcr.io/example/qinglong3-release-catalog@${manifestDigest}`,
      manifestDigest,
      consumptionReportDigest,
      releaseSetDigest,
      discoveryTagAuthority: 'none',
    },
    deploymentFamily: 'local',
    service: {
      kind: 'compose',
      image,
      allowRootService: rootAcknowledgement(),
    },
    verification: {
      releaseSet: 'standalone_structure_identity_and_self_digest',
      sourceRecordsReplayed: false,
      catalogConsumption: 'offline_reconstructed',
      externalToolResultsReplayed: false,
      networkAccess: false,
      deploymentMutation: false,
    },
  };
  const selectionDigest = prefixedDigest(JSON.stringify(unsigned));
  const filePath = path.join(managementRoot, 'release-selection.json');
  writePrivate(filePath, { ...unsigned, selectionDigest });
  return {
    path: filePath,
    expectedSelectionDigest: selectionDigest,
  };
}

function fixture(t, kind) {
  const managementRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-adopted-bundle-')),
  );
  fs.chmodSync(managementRoot, 0o700);
  t.after(() => fs.rmSync(managementRoot, { recursive: true, force: true }));
  const root = path.join(managementRoot, 'runtime');
  const serviceRoot = path.join(root, 'service');
  const cutoverId = 'cutover-edge-router-1';
  const cutoverRoot = path.join(serviceRoot, 'cutovers', cutoverId);
  const transformationRoot = path.join(root, 'transformation');
  const adoptionRoot = path.join(root, 'adoption');
  for (const directory of [
    root,
    path.join(root, 'owner-peppers'),
    path.join(root, 'owner-pepper-backup'),
    serviceRoot,
    path.join(serviceRoot, 'cutovers'),
    cutoverRoot,
    transformationRoot,
    adoptionRoot,
  ]) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  writePrivate(path.join(root, 'local-secret-keyring.json'), '{}\n');
  const sourcePath = path.join(managementRoot, 'legacy.sqlite');
  const targetPath = path.join(adoptionRoot, 'target.sqlite');
  const recoveryPath = path.join(adoptionRoot, 'recovery.sqlite');
  const manifestPath = path.join(adoptionRoot, 'manifest.json');
  const activationPath = path.join(adoptionRoot, 'activation.json');
  writePrivate(sourcePath, 'legacy source\n');
  writePrivate(targetPath, 'adopted target\n');
  writePrivate(recoveryPath, 'legacy source\n');
  const manifestPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-adoption-manifest-fixture',
  };
  const manifestDigest = canonicalDigest(manifestPayload);
  writePrivate(manifestPath, { ...manifestPayload, manifestDigest });
  const target = fs.statSync(targetPath, { bigint: true });
  const activationPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-activation',
    state: 'prepared',
    profile: 'edge',
    createdAtMs: 1786416000000,
    adoptionManifestDigest: manifestDigest,
    planDigest: '2'.repeat(64),
    sourcePathDigest: hexDigest(sourcePath),
    sourceSha256: hexDigest(fs.readFileSync(sourcePath)),
    recoverySha256: hexDigest(fs.readFileSync(recoveryPath)),
    targetSha256: hexDigest(fs.readFileSync(targetPath)),
    targetPathDigest: hexDigest(targetPath),
    targetDevice: target.dev.toString(),
    targetInode: target.ino.toString(),
  };
  const activationDigest = canonicalDigest(activationPayload);
  writePrivate(activationPath, { ...activationPayload, activationDigest });
  const commitmentPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId,
    profile: 'edge',
    instanceId: 'edge-router-1',
    activationDigest,
    requestedAtMs: 1786416000010,
    observedAtMs: 1786416000020,
    previousRecordDigest: '3'.repeat(64),
    controller: {
      kind: 'docker',
      endpointDigest: '4'.repeat(64),
      legacyContainerId: '5'.repeat(64),
      legacyContainerIdentityDigest: '6'.repeat(64),
      legacySourceBindingDigest: '7'.repeat(64),
    },
  };
  const commitmentDigest = canonicalDigest(commitmentPayload);
  const commitmentPath = path.join(cutoverRoot, '0002-legacy-stopped.json');
  writePrivate(commitmentPath, {
    ...commitmentPayload,
    commitmentDigest,
  });
  const commit = createLocalDataDirectoryApplicationCommit({
    mutationId: '00000000-0000-4000-8000-000000000001',
    projectId: 'project-edge-router-1',
    profile: 'edge',
    sourceStageManifestDigest: '8'.repeat(64),
    transformationDigest: '9'.repeat(64),
    modelDigest: 'a'.repeat(64),
    publicationDigest: 'b'.repeat(64),
    receiptDigest: 'c'.repeat(64),
    committedAtMs: 1786416000025,
    receipt: {
      secretCount: 2,
      environmentSecretCount: 1,
      sshSecretCount: 1,
    },
  });
  const commitPath = path.join(transformationRoot, 'commit.json');
  writePrivate(commitPath, commit);
  const applicationEntrypoint = fs.realpathSync(
    path.resolve(__dirname, '../../ql3-local-application/dist/cli.js'),
  );
  const service =
    kind === 'compose'
      ? {
          kind,
          releaseSelection: releaseSelection(managementRoot),
          allowRootService: rootAcknowledgement(),
        }
      : {
          kind,
          nodeExecutable: fs.realpathSync(process.execPath),
          applicationEntrypoint,
          allowRootService: rootAcknowledgement(),
        };
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.adopted.prepare',
    options: {
      deploymentRoot: root,
      profile: 'edge',
      instanceId: 'edge-router-1',
      busyTimeoutMs: 100,
      service,
    },
    request: {
      bundleId: '00000000-0000-4000-8000-000000000d88',
      preparedAtMs: 1786416000030,
      cutoverId,
      storage: {
        sourcePath,
        targetPath,
        recoveryPath,
        manifestPath,
        activationPath,
        expectedActivationDigest: activationDigest,
      },
      cutover: {
        commitmentPath,
        expectedCommitmentDigest: commitmentDigest,
      },
      legacyDataApplication: {
        commitPath,
        expectedCommitDigest: commit.commitDigest,
        expectedReceiptDigest: commit.receiptDigest,
      },
    },
  };
  return {
    root,
    command,
    commitPath,
    commitmentPath,
    sourcePath,
  };
}

for (const kind of ['systemd', 'openrc', 'compose']) {
  test(`prepares and verifies an exact adopted ${kind} bundle without activation`, (t) => {
    const state = fixture(t, kind);
    const prepared = prepareLocalDeploymentAdoptedBundle(state.command);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.service.kind, kind);
    assert.equal(
      prepareLocalDeploymentAdoptedBundle(state.command).status,
      'existing',
    );
    const verified = verifyLocalDeploymentAdoptedBundle({
      ...state.command,
      operation: 'local.deployment.adopted.verify',
    });
    assert.equal(verified.status, 'verified');
    assert.equal(verified.bundleDigest, prepared.bundleDigest);
    const application = JSON.parse(
      fs.readFileSync(path.join(state.root, 'local-application.json'), 'utf8'),
    );
    assert.equal(
      normalizeLocalApplicationProcessConfig(application).schema,
      'qinglong/local-application-process@v4',
    );
    assert.equal(application.schema, 'qinglong/local-application-process@v4');
    assert.equal(application.storage.sourcePath, state.sourcePath);
    assert.equal(
      application.legacyDataApplication.expectedCommitDigest,
      state.command.request.legacyDataApplication.expectedCommitDigest,
    );
    const receipt = JSON.parse(
      fs.readFileSync(path.join(state.root, 'service/adopted-bundle.json')),
    );
    assert.equal(
      receipt.legacyDataApplicationReceiptDigest,
      state.command.request.legacyDataApplication.expectedReceiptDigest,
    );
    assert.equal(receipt.serviceKind, kind);
    assert.equal(
      fs.existsSync(path.join(state.root, 'service/intents')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(state.root, 'setup-receipt.json')),
      false,
    );
    if (kind === 'compose') {
      const descriptor = fs.readFileSync(
        path.join(state.root, 'service/compose.yaml'),
        'utf8',
      );
      assert.match(
        descriptor,
        new RegExp(
          `source: ${state.root.replaceAll(
            '/',
            '\\/',
          )}\\n        target: ${state.root.replaceAll('/', '\\/')}`,
        ),
      );
      assert.match(
        descriptor,
        new RegExp(
          `source: ${state.sourcePath.replaceAll(
            '/',
            '\\/',
          )}\\n        target: ${state.sourcePath.replaceAll(
            '/',
            '\\/',
          )}\\n        read_only: true`,
        ),
      );
      assert.match(descriptor, /restart: "no"/);
      assert.doesNotMatch(descriptor, /\/var\/lib\/qinglong3/);
      assert.equal(
        fs.readFileSync(
          path.join(state.root, 'service/compose.image.yaml'),
          'utf8',
        ),
        fs.readFileSync(
          path.join(state.root, 'service/revisions/1.yaml'),
          'utf8',
        ),
      );
    } else {
      assert.equal(
        fs.existsSync(path.join(state.root, 'service/compose.image.yaml')),
        false,
      );
    }
  });
}

test('rejects commit drift before publishing any bundle material', (t) => {
  const state = fixture(t, 'systemd');
  const commit = JSON.parse(fs.readFileSync(state.commitPath, 'utf8'));
  writePrivate(state.commitPath, { ...commit, receiptDigest: 'd'.repeat(64) });
  assert.throws(
    () => prepareLocalDeploymentAdoptedBundle(state.command),
    LocalDeploymentConfigurationError,
  );
  assert.equal(
    fs.existsSync(path.join(state.root, 'local-application.json')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(state.root, 'service/qinglong3.service')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(state.root, 'service/adopted-bundle.json')),
    false,
  );
});

test('verify fails closed when a committed source fact drifts', (t) => {
  const state = fixture(t, 'openrc');
  prepareLocalDeploymentAdoptedBundle(state.command);
  const commitment = JSON.parse(fs.readFileSync(state.commitmentPath, 'utf8'));
  writePrivate(state.commitmentPath, {
    ...commitment,
    observedAtMs: commitment.observedAtMs + 1,
  });
  assert.throws(
    () =>
      verifyLocalDeploymentAdoptedBundle({
        ...state.command,
        operation: 'local.deployment.adopted.verify',
      }),
    LocalDeploymentConfigurationError,
  );
});

test('requires the legacy source to be the only authority outside deployment root', (t) => {
  const state = fixture(t, 'systemd');
  const sourceInside = path.join(state.root, 'legacy.sqlite');
  writePrivate(sourceInside, 'legacy source\n');
  assert.throws(
    () =>
      prepareLocalDeploymentAdoptedBundle({
        ...state.command,
        request: {
          ...state.command.request,
          storage: {
            ...state.command.request.storage,
            sourcePath: sourceInside,
          },
        },
      }),
    LocalDeploymentConfigurationError,
  );
});

test('exposes separate exact prepare and verify CLI operations', (t) => {
  const state = fixture(t, 'systemd');
  const cli = path.resolve(
    __dirname,
    '../dist/deployment/localDeploymentCli.js',
  );
  const preparePath = path.join(
    path.dirname(state.root),
    'adopted-prepare.json',
  );
  writePrivate(preparePath, state.command);
  const prepared = spawnSync(
    process.execPath,
    [cli, 'adopted-prepare', '--command-file', preparePath],
    { encoding: 'utf8' },
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).status, 'prepared');
  const verifyPath = path.join(path.dirname(state.root), 'adopted-verify.json');
  writePrivate(verifyPath, {
    ...state.command,
    operation: 'local.deployment.adopted.verify',
  });
  const verified = spawnSync(
    process.execPath,
    [cli, 'adopted-verify', '--command-file', verifyPath],
    { encoding: 'utf8' },
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).status, 'verified');
});
