const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  commitLocalReconciliationCapture,
  prepareLocalReconciliationCapture,
  verifyLocalReconciliationCapture,
} = require('../dist/deployment/localDeployment.js');
const {
  createLocalDataDirectoryApplicationCommit,
} = require('@qinglong/local-sqlite/data-directory-application-commit');
const {
  advanceLocalCutoverInstanceHead,
  claimLocalCutoverInstance,
  readLocalCutoverInstanceHead,
} = require('../dist/deployment/cutover/instanceLineage.js');
const {
  readTargetDataReconciliationEvidenceForPaths,
} = require('../dist/deployment/cutover/targetDataEvidence.js');
const {
  targetRunJournalRecord,
  targetStopPhasePath,
  targetStopSequence,
} = require('../dist/deployment/cutover/target-run/targetRunJournal.js');
const {
  targetStoppedEvidence,
} = require('../dist/deployment/cutover/targetStopRecordEvidence.js');

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function rootAcknowledgement() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function fixture(
  t,
  {
    reconciliationRequired = true,
    stoppedAuthority = 'docker',
    mutateTarget,
  } = {},
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-reconciliation-capture-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deploymentRoot = path.join(root, 'runtime');
  const serviceRoot = path.join(deploymentRoot, 'service');
  const cutoverId = 'capture-cutover-1';
  const journal = path.join(serviceRoot, 'cutovers', cutoverId);
  const instanceRoot = path.join(serviceRoot, 'cutover-instances');
  const captureRoot = path.join(root, 'capture-root');
  for (const directory of [
    deploymentRoot,
    serviceRoot,
    path.dirname(journal),
    journal,
    instanceRoot,
    captureRoot,
  ]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  }
  const legacySourcePath = path.join(root, 'database.sqlite');
  const targetDatabasePath = path.join(root, 'database.ql3.sqlite');
  const recoveryPath = path.join(root, 'database.recovery.sqlite');
  const manifestPath = path.join(root, 'adoption-manifest.json');
  const activationPath = path.join(root, 'activation.json');
  const applicationConfigPath = path.join(
    deploymentRoot,
    'local-application.json',
  );
  fs.writeFileSync(legacySourcePath, 'legacy-source\n', { mode: 0o600 });
  fs.writeFileSync(targetDatabasePath, 'target-initial\n', { mode: 0o600 });
  fs.writeFileSync(recoveryPath, 'legacy-source\n', { mode: 0o600 });
  const manifestPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-adoption-manifest-fixture',
  };
  const manifestDigest = digest(manifestPayload);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifestPayload, manifestDigest })}\n`,
    { mode: 0o600 },
  );
  const targetStat = fs.statSync(targetDatabasePath, { bigint: true });
  const activationPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-activation',
    state: 'prepared',
    profile: 'edge',
    createdAtMs: 1_000,
    adoptionManifestDigest: manifestDigest,
    planDigest: '2'.repeat(64),
    sourcePathDigest: crypto
      .createHash('sha256')
      .update(legacySourcePath, 'utf8')
      .digest('hex'),
    sourceSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(legacySourcePath))
      .digest('hex'),
    recoverySha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(recoveryPath))
      .digest('hex'),
    targetSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(targetDatabasePath))
      .digest('hex'),
    targetPathDigest: crypto
      .createHash('sha256')
      .update(targetDatabasePath, 'utf8')
      .digest('hex'),
    targetDevice: targetStat.dev.toString(),
    targetInode: targetStat.ino.toString(),
  };
  const activationDigest = digest(activationPayload);
  fs.writeFileSync(
    activationPath,
    `${JSON.stringify({ ...activationPayload, activationDigest })}\n`,
    { mode: 0o600 },
  );
  let mutationEvidence = Object.freeze({});
  if (reconciliationRequired) {
    mutationEvidence =
      mutateTarget?.({ root, targetDatabasePath }) ?? Object.freeze({});
    if (mutateTarget === undefined) {
      fs.writeFileSync(targetDatabasePath, 'target-mutated\n', {
        mode: 0o600,
      });
    }
    fs.writeFileSync(`${targetDatabasePath}-wal`, 'target-wal-facts\n', {
      mode: 0o600,
    });
    fs.writeFileSync(`${legacySourcePath}-journal`, 'legacy-journal-state\n', {
      mode: 0o600,
    });
  }
  const commitmentPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId,
    profile: 'edge',
    instanceId: 'edge-router-1',
    activationDigest,
    requestedAtMs: 1_100,
    observedAtMs: 1_200,
    previousRecordDigest: '1'.repeat(64),
    controller: {
      kind: 'docker',
      endpointDigest: '2'.repeat(64),
      legacyContainerId: '3'.repeat(64),
      legacyContainerIdentityDigest: '4'.repeat(64),
      legacySourceBindingDigest: '5'.repeat(64),
    },
  };
  const commitmentDigest = digest(commitmentPayload);
  const commitmentPath = path.join(journal, '0002-legacy-stopped.json');
  fs.writeFileSync(
    commitmentPath,
    `${JSON.stringify({ ...commitmentPayload, commitmentDigest })}\n`,
    { mode: 0o600 },
  );
  const dataCommit = createLocalDataDirectoryApplicationCommit({
    mutationId: '00000000-0000-4000-8000-000000000301',
    projectId: 'project-edge-router-1',
    profile: 'edge',
    sourceStageManifestDigest: '6'.repeat(64),
    transformationDigest: '7'.repeat(64),
    modelDigest: '8'.repeat(64),
    publicationDigest: '9'.repeat(64),
    receiptDigest: 'a'.repeat(64),
    committedAtMs: 1_300,
    receipt: {
      secretCount: 0,
      environmentSecretCount: 0,
      sshSecretCount: 0,
    },
  });
  const dataCommitPath = path.join(root, 'legacy-data-commit.json');
  fs.writeFileSync(dataCommitPath, `${JSON.stringify(dataCommit)}\n`, {
    mode: 0o600,
  });
  const application = {
    schema: 'qinglong/local-application-process@v4',
    instanceId: 'edge-router-1',
    profile: 'edge',
    storage: {
      mode: 'adopted',
      sourcePath: legacySourcePath,
      targetPath: targetDatabasePath,
      recoveryPath,
      manifestPath,
      activationPath,
      expectedActivationDigest: activationDigest,
    },
    runtime: {
      receiptRoot: path.join(deploymentRoot, 'receipts'),
      artifactRoot: path.join(deploymentRoot, 'artifacts'),
      secretKeyringPath: path.join(deploymentRoot, 'local-secret-keyring.json'),
    },
    pluginPackages: {
      stagingRoot: path.join(deploymentRoot, 'plugin-staging'),
      activationRoot: path.join(deploymentRoot, 'plugin-activation'),
      recoverySource: { mode: 'disabled' },
      pageSize: 4,
      maxPages: 4,
      taskPublicationPageSize: 4,
      taskPublicationMaxPages: 4,
    },
    ai: { deployment: 'excluded' },
    cutover: {
      cutoverId,
      commitmentPath,
      expectedCommitmentDigest: commitmentDigest,
    },
    legacyDataApplication: {
      commitPath: dataCommitPath,
      expectedCommitDigest: dataCommit.commitDigest,
      expectedReceiptDigest: dataCommit.receiptDigest,
    },
  };
  const applicationContents = `${JSON.stringify(application, null, 2)}\n`;
  fs.writeFileSync(applicationConfigPath, applicationContents, { mode: 0o600 });
  const adoptedBundlePayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-adopted-deployment-bundle',
    state: 'prepared',
    bundleId: '00000000-0000-4000-8000-000000000d88',
    preparedAtMs: 1_400,
    profile: 'edge',
    instanceId: 'edge-router-1',
    cutoverId,
    serviceKind: 'compose',
    deploymentRootDigest: crypto
      .createHash('sha256')
      .update(deploymentRoot, 'utf8')
      .digest('hex'),
    sourcePathDigest: crypto
      .createHash('sha256')
      .update(legacySourcePath, 'utf8')
      .digest('hex'),
    applicationConfigDigest: crypto
      .createHash('sha256')
      .update(applicationContents, 'utf8')
      .digest('hex'),
    serviceDescriptorDigest: 'b'.repeat(64),
    composeSelectionDigest: 'c'.repeat(64),
    activationDigest,
    commitmentDigest,
    legacyDataApplicationCommitDigest: dataCommit.commitDigest,
    legacyDataApplicationReceiptDigest: dataCommit.receiptDigest,
    manifestDigest,
    sourceSha256: activationPayload.sourceSha256,
    recoverySha256: activationPayload.recoverySha256,
    targetIdentityDigest: 'd'.repeat(64),
  };
  fs.writeFileSync(
    path.join(serviceRoot, 'adopted-bundle.json'),
    `${JSON.stringify({
      ...adoptedBundlePayload,
      bundleDigest: digest(adoptedBundlePayload),
    })}\n`,
    { mode: 0o600 },
  );
  const identity = {
    options: { deploymentRoot },
    request: {
      cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      expectedActivationDigest: activationDigest,
      requestedAtMs: 2_000,
    },
  };
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  claimLocalCutoverInstance(identity, uid, '3'.repeat(64));
  advanceLocalCutoverInstanceHead(
    identity,
    uid,
    'legacy_stopped',
    0,
    '4'.repeat(64),
  );
  advanceLocalCutoverInstanceHead(
    identity,
    uid,
    'target_active',
    1,
    '5'.repeat(64),
  );
  const reconciliation = readTargetDataReconciliationEvidenceForPaths(
    {
      profile: 'edge',
      activationPath,
      legacySourcePath,
      targetDatabasePath,
      expectedActivationDigest: activationDigest,
    },
    uid,
  );
  const runCommand = {
    request: {
      cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      expectedActivationDigest: activationDigest,
      generation: 1,
      requestedAtMs: 3_000,
    },
  };
  let stoppedRecord;
  if (stoppedAuthority === 'docker') {
    stoppedRecord = targetRunJournalRecord(
      runCommand,
      targetStopSequence(1, 'outcome'),
      'target_stopped',
      '6'.repeat(64),
      targetStoppedEvidence(
        {
          activeRecordDigest: '5'.repeat(64),
          targetContainerIdentityDigest:
            mutationEvidence.targetContainerIdentityDigest ?? '7'.repeat(64),
          targetApplicationBindingDigest: '8'.repeat(64),
          startupReceiptDigest: '9'.repeat(64),
        },
        reconciliation,
      ),
    );
    fs.writeFileSync(
      targetStopPhasePath(journal, 1, 'outcome'),
      `${JSON.stringify(stoppedRecord)}\n`,
      { mode: 0o600 },
    );
  } else {
    const evidence = {
      managerOutcomeDigest: '6'.repeat(64),
      managerObservationDigest: '7'.repeat(64),
      applicationConfigDigest: '8'.repeat(64),
      activationDigest,
      commitmentDigest: '9'.repeat(64),
      targetDataIdentityDigest: 'a'.repeat(64),
      startupReceiptDigest: 'b'.repeat(64),
      shutdownReceiptDigest: 'c'.repeat(64),
      processIdentityDigest: 'd'.repeat(64),
      manualReason: null,
    };
    const payload = {
      schema: 'qinglong3-local-service-manager-cutover-record',
      schemaVersion: 1,
      actionId: '00000000-0000-4000-8000-000000000201',
      action: 'stop',
      state: 'target_stopped',
      cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      activationDigest,
      generation: 1,
      previousRecordDigest: '5'.repeat(64),
      intentDigest: 'e'.repeat(64),
      requestedAtMs: 2_500,
      completedAtMs: 3_000,
      evidence,
    };
    stoppedRecord = { ...payload, recordDigest: digest(payload) };
    fs.writeFileSync(
      path.join(journal, 'service-manager-g01-stopped.json'),
      `${JSON.stringify(stoppedRecord)}\n`,
      { mode: 0o600 },
    );
  }
  const stoppedHead = advanceLocalCutoverInstanceHead(
    identity,
    uid,
    'target_stopped',
    1,
    stoppedRecord.recordDigest,
  );
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.capture.prepare',
    options: {
      deploymentRoot,
      captureRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      captureId: '00000000-0000-4000-8000-000000000101',
      stoppedAuthority,
      profile: 'edge',
      instanceId: 'edge-router-1',
      cutoverId,
      generation: 1,
      applicationConfigPath,
      activationPath,
      legacySourcePath,
      targetDatabasePath,
      recoveryPath,
      expectedActivationDigest: activationDigest,
      expectedHeadDigest: stoppedHead.headDigest,
      expectedStoppedRecordDigest: stoppedRecord.recordDigest,
      preparedAtMs: 4_000,
    },
  };
  return {
    command,
    deploymentRoot,
    captureRoot,
    identity,
    stoppedHead,
    uid,
    legacySourcePath,
    targetDatabasePath,
    recoveryPath,
  };
}

test('capture prepare establishes one replayable reconciliation fence', (t) => {
  const state = fixture(t);
  const prepared = prepareLocalReconciliationCapture(state.command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'reconciliation_capture_prepared');
  assert.equal(
    fs.existsSync(
      path.join(
        state.captureRoot,
        state.command.request.captureId,
        'intent.json',
      ),
    ),
    true,
  );
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_capture_prepared');
  assert.equal(head.sourceRecordDigest, prepared.preparationDigest);

  const replay = prepareLocalReconciliationCapture(state.command);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.instanceHeadDigest, prepared.instanceHeadDigest);

  assert.throws(
    () =>
      advanceLocalCutoverInstanceHead(
        state.identity,
        state.uid,
        'rollback_prepared',
        1,
        'a'.repeat(64),
      ),
    /transition is invalid/,
  );
  const conflicting = structuredClone(state.command);
  conflicting.request.captureId = '00000000-0000-4000-8000-000000000102';
  assert.throws(
    () => prepareLocalReconciliationCapture(conflicting),
    /another capture owns/,
  );
});

test('capture prepare rejects rollback-candidate stopped data', (t) => {
  const state = fixture(t, { reconciliationRequired: false });
  assert.throws(
    () => prepareLocalReconciliationCapture(state.command),
    /reconciliation-required evidence/,
  );
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.headDigest, state.stoppedHead.headDigest);
  assert.equal(
    fs.existsSync(
      path.join(
        state.captureRoot,
        state.command.request.captureId,
        'intent.json',
      ),
    ),
    false,
  );
});

test('service-manager stopped authority uses the same capture fence', (t) => {
  const state = fixture(t, { stoppedAuthority: 'service-manager' });
  const prepared = prepareLocalReconciliationCapture(state.command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'reconciliation_capture_prepared');
  const replay = prepareLocalReconciliationCapture(state.command);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.preparationDigest, prepared.preparationDigest);
});

test('capture prepare CLI consumes a private command and emits no paths', (t) => {
  const state = fixture(t);
  const commandPath = path.join(state.deploymentRoot, 'capture-command.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(state.command)}\n`, {
    mode: 0o600,
  });
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-capture-prepare',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, 'reconciliation_capture_prepared');
  assert.equal(output.captureId, state.command.request.captureId);
  assert.equal(result.stdout.includes(state.captureRoot), false);
  assert.equal(
    result.stdout.includes(state.command.request.targetDatabasePath),
    false,
  );
  assert.equal(result.stderr, '');
});

