const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  commitLocalReconciliationCapture,
  commitLocalReconciliationApplication,
  commitLocalReconciliationAutomationDecision,
  commitLocalReconciliationSecretConfigDecision,
  applyLocalReconciliationSecretConfig,
  completeLocalReconciliation,
  applyLocalReconciliationAutomation,
  commitLocalReconciliationPlan,
  commitLocalReconciliationReview,
  prepareLocalReconciliationCapture,
  prepareLocalReconciliationApplication,
  prepareLocalReconciliationAutomationDecision,
  prepareLocalReconciliationSecretConfigDecision,
  preserveLocalReconciliationRunHistory,
  readLocalReconciliationAutomationDecisionTerminal,
  readLocalReconciliationSecretConfigDecisionTerminal,
  rollbackLocalReconciliationAutomationApply,
  rollbackLocalReconciliationSecretConfigApply,
  planLocalReconciliationAutomation,
  planLocalReconciliationSecretConfig,
  prepareLocalReconciliationPlan,
  prepareLocalReconciliationReview,
  verifyLocalReconciliationCapture,
  verifyLocalReconciliationApplication,
  verifyLocalReconciliationAutomationDecision,
  verifyLocalReconciliationSecretConfigDecision,
  verifyLocalReconciliationSecretConfigApply,
  verifyLocalReconciliationAutomationApply,
  verifyLocalReconciliationAutomationPlan,
  verifyLocalReconciliationSecretConfigPlan,
  verifyLocalReconciliationCompletion,
  verifyLocalReconciliationPlan,
  verifyLocalReconciliationReview,
  verifyLocalReconciliationRunHistory,
  writeLocalReconciliationReviewDiagnostics,
} = require('../dist/deployment/localDeployment.js');
const { provisionLocalSecretKeyring } = require('@qinglong/local-secret');
const {
  normalizeLocalReconciliationCaptureManifest,
} = require('../dist/deployment/reconciliation/bundle.js');
const {
  writeLocalReconciliationAutomationPlan,
} = require('../dist/deployment/reconciliation/application/automation/rowPlan.js');
const {
  createLocalDataDirectoryApplicationCommit,
} = require('@qinglong/local-sqlite/data-directory-application-commit');
const {
  applyPreparedReconciliationSecretConfigApplication,
} = require('@qinglong/local-admin/reconciliation-secret-and-config-application');
const {
  advanceLocalCutoverInstanceHead,
  assertLocalCutoverTargetHead,
  claimLocalCutoverInstance,
  readLocalCutoverInstanceHead,
} = require('../dist/deployment/cutover/instanceLineage.js');
const {
  readTargetDataReconciliationEvidenceForPaths,
} = require('../dist/deployment/cutover/targetDataEvidence.js');
const {
  adoptedTargetBaselinePath,
  createAdoptedTargetBaseline,
} = require('../dist/deployment/cutover/targetBaseline.js');
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

const CAPTURE_ASSET_NAMES = Object.freeze({
  'target-main': 'target.sqlite',
  'target-wal': 'target.sqlite-wal',
  'target-shm': 'target.sqlite-shm',
  'target-journal': 'target.sqlite-journal',
  'legacy-main': 'legacy.sqlite',
  'legacy-wal': 'legacy.sqlite-wal',
  'legacy-shm': 'legacy.sqlite-shm',
  'legacy-journal': 'legacy.sqlite-journal',
  'recovery-main': 'recovery.sqlite',
});

function removeFixtureRoot(root) {
  if (!fs.existsSync(root)) return;
  const unlock = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(candidate, 0o700);
      for (const name of fs.readdirSync(candidate)) {
        unlock(path.join(candidate, name));
      }
    } else if (!stat.isSymbolicLink()) {
      fs.chmodSync(candidate, 0o600);
    }
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture(
  t,
  {
    reconciliationRequired = true,
    stoppedAuthority = 'docker',
    profile = 'edge',
    createDefaultSidecars = true,
    useAdoptedTargetBaseline = false,
    targetInsideDeploymentRoot = false,
    initializeDatabases,
    mutateTarget,
  } = {},
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-reconciliation-capture-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => removeFixtureRoot(root));
  const deploymentRoot = path.join(root, 'runtime');
  const sqliteRoot = path.join(deploymentRoot, 'sqlite');
  const serviceRoot = path.join(deploymentRoot, 'service');
  const cutoverId = 'capture-cutover-1';
  const journal = path.join(serviceRoot, 'cutovers', cutoverId);
  const instanceRoot = path.join(serviceRoot, 'cutover-instances');
  const captureRoot = path.join(root, 'capture-root');
  for (const directory of [
    deploymentRoot,
    sqliteRoot,
    serviceRoot,
    path.dirname(journal),
    journal,
    instanceRoot,
    captureRoot,
  ]) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  }
  const legacySourcePath = path.join(root, 'database.sqlite');
  const targetDatabasePath = targetInsideDeploymentRoot
    ? path.join(sqliteRoot, 'database.ql3.sqlite')
    : path.join(root, 'database.ql3.sqlite');
  const recoveryPath = path.join(root, 'database.recovery.sqlite');
  const manifestPath = path.join(root, 'adoption-manifest.json');
  const activationPath = path.join(root, 'activation.json');
  const applicationConfigPath = path.join(
    deploymentRoot,
    'local-application.json',
  );
  if (initializeDatabases === undefined) {
    fs.writeFileSync(legacySourcePath, 'legacy-source\n', { mode: 0o600 });
    fs.writeFileSync(targetDatabasePath, 'target-initial\n', { mode: 0o600 });
    fs.writeFileSync(recoveryPath, 'legacy-source\n', { mode: 0o600 });
  } else {
    initializeDatabases({
      legacySourcePath,
      recoveryPath,
      targetDatabasePath,
    });
  }
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
    profile,
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
    if (createDefaultSidecars) {
      fs.writeFileSync(`${targetDatabasePath}-wal`, 'target-wal-facts\n', {
        mode: 0o600,
      });
      fs.writeFileSync(
        `${legacySourcePath}-journal`,
        'legacy-journal-state\n',
        {
          mode: 0o600,
        },
      );
    }
  }
  const commitmentPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId,
    profile,
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
    profile,
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
    profile,
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
  let adoptedTargetBaseline;
  if (useAdoptedTargetBaseline) {
    adoptedTargetBaseline = createAdoptedTargetBaseline({
      preparedAtMs: 1_350,
      profile,
      instanceId: 'edge-router-1',
      cutoverId,
      activationDigest,
      commitmentDigest,
      applicationConfigDigest: crypto
        .createHash('sha256')
        .update(applicationContents, 'utf8')
        .digest('hex'),
      legacyDataApplicationCommitDigest: dataCommit.commitDigest,
      legacyDataApplicationReceiptDigest: dataCommit.receiptDigest,
      targetPathDigest: activationPayload.targetPathDigest,
      targetDevice: activationPayload.targetDevice,
      targetInode: activationPayload.targetInode,
      targetSha256: activationPayload.targetSha256,
    });
    fs.writeFileSync(
      adoptedTargetBaselinePath(deploymentRoot),
      `${JSON.stringify(adoptedTargetBaseline)}\n`,
      { mode: 0o600 },
    );
  }
  const adoptedBundlePayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-adopted-deployment-bundle',
    state: 'prepared',
    bundleId: '00000000-0000-4000-8000-000000000d88',
    preparedAtMs: 1_400,
    profile,
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
      profile,
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
      profile,
      activationPath,
      legacySourcePath,
      targetDatabasePath,
      expectedActivationDigest: activationDigest,
      ...(adoptedTargetBaseline === undefined
        ? {}
        : {
            adoptedTargetBaseline: {
              baselineDigest: adoptedTargetBaseline.baselineDigest,
              targetDevice: adoptedTargetBaseline.targetDevice,
              targetInode: adoptedTargetBaseline.targetInode,
              targetSha256: adoptedTargetBaseline.targetSha256,
            },
          }),
    },
    uid,
  );
  const runCommand = {
    request: {
      cutoverId,
      profile,
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
      profile,
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
      profile,
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
    activation: Object.freeze({ ...activationPayload, activationDigest }),
    deploymentRoot,
    captureRoot,
    identity,
    stoppedHead,
    uid,
    legacySourcePath,
    targetDatabasePath,
    recoveryPath,
    adoptedTargetBaseline,
    reconciliation,
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

test('capture prepare preserves exact adopted-target baseline evidence', (t) => {
  const state = fixture(t, {
    createDefaultSidecars: false,
    useAdoptedTargetBaseline: true,
  });
  assert.ok(state.adoptedTargetBaseline);
  assert.equal(state.reconciliation.baselineKind, 'adopted_target');
  assert.equal(
    state.reconciliation.baselineDigest,
    state.adoptedTargetBaseline.baselineDigest,
  );
  assert.equal(state.reconciliation.targetMatchesBaseline, false);
  const prepared = prepareLocalReconciliationCapture(state.command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'reconciliation_capture_prepared');
});

test('capture prepare rejects a valid but detached adopted-target baseline', (t) => {
  const state = fixture(t, {
    createDefaultSidecars: false,
    useAdoptedTargetBaseline: true,
  });
  const baselinePath = adoptedTargetBaselinePath(state.deploymentRoot);
  const detachedBaseline = createAdoptedTargetBaseline({
    ...state.adoptedTargetBaseline,
    targetSha256: 'f'.repeat(64),
  });
  fs.writeFileSync(baselinePath, `${JSON.stringify(detachedBaseline)}\n`, {
    mode: 0o600,
  });
  assert.throws(
    () => prepareLocalReconciliationCapture(state.command),
    /adopted target baseline is detached from stopped evidence/,
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

function planningDatabaseInitializer({ unknownTargetTable = false } = {}) {
  return ({ legacySourcePath, recoveryPath, targetDatabasePath }) => {
    const legacy = new DatabaseSync(legacySourcePath);
    legacy.exec(`
      CREATE TABLE "Crontabs" (id INTEGER PRIMARY KEY, schedule TEXT NOT NULL);
      CREATE TABLE "Envs" (id INTEGER PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL);
      INSERT INTO "Crontabs" (id, schedule) VALUES (1, '0 0 * * *');
      INSERT INTO "Envs" (id, name, value) VALUES (1, 'TOKEN', 'private-value');
    `);
    legacy.close();
    fs.chmodSync(legacySourcePath, 0o600);
    fs.copyFileSync(legacySourcePath, recoveryPath);
    fs.chmodSync(recoveryPath, 0o600);

    const target = new DatabaseSync(targetDatabasePath);
    target.exec(`
      CREATE TABLE "QingLong3SchemaCapabilities" (id INTEGER PRIMARY KEY);
      CREATE TABLE "QingLong3TaskDefinitions" (id INTEGER PRIMARY KEY);
      CREATE TABLE "Runs" (id INTEGER PRIMARY KEY);
      ${
        unknownTargetTable
          ? 'CREATE TABLE "UnreviewedFacts" (id INTEGER PRIMARY KEY); INSERT INTO "UnreviewedFacts" (id) VALUES (1);'
          : ''
      }
    `);
    target.close();
    fs.chmodSync(targetDatabasePath, 0o600);
  };
}

function automationDatabaseInitializer() {
  return ({ legacySourcePath, recoveryPath, targetDatabasePath }) => {
    const legacy = new DatabaseSync(legacySourcePath);
    legacy.exec(`
      CREATE TABLE "Crontabs" (
        id INTEGER PRIMARY KEY,
        name TEXT,
        command TEXT,
        schedule TEXT,
        saved INTEGER,
        isSystem INTEGER,
        isDisabled INTEGER,
        isPinned INTEGER,
        labels TEXT,
        sub_id INTEGER,
        extra_schedules TEXT,
        task_before TEXT,
        task_after TEXT,
        log_name TEXT,
        allow_multiple_instances INTEGER,
        work_dir TEXT
      );
      INSERT INTO "Crontabs" (
        id, name, command, schedule, saved, isSystem, isDisabled, isPinned
      ) VALUES (1, 'nightly', 'task nightly.js', '0 0 * * *', 1, 0, 0, 0);
    `);
    legacy.close();
    fs.chmodSync(legacySourcePath, 0o600);
    fs.copyFileSync(legacySourcePath, recoveryPath);
    fs.chmodSync(recoveryPath, 0o600);

    const target = new DatabaseSync(targetDatabasePath);
    target.exec(`
      CREATE TABLE "QingLong3SchemaCapabilities" (id INTEGER PRIMARY KEY);
      CREATE TABLE "QingLong3TaskDefinitions" (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL,
        PRIMARY KEY (project_id, task_id)
      );
      CREATE TABLE "QingLong3TaskDefinitionRevisions" (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_digest TEXT NOT NULL,
        PRIMARY KEY (project_id, task_id, revision)
      );
    `);
    target.close();
    fs.chmodSync(targetDatabasePath, 0o600);
  };
}

function runHistoryDatabaseInitializer() {
  return ({ legacySourcePath, recoveryPath, targetDatabasePath }) => {
    const legacy = new DatabaseSync(legacySourcePath);
    legacy.exec(`
      CREATE TABLE "CrontabStats" (
        id INTEGER PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        status INTEGER NOT NULL
      );
      INSERT INTO "CrontabStats" (id, timestamp, status)
      VALUES (1, 1000, 0);
    `);
    legacy.close();
    fs.chmodSync(legacySourcePath, 0o600);
    fs.copyFileSync(legacySourcePath, recoveryPath);
    fs.chmodSync(recoveryPath, 0o600);

    const target = new DatabaseSync(targetDatabasePath);
    target.exec(`
      CREATE TABLE "Runs" (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        finished_at_ms INTEGER
      );
      INSERT INTO "Runs" (id, status, finished_at_ms)
      VALUES ('baseline', 'succeeded', 1000);
    `);
    target.close();
    fs.chmodSync(targetDatabasePath, 0o600);
  };
}

function mutateRunHistoryTarget({ targetDatabasePath }, status = 'failed') {
  const target = new DatabaseSync(targetDatabasePath);
  target
    .prepare(
      `INSERT INTO "Runs" (id, status, finished_at_ms)
       VALUES (?, ?, ?)`,
    )
    .run('captured', status, status === 'running' ? null : 2000);
  target.close();
  return Object.freeze({});
}

function automationReadyDatabaseInitializer() {
  const initializeLegacy = automationDatabaseInitializer();
  return (paths) => {
    initializeLegacy(paths);
    fs.truncateSync(paths.targetDatabasePath, 0);
    const migration = spawnSync(
      process.execPath,
      [
        '-e',
        `require('@qinglong/local-sqlite/migration')
          .migrateLocalSqlitePath({ databasePath: process.argv[1], profile: 'edge' })
          .catch((error) => { console.error(error); process.exitCode = 1; });`,
        paths.targetDatabasePath,
      ],
      { encoding: 'utf8', cwd: path.join(__dirname, '..') },
    );
    assert.equal(migration.status, 0, migration.stderr);
    fs.chmodSync(paths.targetDatabasePath, 0o600);
    const target = new DatabaseSync(paths.targetDatabasePath);
    target.exec(`
      INSERT INTO "QingLong3ProjectRoleBindings" (
        "project_id", "subject_type", "subject_id", "version", "state",
        "role", "mutation_id", "changed_by_type", "changed_by_id",
        "created_at_ms"
      ) VALUES (
        'default', 'user', 'review-owner', 1, 'active', 'owner',
        'automation-apply-owner-binding', 'user', 'review-owner', 1
      );
      PRAGMA wal_checkpoint(TRUNCATE);
      PRAGMA journal_mode=DELETE;
    `);
    target.close();
  };
}

function crossDomainReconciliationDatabaseInitializer() {
  return ({ legacySourcePath, recoveryPath, targetDatabasePath }) => {
    const legacy = new DatabaseSync(legacySourcePath);
    legacy.exec(`
      CREATE TABLE "Crontabs" (
        id INTEGER PRIMARY KEY,
        name TEXT,
        command TEXT,
        schedule TEXT,
        saved INTEGER,
        isSystem INTEGER,
        isDisabled INTEGER,
        isPinned INTEGER,
        labels TEXT,
        sub_id INTEGER,
        extra_schedules TEXT,
        task_before TEXT,
        task_after TEXT,
        log_name TEXT,
        allow_multiple_instances INTEGER,
        work_dir TEXT
      );
      CREATE TABLE "Envs" (
        id INTEGER PRIMARY KEY,
        name TEXT,
        value TEXT,
        status INTEGER,
        position REAL,
        "isPinned" INTEGER,
        "createdAt" TEXT
      );
      CREATE TABLE "CrontabStats" (
        id INTEGER PRIMARY KEY,
        ref_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        run_count INTEGER,
        success_count INTEGER,
        fail_count INTEGER,
        total_time INTEGER,
        max_time INTEGER,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      );
      CREATE TABLE "RunningInstances" (
        id INTEGER PRIMARY KEY,
        cron_id INTEGER NOT NULL,
        run_id TEXT,
        attempt_id TEXT,
        pid INTEGER,
        log_path TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status INTEGER NOT NULL,
        exit_code INTEGER,
        "createdAt" TEXT NOT NULL,
        "updatedAt" TEXT NOT NULL
      );
      INSERT INTO "Crontabs" (
        id, name, command, schedule, saved, isSystem, isDisabled, isPinned
      ) VALUES (1, 'nightly', 'task nightly.js', '0 0 * * *', 1, 0, 0, 0);
      INSERT INTO "Envs" (
        id, name, value, status, position, "isPinned", "createdAt"
      ) VALUES (1, 'ACTIVE_TOKEN', 'private-secret-value', 0, 1, 0, '2026-01-01');
      INSERT INTO "CrontabStats" (
        id, ref_id, date, run_count, success_count, fail_count,
        total_time, max_time, "createdAt", "updatedAt"
      ) VALUES (1, 1, '2026-01-01', 1, 1, 0, 100, 100, '2026-01-01', '2026-01-01');
    `);
    legacy.close();
    fs.chmodSync(legacySourcePath, 0o600);
    fs.copyFileSync(legacySourcePath, recoveryPath);
    fs.chmodSync(recoveryPath, 0o600);
    fs.copyFileSync(legacySourcePath, targetDatabasePath);
    fs.chmodSync(targetDatabasePath, 0o600);

    const migration = spawnSync(
      process.execPath,
      [
        '-e',
        `require('@qinglong/local-sqlite/migration')
          .migrateLocalSqlitePath({ databasePath: process.argv[1], profile: 'edge' })
          .catch((error) => { console.error(error); process.exitCode = 1; });`,
        targetDatabasePath,
      ],
      { encoding: 'utf8', cwd: path.join(__dirname, '..') },
    );
    assert.equal(migration.status, 0, migration.stderr);
    insertSecretConfigOwnerBinding(targetDatabasePath);
  };
}

function insertSecretConfigOwnerBinding(targetDatabasePath) {
  const target = new DatabaseSync(targetDatabasePath);
  target.exec(`
    INSERT OR IGNORE INTO "QingLong3ProjectRoleBindings" (
      "project_id", "subject_type", "subject_id", "version", "state",
      "role", "mutation_id", "changed_by_type", "changed_by_id",
      "created_at_ms"
    ) VALUES (
      'default', 'user', 'review-owner', 1, 'active', 'owner',
      'secret-config-apply-owner-binding', 'user', 'review-owner', 1
    );
    PRAGMA wal_checkpoint(TRUNCATE);
    PRAGMA journal_mode=DELETE;
  `);
  target.close();
}

function secretConfigDatabaseInitializer({
  active = false,
  configs = false,
  ownerBinding = true,
} = {}) {
  return ({ legacySourcePath, recoveryPath, targetDatabasePath }) => {
    const legacy = new DatabaseSync(legacySourcePath);
    legacy.exec(`
      CREATE TABLE "Envs" (
        id INTEGER PRIMARY KEY,
        name TEXT,
        value TEXT,
        status INTEGER,
        position REAL,
        "isPinned" INTEGER,
        "createdAt" TEXT
      );
      INSERT INTO "Envs" VALUES (
        1,
        '${active ? 'ACTIVE_TOKEN' : 'DISABLED_TOKEN'}',
        'private-secret-value',
        ${active ? 0 : 1},
        1,
        0,
        '2026-01-01'
      );
      ${
        configs
          ? 'CREATE TABLE "Configs" (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO "Configs" VALUES (1, \'private-config-value\');'
          : ''
      }
    `);
    legacy.close();
    fs.chmodSync(legacySourcePath, 0o600);
    fs.copyFileSync(legacySourcePath, recoveryPath);
    fs.chmodSync(recoveryPath, 0o600);

    const migration = spawnSync(
      process.execPath,
      [
        '-e',
        `require('@qinglong/local-sqlite/migration')
          .migrateLocalSqlitePath({ databasePath: process.argv[1], profile: 'edge' })
          .catch((error) => { console.error(error); process.exitCode = 1; });`,
        targetDatabasePath,
      ],
      { encoding: 'utf8', cwd: path.join(__dirname, '..') },
    );
    assert.equal(migration.status, 0, migration.stderr);
    fs.chmodSync(targetDatabasePath, 0o600);
    if (ownerBinding) {
      insertSecretConfigOwnerBinding(targetDatabasePath);
    } else {
      const target = new DatabaseSync(targetDatabasePath);
      target.exec(`
        PRAGMA wal_checkpoint(TRUNCATE);
        PRAGMA journal_mode=DELETE;
      `);
      target.close();
    }
  };
}

function mutateAutomationTarget({ targetDatabasePath }, occupied = false) {
  const target = new DatabaseSync(targetDatabasePath);
  if (occupied) {
    target.exec(`
      INSERT INTO "QingLong3TaskDefinitions" VALUES ('default', 'legacy-cron:1', 1);
      INSERT INTO "QingLong3TaskDefinitionRevisions" VALUES (
        'default', 'legacy-cron:1', 1, '${'a'.repeat(64)}'
      );
    `);
  } else {
    target.exec('INSERT INTO "QingLong3SchemaCapabilities" (id) VALUES (1)');
  }
  target.close();
  return Object.freeze({});
}

function mutateReadyAutomationTarget({ targetDatabasePath }) {
  const target = new DatabaseSync(targetDatabasePath);
  target.exec('PRAGMA user_version=1');
  target.close();
  return Object.freeze({});
}

function mutatePlanningTarget({ targetDatabasePath }) {
  const target = new DatabaseSync(targetDatabasePath);
  target.exec('INSERT INTO "QingLong3TaskDefinitions" (id) VALUES (1)');
  target.close();
  return Object.freeze({});
}

function preparedPlan(t, options = {}) {
  const state = preparedCapture(t, {
    createDefaultSidecars: options.createDefaultSidecars ?? false,
    targetInsideDeploymentRoot: options.targetInsideDeploymentRoot ?? false,
    initializeDatabases:
      options.initializeDatabases ?? planningDatabaseInitializer(options),
    mutateTarget: options.mutateTarget ?? mutatePlanningTarget,
    profile: options.profile ?? 'edge',
  });
  const captured = commitLocalReconciliationCapture(state.commitCommand);
  const planRoot = path.join(path.dirname(state.captureRoot), 'plan-root');
  fs.mkdirSync(planRoot, { mode: 0o700 });
  const prepareCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.plan.prepare',
    options: {
      deploymentRoot: state.deploymentRoot,
      captureRoot: state.captureRoot,
      planRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      planId: options.planId ?? '00000000-0000-4000-8000-000000000201',
      captureId: state.command.request.captureId,
      expectedBundleDigest: captured.bundleDigest,
      expectedHeadDigest: captured.instanceHeadDigest,
      legacyTimezone: options.legacyTimezone ?? null,
      preparedAtMs: 6_000,
    },
  };
  const planPrepared = prepareLocalReconciliationPlan(prepareCommand);
  const planCommitCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.plan.commit',
    options: prepareCommand.options,
    request: {
      planId: prepareCommand.request.planId,
      expectedPreparationDigest: planPrepared.preparationDigest,
      committedAtMs: 7_000,
    },
  };
  return {
    ...state,
    captureCommand: state.command,
    captured,
    planRoot,
    prepareCommand,
    planPrepared,
    planCommitCommand,
  };
}

function preparedReview(t, options = {}) {
  const state = preparedPlan(t, options);
  const planned = commitLocalReconciliationPlan(state.planCommitCommand);
  const root = path.dirname(state.captureRoot);
  const reviewRoot = path.join(
    root,
    `review-root-${options.reviewSuffix ?? '1'}`,
  );
  const diagnosticRoot = path.join(
    root,
    `diagnostic-root-${options.reviewSuffix ?? '1'}`,
  );
  fs.mkdirSync(reviewRoot, { mode: 0o700 });
  fs.mkdirSync(diagnosticRoot, { mode: 0o700 });
  const reviewCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.review.prepare',
    options: {
      deploymentRoot: state.deploymentRoot,
      captureRoot: state.captureRoot,
      planRoot: state.planRoot,
      reviewRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      reviewId: options.reviewId ?? '00000000-0000-4000-8000-000000000301',
      planId: state.prepareCommand.request.planId,
      expectedPlanDigest: planned.planDigest,
      expectedHeadDigest: planned.instanceHeadDigest,
      preparedAtMs: 8_000,
    },
  };
  return {
    ...state,
    planned,
    reviewRoot,
    diagnosticRoot,
    reviewCommand,
  };
}

function diagnosticCommand(
  state,
  prepared,
  {
    database = 'legacy',
    domain = 'automation',
    factKind = 'table',
    offset = 0,
    limit = 64,
    outputName = 'diagnostic-page.json',
  } = {},
) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.review.diagnostics',
    options: state.reviewCommand.options,
    request: {
      reviewId: state.reviewCommand.request.reviewId,
      expectedPreparationDigest: prepared.preparationDigest,
      database,
      domain,
      factKind,
      offset,
      limit,
      outputPath: path.join(state.diagnosticRoot, outputName),
    },
  };
}

