const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalDeploymentConfigurationError,
  applyLocalDeploymentCompose,
  collectLocalDeploymentComposeEvidence,
  prepareLocalDeploymentAdoptedBundle,
  preflightLocalDeploymentCompose,
  restoreLocalDeploymentCompose,
  switchLocalDeploymentComposeRevision,
  verifyLocalDeploymentAdoptedBundle,
} = require('../dist/deployment/localDeployment.js');
const {
  createLocalDataDirectoryApplicationCommit,
} = require('@qinglong/local-sqlite/data-directory-application-commit');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  createLocalSqliteRolloutBackup,
} = require('@qinglong/local-sqlite/rollout-safety');
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

function releaseSelection(managementRoot, marker = 'a') {
  const image = `ghcr.io/example/qinglong3-local-application@sha256:${marker.repeat(
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
  const filePath = path.join(
    managementRoot,
    `release-selection-${marker}.json`,
  );
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
    managementRoot,
    command,
    commitPath,
    commitmentPath,
    sourcePath,
    targetPath,
    recoveryPath,
    manifestPath,
    activationPath,
  };
}

async function prepareRuntimeComposeFixture(t) {
  const state = fixture(t, 'compose');
  fs.unlinkSync(state.targetPath);
  await migrateLocalSqlitePath({
    databasePath: state.targetPath,
    profile: 'edge',
    busyTimeoutMs: 100,
  });
  const target = fs.statSync(state.targetPath, { bigint: true });
  const activation = JSON.parse(fs.readFileSync(state.activationPath, 'utf8'));
  delete activation.activationDigest;
  activation.targetSha256 = hexDigest(fs.readFileSync(state.targetPath));
  activation.targetDevice = target.dev.toString();
  activation.targetInode = target.ino.toString();
  const activationDigest = canonicalDigest(activation);
  writePrivate(state.activationPath, { ...activation, activationDigest });
  const commitment = JSON.parse(fs.readFileSync(state.commitmentPath, 'utf8'));
  delete commitment.commitmentDigest;
  commitment.activationDigest = activationDigest;
  const commitmentDigest = canonicalDigest(commitment);
  writePrivate(state.commitmentPath, { ...commitment, commitmentDigest });
  state.command.request.storage.expectedActivationDigest = activationDigest;
  state.command.request.cutover.expectedCommitmentDigest = commitmentDigest;
  prepareLocalDeploymentAdoptedBundle(state.command);
  return state;
}

function selectedComposeGeneration(state) {
  const contents = fs.readFileSync(
    path.join(state.root, 'service/compose.image.yaml'),
    'utf8',
  );
  return {
    generation: Number(/^  generation: ([0-9]+)$/m.exec(contents)[1]),
    mutationId: /^  mutation_id: ([0-9a-f-]+)$/m.exec(contents)[1],
    image: /^    image: ([^\n]+)$/m.exec(contents)[1],
    releaseSelectionDigest: /^  release_selection_digest: ([^\n]+)$/m.exec(
      contents,
    )[1],
    releaseSetDigest: /^  release_set_digest: ([^\n]+)$/m.exec(contents)[1],
    catalogManifestDigest: /^  catalog_manifest_digest: ([^\n]+)$/m.exec(
      contents,
    )[1],
    catalogConsumptionReportDigest:
      /^  catalog_consumption_report_digest: ([^\n]+)$/m.exec(contents)[1],
  };
}

function adoptedDockerHarness(state, options = {}) {
  const calls = [];
  const containerId = '1'.repeat(64);
  const bundle = JSON.parse(
    fs.readFileSync(path.join(state.root, 'service/adopted-bundle.json')),
  );
  const compose = fs.readFileSync(
    path.join(state.root, 'service/compose.yaml'),
    'utf8',
  );
  const projectName = /^name: ([a-z0-9_-]+)$/m.exec(compose)[1];
  let running = false;
  let loseNextUpResponse = options.loseNextUpResponse === true;
  const labels = (selected) => ({
    'io.qinglong.deployment.mode': 'adopted',
    'io.qinglong.deployment.profile': 'edge',
    'io.qinglong.deployment.instance': 'edge-router-1',
    'io.qinglong.deployment.bundle': bundle.bundleId,
    'io.qinglong.application.config': bundle.applicationConfigDigest,
    'io.qinglong.data.commit': bundle.legacyDataApplicationCommitDigest,
    'io.qinglong.data.receipt': bundle.legacyDataApplicationReceiptDigest,
    'io.qinglong.deployment.generation': String(selected.generation),
    'io.qinglong.deployment.mutation': selected.mutationId,
    'io.qinglong.release.selection': selected.releaseSelectionDigest,
    'io.qinglong.release.set': selected.releaseSetDigest,
    'io.qinglong.release.catalog-manifest': selected.catalogManifestDigest,
    'io.qinglong.release.catalog-report':
      selected.catalogConsumptionReportDigest,
  });
  const runDocker = ({ args }) => {
    calls.push(args);
    const selected = selectedComposeGeneration(state);
    if (args[0] === 'image') {
      return JSON.stringify([
        {
          Id: `sha256:${'2'.repeat(64)}`,
          RepoDigests: [selected.image],
          Architecture: 'arm64',
          Os: 'linux',
          Config: {
            User: '65532:65532',
            Entrypoint: [
              'node',
              '/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js',
            ],
            Labels: {
              'io.qinglong.local.sqlite-contract-min': '51',
              'io.qinglong.local.sqlite-contract-max': '52',
              'io.qinglong.local.sqlite-write-contract': '52',
              'io.qinglong.local.application-config': '2,3,4',
              'io.qinglong.local.compose-selection': '1',
              'io.qinglong.ai': 'excluded',
              'io.qinglong.profile': 'edge,standalone',
              'org.opencontainers.image.source':
                'https://github.com/whyour/qinglong',
              'org.opencontainers.image.revision': '3'.repeat(40),
              'org.opencontainers.image.version': '3.0.0-alpha.0',
            },
          },
        },
      ]);
    }
    if (args[0] === 'compose' && args.includes('config')) {
      const volumes = [
        { type: 'bind', source: state.root, target: state.root },
        {
          type: 'bind',
          source: state.sourcePath,
          target: state.sourcePath,
          read_only: true,
        },
      ];
      if (options.driftMount === true) volumes[0].target = '/var/lib/qinglong3';
      return JSON.stringify({
        name: projectName,
        services: {
          qinglong3: {
            image: selected.image,
            user: `${process.getuid()}:${process.getgid()}`,
            read_only: true,
            network_mode: 'none',
            restart: 'no',
            mem_limit: 128 * 1024 * 1024,
            pids_limit: 64,
            cap_drop: ['ALL'],
            security_opt: ['no-new-privileges:true'],
            command: [
              '--config',
              path.join(state.root, 'local-application.json'),
            ],
            labels: labels(selected),
            volumes,
            tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=16m'],
          },
        },
      });
    }
    if (args[0] === 'compose' && args.includes('up')) {
      running = true;
      if (loseNextUpResponse) {
        loseNextUpResponse = false;
        throw new Error('injected Docker response loss');
      }
      return '';
    }
    if (args[0] === 'compose' && args.includes('stop')) {
      running = false;
      return '';
    }
    if (args[0] === 'compose' && args.includes('ps')) return `${containerId}\n`;
    if (args[0] === 'container' && args[1] === 'inspect') {
      return JSON.stringify([
        {
          Id: containerId,
          State: { Running: running, Status: running ? 'running' : 'exited' },
          Config: { Image: selected.image, Labels: labels(selected) },
          HostConfig: {
            ReadonlyRootfs: true,
            NetworkMode: 'none',
            Privileged: false,
          },
        },
      ]);
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      return `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-local-application',
        level: 'info',
        event: 'active',
        profile: 'edge',
        aiStatus: 'deployment_excluded',
        instanceId: 'edge-router-1',
      })}\n`;
    }
    return '';
  };
  return {
    calls,
    runDocker,
    now: () => 10_000,
    wait: async () => {},
  };
}

function composeApplyCommand(state, generation, suffix) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.compose.apply',
    options: {
      deploymentRoot: state.root,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
      allowRootService: rootAcknowledgement(),
    },
    request: {
      expectedGeneration: generation,
      rolloutId: `00000000-0000-4000-8000-000000000d${suffix}`,
      startedAtMs: 1786416000500,
      failureRollbackMutationId: `00000000-0000-4000-8000-000000000e${suffix}`,
      failureRollbackChangedAtMs: 1786416000501,
    },
  };
}

function composePreflightCommand(state, generation) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.compose.preflight',
    options: {
      deploymentRoot: state.root,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
      allowRootService: rootAcknowledgement(),
    },
    request: { expectedGeneration: generation },
  };
}

function composeRevisionCommand(state, operation, request) {
  return {
    schemaVersion: 1,
    operation,
    options: {
      deploymentRoot: state.root,
      allowRootService: rootAcknowledgement(),
    },
    request,
  };
}

function composeRestoreCommands(state, failedCommand, suffix) {
  const options = {
    deploymentRoot: state.root,
    dockerExecutable: fs.realpathSync(process.execPath),
    dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
    allowRootService: rootAcknowledgement(),
  };
  const restoreId = `00000000-0000-4000-8000-000000000d${suffix}`;
  return {
    prepare: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.restore.prepare',
      options,
      request: {
        expectedGeneration: failedCommand.request.expectedGeneration + 1,
        restoreId,
        sourceRolloutId: failedCommand.request.rolloutId,
        preparedAtMs: 1786416000600,
      },
    },
    commit: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.restore.commit',
      options,
      request: {
        expectedGeneration: failedCommand.request.expectedGeneration + 1,
        restoreId,
        committedAtMs: 1786416000601,
      },
    },
  };
}

function composeEvidenceCollectionCommands(
  state,
  generation,
  restoreId,
  suffix,
) {
  const options = {
    deploymentRoot: state.root,
    allowRootService: rootAcknowledgement(),
  };
  const collectionId = `00000000-0000-4000-8000-000000000d${suffix}`;
  return {
    prepare: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.evidence-collection.prepare',
      options,
      request: {
        expectedGeneration: generation,
        collectionId,
        rolloutIds: [],
        restoreIds: [restoreId],
        preparedAtMs: 1786416000700,
      },
    },
    commit: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.evidence-collection.commit',
      options,
      request: {
        expectedGeneration: generation,
        collectionId,
        committedAtMs: 1786416000701,
      },
    },
  };
}

async function createFailedRestoreState(state, currentGeneration, suffix) {
  const attemptedGeneration = currentGeneration + 1;
  const upgradeMutationId = `00000000-0000-4000-8000-000000000a${suffix}`;
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: currentGeneration,
      releaseSelection: releaseSelection(
        state.managementRoot,
        String(attemptedGeneration),
      ),
      mutationId: upgradeMutationId,
      changedAtMs: 1786416000400 + attemptedGeneration,
    }),
  );
  const failedCommand = composeApplyCommand(state, attemptedGeneration, suffix);
  const intent = `${JSON.stringify(failedCommand, null, 2)}\n`;
  fs.writeFileSync(
    path.join(state.root, 'service/.compose-rollout.lock'),
    intent,
    { mode: 0o600 },
  );
  await createLocalSqliteRolloutBackup({
    databasePath: state.targetPath,
    backupPath: path.join(
      state.root,
      'service',
      'rollout-backups',
      `${failedCommand.request.rolloutId}.sqlite`,
    ),
    profile: 'edge',
  });
  const writer = new DatabaseSync(state.targetPath);
  writer.exec(`PRAGMA user_version = ${900 + attemptedGeneration}`);
  writer.close();
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.rollback', {
      expectedGeneration: attemptedGeneration,
      targetGeneration: currentGeneration,
      mutationId: failedCommand.request.failureRollbackMutationId,
      changedAtMs: failedCommand.request.failureRollbackChangedAtMs,
    }),
    intent,
  );
  return failedCommand;
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

test('converges adopted bundle publication crash windows without activation', (t) => {
  const state = fixture(t, 'compose');
  prepareLocalDeploymentAdoptedBundle(state.command);

  const applicationPath = path.join(state.root, 'local-application.json');
  const applicationStagePath = path.join(
    state.root,
    '.local-application.json.ql3-deploy-stage',
  );
  const applicationContents = fs.readFileSync(applicationPath);
  fs.unlinkSync(applicationPath);
  fs.writeFileSync(applicationStagePath, applicationContents, {
    mode: 0o600,
    flag: 'wx',
  });

  const recoveredStage = prepareLocalDeploymentAdoptedBundle(state.command);
  assert.equal(recoveredStage.status, 'prepared');
  assert.equal(recoveredStage.applicationConfiguration.status, 'prepared');
  assert.equal(fs.existsSync(applicationStagePath), false);
  assert.deepEqual(fs.readFileSync(applicationPath), applicationContents);

  const receiptPath = path.join(state.root, 'service', 'adopted-bundle.json');
  const receiptStagePath = path.join(
    state.root,
    'service',
    '.adopted-bundle.json.ql3-deploy-stage',
  );
  fs.linkSync(receiptPath, receiptStagePath);
  assert.equal(fs.statSync(receiptPath).nlink, 2);

  const recoveredLink = prepareLocalDeploymentAdoptedBundle(state.command);
  assert.equal(recoveredLink.status, 'existing');
  assert.equal(fs.existsSync(receiptStagePath), false);
  assert.equal(fs.statSync(receiptPath).nlink, 1);
  assert.equal(
    verifyLocalDeploymentAdoptedBundle({
      ...state.command,
      operation: 'local.deployment.adopted.verify',
    }).status,
    'verified',
  );
  assert.equal(
    fs.existsSync(path.join(state.root, 'service', 'intents')),
    false,
  );
});

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

test('preflights adopted Compose identity mounts and rejects mount drift', async (t) => {
  const state = await prepareRuntimeComposeFixture(t);
  const harness = adoptedDockerHarness(state);
  const ready = await preflightLocalDeploymentCompose(
    composePreflightCommand(state, 1),
    {
      runDocker: harness.runDocker,
      validateSocket() {},
    },
  );
  assert.equal(ready.status, 'ready');
  assert.equal(ready.profile, 'edge');
  assert.equal(ready.sqlite.contractVersion, 52);
  await assert.rejects(
    preflightLocalDeploymentCompose(composePreflightCommand(state, 1), {
      runDocker: adoptedDockerHarness(state, { driftMount: true }).runDocker,
      validateSocket() {},
    }),
    LocalDeploymentConfigurationError,
  );
});

const dockerComposeAvailable =
  spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status ===
  0;

test(
  'accepts the real Docker Compose adopted config projection',
  { skip: !dockerComposeAvailable },
  async (t) => {
    const state = await prepareRuntimeComposeFixture(t);
    const harness = adoptedDockerHarness(state);
    const runDocker = ({ args, ...request }) => {
      if (args[0] === 'compose' && args.includes('config')) {
        const result = spawnSync('docker', args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      }
      return harness.runDocker({ args, ...request });
    };
    const ready = await preflightLocalDeploymentCompose(
      composePreflightCommand(state, 1),
      { runDocker, validateSocket() {} },
    );
    assert.equal(ready.status, 'ready');
  },
);

test('recovers adopted Compose up response loss and binds the rollout receipt', async (t) => {
  const state = await prepareRuntimeComposeFixture(t);
  const harness = adoptedDockerHarness(state, { loseNextUpResponse: true });
  const command = composeApplyCommand(state, 1, '89');
  const dependencies = {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  };
  const applied = await applyLocalDeploymentCompose(command, dependencies);
  assert.equal(applied.status, 'active');
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    1,
  );
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(
        state.root,
        'service',
        'rollouts',
        `${command.request.rolloutId}.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.schema, 'qinglong/local-compose-rollout-receipt@v3');
  assert.equal(receipt.lineage.mode, 'adopted');
  assert.equal(
    receipt.lineage.legacyDataApplicationCommitDigest,
    state.command.request.legacyDataApplication.expectedCommitDigest,
  );
  assert.equal(
    receipt.lineage.legacyDataApplicationReceiptDigest,
    state.command.request.legacyDataApplication.expectedReceiptDigest,
  );
  const replay = await applyLocalDeploymentCompose(command, dependencies);
  assert.equal(replay.status, 'active');
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    1,
  );
  const commitment = JSON.parse(fs.readFileSync(state.commitmentPath, 'utf8'));
  writePrivate(state.commitmentPath, {
    ...commitment,
    observedAtMs: commitment.observedAtMs + 1,
  });
  await assert.rejects(
    applyLocalDeploymentCompose(command, dependencies),
    LocalDeploymentConfigurationError,
  );
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    1,
  );
});