function preparedCapture(t, options) {
  const state = fixture(t, options);
  const prepared = prepareLocalReconciliationCapture(state.command);
  const commitCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.capture.commit',
    options: state.command.options,
    request: {
      captureId: state.command.request.captureId,
      expectedPreparationDigest: prepared.preparationDigest,
      committedAtMs: 5_000,
    },
  };
  return { ...state, prepared, commitCommand };
}

function capturePath(state, name) {
  return path.join(state.captureRoot, state.command.request.captureId, name);
}

test('commit captures main, sidecars and recovery then verifies without sources', (t) => {
  const state = preparedCapture(t);
  fs.writeFileSync(`${state.targetDatabasePath}.unrelated`, 'ignored\n', {
    mode: 0o600,
  });
  const committed = commitLocalReconciliationCapture(state.commitCommand);
  assert.equal(committed.status, 'prepared');
  assert.equal(committed.state, 'reconciliation_captured');
  assert.equal(committed.assetCount, 5);
  const manifest = JSON.parse(
    fs.readFileSync(capturePath(state, 'manifest.json'), 'utf8'),
  );
  assert.deepEqual(
    manifest.assets.map((asset) => asset.logicalName),
    [
      'target-main',
      'target-wal',
      'legacy-main',
      'legacy-journal',
      'recovery-main',
    ],
  );
  const manifestText = fs.readFileSync(
    capturePath(state, 'manifest.json'),
    'utf8',
  );
  assert.equal(manifestText.includes(state.captureRoot), false);
  assert.equal(manifestText.includes(state.targetDatabasePath), false);
  assert.equal(manifestText.includes(state.legacySourcePath), false);
  assert.equal(
    fs.readFileSync(capturePath(state, 'assets/target-main'), 'utf8'),
    'target-mutated\n',
  );
  assert.equal(
    fs.readFileSync(capturePath(state, 'assets/target-wal'), 'utf8'),
    'target-wal-facts\n',
  );
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_captured');
  assert.equal(head.sourceRecordDigest, committed.bundleDigest);

  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.capture.verify',
    options: state.command.options,
    request: {
      captureId: state.command.request.captureId,
      expectedBundleDigest: committed.bundleDigest,
    },
  };
  assert.equal(
    verifyLocalReconciliationCapture(verifyCommand).status,
    'verified',
  );
  fs.unlinkSync(state.targetDatabasePath);
  fs.unlinkSync(state.legacySourcePath);
  fs.unlinkSync(state.recoveryPath);
  assert.equal(
    verifyLocalReconciliationCapture(verifyCommand).bundleDigest,
    committed.bundleDigest,
  );
  assert.equal(
    commitLocalReconciliationCapture(state.commitCommand).status,
    'existing',
  );
  const driftedCommit = structuredClone(state.commitCommand);
  driftedCommit.request.committedAtMs += 1;
  assert.throws(
    () => commitLocalReconciliationCapture(driftedCommit),
    /instance head binding/,
  );
});