function writeReviewDecisionFile(state, prepared, fileName = 'review.ndjson') {
  const decisions = [];
  const domains = [
    'schema_lineage',
    'automation',
    'secret_and_config',
    'run_history',
    'plugin_package',
    'ai_and_tool',
    'identity_policy_audit',
    'unknown',
  ];
  for (const database of ['legacy', 'target']) {
    for (const domain of domains) {
      for (const factKind of ['schema_object', 'table']) {
        let offset = 0;
        let pageNumber = 0;
        while (true) {
          const command = diagnosticCommand(state, prepared, {
            database,
            domain,
            factKind,
            offset,
            outputName: `decision-${database}-${domain}-${factKind}-${pageNumber}.json`,
          });
          const result = writeLocalReconciliationReviewDiagnostics(command);
          const page = JSON.parse(
            fs.readFileSync(command.request.outputPath, 'utf8'),
          );
          for (const fact of page.records) {
            if (fact.decisionRequirement === 'informational') continue;
            const blocked = fact.decisionRequirement === 'blocked';
            const legacy = fact.database === 'legacy';
            decisions.push({
              schemaVersion: 1,
              kind: 'qinglong3-local-reconciliation-review-decision',
              database: fact.database,
              domain: fact.domain,
              factKind: fact.factKind,
              ordinal: fact.ordinal,
              factDigest: fact.factDigest,
              disposition: blocked
                ? 'manual_external'
                : legacy
                ? 'exclude_legacy'
                : 'retain_target',
              reason: blocked
                ? 'external_recovery_required'
                : legacy
                ? 'legacy_excluded'
                : 'preserve_target',
            });
          }
          if (result.complete) break;
          offset = result.nextOffset;
          pageNumber += 1;
        }
      }
    }
  }
  const records = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-review-decision-header',
      diagnosticsContractVersion: 1,
      reviewId: state.reviewCommand.request.reviewId,
      profile: state.command.request.profile,
      planDigest: state.planned.planDigest,
      preparationDigest: prepared.preparationDigest,
    },
    ...decisions,
  ];
  const filePath = path.join(state.diagnosticRoot, fileName);
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return { filePath, records, decisions };
}

function reviewCommitFixture(t, options = {}) {
  const state = preparedReview(t, options);
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  const reviewFile = writeReviewDecisionFile(state, prepared);
  const ownerPepperKeyringDirectory = path.join(
    state.deploymentRoot,
    'review-owner-peppers',
  );
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const credentialFilePath = path.join(
    state.deploymentRoot,
    'review-credential.json',
  );
  fs.writeFileSync(credentialFilePath, '{}\n', { mode: 0o600 });
  const issuerKeyringPath = path.join(
    state.deploymentRoot,
    'review-issuer.keyring',
  );
  const committedAtMs = Date.now();
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.review.commit',
    options: {
      ...state.reviewCommand.options,
      targetDatabasePath: state.targetDatabasePath,
      ownerPepperKeyringDirectory,
      credentialFilePath,
      issuerKeyringPath,
    },
    request: {
      reviewId: state.reviewCommand.request.reviewId,
      expectedPreparationDigest: prepared.preparationDigest,
      expectedHeadDigest: prepared.instanceHeadDigest,
      decisionFilePath: reviewFile.filePath,
      committedAtMs,
      authorizationLifetimeMs: 60_000,
    },
  };
  let authentications = 0;
  let confirmations = 0;
  const dependencies = {
    now: () => committedAtMs,
    async openAuthenticationDatabase() {
      return { async close() {} };
    },
    async authenticate(_database, authenticateOptions) {
      authentications += 1;
      assert.equal(
        authenticateOptions.authenticationNamespace,
        'local_reconciliation_review',
      );
      return {
        principal: {
          subject: { type: 'user', id: 'review-owner' },
          authenticationId: 'local_reconciliation_review:test',
          authenticatedAtMs: committedAtMs,
          expiresAtMs: committedAtMs + 60_000,
          assurance: 'local_console',
        },
        databaseFence: {
          credentialId: 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {
          confirmations += 1;
        },
      };
    },
  };
  return {
    ...state,
    prepared,
    reviewFile,
    command,
    dependencies,
    issuerKeyringPath,
    authenticationCount: () => authentications,
    confirmationCount: () => confirmations,
  };
}