test('preserves adopted restore identity and carries lineage through evidence collection', async (t) => {
  const state = await prepareRuntimeComposeFixture(t);
  const activated = fs.statSync(state.targetPath, { bigint: true });
  const failedCommand = await createFailedRestoreState(state, 1, '90');
  const restore = composeRestoreCommands(state, failedCommand, '91');
  const harness = adoptedDockerHarness(state);
  const dependencies = {
    runDocker: harness.runDocker,
    validateSocket() {},
  };
  const prepared = await restoreLocalDeploymentCompose(
    restore.prepare,
    dependencies,
  );
  assert.equal(prepared.status, 'prepared');
  const committed = await restoreLocalDeploymentCompose(
    restore.commit,
    dependencies,
  );
  assert.equal(committed.status, 'restored');
  const restored = fs.statSync(state.targetPath, { bigint: true });
  assert.equal(restored.dev, activated.dev);
  assert.equal(restored.ino, activated.ino);
  const commitPath = path.join(
    state.root,
    'service',
    'restores',
    `${restore.commit.request.restoreId}.commit.json`,
  );
  const restoreReceipt = JSON.parse(fs.readFileSync(commitPath, 'utf8'));
  assert.equal(
    restoreReceipt.schema,
    'qinglong/local-compose-restore-commit@v2',
  );
  assert.equal(restoreReceipt.lineage.mode, 'adopted');
  assert.equal(
    restoreReceipt.lineage.legacyDataApplicationReceiptDigest,
    state.command.request.legacyDataApplication.expectedReceiptDigest,
  );

  const applyHarness = adoptedDockerHarness(state);
  await applyLocalDeploymentCompose(failedCommand, {
    runDocker: applyHarness.runDocker,
    validateSocket() {},
    now: applyHarness.now,
    wait: applyHarness.wait,
  });
  const secondRestoreId = '00000000-0000-4000-8000-000000000d92';
  const secondSafeguard = await createLocalSqliteRolloutBackup({
    databasePath: state.targetPath,
    backupPath: path.join(
      state.root,
      'service',
      'restore-safeguards',
      `${secondRestoreId}.sqlite`,
    ),
    profile: 'edge',
  });
  const secondReceipt = {
    ...restoreReceipt,
    commandDigest: 'd'.repeat(64),
    restoreId: secondRestoreId,
    recordedAtMs: restoreReceipt.recordedAtMs + 1,
    safeguard: {
      contractVersion: secondSafeguard.contractVersion,
      sha256: secondSafeguard.sha256,
      bytes: secondSafeguard.bytes,
      pageCount: secondSafeguard.pageCount,
      pageSize: secondSafeguard.pageSize,
    },
  };
  writePrivate(
    path.join(
      state.root,
      'service',
      'restores',
      `${secondRestoreId}.commit.json`,
    ),
    `${JSON.stringify(secondReceipt, null, 2)}\n`,
  );
  const collection = composeEvidenceCollectionCommands(
    state,
    3,
    restore.commit.request.restoreId,
    '93',
  );
  const collectionPrepared = await collectLocalDeploymentComposeEvidence(
    collection.prepare,
  );
  assert.equal(collectionPrepared.status, 'prepared');
  const collectionCommitted = await collectLocalDeploymentComposeEvidence(
    collection.commit,
  );
  assert.equal(collectionCommitted.status, 'collected');
  const collectionReceipt = JSON.parse(
    fs.readFileSync(
      path.join(
        state.root,
        'service',
        'evidence-collections',
        `${collection.commit.request.collectionId}.commit.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(
    collectionReceipt.schema,
    'qinglong/local-compose-evidence-collection-commit@v2',
  );
  assert.deepEqual(collectionReceipt.lineage, restoreReceipt.lineage);
  const replay = await restoreLocalDeploymentCompose(
    restore.commit,
    dependencies,
  );
  assert.equal(replay.status, 'existing');
  assert.equal(replay.sqlite.safeguard, 'collected');
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