test('commit resumes after an asset publication crash without replacement', (t) => {
  const state = preparedCapture(t);
  let failed = false;
  assert.throws(
    () =>
      commitLocalReconciliationCapture(state.commitCommand, {
        afterAssetPublished(logicalName) {
          if (!failed && logicalName === 'target-main') {
            failed = true;
            throw new Error('asset crash');
          }
        },
      }),
    /asset crash/,
  );
  const targetAsset = capturePath(state, 'assets/target-main');
  const before = fs.statSync(targetAsset, { bigint: true });
  assert.equal(fs.existsSync(capturePath(state, 'manifest.json')), false);
  const committed = commitLocalReconciliationCapture(state.commitCommand);
  const after = fs.statSync(targetAsset, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(committed.status, 'prepared');
});

test('commit resumes after manifest and receipt crash windows', (t) => {
  const manifestState = preparedCapture(t);
  assert.throws(
    () =>
      commitLocalReconciliationCapture(manifestState.commitCommand, {
        afterManifestPublished() {
          throw new Error('manifest crash');
        },
      }),
    /manifest crash/,
  );
  assert.equal(
    fs.existsSync(capturePath(manifestState, 'manifest.json')),
    true,
  );
  assert.equal(
    fs.existsSync(capturePath(manifestState, 'receipt.json')),
    false,
  );
  fs.unlinkSync(manifestState.targetDatabasePath);
  fs.unlinkSync(manifestState.legacySourcePath);
  fs.unlinkSync(manifestState.recoveryPath);
  assert.equal(
    commitLocalReconciliationCapture(manifestState.commitCommand).state,
    'reconciliation_captured',
  );

  const receiptState = preparedCapture(t, {
    stoppedAuthority: 'service-manager',
  });
  assert.throws(
    () =>
      commitLocalReconciliationCapture(receiptState.commitCommand, {
        afterReceiptPublished() {
          throw new Error('receipt crash');
        },
      }),
    /receipt crash/,
  );
  const preparedHead = readLocalCutoverInstanceHead(
    receiptState.deploymentRoot,
    receiptState.command.request.instanceId,
    receiptState.uid,
  );
  assert.equal(preparedHead.state, 'reconciliation_capture_prepared');
  fs.unlinkSync(receiptState.targetDatabasePath);
  fs.unlinkSync(receiptState.legacySourcePath);
  fs.unlinkSync(receiptState.recoveryPath);
  const resumed = commitLocalReconciliationCapture(receiptState.commitCommand);
  assert.equal(resumed.status, 'prepared');
  assert.equal(resumed.state, 'reconciliation_captured');
});

test('hard-link publication replay removes only the exact retained stage', (t) => {
  const state = preparedCapture(t);
  const cleanupError = Object.assign(new Error('stage cleanup unavailable'), {
    code: 'EIO',
  });
  assert.throws(
    () =>
      commitLocalReconciliationCapture(state.commitCommand, {
        stableCopy: {
          unlink() {
            throw cleanupError;
          },
        },
      }),
    /capture asset cannot be published/,
  );
  const target = capturePath(state, 'assets/target-main');
  const stage = capturePath(state, 'assets/.target-main.ql3-capture-stage');
  const targetBefore = fs.statSync(target, { bigint: true });
  const stageBefore = fs.statSync(stage, { bigint: true });
  assert.equal(targetBefore.ino, stageBefore.ino);
  assert.equal(targetBefore.nlink, 2n);
  const committed = commitLocalReconciliationCapture(state.commitCommand);
  assert.equal(committed.state, 'reconciliation_captured');
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.statSync(target, { bigint: true }).ino, targetBefore.ino);
});