async function reviewedApplicationFixture(t, options = {}) {
  const state = reviewCommitFixture(t, options);
  options.mutateDecisions?.(state.reviewFile.records);
  if (options.mutateDecisions) {
    fs.writeFileSync(
      state.reviewFile.filePath,
      `${state.reviewFile.records
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
      { mode: 0o600 },
    );
  }
  const reviewed = await commitLocalReconciliationReview(
    state.command,
    state.dependencies,
  );
  const applicationRoot = path.join(
    path.dirname(state.captureRoot),
    `application-root-${options.reviewSuffix ?? '1'}`,
  );
  fs.mkdirSync(applicationRoot, { mode: 0o700 });
  const applicationId =
    options.applicationId ?? '00000000-0000-4000-8000-000000000401';
  const prepareCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.prepare',
    options: {
      ...state.reviewCommand.options,
      applicationRoot,
      issuerKeyringPath: state.issuerKeyringPath,
    },
    request: {
      applicationId,
      reviewId: state.reviewCommand.request.reviewId,
      expectedReviewDigest: reviewed.reviewDigest,
      expectedHeadDigest: reviewed.instanceHeadDigest,
      preparedAtMs: state.command.request.committedAtMs + 1,
    },
  };
  return {
    ...state,
    reviewed,
    applicationRoot,
    prepareApplicationCommand: prepareCommand,
  };
}

function applicationCommitCommand(state, prepared) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.commit',
    options: state.prepareApplicationCommand.options,
    request: {
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedPreparationDigest: prepared.preparationDigest,
      expectedHeadDigest: prepared.instanceHeadDigest,
      committedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 1,
    },
  };
}

async function secretConfigPlanFixture(t, options = {}) {
  const suffix = options.suffix ?? 'plan';
  const state = await reviewedApplicationFixture(t, {
    planId: options.planId ?? '00000000-0000-4000-8000-000000000421',
    reviewId: options.reviewId ?? '00000000-0000-4000-8000-000000000422',
    applicationId:
      options.applicationId ?? '00000000-0000-4000-8000-000000000423',
    reviewSuffix: `secret-config-${suffix}`,
    createDefaultSidecars: false,
    initializeDatabases: secretConfigDatabaseInitializer({
      active: options.active === true,
      configs: options.configs === true,
      ownerBinding: options.ownerBinding !== false,
    }),
    mutateTarget({ targetDatabasePath }) {
      const target = new DatabaseSync(targetDatabasePath);
      target.exec('PRAGMA user_version=1');
      target.close();
      return Object.freeze({});
    },
  });
  const preparedApplication = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, preparedApplication),
  );
  const secretConfigRoot = path.join(
    path.dirname(state.captureRoot),
    `secret-config-plan-${suffix}`,
  );
  fs.mkdirSync(secretConfigRoot, { mode: 0o700 });
  const secretConfigId =
    options.secretConfigId ?? '00000000-0000-4000-8000-000000000424';
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.plan',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      secretConfigRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      secretConfigId,
      applicationId: application.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      projectId: 'default',
      preparedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 2,
    },
  };
  return {
    ...state,
    application,
    secretConfigRoot,
    secretConfigId,
    secretConfigCommand: command,
  };
}

async function plannedAutomationFixture(t, options = {}) {
  const suffix = options.suffix ?? 'decision';
  const state = await reviewedApplicationFixture(t, {
    planId: options.planId,
    reviewId: options.reviewId,
    applicationId: options.applicationId,
    reviewSuffix: `automation-decision-${suffix}`,
    createDefaultSidecars: false,
    targetInsideDeploymentRoot: true,
    initializeDatabases:
      options.initializeDatabases ??
      (options.readyTarget === true
        ? automationReadyDatabaseInitializer()
        : automationDatabaseInitializer()),
    mutateTarget(paths) {
      if (options.mutateTarget) return options.mutateTarget(paths);
      return options.readyTarget === true
        ? mutateReadyAutomationTarget(paths)
        : mutateAutomationTarget(paths, options.occupied === true);
    },
    mutateDecisions(records) {
      const selected = records.find(
        (record) =>
          record.kind === 'qinglong3-local-reconciliation-review-decision' &&
          record.database === 'legacy' &&
          record.domain === 'automation' &&
          record.factKind === 'table' &&
          record.disposition === 'exclude_legacy',
      );
      assert.ok(selected);
      selected.disposition =
        options.occupied === true ? 'retain_both' : 'adopt_legacy';
      selected.reason =
        options.occupied === true ? 'preserve_both' : 'prefer_legacy';
      options.mutateDecisions?.(records);
    },
  });
  const preparedApplication = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, preparedApplication),
  );
  const automationRoot = path.join(
    path.dirname(state.captureRoot),
    `automation-decision-plan-${suffix}`,
  );
  const automationDecisionRoot = path.join(
    path.dirname(state.captureRoot),
    `automation-decision-authority-${suffix}`,
  );
  fs.mkdirSync(automationRoot, { mode: 0o700 });
  fs.mkdirSync(automationDecisionRoot, { mode: 0o700 });
  const automationId =
    options.automationId ?? '00000000-0000-4000-8000-000000000461';
  const automationCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.plan',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      automationRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      automationId,
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      projectId: 'default',
      legacyTimezone: 'Asia/Shanghai',
      preparedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 2,
    },
  };
  const planned = await planLocalReconciliationAutomation(automationCommand);
  const automationDirectory = path.join(automationRoot, automationId);
  const planReceipt = JSON.parse(
    fs.readFileSync(path.join(automationDirectory, 'receipt.json'), 'utf8'),
  );
  const planRows = fs
    .readFileSync(path.join(automationDirectory, 'plan.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(
      (record) =>
        record.kind === 'qinglong3-local-reconciliation-automation-plan-row',
    );
  return {
    ...state,
    application,
    automationRoot,
    automationDecisionRoot,
    automationCommand,
    automationDirectory,
    planned,
    planReceipt,
    planRows,
  };
}

function automationDecisionReviewFile(
  state,
  decisionId,
  disposition,
  reason,
  suffix = 'decision',
) {
  assert.equal(state.planRows.length, 1);
  const row = state.planRows[0];
  const records = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-header',
      decisionId,
      profile: state.captureCommand.request.profile,
      planDigest: state.planned.automationPlanDigest,
      inventoryDigest: state.planReceipt.legacyInventoryDigest,
    },
    {
      schemaVersion: 1,
      kind: 'qinglong3-legacy-crontab-decision-review-file-row',
      decision: {
        rowOrdinal: row.rowOrdinal,
        sourceDigest: row.sourceDigest,
        disposition,
        reason,
      },
    },
  ];
  const filePath = path.join(
    state.diagnosticRoot,
    `automation-row-decision-${suffix}.ndjson`,
  );
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return { filePath, records };
}

function automationDecisionPrepareCommand(state, decisionId) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.prepare',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      automationRoot: state.automationRoot,
      automationDecisionRoot: state.automationDecisionRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedAutomationPlanDigest: state.planned.automationPlanDigest,
      expectedHeadDigest: state.planned.instanceHeadDigest,
      preparedAtMs: state.automationCommand.request.preparedAtMs + 1,
    },
  };
}

function automationDecisionCommitFixture(
  state,
  prepared,
  decisionFilePath,
  options = {},
) {
  const committedAtMs = options.committedAtMs ?? Date.now();
  const authorizationLifetimeMs = 10 * 60 * 1_000;
  let authentications = 0;
  let confirmations = 0;
  let databaseCloses = 0;
  let databaseClosed = true;
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.commit',
    options: {
      ...prepared.commandOptions,
      targetDatabasePath: state.targetDatabasePath,
      ownerPepperKeyringDirectory:
        state.command.options.ownerPepperKeyringDirectory,
      credentialFilePath: state.command.options.credentialFilePath,
    },
    request: {
      decisionId: prepared.result.decisionId,
      automationId: prepared.result.automationId,
      expectedPreparationDigest: prepared.result.preparationDigest,
      expectedHeadDigest: prepared.result.instanceHeadDigest,
      decisionFilePath,
      committedAtMs,
      authorizationLifetimeMs,
    },
  };
  const dependencies = {
    now: () => committedAtMs,
    async openAuthenticationDatabase() {
      databaseClosed = false;
      return {
        async close() {
          databaseClosed = true;
          databaseCloses += 1;
        },
      };
    },
    async authenticate(_database, authenticateOptions) {
      authentications += 1;
      assert.equal(
        authenticateOptions.authenticationNamespace,
        'local_reconciliation_automation',
      );
      return {
        principal: {
          subject: {
            type: 'user',
            id: options.reviewerId ?? 'review-owner',
          },
          authenticationId: 'local_reconciliation_automation:test',
          authenticatedAtMs: committedAtMs,
          expiresAtMs: committedAtMs + authorizationLifetimeMs + 60_000,
          assurance: options.assurance ?? 'local_console',
        },
        databaseFence: {
          credentialId: options.reviewerId ?? 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {
          assert.equal(databaseClosed, false);
          confirmations += 1;
        },
      };
    },
  };
  return {
    command,
    dependencies,
    authenticationCount: () => authentications,
    confirmationCount: () => confirmations,
    databaseCloseCount: () => databaseCloses,
  };
}

async function plannedSecretConfigDecisionFixture(t, options = {}) {
  const suffix = options.suffix ?? 'decision';
  const state = await secretConfigPlanFixture(t, {
    suffix,
    active: options.active === true,
    configs: options.configs === true,
    planId: options.planId,
    reviewId: options.reviewId,
    applicationId: options.applicationId,
    secretConfigId: options.secretConfigId,
    ownerBinding: options.ownerBinding,
  });
  const planned = await planLocalReconciliationSecretConfig(
    state.secretConfigCommand,
  );
  const secretConfigDecisionRoot = path.join(
    path.dirname(state.captureRoot),
    `secret-config-decision-${suffix}`,
  );
  fs.mkdirSync(secretConfigDecisionRoot, { mode: 0o700 });
  const planPath = path.join(
    state.secretConfigRoot,
    state.secretConfigId,
    'plan.ndjson',
  );
  const candidates = fs
    .readFileSync(planPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter(
      (record) =>
        record.kind ===
        'qinglong3-local-reconciliation-secret-config-plan-candidate',
    );
  return {
    ...state,
    planned,
    secretConfigDecisionRoot,
    candidates,
  };
}

function secretConfigDecisionPrepareCommand(state, decisionId) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.decision.prepare',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      secretConfigRoot: state.secretConfigRoot,
      secretConfigDecisionRoot: state.secretConfigDecisionRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedSecretConfigPlanDigest: state.planned.secretConfigPlanDigest,
      expectedHeadDigest: state.planned.instanceHeadDigest,
      preparedAtMs: state.secretConfigCommand.request.preparedAtMs + 1,
    },
  };
}

function secretConfigDecisionFile(
  state,
  prepared,
  dispositions,
  suffix = 'decision',
) {
  assert.equal(state.candidates.length, dispositions.length);
  const records = [
    {
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-secret-config-decision-header',
      decisionContractVersion: 1,
      decisionId: prepared.result.decisionId,
      profile: state.captureCommand.request.profile,
      secretConfigPlanDigest: state.planned.secretConfigPlanDigest,
      preparationDigest: prepared.result.preparationDigest,
    },
    ...state.candidates.map((candidate, index) => ({
      schemaVersion: 1,
      kind: 'qinglong3-local-reconciliation-secret-config-decision',
      candidateOrdinal: candidate.candidateOrdinal,
      candidateDigest: candidate.candidateDigest,
      disposition: dispositions[index].disposition,
      reason: dispositions[index].reason,
    })),
  ];
  const filePath = path.join(
    state.diagnosticRoot,
    `secret-config-decision-${suffix}.ndjson`,
  );
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return { filePath, records };
}

function secretConfigDecisionCommitFixture(
  state,
  prepared,
  decisionFilePath,
  options = {},
) {
  const committedAtMs = options.committedAtMs ?? Date.now();
  const authorizationLifetimeMs = 10 * 60 * 1_000;
  let authentications = 0;
  let confirmations = 0;
  let databaseCloses = 0;
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.decision.commit',
    options: {
      ...prepared.commandOptions,
      targetDatabasePath: state.targetDatabasePath,
      ownerPepperKeyringDirectory:
        state.command.options.ownerPepperKeyringDirectory,
      credentialFilePath: state.command.options.credentialFilePath,
    },
    request: {
      decisionId: prepared.result.decisionId,
      secretConfigId: state.secretConfigId,
      expectedPreparationDigest: prepared.result.preparationDigest,
      expectedHeadDigest: prepared.result.instanceHeadDigest,
      decisionFilePath,
      committedAtMs,
      authorizationLifetimeMs,
    },
  };
  const dependencies = {
    now: () => committedAtMs,
    async openAuthenticationDatabase() {
      return {
        async close() {
          databaseCloses += 1;
        },
      };
    },
    async authenticate(_database, authenticateOptions) {
      authentications += 1;
      assert.match(
        authenticateOptions.authenticationNamespace,
        /^[a-z][a-z0-9_]{0,31}$/,
      );
      assert.equal(
        authenticateOptions.authenticationNamespace,
        'reconcile_secret_config_decision',
      );
      return {
        principal: {
          subject: {
            type: 'user',
            id: options.reviewerId ?? 'review-owner',
          },
          authenticationId: 'reconcile_secret_config_decision:test',
          authenticatedAtMs: committedAtMs,
          expiresAtMs: committedAtMs + authorizationLifetimeMs + 60_000,
          assurance: options.assurance ?? 'local_console',
        },
        databaseFence: {
          credentialId: options.reviewerId ?? 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {
          confirmations += 1;
        },
      };
    },
  };
  return {
    command,
    dependencies,
    authenticationCount: () => authentications,
    confirmationCount: () => confirmations,
    databaseCloseCount: () => databaseCloses,
  };
}

async function appliedAutomationFixture(t, options = {}) {
  const state = await plannedAutomationFixture(t, {
    suffix: options.suffix ?? 'completion-applied',
    planId: options.planId ?? '00000000-0000-4000-8000-000000000481',
    reviewId: options.reviewId ?? '00000000-0000-4000-8000-000000000482',
    applicationId:
      options.applicationId ?? '00000000-0000-4000-8000-000000000483',
    automationId:
      options.automationId ?? '00000000-0000-4000-8000-000000000484',
    readyTarget: true,
    initializeDatabases: options.initializeDatabases,
    mutateTarget: options.mutateTarget,
    mutateDecisions: options.mutateDecisions,
  });
  assert.equal(state.application.outcome, 'adapter_and_manual_required');
  const decisionId =
    options.decisionId ?? '019b0000-0000-7000-8000-000000000481';
  const review = automationDecisionReviewFile(
    state,
    decisionId,
    'adopt',
    'reviewed_lossless',
    options.suffix ?? 'completion-applied',
  );
  const prepareCommand = automationDecisionPrepareCommand(state, decisionId);
  const prepared = await prepareLocalReconciliationAutomationDecision(
    prepareCommand,
  );
  const commit = automationDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    review.filePath,
  );
  const decision = await commitLocalReconciliationAutomationDecision(
    commit.command,
    commit.dependencies,
  );
  const automationApplyRoot = path.join(
    path.dirname(state.captureRoot),
    `automation-apply-${options.suffix ?? 'completion-applied'}`,
  );
  fs.mkdirSync(automationApplyRoot, { mode: 0o700 });
  const applyOptions = {
    ...prepareCommand.options,
    automationApplyRoot,
    targetDatabasePath: state.targetDatabasePath,
    ownerPepperKeyringDirectory:
      state.command.options.ownerPepperKeyringDirectory,
    credentialFilePath: state.command.options.credentialFilePath,
  };
  const appliedAtMs = commit.command.request.committedAtMs + 1;
  const applyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply',
    options: applyOptions,
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedDecisionDigest: decision.decisionDigest,
      expectedHeadDigest: decision.instanceHeadDigest,
      mutationId: options.mutationId ?? '00000000-0000-4000-8000-000000000485',
      requestId: `automation-apply-${options.suffix ?? 'completion-applied'}`,
      appliedAtMs,
    },
  };
  const applyDependencies = {
    async openAuthenticationDatabase() {
      return { async close() {} };
    },
    async authenticate(_database, authenticateOptions) {
      const authenticatedAtMs = authenticateOptions.now();
      return {
        principal: {
          subject: { type: 'user', id: 'review-owner' },
          authenticationId: 'local_reconciliation_automation_apply:test',
          authenticatedAtMs,
          expiresAtMs: authenticatedAtMs + 60 * 60 * 1_000,
          assurance: 'local_console',
        },
        databaseFence: {
          credentialId: 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {},
      };
    },
  };
  const applied = await applyLocalReconciliationAutomation(
    applyCommand,
    applyDependencies,
  );
  return {
    ...state,
    decisionId,
    decision,
    automationApplyRoot,
    applyOptions,
    applyCommand,
    applyDependencies,
    applied,
  };
}

async function appliedSecretConfigFixture(t, options = {}) {
  const suffix = options.suffix ?? 'completion-secret-config';
  const state = await plannedSecretConfigDecisionFixture(t, {
    suffix,
    planId: options.planId ?? '00000000-0000-4000-8000-000000000521',
    reviewId: options.reviewId ?? '00000000-0000-4000-8000-000000000522',
    applicationId:
      options.applicationId ?? '00000000-0000-4000-8000-000000000523',
    secretConfigId:
      options.secretConfigId ?? '00000000-0000-4000-8000-000000000524',
    ownerBinding: false,
  });
  const decisionId =
    options.decisionId ?? '019b0000-0000-7000-8000-000000000521';
  const prepareCommand = secretConfigDecisionPrepareCommand(state, decisionId);
  const prepared = await prepareLocalReconciliationSecretConfigDecision(
    prepareCommand,
  );
  const review = secretConfigDecisionFile(
    state,
    { result: prepared },
    [
      {
        disposition: 'preserve_disabled',
        reason: 'reviewed_disabled_preservation',
      },
    ],
    suffix,
  );
  const decisionCommit = secretConfigDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    review.filePath,
  );
  const decision = await commitLocalReconciliationSecretConfigDecision(
    decisionCommit.command,
    decisionCommit.dependencies,
  );
  assert.equal(decision.outcome, 'ready');

  const secretKeyringPath = path.join(
    state.deploymentRoot,
    `local-secret-keyring-${suffix}.json`,
  );
  await provisionLocalSecretKeyring(secretKeyringPath);
  const secretConfigApplyRoot = path.join(
    path.dirname(state.captureRoot),
    `secret-config-apply-${suffix}`,
  );
  fs.mkdirSync(secretConfigApplyRoot, { mode: 0o700 });
  const applyOptions = {
    ...prepareCommand.options,
    secretConfigApplyRoot,
    targetDatabasePath: state.targetDatabasePath,
    secretKeyringPath,
    ownerPepperKeyringDirectory:
      state.command.options.ownerPepperKeyringDirectory,
    credentialFilePath: state.command.options.credentialFilePath,
  };
  const appliedAtMs = decisionCommit.command.request.committedAtMs + 1;
  const applyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply',
    options: applyOptions,
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedDecisionDigest: decision.decisionDigest,
      expectedHeadDigest: decision.instanceHeadDigest,
      mutationId: options.mutationId ?? '00000000-0000-4000-8000-000000000525',
      requestId: `secret-config-apply-${suffix}`,
      appliedAtMs,
    },
  };
  const applyDependencies = {
    async openAuthenticationDatabase() {
      return { async close() {} };
    },
    async authenticate(_database, authenticationOptions) {
      assert.match(
        authenticationOptions.authenticationNamespace,
        /^[a-z][a-z0-9_]{0,31}$/,
      );
      assert.equal(
        authenticationOptions.authenticationNamespace,
        'reconcile_secret_config_apply',
      );
      const authenticatedAtMs = authenticationOptions.now();
      return {
        principal: {
          subject: { type: 'user', id: 'review-owner' },
          authenticationId: 'reconcile_secret_config_apply:test',
          authenticatedAtMs,
          expiresAtMs: authenticatedAtMs + 60 * 60 * 1_000,
          assurance: 'local_console',
        },
        databaseFence: {
          credentialId: 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {},
      };
    },
    async applyApplication(input) {
      insertSecretConfigOwnerBinding(state.targetDatabasePath);
      return applyPreparedReconciliationSecretConfigApplication(input);
    },
  };
  const applied = await applyLocalReconciliationSecretConfig(
    applyCommand,
    applyDependencies,
  );
  return {
    ...state,
    decisionId,
    decision,
    secretConfigApplyRoot,
    applyOptions,
    applyCommand,
    applyDependencies,
    applied,
  };
}

function dockerReadSealedSqlite(assetsDirectory, mode) {
  const source =
    mode === 'main_only_immutable'
      ? 'file:/bundle/target.sqlite?immutable=1'
      : '/bundle/target.sqlite';
  const script = `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');
    const files = fs.readdirSync('/bundle').sort();
    const snapshot = () => Object.fromEntries(files.map((name) => [name, crypto.createHash('sha256').update(fs.readFileSync('/bundle/' + name)).digest('hex')]));
    const before = snapshot();
    const client = new DatabaseSync(${JSON.stringify(
      source,
    )}, { allowExtension: false, defensive: true, readOnly: true, timeout: 0 });
    client.enableDefensive(true);
    client.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 0; PRAGMA cache_size = -2048');
    const row = client.prepare('SELECT COUNT(*) AS count FROM "QingLong3TaskDefinitions"').get();
    client.close();
    const after = snapshot();
    process.stdout.write(JSON.stringify({ count: row.count, unchanged: JSON.stringify(before) === JSON.stringify(after) }));
  `;
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--mount',
      `type=bind,source=${assetsDirectory},target=/bundle,readonly`,
      'node:24-bookworm-slim',
      'node',
      '-e',
      script,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function capturePath(state, name) {
  return path.join(state.captureRoot, state.command.request.captureId, name);
}

function captureAssetPath(state, logicalName) {
  return capturePath(state, `assets/${CAPTURE_ASSET_NAMES[logicalName]}`);
}

function captureAssetStagePath(state, logicalName) {
  return capturePath(
    state,
    `assets/.${CAPTURE_ASSET_NAMES[logicalName]}.ql3-capture-stage`,
  );
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
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.legacyBaselineSha256, state.activation.sourceSha256);
  assert.equal(manifest.targetBaselineSha256, state.activation.targetSha256);
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
    fs.readFileSync(captureAssetPath(state, 'target-main'), 'utf8'),
    'target-mutated\n',
  );
  assert.equal(
    fs.readFileSync(captureAssetPath(state, 'target-wal'), 'utf8'),
    'target-wal-facts\n',
  );
  assert.equal(fs.statSync(capturePath(state, 'assets')).mode & 0o777, 0o500);
  for (const asset of manifest.assets) {
    assert.equal(
      fs.statSync(captureAssetPath(state, asset.logicalName)).mode & 0o777,
      0o400,
    );
  }
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
  const targetAsset = captureAssetPath(state, 'target-main');
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

test('commit converges a partially sealed terminal bundle without sources', (t) => {
  const state = preparedCapture(t);
  let failed = false;
  assert.throws(
    () =>
      commitLocalReconciliationCapture(state.commitCommand, {
        afterAssetSealed(logicalName) {
          if (!failed && logicalName === 'target-main') {
            failed = true;
            throw new Error('seal crash');
          }
        },
      }),
    /seal crash/,
  );
  assert.equal(fs.existsSync(capturePath(state, 'receipt.json')), true);
  assert.equal(
    fs.statSync(captureAssetPath(state, 'target-main')).mode & 0o777,
    0o400,
  );
  assert.equal(
    fs.statSync(captureAssetPath(state, 'target-wal')).mode & 0o777,
    0o600,
  );
  assert.equal(fs.statSync(capturePath(state, 'assets')).mode & 0o777, 0o700);
  fs.unlinkSync(state.targetDatabasePath);
  fs.unlinkSync(state.legacySourcePath);
  fs.unlinkSync(state.recoveryPath);
  const resumed = commitLocalReconciliationCapture(state.commitCommand);
  assert.equal(resumed.state, 'reconciliation_captured');
  assert.equal(fs.statSync(capturePath(state, 'assets')).mode & 0o777, 0o500);
  const manifest = JSON.parse(
    fs.readFileSync(capturePath(state, 'manifest.json'), 'utf8'),
  );
  for (const asset of manifest.assets) {
    assert.equal(
      fs.statSync(captureAssetPath(state, asset.logicalName)).mode & 0o777,
      0o400,
    );
  }
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
  const target = captureAssetPath(state, 'target-main');
  const stage = captureAssetStagePath(state, 'target-main');
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
  const stage = captureAssetStagePath(state, 'target-main');
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
  const targetAsset = captureAssetPath(state, 'target-main');
  fs.chmodSync(targetAsset, 0o600);
  fs.writeFileSync(targetAsset, 'drift\n');
  fs.chmodSync(targetAsset, 0o400);
  assert.throws(
    () => verifyLocalReconciliationCapture(verifyCommand),
    /asset drifted/,
  );
});

test('capture manifest schema v1 is rejected instead of silently upgraded', (t) => {
  const state = preparedCapture(t);
  commitLocalReconciliationCapture(state.commitCommand);
  const manifest = JSON.parse(
    fs.readFileSync(capturePath(state, 'manifest.json'), 'utf8'),
  );
  manifest.schemaVersion = 1;
  assert.throws(
    () => normalizeLocalReconciliationCaptureManifest(manifest),
    /reconciliation capture manifest (?:drifted|schemaVersion must be 2)/,
  );
});

test('plan reads sealed main-only SQLite with fixed budgets and verifies without opening', (t) => {
  const state = preparedPlan(t);
  const beforeAssets = fs
    .readdirSync(capturePath(state, 'assets'))
    .map((name) => ({
      name,
      bytes: fs.readFileSync(capturePath(state, `assets/${name}`)),
      stat: fs.statSync(capturePath(state, `assets/${name}`), { bigint: true }),
    }));
  const opens = [];
  const committed = commitLocalReconciliationPlan(state.planCommitCommand, {
    beforeDatabaseOpen(kind, mode, cacheKiB) {
      opens.push({ kind, mode, cacheKiB });
    },
  });
  assert.equal(committed.status, 'prepared');
  assert.equal(committed.state, 'reconciliation_planned');
  assert.deepEqual(opens, [
    { kind: 'legacy', mode: 'main_only_immutable', cacheKiB: 2048 },
    { kind: 'target', mode: 'main_only_immutable', cacheKiB: 2048 },
  ]);
  const planPath = path.join(
    state.planRoot,
    state.prepareCommand.request.planId,
    'plan.json',
  );
  const planText = fs.readFileSync(planPath, 'utf8');
  const plan = JSON.parse(planText);
  assert.equal(Buffer.byteLength(planText, 'utf8') <= 64 * 1024, true);
  assert.deepEqual(
    plan.domains.map((domain) => domain.domain),
    [
      'schema_lineage',
      'automation',
      'secret_and_config',
      'run_history',
      'plugin_package',
      'ai_and_tool',
      'identity_policy_audit',
      'unknown',
    ],
  );
  assert.equal(plan.domains.length, 8);
  assert.equal(plan.outcome, 'manual_required');
  assert.equal(planText.includes('private-value'), false);
  assert.equal(planText.includes(state.captureRoot), false);
  assert.equal(planText.includes(state.legacySourcePath), false);
  assert.equal(planText.includes('Crontabs'), false);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_planned');
  assert.equal(head.sourceRecordDigest, committed.planDigest);
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.plan.verify',
    options: state.prepareCommand.options,
    request: {
      planId: state.prepareCommand.request.planId,
      expectedPlanDigest: committed.planDigest,
    },
  };
  let verifyOpens = 0;
  assert.equal(
    verifyLocalReconciliationPlan(verifyCommand, {
      beforeDatabaseOpen() {
        verifyOpens += 1;
      },
    }).status,
    'verified',
  );
  assert.equal(verifyOpens, 0);
  for (const before of beforeAssets) {
    const assetPath = capturePath(state, `assets/${before.name}`);
    const after = fs.statSync(assetPath, { bigint: true });
    assert.equal(fs.readFileSync(assetPath).equals(before.bytes), true);
    for (const key of [
      'dev',
      'ino',
      'uid',
      'gid',
      'mode',
      'nlink',
      'size',
      'mtimeNs',
      'ctimeNs',
    ]) {
      assert.equal(after[key], before.stat[key]);
    }
  }
});

test('plan reads a sealed WAL and SHM snapshot without changing either asset', (t) => {
  let target;
  const initializeDatabases = (paths) => {
    planningDatabaseInitializer()(paths);
    target = new DatabaseSync(paths.targetDatabasePath);
    target.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  };
  const mutateTarget = ({ targetDatabasePath }) => {
    target.exec('INSERT INTO "QingLong3TaskDefinitions" (id) VALUES (1)');
    fs.chmodSync(`${targetDatabasePath}-wal`, 0o600);
    fs.chmodSync(`${targetDatabasePath}-shm`, 0o600);
    return Object.freeze({});
  };
  t.after(() => {
    try {
      target?.close();
    } catch {
      // The fixture cleanup may already have invalidated the source handle.
    }
  });
  const state = preparedPlan(t, {
    initializeDatabases,
    mutateTarget,
    planId: '00000000-0000-4000-8000-000000000205',
  });
  const targetWal = captureAssetPath(state, 'target-wal');
  const targetShm = captureAssetPath(state, 'target-shm');
  const before = [targetWal, targetShm].map((assetPath) => ({
    assetPath,
    bytes: fs.readFileSync(assetPath),
    stat: fs.statSync(assetPath, { bigint: true }),
  }));
  const opens = [];
  commitLocalReconciliationPlan(state.planCommitCommand, {
    beforeDatabaseOpen(kind, mode, cacheKiB) {
      opens.push({ kind, mode, cacheKiB });
    },
  });
  assert.deepEqual(opens, [
    { kind: 'legacy', mode: 'main_only_immutable', cacheKiB: 2048 },
    { kind: 'target', mode: 'wal_shm_readonly', cacheKiB: 2048 },
  ]);
  for (const item of before) {
    const after = fs.statSync(item.assetPath, { bigint: true });
    assert.equal(fs.readFileSync(item.assetPath).equals(item.bytes), true);
    assert.equal(after.mtimeNs, item.stat.mtimeNs);
    assert.equal(after.ctimeNs, item.stat.ctimeNs);
    assert.equal(after.mode, item.stat.mode);
  }
});

test('standalone planning fixes each SQLite cache at 8 MiB', (t) => {
  const state = preparedPlan(t, {
    profile: 'standalone',
    planId: '00000000-0000-4000-8000-000000000206',
  });
  const opens = [];
  commitLocalReconciliationPlan(state.planCommitCommand, {
    beforeDatabaseOpen(kind, mode, cacheKiB) {
      opens.push({ kind, mode, cacheKiB });
    },
  });
  assert.deepEqual(opens, [
    { kind: 'legacy', mode: 'main_only_immutable', cacheKiB: 8192 },
    { kind: 'target', mode: 'main_only_immutable', cacheKiB: 8192 },
  ]);
});

test('plan commit converges plan, receipt and head crash windows exactly', (t) => {
  const planState = preparedPlan(t, {
    planId: '00000000-0000-4000-8000-000000000211',
  });
  assert.throws(
    () =>
      commitLocalReconciliationPlan(planState.planCommitCommand, {
        afterPlanPublished() {
          throw new Error('plan crash');
        },
      }),
    /plan crash/,
  );
  let replayOpens = 0;
  const resumedPlan = commitLocalReconciliationPlan(
    planState.planCommitCommand,
    {
      beforeDatabaseOpen() {
        replayOpens += 1;
      },
    },
  );
  assert.equal(resumedPlan.status, 'prepared');
  assert.equal(replayOpens, 0);

  const receiptState = preparedPlan(t, {
    planId: '00000000-0000-4000-8000-000000000212',
  });
  assert.throws(
    () =>
      commitLocalReconciliationPlan(receiptState.planCommitCommand, {
        afterReceiptPublished() {
          throw new Error('receipt crash');
        },
      }),
    /receipt crash/,
  );
  replayOpens = 0;
  assert.equal(
    commitLocalReconciliationPlan(receiptState.planCommitCommand, {
      beforeDatabaseOpen() {
        replayOpens += 1;
      },
    }).status,
    'prepared',
  );
  assert.equal(replayOpens, 0);

  const headState = preparedPlan(t, {
    planId: '00000000-0000-4000-8000-000000000213',
  });
  assert.throws(
    () =>
      commitLocalReconciliationPlan(headState.planCommitCommand, {
        afterHeadAdvanced() {
          throw new Error('head response loss');
        },
      }),
    /head response loss/,
  );
  assert.equal(
    commitLocalReconciliationPlan(headState.planCommitCommand).status,
    'existing',
  );
});

test('hot journal and unpaired sidecars become manual without SQLite open', (t) => {
  const state = preparedPlan(t, {
    createDefaultSidecars: true,
    planId: '00000000-0000-4000-8000-000000000221',
  });
  let opens = 0;
  const committed = commitLocalReconciliationPlan(state.planCommitCommand, {
    beforeDatabaseOpen() {
      opens += 1;
    },
  });
  assert.equal(opens, 0);
  assert.equal(committed.outcome, 'manual_required');
  const plan = JSON.parse(
    fs.readFileSync(
      path.join(
        state.planRoot,
        state.prepareCommand.request.planId,
        'plan.json',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(
    plan.databases.map((database) => ({
      kind: database.kind,
      topology: database.topology,
      opened: database.opened,
    })),
    [
      { kind: 'legacy', topology: 'manual_required', opened: false },
      { kind: 'target', topology: 'manual_required', opened: false },
    ],
  );
  assert.equal(
    plan.domains.every((domain) => domain.disposition === 'manual_required'),
    true,
  );
});

test('unknown target schema is summarized only by digest and requires manual review', (t) => {
  const state = preparedPlan(t, {
    unknownTargetTable: true,
    planId: '00000000-0000-4000-8000-000000000231',
  });
  commitLocalReconciliationPlan(state.planCommitCommand);
  const planText = fs.readFileSync(
    path.join(state.planRoot, state.prepareCommand.request.planId, 'plan.json'),
    'utf8',
  );
  const plan = JSON.parse(planText);
  const unknown = plan.domains.find((domain) => domain.domain === 'unknown');
  assert.equal(unknown.targetTables, 1);
  assert.equal(unknown.rowCountsComplete, false);
  assert.equal(unknown.disposition, 'manual_required');
  assert.equal(plan.outcome, 'manual_required');
  assert.equal(planText.includes('UnreviewedFacts'), false);
});

test('one plan fence blocks a second plan and all rollback transitions', (t) => {
  const state = preparedPlan(t, {
    planId: '00000000-0000-4000-8000-000000000241',
  });
  const competing = structuredClone(state.prepareCommand);
  competing.request.planId = '00000000-0000-4000-8000-000000000242';
  assert.throws(
    () => prepareLocalReconciliationPlan(competing),
    /compare-and-swap/,
  );
  assert.throws(
    () =>
      advanceLocalCutoverInstanceHead(
        state.identity,
        state.uid,
        'rollback_prepared',
        1,
        'f'.repeat(64),
      ),
    /transition is invalid/,
  );
  assert.throws(
    () =>
      advanceLocalCutoverInstanceHead(
        state.identity,
        state.uid,
        'target_active',
        2,
        'e'.repeat(64),
      ),
    /transition is invalid/,
  );
});

test('plan prepare recovers head response loss and CLI verify stays content-free', (t) => {
  const capture = preparedCapture(t, {
    createDefaultSidecars: false,
    initializeDatabases: planningDatabaseInitializer(),
    mutateTarget: mutatePlanningTarget,
  });
  const captured = commitLocalReconciliationCapture(capture.commitCommand);
  const planRoot = path.join(path.dirname(capture.captureRoot), 'plan-root');
  fs.mkdirSync(planRoot, { mode: 0o700 });
  const prepareCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.plan.prepare',
    options: {
      deploymentRoot: capture.deploymentRoot,
      captureRoot: capture.captureRoot,
      planRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      planId: '00000000-0000-4000-8000-000000000251',
      captureId: capture.command.request.captureId,
      expectedBundleDigest: captured.bundleDigest,
      expectedHeadDigest: captured.instanceHeadDigest,
      legacyTimezone: null,
      preparedAtMs: 6_000,
    },
  };
  assert.throws(
    () =>
      prepareLocalReconciliationPlan(prepareCommand, {
        afterHeadPrepared() {
          throw new Error('prepare response loss');
        },
      }),
    /prepare response loss/,
  );
  const prepared = prepareLocalReconciliationPlan(prepareCommand);
  assert.equal(prepared.status, 'prepared');
  const committed = commitLocalReconciliationPlan({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.plan.commit',
    options: prepareCommand.options,
    request: {
      planId: prepareCommand.request.planId,
      expectedPreparationDigest: prepared.preparationDigest,
      committedAtMs: 7_000,
    },
  });
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.plan.verify',
    options: prepareCommand.options,
    request: {
      planId: prepareCommand.request.planId,
      expectedPlanDigest: committed.planDigest,
    },
  };
  const commandPath = path.join(capture.deploymentRoot, 'plan-verify.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-plan-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes(capture.captureRoot), false);
  assert.equal(cli.stdout.includes(planRoot), false);
  assert.equal(cli.stdout.includes(capture.targetDatabasePath), false);

  const overlapping = structuredClone(prepareCommand);
  overlapping.request.planId = '00000000-0000-4000-8000-000000000252';
  overlapping.options.planRoot = capture.captureRoot;
  assert.throws(
    () => prepareLocalReconciliationPlan(overlapping),
    /must not overlap/,
  );
});

test('review prepare establishes one replayable fence and blocks rollback', (t) => {
  const state = preparedReview(t, {
    planId: '00000000-0000-4000-8000-000000000301',
    reviewId: '00000000-0000-4000-8000-000000000311',
  });
  assert.throws(
    () =>
      prepareLocalReconciliationReview(state.reviewCommand, {
        afterHeadPrepared() {
          throw new Error('review prepare response loss');
        },
      }),
    /review prepare response loss/,
  );
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'reconciliation_review_prepared');
  const replay = prepareLocalReconciliationReview(state.reviewCommand);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.preparationDigest, prepared.preparationDigest);
  assert.equal(replay.instanceHeadDigest, prepared.instanceHeadDigest);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.command.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_review_prepared');
  assert.equal(head.sourceRecordDigest, prepared.preparationDigest);

  const competing = structuredClone(state.reviewCommand);
  competing.request.reviewId = '00000000-0000-4000-8000-000000000312';
  competing.options.reviewRoot = path.join(
    path.dirname(state.reviewRoot),
    'review-root-competing',
  );
  fs.mkdirSync(competing.options.reviewRoot, { mode: 0o700 });
  assert.throws(
    () => prepareLocalReconciliationReview(competing),
    /compare-and-swap/,
  );
  assert.throws(
    () =>
      advanceLocalCutoverInstanceHead(
        state.identity,
        state.uid,
        'rollback_prepared',
        1,
        'f'.repeat(64),
      ),
    /transition is invalid/,
  );
  assert.throws(
    () =>
      advanceLocalCutoverInstanceHead(
        state.identity,
        state.uid,
        'target_active',
        2,
        'e'.repeat(64),
      ),
    /transition is invalid/,
  );
});

test('review diagnostics publish one private exact page without changing assets', (t) => {
  const state = preparedReview(t, {
    planId: '00000000-0000-4000-8000-000000000321',
    reviewId: '00000000-0000-4000-8000-000000000322',
  });
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  const assets = fs.readdirSync(capturePath(state, 'assets')).map((name) => ({
    name,
    bytes: fs.readFileSync(capturePath(state, `assets/${name}`)),
    stat: fs.statSync(capturePath(state, `assets/${name}`), { bigint: true }),
  }));
  const command = diagnosticCommand(state, prepared);
  const opens = [];
  const result = writeLocalReconciliationReviewDiagnostics(command, {
    beforeDatabaseOpen(kind, mode, cacheKiB) {
      opens.push({ kind, mode, cacheKiB });
    },
  });
  assert.deepEqual(opens, [
    { kind: 'legacy', mode: 'main_only_immutable', cacheKiB: 2048 },
  ]);
  assert.equal(result.status, 'prepared');
  assert.equal(result.recordCount, 1);
  assert.equal(result.complete, true);
  assert.equal(result.nextOffset, null);
  assert.equal(
    JSON.stringify(result).includes(command.request.outputPath),
    false,
  );
  assert.equal(JSON.stringify(result).includes('Crontabs'), false);
  const pageText = fs.readFileSync(command.request.outputPath, 'utf8');
  const page = JSON.parse(pageText);
  assert.equal(page.records[0].name, 'Crontabs');
  assert.equal(page.records[0].rowCount, '1');
  assert.equal(page.records[0].decisionRequirement, 'required');
  assert.equal(pageText.includes('0 0 * * *'), false);
  assert.equal(pageText.includes('private-value'), false);
  assert.equal(fs.statSync(command.request.outputPath).mode & 0o777, 0o600);
  assert.equal(
    writeLocalReconciliationReviewDiagnostics(command).status,
    'existing',
  );
  for (const before of assets) {
    const assetPath = capturePath(state, `assets/${before.name}`);
    const after = fs.statSync(assetPath, { bigint: true });
    assert.equal(fs.readFileSync(assetPath).equals(before.bytes), true);
    assert.equal(after.mtimeNs, before.stat.mtimeNs);
    assert.equal(after.ctimeNs, before.stat.ctimeNs);
    assert.equal(after.mode, before.stat.mode);
  }
});

test('review diagnostics keep secret and unknown facts blocked and row-free', (t) => {
  const state = preparedReview(t, {
    unknownTargetTable: true,
    planId: '00000000-0000-4000-8000-000000000331',
    reviewId: '00000000-0000-4000-8000-000000000332',
  });
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  const secretCommand = diagnosticCommand(state, prepared, {
    domain: 'secret_and_config',
    outputName: 'secret.json',
  });
  writeLocalReconciliationReviewDiagnostics(secretCommand);
  const secretText = fs.readFileSync(secretCommand.request.outputPath, 'utf8');
  const secret = JSON.parse(secretText);
  assert.equal(secret.records[0].name, 'Envs');
  assert.equal(secret.records[0].decisionRequirement, 'blocked');
  assert.equal(secret.records[0].reason, 'secret_custody_required');
  assert.equal(secretText.includes('TOKEN'), false);
  assert.equal(secretText.includes('private-value'), false);

  const unknownCommand = diagnosticCommand(state, prepared, {
    database: 'target',
    domain: 'unknown',
    outputName: 'unknown.json',
  });
  writeLocalReconciliationReviewDiagnostics(unknownCommand);
  const unknown = JSON.parse(
    fs.readFileSync(unknownCommand.request.outputPath, 'utf8'),
  );
  assert.equal(unknown.records[0].name, 'UnreviewedFacts');
  assert.equal(unknown.records[0].rowCount, null);
  assert.equal(unknown.records[0].decisionRequirement, 'blocked');
  assert.equal(unknown.records[0].reason, 'unknown_schema');

  const overlapping = structuredClone(unknownCommand);
  overlapping.request.outputPath = path.join(state.reviewRoot, 'leak.json');
  assert.throws(
    () => writeLocalReconciliationReviewDiagnostics(overlapping),
    /outside authority roots/,
  );
});

test('review diagnostics treat empty Legacy identity catalogs as no-effect evidence', (t) => {
  const initializeDatabases = (paths) => {
    planningDatabaseInitializer()(paths);
    const legacy = new DatabaseSync(paths.legacySourcePath);
    legacy.exec('CREATE TABLE "Auths" (id INTEGER PRIMARY KEY)');
    legacy.close();
    fs.copyFileSync(paths.legacySourcePath, paths.recoveryPath);
    fs.chmodSync(paths.recoveryPath, 0o600);
    const target = new DatabaseSync(paths.targetDatabasePath);
    target.exec(
      'CREATE TABLE "QingLong3IdentityRecords" (id INTEGER PRIMARY KEY)',
    );
    target.close();
  };
  const state = preparedReview(t, {
    initializeDatabases,
    planId: '00000000-0000-4000-8000-000000000333',
    reviewId: '00000000-0000-4000-8000-000000000334',
    reviewSuffix: 'identity-custody',
  });
  assert.equal(state.planned.outcome, 'manual_required');
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  const legacyCommand = diagnosticCommand(state, prepared, {
    database: 'legacy',
    domain: 'identity_policy_audit',
    outputName: 'legacy-identity.json',
  });
  writeLocalReconciliationReviewDiagnostics(legacyCommand);
  const legacy = JSON.parse(
    fs.readFileSync(legacyCommand.request.outputPath, 'utf8'),
  );
  assert.equal(legacy.records[0].name, 'Auths');
  assert.equal(legacy.records[0].decisionRequirement, 'informational');
  assert.equal(legacy.records[0].reason, 'catalog_evidence');

  const targetCommand = diagnosticCommand(state, prepared, {
    database: 'target',
    domain: 'identity_policy_audit',
    outputName: 'target-identity.json',
  });
  writeLocalReconciliationReviewDiagnostics(targetCommand);
  const target = JSON.parse(
    fs.readFileSync(targetCommand.request.outputPath, 'utf8'),
  );
  assert.equal(target.records[0].name, 'QingLong3IdentityRecords');
  assert.equal(target.records[0].decisionRequirement, 'required');
  assert.equal(target.records[0].reason, 'reviewable_fact');
});

test('review diagnostics keep nonempty Legacy identity custody fail-closed', (t) => {
  const initializeDatabases = (paths) => {
    planningDatabaseInitializer()(paths);
    const legacy = new DatabaseSync(paths.legacySourcePath);
    legacy.exec(`
      CREATE TABLE "Auths" (id INTEGER PRIMARY KEY);
      INSERT INTO "Auths" (id) VALUES (1);
    `);
    legacy.close();
    fs.copyFileSync(paths.legacySourcePath, paths.recoveryPath);
    fs.chmodSync(paths.recoveryPath, 0o600);
  };
  const state = preparedReview(t, {
    initializeDatabases,
    planId: '00000000-0000-4000-8000-000000000335',
    reviewId: '00000000-0000-4000-8000-000000000336',
    reviewSuffix: 'nonempty-identity-custody',
  });
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  const command = diagnosticCommand(state, prepared, {
    database: 'legacy',
    domain: 'identity_policy_audit',
    outputName: 'legacy-nonempty-identity.json',
  });
  writeLocalReconciliationReviewDiagnostics(command);
  const page = JSON.parse(fs.readFileSync(command.request.outputPath, 'utf8'));
  assert.equal(page.records[0].decisionRequirement, 'blocked');
  assert.equal(page.records[0].reason, 'identity_custody_required');
});

test('review diagnostics page at sixty-four and CLI output stays content-free', (t) => {
  const initializeDatabases = (paths) => {
    planningDatabaseInitializer()(paths);
    const target = new DatabaseSync(paths.targetDatabasePath);
    for (let index = 0; index < 70; index += 1) {
      target.exec(
        `CREATE TABLE "QingLong3TaskDefinitionExtra${String(index).padStart(
          2,
          '0',
        )}" (id INTEGER PRIMARY KEY)`,
      );
    }
    target.close();
    fs.chmodSync(paths.targetDatabasePath, 0o600);
  };
  const state = preparedReview(t, {
    initializeDatabases,
    planId: '00000000-0000-4000-8000-000000000341',
    reviewId: '00000000-0000-4000-8000-000000000342',
  });
  const prepared = prepareLocalReconciliationReview(state.reviewCommand);
  const firstCommand = diagnosticCommand(state, prepared, {
    database: 'target',
    domain: 'automation',
    factKind: 'schema_object',
    outputName: 'page-1.json',
  });
  const first = writeLocalReconciliationReviewDiagnostics(firstCommand);
  assert.equal(first.recordCount, 64);
  assert.equal(first.complete, false);
  assert.equal(first.nextOffset, 64);
  const secondCommand = diagnosticCommand(state, prepared, {
    database: 'target',
    domain: 'automation',
    factKind: 'schema_object',
    offset: first.nextOffset,
    outputName: 'page-2.json',
  });
  const second = writeLocalReconciliationReviewDiagnostics(secondCommand);
  assert.equal(second.recordCount, 7);
  assert.equal(second.complete, true);
  assert.equal(second.nextOffset, null);

  const cliCommand = diagnosticCommand(state, prepared, {
    database: 'target',
    domain: 'automation',
    factKind: 'table',
    limit: 1,
    outputName: 'cli-page.json',
  });
  const commandPath = path.join(state.deploymentRoot, 'review-diagnostic.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(cliCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-review-diagnostics',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  assert.equal(output.recordCount, 1);
  assert.equal(cli.stdout.includes(state.reviewRoot), false);
  assert.equal(cli.stdout.includes(state.diagnosticRoot), false);
  assert.equal(cli.stdout.includes('QingLong3TaskDefinitions'), false);
  assert.equal(cli.stderr, '');
});

