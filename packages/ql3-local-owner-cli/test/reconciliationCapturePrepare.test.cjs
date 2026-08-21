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
  commitLocalReconciliationPlan,
  prepareLocalReconciliationCapture,
  prepareLocalReconciliationPlan,
  prepareLocalReconciliationReview,
  verifyLocalReconciliationCapture,
  verifyLocalReconciliationPlan,
  writeLocalReconciliationReviewDiagnostics,
} = require('../dist/deployment/localDeployment.js');
const {
  normalizeLocalReconciliationCaptureManifest,
} = require('../dist/deployment/reconciliation/bundle.js');
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
      fs.writeFileSync(`${legacySourcePath}-journal`, 'legacy-journal-state\n', {
        mode: 0o600,
      });
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

function mutatePlanningTarget({ targetDatabasePath }) {
  const target = new DatabaseSync(targetDatabasePath);
  target.exec('INSERT INTO "QingLong3TaskDefinitions" (id) VALUES (1)');
  target.close();
  return Object.freeze({});
}

function preparedPlan(t, options = {}) {
  const state = preparedCapture(t, {
    createDefaultSidecars: options.createDefaultSidecars ?? false,
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
  const reviewRoot = path.join(root, `review-root-${options.reviewSuffix ?? '1'}`);
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
      reviewId:
        options.reviewId ?? '00000000-0000-4000-8000-000000000301',
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
    const client = new DatabaseSync(${JSON.stringify(source)}, { allowExtension: false, defensive: true, readOnly: true, timeout: 0 });
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
  assert.equal(
    fs.statSync(capturePath(state, 'assets')).mode & 0o777,
    0o500,
  );
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
  assert.equal(
    fs.statSync(capturePath(state, 'assets')).mode & 0o777,
    0o700,
  );
  fs.unlinkSync(state.targetDatabasePath);
  fs.unlinkSync(state.legacySourcePath);
  fs.unlinkSync(state.recoveryPath);
  const resumed = commitLocalReconciliationCapture(state.commitCommand);
  assert.equal(resumed.state, 'reconciliation_captured');
  assert.equal(
    fs.statSync(capturePath(state, 'assets')).mode & 0o777,
    0o500,
  );
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
  const beforeAssets = fs.readdirSync(
    capturePath(state, 'assets'),
  ).map((name) => ({
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
    plan.domains.every(
      (domain) => domain.disposition === 'manual_required',
    ),
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
    path.join(
      state.planRoot,
      state.prepareCommand.request.planId,
      'plan.json',
    ),
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
  assert.equal(JSON.stringify(result).includes(command.request.outputPath), false);
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