test('ENOSPC cleans a new stage and exact replay completes', (t) => {
  const state = preparedCapture(t);
  const noSpace = Object.assign(new Error('no space'), { code: 'ENOSPC' });
  assert.throws(
    () =>
      commitLocalReconciliationCapture(state.commitCommand, {
        stableCopy: {
          write() {
            throw noSpace;
          },
        },
      }),
    /capture asset cannot be published/,
  );
  const assetsRoot = capturePath(state, 'assets');
  assert.deepEqual(fs.readdirSync(assetsRoot), []);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_capture_prepared');
  assert.equal(
    commitLocalReconciliationCapture(state.commitCommand).state,
    'reconciliation_captured',
  );
});

test('a cleanup-resistant partial stage resumes only from its exact prefix', (t) => {
  const state = preparedCapture(t);
  let writes = 0;
  assert.throws(
    () =>
      commitLocalReconciliationCapture(state.commitCommand, {
        stableCopy: {
          write(descriptor, buffer, offset, length, position) {
            writes += 1;
            if (writes === 1) {
              return fs.writeSync(
                descriptor,
                buffer,
                offset,
                Math.min(4, length),
                position,
              );
            }
            throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          },
          unlink() {
            throw Object.assign(new Error('cleanup unavailable'), {
              code: 'EIO',
            });
          },
        },
      }),
    /capture asset cannot be published/,
  );
  const stage = capturePath(state, 'assets/.target-main.ql3-capture-stage');
  assert.equal(fs.statSync(stage).size, 4);
  assert.equal(
    fs
      .readFileSync(stage)
      .equals(fs.readFileSync(state.targetDatabasePath).subarray(0, 4)),
    true,
  );
  assert.equal(
    commitLocalReconciliationCapture(state.commitCommand).state,
    'reconciliation_captured',
  );
  assert.equal(fs.existsSync(stage), false);
});