test('review commit signs the exact decision stream, seals terminal evidence and verifies read-only', async (t) => {
  const state = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000351',
    reviewId: '00000000-0000-4000-8000-000000000352',
  });
  const targetBefore = fs.statSync(state.targetDatabasePath, { bigint: true });
  const targetBytes = fs.readFileSync(state.targetDatabasePath);
  const committed = await commitLocalReconciliationReview(
    state.command,
    state.dependencies,
  );
  assert.equal(committed.status, 'prepared');
  assert.equal(committed.state, 'reconciliation_reviewed');
  assert.equal(committed.decisionCount, state.reviewFile.decisions.length);
  assert.equal(state.authenticationCount(), 1);
  assert.equal(state.confirmationCount(), 3);
  const reviewDirectory = path.join(
    state.reviewRoot,
    state.reviewCommand.request.reviewId,
  );
  assert.deepEqual(fs.readdirSync(reviewDirectory).sort(), [
    'authorization.ndjson',
    'intent.json',
    'receipt.json',
    'review.json',
    'staging',
  ]);
  assert.equal(fs.statSync(reviewDirectory).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(reviewDirectory, 'staging')).mode & 0o777,
    0o500,
  );
  for (const fileName of [
    'authorization.ndjson',
    'intent.json',
    'receipt.json',
    'review.json',
  ]) {
    assert.equal(
      fs.statSync(path.join(reviewDirectory, fileName)).mode & 0o777,
      0o400,
    );
  }
  const authorizationText = fs.readFileSync(
    path.join(reviewDirectory, 'authorization.ndjson'),
    'utf8',
  );
  assert.equal(authorizationText.includes('Crontabs'), false);
  assert.equal(authorizationText.includes('private-value'), false);
  assert.equal(authorizationText.includes('0 0 * * *'), false);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.captureCommand.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_reviewed');
  assert.equal(head.sourceRecordDigest, committed.reviewDigest);
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.review.verify',
    options: {
      ...state.reviewCommand.options,
      issuerKeyringPath: state.issuerKeyringPath,
    },
    request: {
      reviewId: state.reviewCommand.request.reviewId,
      expectedReviewDigest: committed.reviewDigest,
    },
  };
  const verified = await verifyLocalReconciliationReview(verifyCommand);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.reviewDigest, committed.reviewDigest);
  const targetAfter = fs.statSync(state.targetDatabasePath, { bigint: true });
  assert.equal(
    fs.readFileSync(state.targetDatabasePath).equals(targetBytes),
    true,
  );
  assert.equal(targetAfter.mtimeNs, targetBefore.mtimeNs);
  assert.equal(targetAfter.ctimeNs, targetBefore.ctimeNs);

  const commandPath = path.join(state.deploymentRoot, 'review-verify.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-review-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes(state.reviewRoot), false);
  assert.equal(cli.stdout.includes('review-owner'), false);
  assert.equal(cli.stdout.includes('Crontabs'), false);
});

