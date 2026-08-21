const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  prepareLocalReconciliationCapture,
} = require('../dist/deployment/localDeployment.js');
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
  { reconciliationRequired = true, stoppedAuthority = 'docker' } = {},
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
  const activationPath = path.join(root, 'activation.json');
  fs.writeFileSync(legacySourcePath, 'legacy-source\n', { mode: 0o600 });
  fs.writeFileSync(targetDatabasePath, 'target-initial\n', { mode: 0o600 });
  fs.writeFileSync(recoveryPath, 'legacy-source\n', { mode: 0o600 });
  const targetStat = fs.statSync(targetDatabasePath, { bigint: true });
  const activationPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-activation',
    state: 'prepared',
    profile: 'edge',
    createdAtMs: 1_000,
    adoptionManifestDigest: '1'.repeat(64),
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
  if (reconciliationRequired) {
    fs.writeFileSync(targetDatabasePath, 'target-mutated\n', { mode: 0o600 });
  }
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
          targetContainerIdentityDigest: '7'.repeat(64),
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
  return { command, deploymentRoot, captureRoot, identity, stoppedHead, uid };
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
  assert.equal(result.stdout.includes(state.command.request.targetDatabasePath), false);
  assert.equal(result.stderr, '');
});