test('sidecar set drift prevents manifest publication and remains replayable', (t) => {
  const state = preparedCapture(t);
  let changed = false;
  const unexpectedSidecar = `${state.targetDatabasePath}-shm`;
  assert.throws(
    () =>
      commitLocalReconciliationCapture(state.commitCommand, {
        afterAssetPublished() {
          if (!changed) {
            changed = true;
            fs.writeFileSync(unexpectedSidecar, 'late-sidecar\n', {
              mode: 0o600,
            });
          }
        },
      }),
    /sidecar set changed/,
  );
  assert.equal(fs.existsSync(capturePath(state, 'manifest.json')), false);
  fs.unlinkSync(unexpectedSidecar);
  assert.equal(
    commitLocalReconciliationCapture(state.commitCommand).state,
    'reconciliation_captured',
  );
});

test('terminal verify rejects asset drift and CLI output remains content-free', (t) => {
  const state = preparedCapture(t);
  const committed = commitLocalReconciliationCapture(state.commitCommand);
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.capture.verify',
    options: state.command.options,
    request: {
      captureId: state.command.request.captureId,
      expectedBundleDigest: committed.bundleDigest,
    },
  };
  const verifyPath = path.join(state.deploymentRoot, 'verify-command.json');
  fs.writeFileSync(verifyPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-capture-verify',
      '--command-file',
      verifyPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(state.captureRoot), false);
  assert.equal(result.stdout.includes(state.targetDatabasePath), false);
  fs.writeFileSync(capturePath(state, 'assets/target-main'), 'drift\n');
  assert.throws(
    () => verifyLocalReconciliationCapture(verifyCommand),
    /asset drifted/,
  );
});