test('review commit rejects missing and policy-invalid decisions before terminal publication', async (t) => {
  const missing = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000361',
    reviewId: '00000000-0000-4000-8000-000000000362',
    reviewSuffix: 'missing',
  });
  const missingRecords = missing.reviewFile.records.slice(0, -1);
  fs.writeFileSync(
    missing.reviewFile.filePath,
    `${missingRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    commitLocalReconciliationReview(missing.command, missing.dependencies),
    /omitted a canonical fact/,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        missing.reviewRoot,
        missing.reviewCommand.request.reviewId,
        'authorization.ndjson',
      ),
    ),
    false,
  );

  const blocked = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000363',
    reviewId: '00000000-0000-4000-8000-000000000364',
    reviewSuffix: 'blocked',
  });
  const blockedRecord = blocked.reviewFile.records.find(
    (record) =>
      record.kind === 'qinglong3-local-reconciliation-review-decision' &&
      [
        'secret_and_config',
        'run_history',
        'identity_policy_audit',
        'unknown',
      ].includes(record.domain),
  );
  blockedRecord.disposition = 'adopt_legacy';
  blockedRecord.reason = 'prefer_legacy';
  fs.writeFileSync(
    blocked.reviewFile.filePath,
    `${blocked.reviewFile.records
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    commitLocalReconciliationReview(blocked.command, blocked.dependencies),
    /not allowed for canonical fact/,
  );

  const crossDatabase = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000390',
    reviewId: '00000000-0000-4000-8000-000000000391',
    reviewSuffix: 'cross-database',
  });
  const legacyDecision = crossDatabase.reviewFile.records.find(
    (record) =>
      record.kind === 'qinglong3-local-reconciliation-review-decision' &&
      record.database === 'legacy' &&
      record.disposition === 'exclude_legacy',
  );
  assert.ok(legacyDecision);
  legacyDecision.disposition = 'retain_target';
  legacyDecision.reason = 'preserve_target';
  fs.writeFileSync(
    crossDatabase.reviewFile.filePath,
    `${crossDatabase.reviewFile.records
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    commitLocalReconciliationReview(
      crossDatabase.command,
      crossDatabase.dependencies,
    ),
    /not allowed for canonical fact/,
  );
});

test('review commit rejects weak principals, oversized Edge streams and decision-file drift around signing', async (t) => {
  const weak = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000365',
    reviewId: '00000000-0000-4000-8000-000000000366',
    reviewSuffix: 'weak',
  });
  await assert.rejects(
    commitLocalReconciliationReview(weak.command, {
      ...weak.dependencies,
      async authenticate() {
        return {
          principal: {
            subject: { type: 'user', id: 'weak-user' },
            authenticationId: 'local_reconciliation_review:weak',
            authenticatedAtMs: weak.command.request.committedAtMs,
            expiresAtMs: weak.command.request.committedAtMs + 60_000,
            assurance: 'single_factor',
          },
          databaseFence: {},
          async confirm() {},
        };
      },
    }),
    /recent strongly authenticated User/,
  );

  const overlong = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000392',
    reviewId: '00000000-0000-4000-8000-000000000393',
    reviewSuffix: 'overlong',
  });
  overlong.command.request.authorizationLifetimeMs = 60_001;
  await assert.rejects(
    commitLocalReconciliationReview(overlong.command, overlong.dependencies),
    /recent strongly authenticated User/,
  );

  const oversized = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000367',
    reviewId: '00000000-0000-4000-8000-000000000368',
    reviewSuffix: 'oversized',
  });
  fs.truncateSync(oversized.reviewFile.filePath, 8 * 1024 * 1024 + 1);
  await assert.rejects(
    commitLocalReconciliationReview(oversized.command, oversized.dependencies),
    /identity or size is invalid/,
  );

  const drift = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000369',
    reviewId: '00000000-0000-4000-8000-00000000036a',
    reviewSuffix: 'drift',
  });
  let confirmations = 0;
  await assert.rejects(
    commitLocalReconciliationReview(drift.command, {
      ...drift.dependencies,
      async authenticate() {
        return {
          principal: {
            subject: { type: 'user', id: 'review-owner' },
            authenticationId: 'local_reconciliation_review:drift',
            authenticatedAtMs: drift.command.request.committedAtMs,
            expiresAtMs: drift.command.request.committedAtMs + 60_000,
            assurance: 'hardware',
          },
          databaseFence: {},
          async confirm() {
            confirmations += 1;
            if (confirmations === 3) {
              fs.appendFileSync(drift.reviewFile.filePath, '{}\n');
            }
          },
        };
      },
    }),
    /identity changed after reading/,
  );
});

test('review commit resumes authorization, receipt, seal and head response-loss windows without re-authentication', async (t) => {
  const authorizationState = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000371',
    reviewId: '00000000-0000-4000-8000-000000000372',
    reviewSuffix: 'authorization-crash',
  });
  await assert.rejects(
    commitLocalReconciliationReview(authorizationState.command, {
      ...authorizationState.dependencies,
      afterAuthorizationPublished() {
        throw new Error('authorization crash');
      },
    }),
    /authorization crash/,
  );
  const authorizationDirectory = path.join(
    authorizationState.reviewRoot,
    authorizationState.reviewCommand.request.reviewId,
  );
  fs.linkSync(
    path.join(authorizationDirectory, 'authorization.ndjson'),
    path.join(authorizationDirectory, 'staging', 'authorization.ndjson.stage'),
  );
  const authorizationReplay = await commitLocalReconciliationReview(
    authorizationState.command,
    {
      ...authorizationState.dependencies,
      async authenticate() {
        throw new Error('must not re-authenticate signed response-loss replay');
      },
    },
  );
  assert.equal(authorizationReplay.state, 'reconciliation_reviewed');

  const receiptState = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000373',
    reviewId: '00000000-0000-4000-8000-000000000374',
    reviewSuffix: 'receipt-crash',
  });
  await assert.rejects(
    commitLocalReconciliationReview(receiptState.command, {
      ...receiptState.dependencies,
      afterReceiptPublished() {
        throw new Error('receipt crash');
      },
    }),
    /receipt crash/,
  );
  const receiptReplay = await commitLocalReconciliationReview(
    receiptState.command,
    receiptState.dependencies,
  );
  assert.equal(receiptReplay.state, 'reconciliation_reviewed');

  const sealState = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000375',
    reviewId: '00000000-0000-4000-8000-000000000376',
    reviewSuffix: 'seal-crash',
  });
  await assert.rejects(
    commitLocalReconciliationReview(sealState.command, {
      ...sealState.dependencies,
      afterTerminalSealed() {
        throw new Error('seal crash');
      },
    }),
    /seal crash/,
  );
  assert.equal(
    fs.statSync(
      path.join(sealState.reviewRoot, sealState.reviewCommand.request.reviewId),
    ).mode & 0o777,
    0o500,
  );
  const sealReplay = await commitLocalReconciliationReview(
    sealState.command,
    sealState.dependencies,
  );
  assert.equal(sealReplay.state, 'reconciliation_reviewed');

  const headState = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000377',
    reviewId: '00000000-0000-4000-8000-000000000378',
    reviewSuffix: 'head-crash',
  });
  await assert.rejects(
    commitLocalReconciliationReview(headState.command, {
      ...headState.dependencies,
      afterHeadAdvanced() {
        throw new Error('head response loss');
      },
    }),
    /head response loss/,
  );
  const headReplay = await commitLocalReconciliationReview(
    headState.command,
    headState.dependencies,
  );
  assert.equal(headReplay.status, 'existing');
});

test('application coordinator plans eight content-free domains and verifies without SQLite writes', async (t) => {
  const state = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000401',
    reviewId: '00000000-0000-4000-8000-000000000402',
    applicationId: '00000000-0000-4000-8000-000000000403',
    reviewSuffix: 'application-terminal',
    mutateDecisions(records) {
      const selected = records.find(
        (record) =>
          record.kind === 'qinglong3-local-reconciliation-review-decision' &&
          record.database === 'legacy' &&
          record.domain === 'automation' &&
          record.disposition === 'exclude_legacy',
      );
      assert.ok(selected);
      selected.disposition = 'adopt_legacy';
      selected.reason = 'prefer_legacy';
    },
  });
  const targetBefore = fs.statSync(state.targetDatabasePath, { bigint: true });
  const targetBytes = fs.readFileSync(state.targetDatabasePath);
  const prepared = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'reconciliation_application_prepared');
  const commitCommand = applicationCommitCommand(state, prepared);
  const committed = await commitLocalReconciliationApplication(commitCommand);
  assert.equal(committed.status, 'prepared');
  assert.equal(committed.state, 'reconciliation_application_planned');
  assert.equal(committed.domainCount, 8);
  assert.equal(committed.outcome, 'adapter_and_manual_required');
  const applicationDirectory = path.join(
    state.applicationRoot,
    state.prepareApplicationCommand.request.applicationId,
  );
  assert.deepEqual(fs.readdirSync(applicationDirectory).sort(), [
    'intent.json',
    'plan.json',
    'receipt.json',
    'staging',
  ]);
  assert.equal(fs.statSync(applicationDirectory).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(applicationDirectory, 'staging')).mode & 0o777,
    0o500,
  );
  for (const fileName of ['intent.json', 'plan.json', 'receipt.json']) {
    assert.equal(
      fs.statSync(path.join(applicationDirectory, fileName)).mode & 0o777,
      0o400,
    );
  }
  const planText = fs.readFileSync(
    path.join(applicationDirectory, 'plan.json'),
    'utf8',
  );
  const plan = JSON.parse(planText);
  assert.equal(plan.domains.length, 8);
  assert.equal(
    plan.domains.find((domain) => domain.domain === 'automation').action,
    'adapter_required',
  );
  assert.equal(planText.includes('QingLong3TaskDefinitions'), false);
  assert.equal(planText.includes('Crontabs'), false);
  assert.equal(planText.includes('private-value'), false);
  assert.equal(planText.includes('0 0 * * *'), false);
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.verify',
    options: state.prepareApplicationCommand.options,
    request: {
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: committed.applicationPlanDigest,
    },
  };
  const verified = await verifyLocalReconciliationApplication(verifyCommand);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.applicationPlanDigest, committed.applicationPlanDigest);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.captureCommand.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_application_planned');
  assert.equal(head.sourceRecordDigest, committed.applicationPlanDigest);
  const targetAfter = fs.statSync(state.targetDatabasePath, { bigint: true });
  assert.equal(
    fs.readFileSync(state.targetDatabasePath).equals(targetBytes),
    true,
  );
  assert.equal(targetAfter.mtimeNs, targetBefore.mtimeNs);
  assert.equal(targetAfter.ctimeNs, targetBefore.ctimeNs);

  const commandPath = path.join(
    state.deploymentRoot,
    'application-verify.json',
  );
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-application-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes(state.applicationRoot), false);
  assert.equal(cli.stdout.includes('review-owner'), false);
  assert.equal(cli.stdout.includes('Crontabs'), false);
});

test('completion fence seals all eight no-effect domains before target restart', async (t) => {
  const state = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000421',
    reviewId: '00000000-0000-4000-8000-000000000422',
    applicationId: '00000000-0000-4000-8000-000000000423',
    reviewSuffix: 'completion-no-effect',
    createDefaultSidecars: false,
    initializeDatabases: automationDatabaseInitializer(),
    mutateTarget(paths) {
      return mutateAutomationTarget(paths);
    },
  });
  const prepared = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, prepared),
  );
  assert.equal(application.outcome, 'no_effect_ready');
  const completionRoot = path.join(
    path.dirname(state.captureRoot),
    'completion-no-effect',
  );
  fs.mkdirSync(completionRoot, { mode: 0o700 });
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.complete',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      completionRoot,
      automation: null,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      completionId: '00000000-0000-4000-8000-000000000424',
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      automation: null,
      completedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 4,
    },
  };
  for (const boundary of [
    'afterReceiptPublished',
    'afterTerminalSealed',
    'afterHeadAdvanced',
  ]) {
    await assert.rejects(
      completeLocalReconciliation(command, {
        [boundary]() {
          throw new Error(`completion ${boundary} response loss`);
        },
      }),
      new RegExp(`completion ${boundary} response loss`),
    );
  }
  const completed = await completeLocalReconciliation(command);
  assert.equal(completed.status, 'existing');
  assert.equal(completed.state, 'reconciliation_completed');
  assert.equal(completed.domainCount, 8);
  assert.equal(completed.adapterCount, 0);
  const completionDirectory = path.join(
    completionRoot,
    command.request.completionId,
  );
  assert.deepEqual(fs.readdirSync(completionDirectory), ['receipt.json']);
  assert.equal(fs.statSync(completionDirectory).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(completionDirectory, 'receipt.json')).mode & 0o777,
    0o400,
  );
  const receipt = JSON.parse(
    fs.readFileSync(path.join(completionDirectory, 'receipt.json'), 'utf8'),
  );
  assert.equal(receipt.domains.length, 8);
  assert.equal(
    receipt.domains.every(
      (domain) =>
        domain.action === 'no_effect' &&
        domain.evidenceKind === 'application_summary',
    ),
    true,
  );
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.complete.verify',
    options: command.options,
    request: {
      completionId: command.request.completionId,
      applicationId: command.request.applicationId,
      expectedCompletionDigest: completed.completionDigest,
      automation: null,
    },
  };
  const verified = await verifyLocalReconciliationCompletion(verifyCommand);
  assert.equal(verified.status, 'verified');
  const commandPath = path.join(state.deploymentRoot, 'completion-verify.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-complete-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes(completionRoot), false);
  const identity = {
    options: { deploymentRoot: state.deploymentRoot },
    request: {
      cutoverId: state.captureCommand.request.cutoverId,
      profile: state.captureCommand.request.profile,
      instanceId: state.captureCommand.request.instanceId,
      expectedActivationDigest:
        state.captureCommand.request.expectedActivationDigest,
      requestedAtMs: command.request.completedAtMs + 1,
    },
  };
  const restartHead = assertLocalCutoverTargetHead(identity, state.uid);
  assert.equal(restartHead.state, 'reconciliation_completed');
  const activeHead = advanceLocalCutoverInstanceHead(
    identity,
    state.uid,
    'target_active',
    2,
    'e'.repeat(64),
  );
  assert.equal(activeHead.state, 'target_active');
  assert.equal(activeHead.generation, 2);
});

test('Secret/Config plan publishes, seals, verifies and stays content-free', async (t) => {
  const state = await secretConfigPlanFixture(t, { suffix: 'terminal' });
  const opened = [];
  const closed = [];
  const planned = await planLocalReconciliationSecretConfig(
    state.secretConfigCommand,
    {
      beforeDatabaseOpen(kind, mode, cacheKiB) {
        opened.push({ kind, mode, cacheKiB });
      },
      afterDatabaseClose(kind) {
        closed.push(kind);
      },
    },
  );
  assert.equal(planned.status, 'prepared');
  assert.equal(planned.state, 'reconciliation_secret_config_planned');
  assert.equal(planned.outcome, 'ready');
  assert.equal(planned.rowCount, 1);
  assert.equal(planned.eligibleBindingCount, 0);
  assert.equal(planned.eligiblePreservationCount, 1);
  assert.equal(planned.adoptedLegacyTaskCount, 0);
  assert.deepEqual(opened, [
    { kind: 'legacy', mode: 'main_only_immutable', cacheKiB: 2048 },
    { kind: 'target', mode: 'main_only_immutable', cacheKiB: 2048 },
    { kind: 'target', mode: 'main_only_immutable', cacheKiB: 2048 },
    { kind: 'legacy', mode: 'main_only_immutable', cacheKiB: 2048 },
  ]);
  assert.deepEqual(closed, ['legacy', 'target', 'legacy', 'target']);

  const root = path.join(state.secretConfigRoot, state.secretConfigId);
  assert.deepEqual(fs.readdirSync(root).sort(), [
    'plan.ndjson',
    'receipt.json',
    'staging',
  ]);
  assert.equal(fs.statSync(root).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(root, 'staging')).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(root, 'plan.ndjson')).mode & 0o777, 0o400);
  assert.equal(
    fs.statSync(path.join(root, 'receipt.json')).mode & 0o777,
    0o400,
  );
  const serialized = fs.readFileSync(path.join(root, 'plan.ndjson'), 'utf8');
  for (const privateValue of [
    'DISABLED_TOKEN',
    'private-secret-value',
    state.targetDatabasePath,
    state.reviewFile.filePath,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  const receipt = JSON.parse(
    fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'),
  );
  assert.equal(receipt.unadaptedLegacyConfigCount, 0);
  assert.match(receipt.automationAdoptionSetDigest, /^[0-9a-f]{64}$/);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.captureCommand.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_secret_config_planned');
  assert.equal(head.sourceRecordDigest, planned.secretConfigPlanDigest);

  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.verify',
    options: state.secretConfigCommand.options,
    request: {
      secretConfigId: state.secretConfigId,
      expectedSecretConfigPlanDigest: planned.secretConfigPlanDigest,
    },
  };
  const verified = await verifyLocalReconciliationSecretConfigPlan(
    verifyCommand,
  );
  assert.equal(verified.status, 'verified');
  assert.equal(
    (await planLocalReconciliationSecretConfig(state.secretConfigCommand))
      .status,
    'existing',
  );

  const commandPath = path.join(
    state.deploymentRoot,
    'secret-config-verify-command.json',
  );
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-secret-config-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes(state.secretConfigRoot), false);
  assert.equal(cli.stdout.includes('DISABLED_TOKEN'), false);
  assert.equal(cli.stderr, '');
});

test('Secret/Config plan recovers exact publication response loss windows', async (t) => {
  for (const [hook, finalStatus] of [
    ['afterPlanPublished', 'prepared'],
    ['afterReceiptPublished', 'prepared'],
    ['afterTerminalSealed', 'prepared'],
    ['afterHeadAdvanced', 'existing'],
  ]) {
    await t.test(hook, async (subtest) => {
      const state = await secretConfigPlanFixture(subtest, { suffix: hook });
      let fault = true;
      await assert.rejects(
        planLocalReconciliationSecretConfig(state.secretConfigCommand, {
          [hook]() {
            if (fault) {
              fault = false;
              throw new Error(`secret-config-${hook}-fault`);
            }
          },
        }),
        new RegExp(`secret-config-${hook}-fault`),
      );
      const recovered = await planLocalReconciliationSecretConfig(
        state.secretConfigCommand,
      );
      assert.equal(recovered.status, finalStatus);
      assert.equal(recovered.outcome, 'ready');
      const verified = await verifyLocalReconciliationSecretConfigPlan({
        schemaVersion: 1,
        operation: 'local.deployment.reconciliation.secret-config.verify',
        options: state.secretConfigCommand.options,
        request: {
          secretConfigId: state.secretConfigId,
          expectedSecretConfigPlanDigest: recovered.secretConfigPlanDigest,
        },
      });
      assert.equal(verified.status, 'verified');
    });
  }
});

test('Secret/Config plan keeps active Env and unknown Configs manual', async (t) => {
  await t.test('active without adopted task', async (subtest) => {
    const state = await secretConfigPlanFixture(subtest, {
      suffix: 'active-manual',
      active: true,
    });
    const planned = await planLocalReconciliationSecretConfig(
      state.secretConfigCommand,
    );
    assert.equal(planned.outcome, 'manual_required');
    assert.equal(planned.eligibleBindingCount, 1);
    assert.equal(planned.adoptedLegacyTaskCount, 0);
  });
  await t.test('historical Configs', async (subtest) => {
    const state = await secretConfigPlanFixture(subtest, {
      suffix: 'configs-manual',
      configs: true,
    });
    const planned = await planLocalReconciliationSecretConfig(
      state.secretConfigCommand,
    );
    assert.equal(planned.outcome, 'manual_required');
    assert.equal(planned.unadaptedLegacyConfigCount, 1);
    const serialized = fs.readFileSync(
      path.join(state.secretConfigRoot, state.secretConfigId, 'plan.ndjson'),
      'utf8',
    );
    assert.equal(serialized.includes('private-config-value'), false);
  });
});

test('Secret/Config plan follows applied Automation and preserved Run History on an adopted legacy target', async (t) => {
  const state = await appliedAutomationFixture(t, {
    suffix: 'cross-domain-secret-config-plan',
    planId: '00000000-0000-4000-8000-000000000425',
    reviewId: '00000000-0000-4000-8000-000000000426',
    applicationId: '00000000-0000-4000-8000-000000000427',
    automationId: '00000000-0000-4000-8000-000000000428',
    decisionId: '019b0000-0000-7000-8000-000000000425',
    mutationId: '00000000-0000-4000-8000-000000000429',
    initializeDatabases: crossDomainReconciliationDatabaseInitializer(),
    mutateDecisions(records) {
      let secretConfigCount = 0;
      let runHistoryCount = 0;
      for (const record of records) {
        if (record.kind !== 'qinglong3-local-reconciliation-review-decision') {
          continue;
        }
        if (record.domain === 'secret_and_config') {
          record.disposition = 'manual_external';
          record.reason = 'external_recovery_required';
          secretConfigCount += 1;
        } else if (
          record.database === 'legacy' &&
          record.domain === 'run_history'
        ) {
          record.disposition = 'retain_both';
          record.reason = 'preserve_both';
          runHistoryCount += 1;
        }
      }
      assert.ok(secretConfigCount > 0);
      assert.ok(runHistoryCount > 0);
    },
  });
  assert.equal(state.application.outcome, 'adapter_and_manual_required');

  const runHistoryRoot = path.join(
    path.dirname(state.captureRoot),
    'cross-domain-run-history',
  );
  fs.mkdirSync(runHistoryRoot, { mode: 0o700 });
  const preservationCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.run-history.preserve',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      runHistoryRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      preservationId: '00000000-0000-4000-8000-000000000430',
      applicationId: state.application.applicationId,
      expectedApplicationPlanDigest: state.application.applicationPlanDigest,
      expectedHeadDigest: state.applied.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      preservedAtMs: state.applyCommand.request.appliedAtMs + 1,
    },
  };
  const preserved = await preserveLocalReconciliationRunHistory(
    preservationCommand,
  );
  assert.ok(preserved.legacyFactCount > 0);
  assert.ok(preserved.targetFactCount > 0);
  const preservationVerified = await verifyLocalReconciliationRunHistory({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.run-history.verify',
    options: preservationCommand.options,
    request: {
      preservationId: preservationCommand.request.preservationId,
      applicationId: preservationCommand.request.applicationId,
      expectedPreservationDigest: preserved.preservationDigest,
      decisionFilePath: state.reviewFile.filePath,
    },
  });
  assert.equal(preservationVerified.status, 'verified');

  const secretConfigRoot = path.join(
    path.dirname(state.captureRoot),
    'cross-domain-secret-config-plan',
  );
  fs.mkdirSync(secretConfigRoot, { mode: 0o700 });
  const secretConfigId = '00000000-0000-4000-8000-000000000431';
  const secretConfigCommand = {
    schemaVersion: 2,
    operation: 'local.deployment.reconciliation.secret-config.plan',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      secretConfigRoot,
      automationApplyRoot: state.automationApplyRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      secretConfigId,
      applicationId: state.application.applicationId,
      expectedApplicationPlanDigest: state.application.applicationPlanDigest,
      expectedHeadDigest: state.applied.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      projectId: 'default',
      preparedAtMs: preservationCommand.request.preservedAtMs + 1,
      automation: {
        automationId: state.automationCommand.request.automationId,
        decisionId: state.decisionId,
        expectedApplyDigest: state.applied.applyDigest,
      },
    },
  };
  const legacyPlanCommand = {
    ...secretConfigCommand,
    schemaVersion: 1,
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      secretConfigRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      ...secretConfigCommand.request,
      automation: undefined,
    },
  };
  delete legacyPlanCommand.request.automation;
  await assert.rejects(
    planLocalReconciliationSecretConfig(legacyPlanCommand),
    /Automation target authority is required/,
  );
  await assert.rejects(
    planLocalReconciliationSecretConfig({
      ...secretConfigCommand,
      request: {
        ...secretConfigCommand.request,
        automation: {
          ...secretConfigCommand.request.automation,
          expectedApplyDigest: 'f'.repeat(64),
        },
      },
    }),
    /Automation target authority is detached/,
  );
  const planned = await planLocalReconciliationSecretConfig(
    secretConfigCommand,
  );
  assert.equal(planned.outcome, 'ready');
  assert.equal(planned.eligibleBindingCount, 1);
  assert.equal(planned.adoptedLegacyTaskCount, 1);
  const verified = await verifyLocalReconciliationSecretConfigPlan({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.verify',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      secretConfigRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      secretConfigId,
      expectedSecretConfigPlanDigest: planned.secretConfigPlanDigest,
    },
  });
  assert.equal(verified.status, 'verified');
});

test('Secret/Config decision reauthenticates the same reviewer, seals exact candidates and verifies content-free', async (t) => {
  const state = await plannedSecretConfigDecisionFixture(t, {
    suffix: 'decision-terminal',
    planId: '00000000-0000-4000-8000-000000000425',
    reviewId: '00000000-0000-4000-8000-000000000426',
    applicationId: '00000000-0000-4000-8000-000000000427',
    secretConfigId: '00000000-0000-4000-8000-000000000428',
  });
  assert.equal(state.planned.outcome, 'ready');
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].requirement, 'review_preserve_disabled');
  const decisionId = '019b0000-0000-7000-8000-000000000425';
  const prepareCommand = secretConfigDecisionPrepareCommand(state, decisionId);
  const prepared = await prepareLocalReconciliationSecretConfigDecision(
    prepareCommand,
  );
  assert.equal(prepared.status, 'prepared');
  assert.equal(
    prepared.state,
    'reconciliation_secret_config_decision_prepared',
  );
  const decisionFile = secretConfigDecisionFile(
    state,
    { result: prepared },
    [
      {
        disposition: 'preserve_disabled',
        reason: 'reviewed_disabled_preservation',
      },
    ],
    'terminal',
  );
  const commit = secretConfigDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    decisionFile.filePath,
  );
  const targetBytes = fs.readFileSync(state.targetDatabasePath);
  const committed = await commitLocalReconciliationSecretConfigDecision(
    commit.command,
    commit.dependencies,
  );
  assert.equal(committed.status, 'prepared');
  assert.equal(committed.state, 'reconciliation_secret_config_reviewed');
  assert.equal(committed.outcome, 'ready');
  assert.equal(committed.candidateCount, 1);
  assert.equal(committed.applyBindingCount, 0);
  assert.equal(committed.preserveDisabledCount, 1);
  assert.equal(committed.skippedCount, 0);
  assert.equal(commit.authenticationCount(), 1);
  assert.equal(commit.confirmationCount(), 3);
  assert.equal(commit.databaseCloseCount(), 1);
  assert.equal(
    fs.readFileSync(state.targetDatabasePath).equals(targetBytes),
    true,
  );
  const decisionRoot = path.join(
    state.secretConfigDecisionRoot,
    state.secretConfigId,
  );
  assert.deepEqual(fs.readdirSync(decisionRoot).sort(), [
    'authorization.ndjson',
    'intent.json',
    'receipt.json',
    'staging',
  ]);
  assert.equal(fs.statSync(decisionRoot).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(decisionRoot, 'staging')).mode & 0o777,
    0o500,
  );
  for (const name of ['authorization.ndjson', 'intent.json', 'receipt.json']) {
    assert.equal(
      fs.statSync(path.join(decisionRoot, name)).mode & 0o777,
      0o400,
    );
  }
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.decision.verify',
    options: prepareCommand.options,
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedDecisionDigest: committed.decisionDigest,
    },
  };
  const verified = await verifyLocalReconciliationSecretConfigDecision(
    verifyCommand,
  );
  assert.equal(verified.status, 'verified');
  assert.equal(
    verified.signedDecisionSetDigest,
    committed.signedDecisionSetDigest,
  );
  const terminal = await readLocalReconciliationSecretConfigDecisionTerminal(
    prepareCommand.options,
    state.secretConfigId,
    process.getuid(),
  );
  assert.equal(terminal.receipt.decisionDigest, committed.decisionDigest);
  assert.equal(terminal.reviewer.subject.id, 'review-owner');
  const serialized = JSON.stringify(verified);
  for (const privateValue of [
    'DISABLED_TOKEN',
    'private-secret-value',
    'review-owner',
    decisionFile.filePath,
    state.candidates[0].candidateDigest,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  const commandPath = path.join(
    state.deploymentRoot,
    'secret-config-decision-verify.json',
  );
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-secret-config-decision-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes('review-owner'), false);
  assert.equal(cli.stdout.includes('DISABLED_TOKEN'), false);
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.captureCommand.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_secret_config_reviewed');
  assert.equal(head.sourceRecordDigest, committed.decisionDigest);

  const authorizationPath = path.join(decisionRoot, 'authorization.ndjson');
  fs.chmodSync(decisionRoot, 0o700);
  fs.chmodSync(authorizationPath, 0o600);
  fs.appendFileSync(authorizationPath, '{}\n');
  fs.chmodSync(authorizationPath, 0o400);
  fs.chmodSync(decisionRoot, 0o500);
  await assert.rejects(
    verifyLocalReconciliationSecretConfigDecision(verifyCommand),
    /authorization|file identity or size|file is incomplete/,
  );
});

test('Secret/Config apply publishes encrypted material atomically and recovers every apply and rollback boundary', async (t) => {
  const state = await plannedSecretConfigDecisionFixture(t, {
    suffix: 'apply-terminal',
    planId: '00000000-0000-4000-8000-000000000437',
    reviewId: '00000000-0000-4000-8000-000000000438',
    applicationId: '00000000-0000-4000-8000-000000000439',
    secretConfigId: '00000000-0000-4000-8000-00000000043a',
  });
  const decisionId = '019b0000-0000-7000-8000-000000000437';
  const prepareCommand = secretConfigDecisionPrepareCommand(state, decisionId);
  const prepared = await prepareLocalReconciliationSecretConfigDecision(
    prepareCommand,
  );
  const review = secretConfigDecisionFile(
    state,
    { result: prepared },
    [
      {
        disposition: 'preserve_disabled',
        reason: 'reviewed_disabled_preservation',
      },
    ],
    'apply-terminal',
  );
  const decision = secretConfigDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    review.filePath,
  );
  const committed = await commitLocalReconciliationSecretConfigDecision(
    decision.command,
    decision.dependencies,
  );
  assert.equal(committed.outcome, 'ready');

  const secretKeyringPath = path.join(
    state.deploymentRoot,
    'local-secret-keyring.json',
  );
  await provisionLocalSecretKeyring(secretKeyringPath);
  const secretConfigApplyRoot = path.join(
    path.dirname(state.captureRoot),
    'secret-config-apply-terminal',
  );
  fs.mkdirSync(secretConfigApplyRoot, { mode: 0o700 });
  const appliedAtMs = decision.command.request.committedAtMs + 1;
  const applyOptions = {
    ...prepareCommand.options,
    secretConfigApplyRoot,
    targetDatabasePath: state.targetDatabasePath,
    secretKeyringPath,
    ownerPepperKeyringDirectory:
      state.command.options.ownerPepperKeyringDirectory,
    credentialFilePath: state.command.options.credentialFilePath,
  };
  const applyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply',
    options: applyOptions,
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedDecisionDigest: committed.decisionDigest,
      expectedHeadDigest: committed.instanceHeadDigest,
      mutationId: '00000000-0000-4000-8000-00000000043b',
      requestId: 'secret-config-apply-terminal',
      appliedAtMs,
    },
  };
  let authentications = 0;
  let confirmations = 0;
  let databaseCloses = 0;
  const applyDependencies = {
    async openAuthenticationDatabase() {
      return {
        async close() {
          databaseCloses += 1;
        },
      };
    },
    async authenticate(_database, options) {
      authentications += 1;
      assert.match(
        options.authenticationNamespace,
        /^[a-z][a-z0-9_]{0,31}$/,
      );
      assert.equal(
        options.authenticationNamespace,
        'reconcile_secret_config_apply',
      );
      const authenticatedAtMs = options.now();
      return {
        principal: {
          subject: { type: 'user', id: 'review-owner' },
          authenticationId: 'reconcile_secret_config_apply:test',
          authenticatedAtMs,
          expiresAtMs: authenticatedAtMs + 60 * 60 * 1_000,
          assurance: 'local_console',
        },
        databaseFence: {
          credentialId: 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {
          confirmations += 1;
        },
      };
    },
  };
  const targetIdentity = fs.statSync(state.targetDatabasePath);
  await assert.rejects(
    applyLocalReconciliationSecretConfig(
      {
        ...applyCommand,
        options: {
          ...applyOptions,
          secretKeyringPath: path.join(
            path.dirname(state.deploymentRoot),
            'outside-secret-keyring.json',
          ),
        },
      },
      applyDependencies,
    ),
    /authentication or Secret material must be below deploymentRoot/,
  );
  for (const boundary of ['afterMaterialPublished']) {
    await assert.rejects(
      applyLocalReconciliationSecretConfig(applyCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`secret config apply ${boundary} response loss`);
        },
      }),
      new RegExp(`secret config apply ${boundary} response loss`),
    );
  }
  await assert.rejects(
    applyLocalReconciliationSecretConfig(applyCommand, {
      ...applyDependencies,
      async createBackup() {
        const error = new Error('router storage is full');
        error.code = 'ENOSPC';
        throw error;
      },
    }),
    /router storage is full/,
  );
  assert.equal(
    fs.existsSync(
      path.join(secretConfigApplyRoot, state.secretConfigId, 'intent.json'),
    ),
    false,
  );
  assert.equal(
    readLocalCutoverInstanceHead(
      state.deploymentRoot,
      state.captureCommand.request.instanceId,
      state.uid,
    ).state,
    'reconciliation_secret_config_reviewed',
  );
  for (const boundary of ['afterBackupPublished', 'afterPreparedHead']) {
    await assert.rejects(
      applyLocalReconciliationSecretConfig(applyCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`secret config apply ${boundary} response loss`);
        },
      }),
      new RegExp(`secret config apply ${boundary} response loss`),
    );
  }
  await assert.rejects(
    applyLocalReconciliationSecretConfig(applyCommand, {
      ...applyDependencies,
      async authenticate(database, options) {
        const authenticated = await applyDependencies.authenticate(
          database,
          options,
        );
        return {
          ...authenticated,
          principal: {
            ...authenticated.principal,
            subject: { type: 'user', id: 'another-owner' },
          },
        };
      },
    }),
    /current reviewer authentication is not strong or identical/,
  );
  for (const boundary of [
    'afterDatabaseCommit',
    'afterReceiptPublished',
    'afterAppliedHead',
    'afterAppliedSeal',
  ]) {
    await assert.rejects(
      applyLocalReconciliationSecretConfig(applyCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`secret config apply ${boundary} response loss`);
        },
      }),
      new RegExp(`secret config apply ${boundary} response loss`),
    );
  }
  const applied = await applyLocalReconciliationSecretConfig(
    applyCommand,
    applyDependencies,
  );
  assert.equal(applied.status, 'existing');
  assert.equal(applied.state, 'reconciliation_secret_config_applied');
  assert.equal(applied.activeBindingCount, 0);
  assert.equal(applied.disabledPreservationCount, 1);
  assert.equal(fs.statSync(state.targetDatabasePath).ino, targetIdentity.ino);
  const target = new DatabaseSync(state.targetDatabasePath, {
    readOnly: true,
  });
  assert.equal(
    target
      .prepare(
        'SELECT count(*) AS count FROM "QingLong3SecretConfigApplications"',
      )
      .get().count,
    1,
  );
  assert.equal(
    target
      .prepare('SELECT count(*) AS count FROM "QingLong3LocalSecretEnvelopes"')
      .get().count,
    1,
  );
  target.close();
  const evidenceRoot = path.join(secretConfigApplyRoot, state.secretConfigId);
  const materialsPath = path.join(evidenceRoot, 'materials.ndjson');
  const materialText = fs.readFileSync(materialsPath, 'utf8');
  assert.equal(materialText.includes('private-secret-value'), false);
  assert.equal(materialText.includes('DISABLED_TOKEN'), false);
  assert.equal(fs.statSync(evidenceRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(materialsPath).mode & 0o777, 0o400);
  assert.deepEqual(fs.readdirSync(evidenceRoot).sort(), [
    'backup',
    'intent.json',
    'materials.ndjson',
    'receipt.json',
    'rollback-work',
  ]);
  const verified = await verifyLocalReconciliationSecretConfigApply({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply.verify',
    options: applyOptions,
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedApplyDigest: applied.applyDigest,
    },
  });
  assert.equal(verified.status, 'verified');
  const verifyPath = path.join(
    state.deploymentRoot,
    'secret-config-apply-verify.json',
  );
  fs.writeFileSync(
    verifyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.secret-config.apply.verify',
      options: applyOptions,
      request: {
        decisionId,
        secretConfigId: state.secretConfigId,
        expectedApplyDigest: applied.applyDigest,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const verifyCli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-secret-config-apply-verify',
      '--command-file',
      verifyPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(verifyCli.status, 0, verifyCli.stderr);
  assert.equal(JSON.parse(verifyCli.stdout).status, 'verified');
  assert.equal(verifyCli.stdout.includes('private-secret-value'), false);

  const rollbackCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply.rollback',
    options: applyOptions,
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedApplyDigest: applied.applyDigest,
      expectedHeadDigest: applied.instanceHeadDigest,
      rolledBackAtMs: appliedAtMs + 1,
    },
  };
  for (const boundary of [
    'afterRestore',
    'afterRollbackReceipt',
    'afterRollbackHead',
    'afterRollbackSeal',
  ]) {
    await assert.rejects(
      rollbackLocalReconciliationSecretConfigApply(rollbackCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`secret config rollback ${boundary} response loss`);
        },
      }),
      new RegExp(`secret config rollback ${boundary} response loss`),
    );
  }
  const rolledBack = await rollbackLocalReconciliationSecretConfigApply(
    rollbackCommand,
    applyDependencies,
  );
  assert.equal(rolledBack.status, 'existing');
  assert.equal(rolledBack.state, 'reconciliation_secret_config_rolled_back');
  assert.equal(fs.statSync(state.targetDatabasePath).ino, targetIdentity.ino);
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'backup')), []);
  assert.deepEqual(fs.readdirSync(path.join(evidenceRoot, 'rollback-work')), [
    'receipt.json',
  ]);
  const restored = new DatabaseSync(state.targetDatabasePath, {
    readOnly: true,
  });
  assert.equal(
    restored
      .prepare(
        'SELECT count(*) AS count FROM "QingLong3SecretConfigApplications"',
      )
      .get().count,
    0,
  );
  restored.close();
  const rollbackVerified = await verifyLocalReconciliationSecretConfigApply({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.secret-config.apply.verify',
    options: applyOptions,
    request: {
      decisionId,
      secretConfigId: state.secretConfigId,
      expectedApplyDigest: applied.applyDigest,
    },
  });
  assert.equal(
    rollbackVerified.state,
    'reconciliation_secret_config_rolled_back',
  );
  assert.ok(authentications >= 3);
  assert.ok(confirmations >= 4);
  assert.equal(databaseCloses, authentications);
});

test('completion v3 completes a classified v52 target and collects Secret/Config rollback authority', async (t) => {
  const state = await appliedSecretConfigFixture(t, {
    suffix: 'completion-v3',
  });
  const completionRoot = path.join(
    path.dirname(state.captureRoot),
    'completion-secret-config-v3',
  );
  fs.mkdirSync(completionRoot, { mode: 0o700 });
  const secretConfig = {
    secretConfigId: state.secretConfigId,
    decisionId: state.decisionId,
    expectedApplyDigest: state.applied.applyDigest,
  };
  const command = {
    schemaVersion: 3,
    operation: 'local.deployment.reconciliation.complete',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      completionRoot,
      automation: null,
      secretConfig: {
        secretConfigRoot: state.secretConfigRoot,
        secretConfigDecisionRoot: state.secretConfigDecisionRoot,
        secretConfigApplyRoot: state.secretConfigApplyRoot,
        targetDatabasePath: state.targetDatabasePath,
      },
      runHistory: null,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      completionId: '00000000-0000-4000-8000-000000000526',
      applicationId: state.application.applicationId,
      expectedApplicationPlanDigest: state.application.applicationPlanDigest,
      expectedHeadDigest: state.applied.instanceHeadDigest,
      automation: null,
      secretConfig,
      runHistory: null,
      completedAtMs: state.applyCommand.request.appliedAtMs + 1,
    },
  };
  const applyRoot = path.join(
    state.secretConfigApplyRoot,
    state.secretConfigId,
  );
  const backupRoot = path.join(applyRoot, 'backup');
  const backupPath = path.join(backupRoot, 'before.sqlite');
  const materialPath = path.join(applyRoot, 'materials.ndjson');
  assert.equal(fs.existsSync(backupPath), true);
  const plan = JSON.parse(
    fs.readFileSync(
      path.join(
        state.planRoot,
        state.prepareCommand.request.planId,
        'plan.json',
      ),
      'utf8',
    ),
  );
  assert.deepEqual(
    plan.domains.find((domain) => domain.domain === 'unknown'),
    {
      domain: 'unknown',
      legacySchemaObjects: 0,
      targetSchemaObjects: 0,
      legacyTables: 0,
      targetTables: 0,
      legacyRows: 0,
      targetRows: 0,
      rowCountsComplete: true,
      inventoryDigest: plan.domains.find(
        (domain) => domain.domain === 'unknown',
      ).inventoryDigest,
      disposition: 'aligned',
    },
  );
  assert.equal(
    plan.domains.find((domain) => domain.domain === 'identity_policy_audit')
      .disposition,
    'target_only',
  );
  const targetIdentityDecisions = state.reviewFile.decisions.filter(
    (decision) =>
      decision.database === 'target' &&
      decision.domain === 'identity_policy_audit',
  );
  assert.ok(targetIdentityDecisions.length > 0);
  assert.equal(
    targetIdentityDecisions.every(
      (decision) => decision.disposition === 'retain_target',
    ),
    true,
  );

  const completed = await completeLocalReconciliation(command);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.state, 'reconciliation_completed');
  assert.equal(completed.adapterCount, 1);
  assert.equal((await completeLocalReconciliation(command)).status, 'existing');
  assert.equal(
    readLocalCutoverInstanceHead(
      state.deploymentRoot,
      state.captureCommand.request.instanceId,
      state.uid,
    ).state,
    'reconciliation_completed',
  );
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(completionRoot, command.request.completionId, 'receipt.json'),
      'utf8',
    ),
  );
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(fs.existsSync(backupPath), false);
  assert.deepEqual(fs.readdirSync(backupRoot), []);
  assert.deepEqual(fs.readdirSync(path.join(applyRoot, 'rollback-work')), []);
  assert.equal(fs.statSync(backupRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(materialPath).mode & 0o777, 0o400);
  assert.ok(fs.statSync(materialPath).size < 64 * 1024);
  assert.deepEqual(
    receipt.domains.find((domain) => domain.domain === 'secret_and_config'),
    {
      domain: 'secret_and_config',
      action: 'adapter_required',
      evidenceKind: 'secret_config_application',
      evidenceDigest: state.applied.applyDigest,
    },
  );
  for (const domainName of ['identity_policy_audit', 'unknown']) {
    assert.equal(
      receipt.domains.find((domain) => domain.domain === domainName).action,
      'no_effect',
    );
  }
  const verified = await verifyLocalReconciliationCompletion({
    schemaVersion: 3,
    operation: 'local.deployment.reconciliation.complete.verify',
    options: command.options,
    request: {
      completionId: command.request.completionId,
      applicationId: command.request.applicationId,
      expectedCompletionDigest: completed.completionDigest,
      automation: null,
      secretConfig,
      runHistory: null,
    },
  });
  assert.equal(verified.status, 'verified');
});

test('completion v3 rejects rolled-back Secret/Config evidence', async (t) => {
  const state = await appliedSecretConfigFixture(t, {
    suffix: 'completion-rolled-back',
    planId: '00000000-0000-4000-8000-000000000531',
    reviewId: '00000000-0000-4000-8000-000000000532',
    applicationId: '00000000-0000-4000-8000-000000000533',
    secretConfigId: '00000000-0000-4000-8000-000000000534',
    decisionId: '019b0000-0000-7000-8000-000000000531',
    mutationId: '00000000-0000-4000-8000-000000000535',
  });
  const rollback = await rollbackLocalReconciliationSecretConfigApply(
    {
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.secret-config.apply.rollback',
      options: state.applyOptions,
      request: {
        decisionId: state.decisionId,
        secretConfigId: state.secretConfigId,
        expectedApplyDigest: state.applied.applyDigest,
        expectedHeadDigest: state.applied.instanceHeadDigest,
        rolledBackAtMs: state.applyCommand.request.appliedAtMs + 1,
      },
    },
    state.applyDependencies,
  );
  const completionRoot = path.join(
    path.dirname(state.captureRoot),
    'completion-secret-config-rolled-back',
  );
  fs.mkdirSync(completionRoot, { mode: 0o700 });
  await assert.rejects(
    completeLocalReconciliation({
      schemaVersion: 3,
      operation: 'local.deployment.reconciliation.complete',
      options: {
        deploymentRoot: state.deploymentRoot,
        applicationRoot: state.applicationRoot,
        completionRoot,
        automation: null,
        secretConfig: {
          secretConfigRoot: state.secretConfigRoot,
          secretConfigDecisionRoot: state.secretConfigDecisionRoot,
          secretConfigApplyRoot: state.secretConfigApplyRoot,
          targetDatabasePath: state.targetDatabasePath,
        },
        runHistory: null,
        allowRootService: rootAcknowledgement(),
      },
      request: {
        completionId: '00000000-0000-4000-8000-000000000536',
        applicationId: state.application.applicationId,
        expectedApplicationPlanDigest: state.application.applicationPlanDigest,
        expectedHeadDigest: rollback.instanceHeadDigest,
        automation: null,
        secretConfig: {
          secretConfigId: state.secretConfigId,
          decisionId: state.decisionId,
          expectedApplyDigest: state.applied.applyDigest,
        },
        runHistory: null,
        completedAtMs: state.applyCommand.request.appliedAtMs + 2,
      },
    }),
    /secret config apply evidence is detached/,
  );
});

test('completion v3 rejects Secret/Config target drift without collecting rollback authority', async (t) => {
  const state = await appliedSecretConfigFixture(t, {
    suffix: 'completion-target-drift',
    planId: '00000000-0000-4000-8000-000000000541',
    reviewId: '00000000-0000-4000-8000-000000000542',
    applicationId: '00000000-0000-4000-8000-000000000543',
    secretConfigId: '00000000-0000-4000-8000-000000000544',
    decisionId: '019b0000-0000-7000-8000-000000000541',
    mutationId: '00000000-0000-4000-8000-000000000545',
  });
  const target = new DatabaseSync(state.targetDatabasePath);
  target.exec('PRAGMA user_version=77');
  target.close();
  const completionRoot = path.join(
    path.dirname(state.captureRoot),
    'completion-secret-config-target-drift',
  );
  fs.mkdirSync(completionRoot, { mode: 0o700 });
  const backupPath = path.join(
    state.secretConfigApplyRoot,
    state.secretConfigId,
    'backup',
    'before.sqlite',
  );
  await assert.rejects(
    completeLocalReconciliation({
      schemaVersion: 3,
      operation: 'local.deployment.reconciliation.complete',
      options: {
        deploymentRoot: state.deploymentRoot,
        applicationRoot: state.applicationRoot,
        completionRoot,
        automation: null,
        secretConfig: {
          secretConfigRoot: state.secretConfigRoot,
          secretConfigDecisionRoot: state.secretConfigDecisionRoot,
          secretConfigApplyRoot: state.secretConfigApplyRoot,
          targetDatabasePath: state.targetDatabasePath,
        },
        runHistory: null,
        allowRootService: rootAcknowledgement(),
      },
      request: {
        completionId: '00000000-0000-4000-8000-000000000546',
        applicationId: state.application.applicationId,
        expectedApplicationPlanDigest: state.application.applicationPlanDigest,
        expectedHeadDigest: state.applied.instanceHeadDigest,
        automation: null,
        secretConfig: {
          secretConfigId: state.secretConfigId,
          decisionId: state.decisionId,
          expectedApplyDigest: state.applied.applyDigest,
        },
        runHistory: null,
        completedAtMs: state.applyCommand.request.appliedAtMs + 1,
      },
    }),
    /secret config target drifted after apply/,
  );
  assert.equal(fs.existsSync(backupPath), true);
});

test('Secret/Config decision rejects manual plans, invalid candidate choices and reviewer drift', async (t) => {
  const manual = await plannedSecretConfigDecisionFixture(t, {
    suffix: 'decision-manual-plan',
    active: true,
    planId: '00000000-0000-4000-8000-000000000429',
    reviewId: '00000000-0000-4000-8000-00000000042a',
    applicationId: '00000000-0000-4000-8000-00000000042b',
    secretConfigId: '00000000-0000-4000-8000-00000000042c',
  });
  assert.equal(manual.planned.outcome, 'manual_required');
  await assert.rejects(
    prepareLocalReconciliationSecretConfigDecision(
      secretConfigDecisionPrepareCommand(
        manual,
        '019b0000-0000-7000-8000-000000000429',
      ),
    ),
    /only a ready non-empty plan can be reviewed/,
  );

  const state = await plannedSecretConfigDecisionFixture(t, {
    suffix: 'decision-reject',
    planId: '00000000-0000-4000-8000-00000000042d',
    reviewId: '00000000-0000-4000-8000-00000000042e',
    applicationId: '00000000-0000-4000-8000-00000000042f',
    secretConfigId: '00000000-0000-4000-8000-000000000430',
  });
  const prepareCommand = secretConfigDecisionPrepareCommand(
    state,
    '019b0000-0000-7000-8000-00000000042d',
  );
  const prepared = await prepareLocalReconciliationSecretConfigDecision(
    prepareCommand,
  );
  const invalid = secretConfigDecisionFile(
    state,
    { result: prepared },
    [
      {
        disposition: 'apply_active_binding',
        reason: 'reviewed_active_binding',
      },
    ],
    'invalid-choice',
  );
  const invalidCommit = secretConfigDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    invalid.filePath,
  );
  await assert.rejects(
    commitLocalReconciliationSecretConfigDecision(
      invalidCommit.command,
      invalidCommit.dependencies,
    ),
    /decision is not allowed for canonical candidate/,
  );
  assert.equal(invalidCommit.authenticationCount(), 0);

  const valid = secretConfigDecisionFile(
    state,
    { result: prepared },
    [
      {
        disposition: 'preserve_disabled',
        reason: 'reviewed_disabled_preservation',
      },
    ],
    'reviewer-reject',
  );
  for (const auth of [
    { reviewerId: 'another-owner', assurance: 'local_console' },
    { reviewerId: 'review-owner', assurance: 'password' },
  ]) {
    const rejected = secretConfigDecisionCommitFixture(
      state,
      { result: prepared, commandOptions: prepareCommand.options },
      valid.filePath,
      auth,
    );
    await assert.rejects(
      commitLocalReconciliationSecretConfigDecision(
        rejected.command,
        rejected.dependencies,
      ),
      /requires the same recently strong authenticated User/,
    );
    assert.equal(rejected.authenticationCount(), 1);
    assert.equal(rejected.confirmationCount(), 0);
    assert.equal(rejected.databaseCloseCount(), 1);
  }
});

test('Secret/Config decision replays every publication boundary without repeated authentication', async (t) => {
  const prepareState = await plannedSecretConfigDecisionFixture(t, {
    suffix: 'decision-prepare-loss',
    secretConfigId: '00000000-0000-4000-8000-000000000431',
  });
  const prepareCommand = secretConfigDecisionPrepareCommand(
    prepareState,
    '019b0000-0000-7000-8000-000000000431',
  );
  await assert.rejects(
    prepareLocalReconciliationSecretConfigDecision(prepareCommand, {
      afterHeadPrepared() {
        throw new Error('secret config decision prepare response loss');
      },
    }),
    /secret config decision prepare response loss/,
  );
  const prepareReplay = await prepareLocalReconciliationSecretConfigDecision(
    prepareCommand,
  );
  assert.equal(
    prepareReplay.state,
    'reconciliation_secret_config_decision_prepared',
  );

  for (const [window, tail] of [
    ['authorization', '432'],
    ['receipt', '433'],
    ['seal', '434'],
    ['head', '435'],
  ]) {
    await t.test(window, async (subtest) => {
      const state = await plannedSecretConfigDecisionFixture(subtest, {
        suffix: `decision-${window}-loss`,
        secretConfigId: `00000000-0000-4000-8000-000000000${tail}`,
      });
      const decisionId = `019b0000-0000-7000-8000-000000000${tail}`;
      const selectedPrepareCommand = secretConfigDecisionPrepareCommand(
        state,
        decisionId,
      );
      const prepared = await prepareLocalReconciliationSecretConfigDecision(
        selectedPrepareCommand,
      );
      const review = secretConfigDecisionFile(
        state,
        { result: prepared },
        [
          {
            disposition: 'preserve_disabled',
            reason: 'reviewed_disabled_preservation',
          },
        ],
        `${window}-loss`,
      );
      const commit = secretConfigDecisionCommitFixture(
        state,
        {
          result: prepared,
          commandOptions: selectedPrepareCommand.options,
        },
        review.filePath,
      );
      const callback =
        window === 'authorization'
          ? 'afterAuthorizationPublished'
          : window === 'receipt'
          ? 'afterReceiptPublished'
          : window === 'seal'
          ? 'afterTerminalSealed'
          : 'afterHeadAdvanced';
      await assert.rejects(
        commitLocalReconciliationSecretConfigDecision(commit.command, {
          ...commit.dependencies,
          [callback]() {
            throw new Error(`secret config decision ${window} response loss`);
          },
        }),
        new RegExp(`secret config decision ${window} response loss`),
      );
      const replay = await commitLocalReconciliationSecretConfigDecision(
        commit.command,
        commit.dependencies,
      );
      assert.equal(replay.state, 'reconciliation_secret_config_reviewed');
      assert.equal(commit.authenticationCount(), 1);
      assert.equal(commit.confirmationCount(), 3);
      assert.equal(commit.databaseCloseCount(), 1);
      if (window === 'head') assert.equal(replay.status, 'existing');
    });
  }
});

test('Secret/Config decision can explicitly skip a ready candidate only into manual_required', async (t) => {
  const state = await plannedSecretConfigDecisionFixture(t, {
    suffix: 'decision-skip',
    secretConfigId: '00000000-0000-4000-8000-000000000436',
  });
  const prepareCommand = secretConfigDecisionPrepareCommand(
    state,
    '019b0000-0000-7000-8000-000000000436',
  );
  const prepared = await prepareLocalReconciliationSecretConfigDecision(
    prepareCommand,
  );
  const review = secretConfigDecisionFile(
    state,
    { result: prepared },
    [{ disposition: 'skip', reason: 'operator_excluded' }],
    'skip',
  );
  const commit = secretConfigDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    review.filePath,
  );
  const result = await commitLocalReconciliationSecretConfigDecision(
    commit.command,
    commit.dependencies,
  );
  assert.equal(result.outcome, 'manual_required');
  assert.equal(result.skippedCount, 1);
  assert.equal(result.preserveDisabledCount, 0);
});

test('completion fence retains automation rollback backup while other domains remain manual', async (t) => {
  const state = await appliedAutomationFixture(t, {
    suffix: 'completion-fence',
    planId: '00000000-0000-4000-8000-000000000491',
    reviewId: '00000000-0000-4000-8000-000000000492',
    applicationId: '00000000-0000-4000-8000-000000000493',
    automationId: '00000000-0000-4000-8000-000000000494',
    decisionId: '019b0000-0000-7000-8000-000000000491',
    mutationId: '00000000-0000-4000-8000-000000000495',
  });
  const completionRoot = path.join(
    path.dirname(state.captureRoot),
    'completion-automation-applied',
  );
  fs.mkdirSync(completionRoot, { mode: 0o700 });
  const automation = {
    automationId: state.automationCommand.request.automationId,
    decisionId: state.decisionId,
    expectedApplyDigest: state.applied.applyDigest,
  };
  const completionOptions = {
    deploymentRoot: state.deploymentRoot,
    applicationRoot: state.applicationRoot,
    completionRoot,
    automation: {
      automationRoot: state.automationRoot,
      automationDecisionRoot: state.automationDecisionRoot,
      automationApplyRoot: state.automationApplyRoot,
      targetDatabasePath: state.targetDatabasePath,
    },
    allowRootService: rootAcknowledgement(),
  };
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.complete',
    options: completionOptions,
    request: {
      completionId: '00000000-0000-4000-8000-000000000496',
      applicationId: state.application.applicationId,
      expectedApplicationPlanDigest: state.application.applicationPlanDigest,
      expectedHeadDigest: state.applied.instanceHeadDigest,
      automation,
      completedAtMs: state.applyCommand.request.appliedAtMs + 1,
    },
  };
  const applyRoot = path.join(
    state.automationApplyRoot,
    state.automationCommand.request.automationId,
  );
  const backupRoot = path.join(applyRoot, 'backup');
  const backupPath = path.join(backupRoot, 'before.sqlite');
  const rollbackRoot = path.join(applyRoot, 'rollback-work');
  assert.equal(fs.existsSync(backupPath), true);
  await assert.rejects(
    completeLocalReconciliation(command),
    /secret_and_config is not terminally reconciled/,
  );
  assert.equal(fs.existsSync(backupPath), true);
  assert.deepEqual(fs.readdirSync(backupRoot), ['before.sqlite']);
  assert.deepEqual(fs.readdirSync(rollbackRoot), []);
  assert.equal(fs.statSync(backupRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(rollbackRoot).mode & 0o777, 0o700);
  assert.equal(
    fs.existsSync(path.join(completionRoot, command.request.completionId)),
    false,
  );
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.captureCommand.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_automation_applied');
  assert.equal(head.sourceRecordDigest, state.applied.applyDigest);
  assert.throws(
    () =>
      assertLocalCutoverTargetHead(
        {
          options: { deploymentRoot: state.deploymentRoot },
          request: {
            cutoverId: state.captureCommand.request.cutoverId,
            profile: state.captureCommand.request.profile,
            instanceId: state.captureCommand.request.instanceId,
            expectedActivationDigest:
              state.captureCommand.request.expectedActivationDigest,
            requestedAtMs: command.request.completedAtMs + 1,
          },
        },
        state.uid,
      ),
    /not bound to the instance lineage head/,
  );
});

test('run history preservation seals terminal histories and completes through v2 evidence', async (t) => {
  const state = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000501',
    reviewId: '00000000-0000-4000-8000-000000000502',
    applicationId: '00000000-0000-4000-8000-000000000503',
    reviewSuffix: 'run-history-preservation',
    createDefaultSidecars: false,
    initializeDatabases: runHistoryDatabaseInitializer(),
    mutateTarget(paths) {
      return mutateRunHistoryTarget(paths);
    },
    mutateDecisions(records) {
      const selected = records.filter(
        (record) =>
          record.kind === 'qinglong3-local-reconciliation-review-decision' &&
          record.database === 'legacy' &&
          record.domain === 'run_history',
      );
      assert.ok(selected.length > 0);
      for (const record of selected) {
        record.disposition = 'retain_both';
        record.reason = 'preserve_both';
      }
    },
  });
  const prepared = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, prepared),
  );
  assert.equal(application.outcome, 'adapter_required');
  const applicationPlan = JSON.parse(
    fs.readFileSync(
      path.join(state.applicationRoot, application.applicationId, 'plan.json'),
      'utf8',
    ),
  );
  assert.equal(
    applicationPlan.domains.find((domain) => domain.domain === 'run_history')
      .action,
    'adapter_required',
  );

  const runHistoryRoot = path.join(
    path.dirname(state.captureRoot),
    'run-history-preservation-root',
  );
  fs.mkdirSync(runHistoryRoot, { mode: 0o700 });
  const preservationCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.run-history.preserve',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      runHistoryRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      preservationId: '00000000-0000-4000-8000-000000000504',
      applicationId: application.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      preservedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 3,
    },
  };
  for (const boundary of ['afterReceiptPublished', 'afterTerminalSealed']) {
    await assert.rejects(
      preserveLocalReconciliationRunHistory(preservationCommand, {
        [boundary]() {
          throw new Error(`run history ${boundary} response loss`);
        },
      }),
      new RegExp(`run history ${boundary} response loss`),
    );
  }
  const preserved = await preserveLocalReconciliationRunHistory(
    preservationCommand,
  );
  assert.equal(preserved.status, 'existing');
  assert.ok(preserved.legacyFactCount > 0);
  assert.ok(preserved.targetFactCount > 0);
  const preservationDirectory = path.join(
    runHistoryRoot,
    preservationCommand.request.preservationId,
  );
  assert.deepEqual(fs.readdirSync(preservationDirectory), ['receipt.json']);
  assert.equal(fs.statSync(preservationDirectory).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(preservationDirectory, 'receipt.json')).mode & 0o777,
    0o400,
  );
  const preservationReceiptText = fs.readFileSync(
    path.join(preservationDirectory, 'receipt.json'),
    'utf8',
  );
  assert.equal(preservationReceiptText.includes('CrontabStats'), false);
  assert.equal(preservationReceiptText.includes('captured'), false);
  assert.equal(
    preservationReceiptText.includes(state.reviewFile.filePath),
    false,
  );

  const preservationVerifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.run-history.verify',
    options: preservationCommand.options,
    request: {
      preservationId: preservationCommand.request.preservationId,
      applicationId: preservationCommand.request.applicationId,
      expectedPreservationDigest: preserved.preservationDigest,
      decisionFilePath: state.reviewFile.filePath,
    },
  };
  const preservationVerified = await verifyLocalReconciliationRunHistory(
    preservationVerifyCommand,
  );
  assert.equal(preservationVerified.status, 'verified');

  const completionRoot = path.join(
    path.dirname(state.captureRoot),
    'completion-run-history',
  );
  fs.mkdirSync(completionRoot, { mode: 0o700 });
  const runHistory = {
    preservationId: preservationCommand.request.preservationId,
    expectedPreservationDigest: preserved.preservationDigest,
  };
  const completionCommand = {
    schemaVersion: 2,
    operation: 'local.deployment.reconciliation.complete',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      completionRoot,
      automation: null,
      runHistory: {
        runHistoryRoot,
        decisionFilePath: state.reviewFile.filePath,
      },
      allowRootService: rootAcknowledgement(),
    },
    request: {
      completionId: '00000000-0000-4000-8000-000000000505',
      applicationId: application.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      automation: null,
      runHistory,
      completedAtMs: preservationCommand.request.preservedAtMs + 1,
    },
  };
  const completed = await completeLocalReconciliation(completionCommand);
  assert.equal(completed.adapterCount, 1);
  const completionReceipt = JSON.parse(
    fs.readFileSync(
      path.join(
        completionRoot,
        completionCommand.request.completionId,
        'receipt.json',
      ),
      'utf8',
    ),
  );
  assert.equal(completionReceipt.schemaVersion, 2);
  assert.deepEqual(
    completionReceipt.domains.find((domain) => domain.domain === 'run_history'),
    {
      domain: 'run_history',
      action: 'adapter_required',
      evidenceKind: 'run_history_preservation',
      evidenceDigest: preserved.preservationDigest,
    },
  );
  const completionVerified = await verifyLocalReconciliationCompletion({
    schemaVersion: 2,
    operation: 'local.deployment.reconciliation.complete.verify',
    options: completionCommand.options,
    request: {
      completionId: completionCommand.request.completionId,
      applicationId: completionCommand.request.applicationId,
      expectedCompletionDigest: completed.completionDigest,
      automation: null,
      runHistory,
    },
  });
  assert.equal(completionVerified.status, 'verified');

  const commandPath = path.join(
    state.deploymentRoot,
    'run-history-verify.json',
  );
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify(preservationVerifyCommand)}\n`,
    { mode: 0o600 },
  );
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-run-history-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes(runHistoryRoot), false);
  assert.equal(cli.stdout.includes('CrontabStats'), false);

  const preservationReceiptPath = path.join(
    preservationDirectory,
    'receipt.json',
  );
  const tamperedReceipt = JSON.parse(
    fs.readFileSync(preservationReceiptPath, 'utf8'),
  );
  tamperedReceipt.legacyFactCount += 1;
  fs.chmodSync(preservationDirectory, 0o700);
  fs.chmodSync(preservationReceiptPath, 0o600);
  fs.writeFileSync(
    preservationReceiptPath,
    `${JSON.stringify(tamperedReceipt, null, 2)}\n`,
  );
  fs.chmodSync(preservationReceiptPath, 0o400);
  fs.chmodSync(preservationDirectory, 0o500);
  await assert.rejects(
    verifyLocalReconciliationRunHistory(preservationVerifyCommand),
    /receipt binding is invalid/,
  );
});

test('run history preservation rejects active target runs and review escalation', async (t) => {
  const state = reviewCommitFixture(t, {
    planId: '00000000-0000-4000-8000-000000000511',
    reviewId: '00000000-0000-4000-8000-000000000512',
    reviewSuffix: 'run-history-active',
    createDefaultSidecars: false,
    initializeDatabases: runHistoryDatabaseInitializer(),
    mutateTarget(paths) {
      return mutateRunHistoryTarget(paths, 'running');
    },
  });
  const pageCommand = diagnosticCommand(state, state.prepared, {
    database: 'target',
    domain: 'run_history',
    factKind: 'table',
    outputName: 'active-run-history.json',
  });
  writeLocalReconciliationReviewDiagnostics(pageCommand);
  const page = JSON.parse(
    fs.readFileSync(pageCommand.request.outputPath, 'utf8'),
  );
  assert.ok(page.records.length > 0);
  assert.equal(
    page.records.every(
      (fact) =>
        fact.decisionRequirement === 'blocked' &&
        fact.reason === 'historical_integrity_required',
    ),
    true,
  );
  const selected = state.reviewFile.records.find(
    (record) =>
      record.kind === 'qinglong3-local-reconciliation-review-decision' &&
      record.database === 'target' &&
      record.domain === 'run_history',
  );
  assert.ok(selected);
  selected.disposition = 'retain_target';
  selected.reason = 'preserve_target';
  fs.writeFileSync(
    state.reviewFile.filePath,
    `${state.reviewFile.records
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    commitLocalReconciliationReview(state.command, state.dependencies),
    /decision disposition is not allowed for canonical fact/,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        state.reviewRoot,
        state.reviewCommand.request.reviewId,
        'review.json',
      ),
    ),
    false,
  );
});

test('automation adapter builds a sealed row plan with bounded conflict evidence', async (t) => {
  const state = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000431',
    reviewId: '00000000-0000-4000-8000-000000000432',
    applicationId: '00000000-0000-4000-8000-000000000433',
    reviewSuffix: 'automation-row-plan',
    createDefaultSidecars: false,
    initializeDatabases: automationDatabaseInitializer(),
    mutateTarget(paths) {
      return mutateAutomationTarget(paths);
    },
    mutateDecisions(records) {
      const selected = records.find(
        (record) =>
          record.kind === 'qinglong3-local-reconciliation-review-decision' &&
          record.database === 'legacy' &&
          record.domain === 'automation' &&
          record.factKind === 'table' &&
          record.disposition === 'exclude_legacy',
      );
      assert.ok(selected);
      selected.disposition = 'adopt_legacy';
      selected.reason = 'prefer_legacy';
    },
  });
  const prepared = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, prepared),
  );
  const automationRoot = path.join(
    path.dirname(state.captureRoot),
    'automation-root',
  );
  fs.mkdirSync(automationRoot, { mode: 0o700 });
  const targetBefore = fs.readFileSync(state.targetDatabasePath);
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.plan',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      automationRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      automationId: '00000000-0000-4000-8000-000000000434',
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      projectId: 'default',
      legacyTimezone: 'Asia/Shanghai',
      preparedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 2,
    },
  };
  const planned = await planLocalReconciliationAutomation(command);
  assert.equal(planned.status, 'prepared');
  assert.equal(planned.state, 'reconciliation_automation_planned');
  assert.equal(planned.outcome, 'ready');
  assert.equal(planned.rowCount, 1);
  assert.equal(planned.eligibleCount, 1);
  assert.equal(planned.conflictCount, 0);
  const automationDirectory = path.join(
    automationRoot,
    command.request.automationId,
  );
  assert.deepEqual(fs.readdirSync(automationDirectory).sort(), [
    'plan.ndjson',
    'receipt.json',
    'staging',
  ]);
  assert.equal(fs.statSync(automationDirectory).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(automationDirectory, 'staging')).mode & 0o777,
    0o500,
  );
  for (const name of ['plan.ndjson', 'receipt.json']) {
    assert.equal(
      fs.statSync(path.join(automationDirectory, name)).mode & 0o777,
      0o400,
    );
  }
  const planText = fs.readFileSync(
    path.join(automationDirectory, 'plan.ndjson'),
    'utf8',
  );
  assert.equal(planText.includes('task nightly.js'), false);
  assert.equal(planText.includes('nightly'), false);
  assert.equal(planText.includes('legacy-cron:1'), true);
  assert.equal(planText.includes('review-owner'), false);
  assert.equal(planText.includes('"requirement":"review_adopt"'), true);
  assert.equal(
    fs.readFileSync(state.targetDatabasePath).equals(targetBefore),
    true,
  );

  const replay = await planLocalReconciliationAutomation(command);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.automationPlanDigest, planned.automationPlanDigest);
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.verify',
    options: command.options,
    request: {
      automationId: command.request.automationId,
      expectedAutomationPlanDigest: planned.automationPlanDigest,
    },
  };
  const verified = await verifyLocalReconciliationAutomationPlan(verifyCommand);
  assert.equal(verified.status, 'verified');
  const head = readLocalCutoverInstanceHead(
    state.deploymentRoot,
    state.captureCommand.request.instanceId,
    state.uid,
  );
  assert.equal(head.state, 'reconciliation_automation_planned');
  assert.equal(head.sourceRecordDigest, planned.automationPlanDigest);

  const commandPath = path.join(state.deploymentRoot, 'automation-verify.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-automation-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes('legacy-cron:1'), false);
});

test('automation decision reauthenticates the same reviewer, seals exact row decisions and verifies content-free', async (t) => {
  const state = await plannedAutomationFixture(t, {
    suffix: 'signed-success',
    planId: '00000000-0000-4000-8000-000000000461',
    reviewId: '00000000-0000-4000-8000-000000000462',
    applicationId: '00000000-0000-4000-8000-000000000463',
    automationId: '00000000-0000-4000-8000-000000000464',
    readyTarget: true,
  });
  assert.equal(state.planRows[0].requirement, 'review_adopt');
  const decisionId = '019b0000-0000-7000-8000-000000000461';
  const review = automationDecisionReviewFile(
    state,
    decisionId,
    'adopt',
    'reviewed_lossless',
    'signed-success',
  );
  const prepareCommand = automationDecisionPrepareCommand(state, decisionId);
  const prepared = await prepareLocalReconciliationAutomationDecision(
    prepareCommand,
  );
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'reconciliation_automation_decision_prepared');
  const commit = automationDecisionCommitFixture(
    state,
    { result: prepared, commandOptions: prepareCommand.options },
    review.filePath,
  );
  const targetBytes = fs.readFileSync(state.targetDatabasePath);
  const committed = await commitLocalReconciliationAutomationDecision(
    commit.command,
    commit.dependencies,
  );
  assert.equal(committed.status, 'prepared');
  assert.equal(committed.state, 'reconciliation_automation_reviewed');
  assert.equal(committed.rowCount, 1);
  assert.equal(committed.adoptedCount, 1);
  assert.equal(committed.skippedCount, 0);
  assert.equal(commit.authenticationCount(), 1);
  assert.equal(commit.confirmationCount(), 1);
  assert.equal(commit.databaseCloseCount(), 1);
  assert.equal(
    fs.readFileSync(state.targetDatabasePath).equals(targetBytes),
    true,
  );
  const decisionDirectory = path.join(
    state.automationDecisionRoot,
    state.automationCommand.request.automationId,
  );
  assert.deepEqual(fs.readdirSync(decisionDirectory).sort(), [
    'authorization.ndjson',
    'intent.json',
    'receipt.json',
    'staging',
  ]);
  assert.equal(fs.statSync(decisionDirectory).mode & 0o777, 0o500);
  assert.equal(
    fs.statSync(path.join(decisionDirectory, 'staging')).mode & 0o777,
    0o500,
  );
  for (const name of ['authorization.ndjson', 'intent.json', 'receipt.json']) {
    assert.equal(
      fs.statSync(path.join(decisionDirectory, name)).mode & 0o777,
      0o400,
    );
  }
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.decision.verify',
    options: prepareCommand.options,
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedDecisionDigest: committed.decisionDigest,
    },
  };
  const verified = await verifyLocalReconciliationAutomationDecision(
    verifyCommand,
  );
  assert.equal(verified.status, 'verified');
  assert.equal(
    verified.signedDecisionSetDigest,
    committed.signedDecisionSetDigest,
  );
  const serialized = JSON.stringify(verified);
  assert.equal(serialized.includes('review-owner'), false);
  assert.equal(serialized.includes(state.planRows[0].sourceDigest), false);
  assert.equal(serialized.includes(review.filePath), false);
  const terminal = await readLocalReconciliationAutomationDecisionTerminal(
    prepareCommand.options,
    state.automationCommand.request.automationId,
    process.getuid(),
  );
  assert.equal(terminal.receipt.decisionDigest, committed.decisionDigest);
  assert.equal(
    terminal.context.application.plan.applicationPlanDigest,
    state.application.applicationPlanDigest,
  );
  assert.equal(
    terminal.authorizationPath.endsWith('/authorization.ndjson'),
    true,
  );
  const commandPath = path.join(
    state.deploymentRoot,
    'automation-decision-verify.json',
  );
  fs.writeFileSync(commandPath, `${JSON.stringify(verifyCommand)}\n`, {
    mode: 0o600,
  });
  const cli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-automation-decision-verify',
      '--command-file',
      commandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'verified');
  assert.equal(cli.stdout.includes('review-owner'), false);
  assert.equal(cli.stdout.includes(state.planRows[0].sourceDigest), false);

  const automationApplyRoot = path.join(
    path.dirname(state.captureRoot),
    'automation-apply-signed-success',
  );
  fs.mkdirSync(automationApplyRoot, { mode: 0o700 });
  const appliedAtMs = commit.command.request.committedAtMs + 1;
  const targetIdentity = fs.statSync(state.targetDatabasePath);
  const applyOptions = {
    ...prepareCommand.options,
    automationApplyRoot,
    targetDatabasePath: state.targetDatabasePath,
    ownerPepperKeyringDirectory:
      state.command.options.ownerPepperKeyringDirectory,
    credentialFilePath: state.command.options.credentialFilePath,
  };
  const applyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply',
    options: applyOptions,
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedDecisionDigest: committed.decisionDigest,
      expectedHeadDigest: committed.instanceHeadDigest,
      mutationId: '00000000-0000-4000-8000-000000000465',
      requestId: 'automation-apply-signed-success',
      appliedAtMs,
    },
  };
  const applyDependencies = {
    async openAuthenticationDatabase() {
      return { async close() {} };
    },
    async authenticate(_database, options) {
      assert.equal(
        options.authenticationNamespace,
        'reconcile_automation_apply',
      );
      const authenticatedAtMs = options.now();
      return {
        principal: {
          subject: { type: 'user', id: 'review-owner' },
          authenticationId: 'local_reconciliation_automation_apply:test',
          authenticatedAtMs,
          expiresAtMs: authenticatedAtMs + 60 * 60 * 1_000,
          assurance: 'local_console',
        },
        databaseFence: {
          credentialId: 'review-owner',
          credentialVersion: 1,
          pepperKeyId: 'review-owner-v1',
          pepperVersion: 1,
        },
        async confirm() {},
      };
    },
  };
  const liveApplyEvidence = readTargetDataReconciliationEvidenceForPaths(
    {
      profile: state.captureCommand.request.profile,
      activationPath: state.captureCommand.request.activationPath,
      legacySourcePath: state.captureCommand.request.legacySourcePath,
      targetDatabasePath: state.targetDatabasePath,
      expectedActivationDigest:
        state.captureCommand.request.expectedActivationDigest,
    },
    process.getuid(),
  );
  assert.equal(
    liveApplyEvidence.disposition,
    'reconciliation_required',
    JSON.stringify({
      liveApplyEvidence,
      activation: JSON.parse(
        fs.readFileSync(state.captureCommand.request.activationPath, 'utf8'),
      ),
      target: {
        ...fs.statSync(state.targetDatabasePath),
        mode: fs.statSync(state.targetDatabasePath).mode & 0o777,
        realpath: fs.realpathSync(state.targetDatabasePath),
        sidecars: ['-wal', '-shm', '-journal'].map((suffix) =>
          fs.existsSync(`${state.targetDatabasePath}${suffix}`),
        ),
      },
    }),
  );
  for (const boundary of ['afterBackupPublished', 'afterPreparedHead']) {
    await assert.rejects(
      applyLocalReconciliationAutomation(applyCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`automation apply ${boundary} response loss`);
        },
      }),
      new RegExp(`automation apply ${boundary} response loss`),
    );
  }
  await assert.rejects(
    applyLocalReconciliationAutomation(applyCommand, {
      ...applyDependencies,
      async authenticate(database, options) {
        const authenticated = await applyDependencies.authenticate(
          database,
          options,
        );
        return {
          ...authenticated,
          principal: {
            ...authenticated.principal,
            subject: { type: 'user', id: 'another-owner' },
          },
        };
      },
    }),
    /current reviewer authentication is not strong or identical/,
  );
  for (const boundary of [
    'afterDatabaseCommit',
    'afterReceiptPublished',
    'afterAppliedHead',
    'afterAppliedSeal',
  ]) {
    await assert.rejects(
      applyLocalReconciliationAutomation(applyCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`automation apply ${boundary} response loss`);
        },
      }),
      new RegExp(`automation apply ${boundary} response loss`),
    );
  }
  const applied = await applyLocalReconciliationAutomation(
    applyCommand,
    applyDependencies,
  );
  assert.equal(applied.status, 'existing');
  assert.equal(applied.state, 'reconciliation_automation_applied');
  assert.equal(applied.adoptedTaskCount, 1);
  assert.equal(fs.statSync(state.targetDatabasePath).ino, targetIdentity.ino);
  const applyEvidenceRoot = path.join(
    automationApplyRoot,
    state.automationCommand.request.automationId,
  );
  const applyBackupRoot = path.join(applyEvidenceRoot, 'backup');
  const rollbackWorkRoot = path.join(applyEvidenceRoot, 'rollback-work');
  assert.equal(fs.statSync(applyEvidenceRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(applyBackupRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(rollbackWorkRoot).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(applyEvidenceRoot, 'intent.json')).mode & 0o777,
    0o400,
  );
  assert.equal(
    fs.statSync(path.join(applyEvidenceRoot, 'receipt.json')).mode & 0o777,
    0o400,
  );
  assert.equal(
    fs.statSync(path.join(applyBackupRoot, 'before.sqlite')).mode & 0o777,
    0o400,
  );
  assert.deepEqual(fs.readdirSync(applyEvidenceRoot).sort(), [
    'backup',
    'intent.json',
    'receipt.json',
    'rollback-work',
  ]);
  assert.deepEqual(fs.readdirSync(rollbackWorkRoot), []);
  const applyReplay = await applyLocalReconciliationAutomation(
    applyCommand,
    applyDependencies,
  );
  assert.equal(applyReplay.status, 'existing');
  const applyVerified = await verifyLocalReconciliationAutomationApply({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply.verify',
    options: applyOptions,
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedApplyDigest: applied.applyDigest,
    },
  });
  assert.equal(applyVerified.status, 'verified');
  const rollbackCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply.rollback',
    options: applyOptions,
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedApplyDigest: applied.applyDigest,
      expectedHeadDigest: applied.instanceHeadDigest,
      rolledBackAtMs: appliedAtMs + 1,
    },
  };
  for (const boundary of [
    'afterRestore',
    'afterRollbackReceipt',
    'afterRollbackHead',
    'afterRollbackSeal',
  ]) {
    await assert.rejects(
      rollbackLocalReconciliationAutomationApply(rollbackCommand, {
        ...applyDependencies,
        [boundary]() {
          throw new Error(`automation rollback ${boundary} response loss`);
        },
      }),
      new RegExp(`automation rollback ${boundary} response loss`),
    );
  }
  const rolledBack = await rollbackLocalReconciliationAutomationApply(
    rollbackCommand,
    applyDependencies,
  );
  assert.equal(rolledBack.status, 'existing');
  assert.equal(rolledBack.state, 'reconciliation_automation_rolled_back');
  assert.equal(fs.statSync(state.targetDatabasePath).ino, targetIdentity.ino);
  assert.equal(fs.statSync(applyEvidenceRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(applyBackupRoot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(rollbackWorkRoot).mode & 0o777, 0o500);
  assert.deepEqual(fs.readdirSync(applyBackupRoot), []);
  assert.deepEqual(fs.readdirSync(rollbackWorkRoot), ['receipt.json']);
  assert.equal(
    fs.statSync(path.join(rollbackWorkRoot, 'receipt.json')).mode & 0o777,
    0o400,
  );
  assert.equal(
    (
      await rollbackLocalReconciliationAutomationApply(
        rollbackCommand,
        applyDependencies,
      )
    ).status,
    'existing',
  );
  const rollbackVerified = await verifyLocalReconciliationAutomationApply({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.apply.verify',
    options: applyOptions,
    request: {
      decisionId,
      automationId: state.automationCommand.request.automationId,
      expectedApplyDigest: applied.applyDigest,
    },
  });
  assert.equal(rollbackVerified.status, 'verified');
  assert.equal(rollbackVerified.state, 'reconciliation_automation_rolled_back');
  const applyVerifyPath = path.join(
    state.deploymentRoot,
    'automation-apply-verify.json',
  );
  fs.writeFileSync(
    applyVerifyPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.automation.apply.verify',
      options: applyOptions,
      request: {
        decisionId,
        automationId: state.automationCommand.request.automationId,
        expectedApplyDigest: applied.applyDigest,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const applyCli = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/deployment/localDeploymentCli.js'),
      'reconciliation-automation-apply-verify',
      '--command-file',
      applyVerifyPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(applyCli.status, 0, applyCli.stderr);
  assert.equal(JSON.parse(applyCli.stdout).status, 'verified');
  const restored = new DatabaseSync(state.targetDatabasePath, {
    readOnly: true,
  });
  assert.equal(
    restored
      .prepare('SELECT COUNT(*) AS count FROM "QingLong3LegacyAdoptions"')
      .get().count,
    0,
  );
  restored.close();
});

test('automation decision rejects conflict adoption, another reviewer and weak assurance', async (t) => {
  const conflict = await plannedAutomationFixture(t, {
    suffix: 'conflict-reject',
    occupied: true,
    planId: '00000000-0000-4000-8000-000000000465',
    reviewId: '00000000-0000-4000-8000-000000000466',
    applicationId: '00000000-0000-4000-8000-000000000467',
    automationId: '00000000-0000-4000-8000-000000000468',
  });
  assert.equal(conflict.planRows[0].requirement, 'review_skip_conflict');
  const conflictDecisionId = '019b0000-0000-7000-8000-000000000465';
  const conflictReview = automationDecisionReviewFile(
    conflict,
    conflictDecisionId,
    'adopt',
    'reviewed_lossless',
    'conflict-reject',
  );
  const conflictPrepareCommand = automationDecisionPrepareCommand(
    conflict,
    conflictDecisionId,
  );
  const conflictPrepared = await prepareLocalReconciliationAutomationDecision(
    conflictPrepareCommand,
  );
  const conflictCommit = automationDecisionCommitFixture(
    conflict,
    {
      result: conflictPrepared,
      commandOptions: conflictPrepareCommand.options,
    },
    conflictReview.filePath,
  );
  await assert.rejects(
    commitLocalReconciliationAutomationDecision(
      conflictCommit.command,
      conflictCommit.dependencies,
    ),
    (error) => {
      const messages = [];
      for (let current = error; current; current = current.cause) {
        messages.push(String(current.message));
      }
      assert.match(
        messages.join('\n'),
        /conflict or manual row cannot be adopted/,
      );
      return true;
    },
  );
  assert.equal(
    fs.existsSync(
      path.join(
        conflict.automationDecisionRoot,
        conflict.automationCommand.request.automationId,
        'authorization.ndjson',
      ),
    ),
    false,
  );

  const identity = await plannedAutomationFixture(t, {
    suffix: 'identity-reject',
    planId: '00000000-0000-4000-8000-000000000469',
    reviewId: '00000000-0000-4000-8000-00000000046a',
    applicationId: '00000000-0000-4000-8000-00000000046b',
    automationId: '00000000-0000-4000-8000-00000000046c',
  });
  const identityDecisionId = '019b0000-0000-7000-8000-000000000469';
  const identityReview = automationDecisionReviewFile(
    identity,
    identityDecisionId,
    'adopt',
    'reviewed_lossless',
    'identity-reject',
  );
  const identityPrepareCommand = automationDecisionPrepareCommand(
    identity,
    identityDecisionId,
  );
  const identityPrepared = await prepareLocalReconciliationAutomationDecision(
    identityPrepareCommand,
  );
  for (const auth of [
    { reviewerId: 'another-owner', assurance: 'local_console' },
    { reviewerId: 'review-owner', assurance: 'password' },
  ]) {
    const rejected = automationDecisionCommitFixture(
      identity,
      {
        result: identityPrepared,
        commandOptions: identityPrepareCommand.options,
      },
      identityReview.filePath,
      auth,
    );
    await assert.rejects(
      commitLocalReconciliationAutomationDecision(
        rejected.command,
        rejected.dependencies,
      ),
      /requires the same recently strong authenticated User/,
    );
    assert.equal(rejected.authenticationCount(), 1);
    assert.equal(rejected.confirmationCount(), 0);
    assert.equal(rejected.databaseCloseCount(), 1);
  }
});

test('automation decision replays every publication boundary without repeated authentication', async (t) => {
  const prepareState = await plannedAutomationFixture(t, {
    suffix: 'prepare-response-loss',
    automationId: '00000000-0000-4000-8000-00000000046d',
  });
  const prepareDecisionId = '019b0000-0000-7000-8000-00000000046d';
  const prepareCommand = automationDecisionPrepareCommand(
    prepareState,
    prepareDecisionId,
  );
  await assert.rejects(
    prepareLocalReconciliationAutomationDecision(prepareCommand, {
      afterHeadPrepared() {
        throw new Error('automation decision prepare response loss');
      },
    }),
    /automation decision prepare response loss/,
  );
  const prepareReplay = await prepareLocalReconciliationAutomationDecision(
    prepareCommand,
  );
  assert.equal(
    prepareReplay.state,
    'reconciliation_automation_decision_prepared',
  );

  for (const [window, tail] of [
    ['authorization', '471'],
    ['receipt', '472'],
    ['seal', '473'],
    ['head', '474'],
  ]) {
    const state = await plannedAutomationFixture(t, {
      suffix: `${window}-response-loss`,
      automationId: `00000000-0000-4000-8000-000000000${tail}`,
    });
    const decisionId = `019b0000-0000-7000-8000-000000000${tail}`;
    const review = automationDecisionReviewFile(
      state,
      decisionId,
      'adopt',
      'reviewed_lossless',
      `${window}-response-loss`,
    );
    const selectedPrepareCommand = automationDecisionPrepareCommand(
      state,
      decisionId,
    );
    const prepared = await prepareLocalReconciliationAutomationDecision(
      selectedPrepareCommand,
    );
    const commit = automationDecisionCommitFixture(
      state,
      { result: prepared, commandOptions: selectedPrepareCommand.options },
      review.filePath,
    );
    const callback =
      window === 'authorization'
        ? 'afterAuthorizationPublished'
        : window === 'receipt'
        ? 'afterReceiptPublished'
        : window === 'seal'
        ? 'afterTerminalSealed'
        : 'afterHeadAdvanced';
    await assert.rejects(
      commitLocalReconciliationAutomationDecision(commit.command, {
        ...commit.dependencies,
        [callback]() {
          throw new Error(`automation decision ${window} response loss`);
        },
      }),
      new RegExp(`automation decision ${window} response loss`),
    );
    const replay = await commitLocalReconciliationAutomationDecision(
      commit.command,
      commit.dependencies,
    );
    assert.equal(replay.state, 'reconciliation_automation_reviewed');
    assert.equal(commit.authenticationCount(), 1);
    assert.equal(commit.confirmationCount(), 1);
    assert.equal(commit.databaseCloseCount(), 1);
    if (window === 'head') assert.equal(replay.status, 'existing');
  }
});

test('automation decision verification rejects sealed authorization and plan drift', async (t) => {
  const authorizationState = await plannedAutomationFixture(t, {
    suffix: 'authorization-drift',
    automationId: '00000000-0000-4000-8000-000000000475',
  });
  const authorizationDecisionId = '019b0000-0000-7000-8000-000000000475';
  const authorizationReview = automationDecisionReviewFile(
    authorizationState,
    authorizationDecisionId,
    'adopt',
    'reviewed_lossless',
    'authorization-drift',
  );
  const authorizationPrepareCommand = automationDecisionPrepareCommand(
    authorizationState,
    authorizationDecisionId,
  );
  const authorizationPrepared =
    await prepareLocalReconciliationAutomationDecision(
      authorizationPrepareCommand,
    );
  const authorizationCommit = automationDecisionCommitFixture(
    authorizationState,
    {
      result: authorizationPrepared,
      commandOptions: authorizationPrepareCommand.options,
    },
    authorizationReview.filePath,
  );
  const committed = await commitLocalReconciliationAutomationDecision(
    authorizationCommit.command,
    authorizationCommit.dependencies,
  );
  const decisionDirectory = path.join(
    authorizationState.automationDecisionRoot,
    authorizationState.automationCommand.request.automationId,
  );
  const authorizationPath = path.join(
    decisionDirectory,
    'authorization.ndjson',
  );
  fs.chmodSync(decisionDirectory, 0o700);
  fs.chmodSync(authorizationPath, 0o600);
  fs.appendFileSync(authorizationPath, '{}\n');
  fs.chmodSync(authorizationPath, 0o400);
  fs.chmodSync(decisionDirectory, 0o500);
  await assert.rejects(
    verifyLocalReconciliationAutomationDecision({
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.automation.decision.verify',
      options: authorizationPrepareCommand.options,
      request: {
        decisionId: authorizationDecisionId,
        automationId: authorizationState.automationCommand.request.automationId,
        expectedDecisionDigest: committed.decisionDigest,
      },
    }),
    (error) => {
      const messages = [];
      for (let current = error; current; current = current.cause) {
        messages.push(String(current.message));
      }
      assert.match(
        messages.join('\n'),
        /authorization verification failed|authorization file/,
      );
      return true;
    },
  );

  const planState = await plannedAutomationFixture(t, {
    suffix: 'plan-drift-decision',
    automationId: '00000000-0000-4000-8000-000000000476',
  });
  const planDecisionId = '019b0000-0000-7000-8000-000000000476';
  const planReview = automationDecisionReviewFile(
    planState,
    planDecisionId,
    'adopt',
    'reviewed_lossless',
    'plan-drift-decision',
  );
  const planPrepareCommand = automationDecisionPrepareCommand(
    planState,
    planDecisionId,
  );
  const planPrepared = await prepareLocalReconciliationAutomationDecision(
    planPrepareCommand,
  );
  const planPath = path.join(planState.automationDirectory, 'plan.ndjson');
  fs.chmodSync(planState.automationDirectory, 0o700);
  fs.chmodSync(planPath, 0o600);
  fs.appendFileSync(planPath, '{}\n');
  fs.chmodSync(planPath, 0o400);
  fs.chmodSync(planState.automationDirectory, 0o500);
  const planCommit = automationDecisionCommitFixture(
    planState,
    { result: planPrepared, commandOptions: planPrepareCommand.options },
    planReview.filePath,
  );
  await assert.rejects(
    commitLocalReconciliationAutomationDecision(
      planCommit.command,
      planCommit.dependencies,
    ),
    (error) => {
      const messages = [];
      for (let current = error; current; current = current.cause) {
        messages.push(String(current.message));
      }
      assert.match(
        messages.join('\n'),
        /plan file identity is invalid|plan file content drifted/,
      );
      return true;
    },
  );
  assert.equal(planCommit.authenticationCount(), 0);
});

test('automation row plan fails closed to manual review on a target task collision', async (t) => {
  const state = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000435',
    reviewId: '00000000-0000-4000-8000-000000000436',
    applicationId: '00000000-0000-4000-8000-000000000437',
    reviewSuffix: 'automation-row-conflict',
    createDefaultSidecars: false,
    initializeDatabases: automationDatabaseInitializer(),
    mutateTarget(paths) {
      return mutateAutomationTarget(paths, true);
    },
    mutateDecisions(records) {
      const selected = records.find(
        (record) =>
          record.kind === 'qinglong3-local-reconciliation-review-decision' &&
          record.database === 'legacy' &&
          record.domain === 'automation' &&
          record.factKind === 'table' &&
          record.disposition === 'exclude_legacy',
      );
      assert.ok(selected);
      selected.disposition = 'retain_both';
      selected.reason = 'preserve_both';
    },
  });
  const prepared = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, prepared),
  );
  const automationRoot = path.join(
    path.dirname(state.captureRoot),
    'automation-conflict-root',
  );
  fs.mkdirSync(automationRoot, { mode: 0o700 });
  const planned = await planLocalReconciliationAutomation({
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.plan',
    options: {
      deploymentRoot: state.deploymentRoot,
      applicationRoot: state.applicationRoot,
      automationRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      automationId: '00000000-0000-4000-8000-000000000438',
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      decisionFilePath: state.reviewFile.filePath,
      projectId: 'default',
      legacyTimezone: 'Asia/Shanghai',
      preparedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 2,
    },
  });
  assert.equal(planned.outcome, 'manual_required');
  assert.equal(planned.eligibleCount, 0);
  assert.equal(planned.conflictCount, 1);
  const planText = fs.readFileSync(
    path.join(
      automationRoot,
      '00000000-0000-4000-8000-000000000438',
      'plan.ndjson',
    ),
    'utf8',
  );
  assert.equal(planText.includes('"state":"occupied"'), true);
  assert.equal(planText.includes('"requirement":"review_skip_conflict"'), true);
  assert.equal(planText.includes('task nightly.js'), false);
});

test('automation row planner makes an empty table no-effect and a missing timezone manual', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-automation-row-unit-'),
  );
  t.after(() => removeFixtureRoot(root));
  const legacySourcePath = path.join(root, 'legacy.sqlite');
  const recoveryPath = path.join(root, 'recovery.sqlite');
  const targetDatabasePath = path.join(root, 'target.sqlite');
  automationDatabaseInitializer()({
    legacySourcePath,
    recoveryPath,
    targetDatabasePath,
  });
  const legacy = new DatabaseSync(legacySourcePath);
  const target = new DatabaseSync(targetDatabasePath);
  t.after(() => {
    legacy.close();
    target.close();
  });
  legacy.exec('DELETE FROM "Crontabs"');
  const header = {
    schemaVersion: 1,
    kind: 'qinglong3-local-reconciliation-automation-plan-header',
    automationId: '00000000-0000-4000-8000-000000000439',
    applicationId: '00000000-0000-4000-8000-00000000043a',
    applicationPlanDigest: '1'.repeat(64),
    reviewDigest: '2'.repeat(64),
    reviewAuthorizationDigest: '3'.repeat(64),
    reviewDecisionSetDigest: '4'.repeat(64),
    reviewDecisionFileDigest: '5'.repeat(64),
    bundleDigest: '6'.repeat(64),
    bundleFingerprintDigest: '7'.repeat(64),
    profile: 'edge',
    projectId: 'default',
    legacyTimezone: null,
    tableDisposition: 'adopt_legacy',
    preparedHeadDigest: '8'.repeat(64),
    preparedAtMs: 1,
  };
  const emptyPath = path.join(root, 'empty.ndjson');
  const emptyDescriptor = fs.openSync(emptyPath, 'wx', 0o600);
  let empty;
  try {
    empty = writeLocalReconciliationAutomationPlan({
      descriptor: emptyDescriptor,
      maxBytes: 64 * 1024,
      header,
      legacy,
      target,
    });
  } finally {
    fs.closeSync(emptyDescriptor);
  }
  assert.equal(empty.footer.outcome, 'no_effect');
  assert.equal(empty.footer.rowCount, 0);

  legacy.exec(`
    INSERT INTO "Crontabs" (
      id, name, command, schedule, saved, isSystem, isDisabled, isPinned
    ) VALUES (2, 'timezone-required', 'task timezone.js', '0 0 * * *', 1, 0, 0, 0)
  `);
  const manualPath = path.join(root, 'manual.ndjson');
  const manualDescriptor = fs.openSync(manualPath, 'wx', 0o600);
  let manual;
  try {
    manual = writeLocalReconciliationAutomationPlan({
      descriptor: manualDescriptor,
      maxBytes: 64 * 1024,
      header: {
        ...header,
        automationId: '00000000-0000-4000-8000-00000000043b',
      },
      legacy,
      target,
    });
  } finally {
    fs.closeSync(manualDescriptor);
  }
  assert.equal(manual.footer.outcome, 'manual_required');
  assert.equal(manual.footer.manualCount, 1);
  const manualText = fs.readFileSync(manualPath, 'utf8');
  assert.equal(manualText.includes('timezone_required'), true);
  assert.equal(manualText.includes('task timezone.js'), false);
});

test('automation row planner fails closed at its byte budget', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-automation-budget-'));
  t.after(() => removeFixtureRoot(root));
  const legacySourcePath = path.join(root, 'legacy.sqlite');
  const recoveryPath = path.join(root, 'recovery.sqlite');
  const targetDatabasePath = path.join(root, 'target.sqlite');
  automationDatabaseInitializer()({
    legacySourcePath,
    recoveryPath,
    targetDatabasePath,
  });
  const legacy = new DatabaseSync(legacySourcePath);
  const target = new DatabaseSync(targetDatabasePath);
  t.after(() => {
    legacy.close();
    target.close();
  });
  const insert = legacy.prepare(`
    INSERT INTO "Crontabs" (
      id, name, command, schedule, saved, isSystem, isDisabled, isPinned
    ) VALUES (?, ?, ?, '0 0 * * *', 1, 0, 0, 0)
  `);
  legacy.exec('BEGIN IMMEDIATE');
  try {
    for (let id = 2; id <= 400; id += 1) {
      insert.run(id, `task-${id}`, `task workload-${id}.js`);
    }
    legacy.exec('COMMIT');
  } catch (error) {
    legacy.exec('ROLLBACK');
    throw error;
  }
  const outputPath = path.join(root, 'bounded.ndjson');
  const descriptor = fs.openSync(outputPath, 'wx', 0o600);
  try {
    assert.throws(
      () =>
        writeLocalReconciliationAutomationPlan({
          descriptor,
          maxBytes: 64 * 1024,
          header: {
            schemaVersion: 1,
            kind: 'qinglong3-local-reconciliation-automation-plan-header',
            automationId: '00000000-0000-4000-8000-00000000043c',
            applicationId: '00000000-0000-4000-8000-00000000043d',
            applicationPlanDigest: '1'.repeat(64),
            reviewDigest: '2'.repeat(64),
            reviewAuthorizationDigest: '3'.repeat(64),
            reviewDecisionSetDigest: '4'.repeat(64),
            reviewDecisionFileDigest: '5'.repeat(64),
            bundleDigest: '6'.repeat(64),
            bundleFingerprintDigest: '7'.repeat(64),
            profile: 'edge',
            projectId: 'default',
            legacyTimezone: 'UTC',
            tableDisposition: 'adopt_legacy',
            preparedHeadDigest: '8'.repeat(64),
            preparedAtMs: 1,
          },
          legacy,
          target,
        }),
      /exceeds profile byte budget/,
    );
  } finally {
    fs.closeSync(descriptor);
  }
  assert.equal(fs.statSync(outputPath).size <= 64 * 1024, true);
});

test('automation row planning replays every publication boundary and rejects drift', async (t) => {
  const windows = [
    ['plan', '000000000441', '000000000442', '000000000443', '000000000444'],
    ['receipt', '000000000445', '000000000446', '000000000447', '000000000448'],
    ['seal', '000000000449', '00000000044a', '00000000044b', '00000000044c'],
    ['head', '00000000044d', '00000000044e', '00000000044f', '000000000450'],
  ];
  for (const [
    window,
    planTail,
    reviewTail,
    applicationTail,
    automationTail,
  ] of windows) {
    const state = await reviewedApplicationFixture(t, {
      planId: `00000000-0000-4000-8000-${planTail}`,
      reviewId: `00000000-0000-4000-8000-${reviewTail}`,
      applicationId: `00000000-0000-4000-8000-${applicationTail}`,
      reviewSuffix: `automation-${window}-replay`,
      createDefaultSidecars: false,
      initializeDatabases: automationDatabaseInitializer(),
      mutateTarget(paths) {
        return mutateAutomationTarget(paths);
      },
      mutateDecisions(records) {
        const selected = records.find(
          (record) =>
            record.kind === 'qinglong3-local-reconciliation-review-decision' &&
            record.database === 'legacy' &&
            record.domain === 'automation' &&
            record.factKind === 'table' &&
            record.disposition === 'exclude_legacy',
        );
        assert.ok(selected);
        selected.disposition = 'adopt_legacy';
        selected.reason = 'prefer_legacy';
      },
    });
    const prepared = await prepareLocalReconciliationApplication(
      state.prepareApplicationCommand,
    );
    const application = await commitLocalReconciliationApplication(
      applicationCommitCommand(state, prepared),
    );
    const automationRoot = path.join(
      path.dirname(state.captureRoot),
      `automation-${window}-root`,
    );
    fs.mkdirSync(automationRoot, { mode: 0o700 });
    const command = {
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.automation.plan',
      options: {
        deploymentRoot: state.deploymentRoot,
        applicationRoot: state.applicationRoot,
        automationRoot,
        allowRootService: rootAcknowledgement(),
      },
      request: {
        automationId: `00000000-0000-4000-8000-${automationTail}`,
        applicationId: state.prepareApplicationCommand.request.applicationId,
        expectedApplicationPlanDigest: application.applicationPlanDigest,
        expectedHeadDigest: application.instanceHeadDigest,
        decisionFilePath: state.reviewFile.filePath,
        projectId: 'default',
        legacyTimezone: 'Asia/Shanghai',
        preparedAtMs: state.prepareApplicationCommand.request.preparedAtMs + 2,
      },
    };
    const callback =
      window === 'plan'
        ? 'afterPlanPublished'
        : window === 'receipt'
        ? 'afterReceiptPublished'
        : window === 'seal'
        ? 'afterTerminalSealed'
        : 'afterHeadAdvanced';
    await assert.rejects(
      planLocalReconciliationAutomation(command, {
        [callback]() {
          throw new Error(`automation ${window} response loss`);
        },
      }),
      new RegExp(`automation ${window} response loss`),
    );
    const replay = await planLocalReconciliationAutomation(command);
    assert.equal(replay.state, 'reconciliation_automation_planned');
    if (window === 'head') assert.equal(replay.status, 'existing');
  }

  const drift = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000451',
    reviewId: '00000000-0000-4000-8000-000000000452',
    applicationId: '00000000-0000-4000-8000-000000000453',
    reviewSuffix: 'automation-drift',
    createDefaultSidecars: false,
    initializeDatabases: automationDatabaseInitializer(),
    mutateTarget(paths) {
      return mutateAutomationTarget(paths);
    },
    mutateDecisions(records) {
      const selected = records.find(
        (record) =>
          record.kind === 'qinglong3-local-reconciliation-review-decision' &&
          record.database === 'legacy' &&
          record.domain === 'automation' &&
          record.factKind === 'table' &&
          record.disposition === 'exclude_legacy',
      );
      assert.ok(selected);
      selected.disposition = 'adopt_legacy';
      selected.reason = 'prefer_legacy';
    },
  });
  const prepared = await prepareLocalReconciliationApplication(
    drift.prepareApplicationCommand,
  );
  const application = await commitLocalReconciliationApplication(
    applicationCommitCommand(drift, prepared),
  );
  const automationRoot = path.join(
    path.dirname(drift.captureRoot),
    'automation-drift-root',
  );
  fs.mkdirSync(automationRoot, { mode: 0o700 });
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.automation.plan',
    options: {
      deploymentRoot: drift.deploymentRoot,
      applicationRoot: drift.applicationRoot,
      automationRoot,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      automationId: '00000000-0000-4000-8000-000000000454',
      applicationId: drift.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: application.applicationPlanDigest,
      expectedHeadDigest: application.instanceHeadDigest,
      decisionFilePath: drift.reviewFile.filePath,
      projectId: 'default',
      legacyTimezone: 'Asia/Shanghai',
      preparedAtMs: drift.prepareApplicationCommand.request.preparedAtMs + 2,
    },
  };
  const planned = await planLocalReconciliationAutomation(command);
  const planPath = path.join(
    automationRoot,
    command.request.automationId,
    'plan.ndjson',
  );
  fs.chmodSync(planPath, 0o600);
  fs.appendFileSync(planPath, '{}\n');
  fs.chmodSync(planPath, 0o400);
  await assert.rejects(
    verifyLocalReconciliationAutomationPlan({
      schemaVersion: 1,
      operation: 'local.deployment.reconciliation.automation.verify',
      options: command.options,
      request: {
        automationId: command.request.automationId,
        expectedAutomationPlanDigest: planned.automationPlanDigest,
      },
    }),
    /plan file identity is invalid|plan file content drifted/,
  );
});

test('application coordinator resumes every publication window and fences competitors', async (t) => {
  const prepareCrash = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000410',
    reviewId: '00000000-0000-4000-8000-000000000411',
    applicationId: '00000000-0000-4000-8000-000000000412',
    reviewSuffix: 'application-prepare-crash',
  });
  await assert.rejects(
    prepareLocalReconciliationApplication(
      prepareCrash.prepareApplicationCommand,
      {
        afterHeadPrepared() {
          throw new Error('application prepare head response loss');
        },
      },
    ),
    /application prepare head response loss/,
  );
  const preparedReplay = await prepareLocalReconciliationApplication(
    prepareCrash.prepareApplicationCommand,
  );
  assert.equal(preparedReplay.state, 'reconciliation_application_prepared');
  await assert.rejects(
    prepareLocalReconciliationApplication({
      ...prepareCrash.prepareApplicationCommand,
      request: {
        ...prepareCrash.prepareApplicationCommand.request,
        applicationId: '00000000-0000-4000-8000-00000000041f',
      },
    }),
    /lost reviewed head compare-and-swap/,
  );

  const windows = [
    ['plan', '000000000413', '000000000414', '000000000415'],
    ['receipt', '000000000416', '000000000417', '000000000418'],
    ['seal', '000000000419', '00000000041a', '00000000041b'],
    ['head', '00000000041c', '00000000041d', '00000000041e'],
  ];
  for (const [window, planTail, reviewTail, applicationTail] of windows) {
    const state = await reviewedApplicationFixture(t, {
      planId: `00000000-0000-4000-8000-${planTail}`,
      reviewId: `00000000-0000-4000-8000-${reviewTail}`,
      applicationId: `00000000-0000-4000-8000-${applicationTail}`,
      reviewSuffix: `application-${window}-crash`,
    });
    const prepared = await prepareLocalReconciliationApplication(
      state.prepareApplicationCommand,
    );
    const commitCommand = applicationCommitCommand(state, prepared);
    const callback =
      window === 'plan'
        ? 'afterPlanPublished'
        : window === 'receipt'
        ? 'afterReceiptPublished'
        : window === 'seal'
        ? 'afterTerminalSealed'
        : 'afterHeadAdvanced';
    await assert.rejects(
      commitLocalReconciliationApplication(commitCommand, {
        [callback]() {
          throw new Error(`application ${window} response loss`);
        },
      }),
      new RegExp(`application ${window} response loss`),
    );
    const replay = await commitLocalReconciliationApplication(commitCommand);
    assert.equal(replay.state, 'reconciliation_application_planned');
    if (window === 'head') assert.equal(replay.status, 'existing');
  }
});

test('application verify rejects digest and head drift without repairing state', async (t) => {
  const state = await reviewedApplicationFixture(t, {
    planId: '00000000-0000-4000-8000-000000000421',
    reviewId: '00000000-0000-4000-8000-000000000422',
    applicationId: '00000000-0000-4000-8000-000000000423',
    reviewSuffix: 'application-verify-drift',
  });
  const prepared = await prepareLocalReconciliationApplication(
    state.prepareApplicationCommand,
  );
  const committed = await commitLocalReconciliationApplication(
    applicationCommitCommand(state, prepared),
  );
  const verifyCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.reconciliation.application.verify',
    options: state.prepareApplicationCommand.options,
    request: {
      applicationId: state.prepareApplicationCommand.request.applicationId,
      expectedApplicationPlanDigest: 'f'.repeat(64),
    },
  };
  const applicationDirectory = path.join(
    state.applicationRoot,
    state.prepareApplicationCommand.request.applicationId,
  );
  const before = fs.statSync(path.join(applicationDirectory, 'plan.json'), {
    bigint: true,
  });
  await assert.rejects(
    verifyLocalReconciliationApplication(verifyCommand),
    /expected digest drifted/,
  );
  const after = fs.statSync(path.join(applicationDirectory, 'plan.json'), {
    bigint: true,
  });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.notEqual(committed.applicationPlanDigest, 'f'.repeat(64));

  const headPath = path.join(
    state.deploymentRoot,
    'service',
    'cutover-instances',
    state.captureCommand.request.instanceId,
    'head.json',
  );
  const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
  delete head.headDigest;
  head.sourceRecordDigest = 'e'.repeat(64);
  head.headDigest = digest(head);
  fs.writeFileSync(headPath, `${JSON.stringify(head, null, 2)}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    verifyLocalReconciliationApplication({
      ...verifyCommand,
      request: {
        ...verifyCommand.request,
        expectedApplicationPlanDigest: committed.applicationPlanDigest,
      },
    }),
    /lost terminal instance head/,
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
      createDefaultSidecars: false,
      initializeDatabases: planningDatabaseInitializer(),
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
            "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/capture-fixture/database.ql3.sqlite'); db.exec('INSERT INTO \\\"QingLong3TaskDefinitions\\\" (id) VALUES (1)'); db.close()",
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
    assert.deepEqual(
      dockerReadSealedSqlite(
        capturePath(state, 'assets'),
        'main_only_immutable',
      ),
      { count: 1, unchanged: true },
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

test(
  'real Docker reads sealed WAL and SHM without changing the bundle',
  { skip: process.env.QL3_RECONCILIATION_DOCKER_GATE !== '1' },
  (t) => {
    let target;
    const state = preparedCapture(t, {
      createDefaultSidecars: false,
      initializeDatabases(paths) {
        planningDatabaseInitializer()(paths);
        target = new DatabaseSync(paths.targetDatabasePath);
        target.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
      },
      mutateTarget({ targetDatabasePath }) {
        target.exec('INSERT INTO "QingLong3TaskDefinitions" (id) VALUES (1)');
        fs.chmodSync(`${targetDatabasePath}-wal`, 0o600);
        fs.chmodSync(`${targetDatabasePath}-shm`, 0o600);
        return Object.freeze({});
      },
    });
    t.after(() => {
      try {
        target?.close();
      } catch {
        // The fixture cleanup may already have invalidated the source handle.
      }
    });
    commitLocalReconciliationCapture(state.commitCommand);
    assert.deepEqual(
      dockerReadSealedSqlite(capturePath(state, 'assets'), 'wal_shm_readonly'),
      { count: 1, unchanged: true },
    );
  },
);