test(
  'real stopped Docker target produces an independently verified bundle',
  { skip: process.env.QL3_RECONCILIATION_DOCKER_GATE !== '1' },
  (t) => {
    const containerName = `ql3-reconciliation-${process.pid}-${Date.now()}`;
    t.after(() => {
      spawnSync('docker', ['rm', '--force', containerName], {
        encoding: 'utf8',
      });
    });
    const state = preparedCapture(t, {
      mutateTarget({ root }) {
        const created = spawnSync(
          'docker',
          [
            'create',
            '--name',
            containerName,
            '--mount',
            `type=bind,source=${root},target=/capture-fixture`,
            'node:24-bookworm-slim',
            'node',
            '-e',
            "require('node:fs').writeFileSync('/capture-fixture/database.ql3.sqlite','target-docker-mutated\\n')",
          ],
          { encoding: 'utf8' },
        );
        assert.equal(created.status, 0, created.stderr);
        const containerId = created.stdout.trim();
        assert.match(containerId, /^[0-9a-f]{64}$/);
        const started = spawnSync(
          'docker',
          ['start', '--attach', containerName],
          {
            encoding: 'utf8',
          },
        );
        assert.equal(started.status, 0, started.stderr);
        const inspected = spawnSync(
          'docker',
          [
            'inspect',
            '--format',
            '{{.State.Running}} {{.State.Status}}',
            containerName,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(inspected.status, 0, inspected.stderr);
        assert.equal(inspected.stdout.trim(), 'false exited');
        return Object.freeze({
          targetContainerIdentityDigest: crypto
            .createHash('sha256')
            .update(containerId, 'utf8')
            .digest('hex'),
        });
      },
    });
    const committed = commitLocalReconciliationCapture(state.commitCommand);
    assert.equal(
      fs.readFileSync(capturePath(state, 'assets/target-main'), 'utf8'),
      'target-docker-mutated\n',
    );
    const verified = verifyLocalReconciliationCapture({
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.capture.verify',
      options: state.command.options,
      request: {
        captureId: state.command.request.captureId,
        expectedBundleDigest: committed.bundleDigest,
      },
    });
    assert.equal(verified.status, 'verified');
    assert.equal(verified.bundleDigest, committed.bundleDigest);
  },
);
