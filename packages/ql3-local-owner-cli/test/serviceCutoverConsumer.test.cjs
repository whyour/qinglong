const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  consumeLocalServiceManagerCutoverOutcome,
} = require('../dist/deployment/service-manager/serviceCutoverConsumer.js');
const {
  localServiceManagerLegacyRollbackPreparationPath,
  prepareLocalServiceManagerLegacyRollback,
} = require('../dist/deployment/service-manager/serviceLegacyRollback.js');
const {
  prepareLocalServiceManagerIntent,
} = require('../dist/deployment/service-manager/serviceManagerIntent.js');
const {
  localServiceManagerObservationDigest,
  localServiceManagerOutcomeDigest,
} = require('../dist/deployment/service-manager/serviceOutcomeContract.js');
const {
  advanceLocalCutoverInstanceHead,
  claimLocalCutoverInstance,
  readLocalCutoverInstanceHead,
} = require('../dist/deployment/cutover/instanceLineage.js');
const {
  cutoverDigest,
} = require('../dist/deployment/cutover/targetEvidence.js');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writePrivate(filePath, value) {
  fs.writeFileSync(
    filePath,
    typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
    { mode: 0o600 },
  );
}

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-service-cutover-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const service = path.join(root, 'service');
  const cutoverId = 'cutover-edge-router-1';
  const journal = path.join(service, 'cutovers', cutoverId);
  fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
  fs.chmodSync(service, 0o700);
  fs.chmodSync(path.join(service, 'cutovers'), 0o700);
  fs.chmodSync(journal, 0o700);
  const sourcePath = path.join(root, 'legacy.sqlite');
  const targetPath = path.join(root, 'target.sqlite');
  const recoveryPath = path.join(root, 'recovery.sqlite');
  const manifestPath = path.join(root, 'manifest.json');
  const activationPath = path.join(root, 'activation.json');
  for (const [filePath, contents] of [
    [sourcePath, 'legacy\n'],
    [targetPath, 'target\n'],
    [recoveryPath, 'legacy\n'],
  ]) {
    writePrivate(filePath, contents);
  }
  const manifestPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-adoption-manifest-fixture',
  };
  const manifestDigest = cutoverDigest(manifestPayload);
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
    sourcePathDigest: sha256(sourcePath),
    recoverySha256: sha256(fs.readFileSync(recoveryPath)),
    targetSha256: sha256(fs.readFileSync(targetPath)),
    targetPathDigest: sha256(targetPath),
    targetDevice: target.dev.toString(),
    targetInode: target.ino.toString(),
  };
  const activationDigest = cutoverDigest(activationPayload);
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
  const commitmentDigest = cutoverDigest(commitmentPayload);
  const commitmentPath = path.join(journal, '0002-legacy-stopped.json');
  writePrivate(commitmentPath, {
    ...commitmentPayload,
    commitmentDigest,
  });
  const applicationPath = path.join(root, 'local-application.json');
  writePrivate(applicationPath, {
    schema: 'qinglong/local-application-process@v3',
    instanceId: 'edge-router-1',
    profile: 'edge',
    storage: {
      mode: 'adopted',
      sourcePath,
      targetPath,
      recoveryPath,
      manifestPath,
      activationPath,
      expectedActivationDigest: activationDigest,
    },
    runtime: {},
    pluginPackages: {},
    ai: { deployment: 'excluded' },
    cutover: {
      cutoverId,
      commitmentPath,
      expectedCommitmentDigest: commitmentDigest,
    },
  });
  writePrivate(
    path.join(service, 'qinglong3.service'),
    '[Service]\nExecStart=/usr/bin/node /opt/qinglong3/app.js\n',
  );
  const identity = {
    options: { deploymentRoot: root },
    request: {
      cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      expectedActivationDigest: activationDigest,
      requestedAtMs: 1786416000030,
    },
  };
  claimLocalCutoverInstance(identity, process.getuid(), '8'.repeat(64));
  advanceLocalCutoverInstanceHead(
    identity,
    process.getuid(),
    'legacy_stopped',
    0,
    commitmentDigest,
  );
  const procRoot = path.join(root, 'proc');
  fs.mkdirSync(procRoot, { mode: 0o700 });
  return {
    root,
    service,
    cutoverId,
    activationDigest,
    commitmentDigest,
    commitmentPath,
    applicationPath,
    sourcePath,
    targetPath,
    identity,
    procRoot,
  };
}

function prepare(state, generation, action, previousRecordDigest, actionId) {
  return prepareLocalServiceManagerIntent({
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.intent.prepare',
    options: {
      deploymentRoot: state.root,
      allowRootService: process.getuid() === 0,
    },
    request: {
      actionId,
      action,
      serviceKind: 'systemd',
      lineage: {
        mode: 'adopted',
        cutoverId: state.cutoverId,
        generation,
        expectedActivationDigest: state.activationDigest,
        previousRecordDigest,
      },
      requestedAtMs: 1786416000100 + generation,
    },
  });
}

function publishOutcome(prepared, action, state, mainPid, completedAtMs) {
  const intent = JSON.parse(fs.readFileSync(prepared.intentPath, 'utf8'));
  const observationPayload = {
    managerKind: 'systemd',
    serviceName: 'qinglong3',
    fragmentPath: '/etc/systemd/system/qinglong3.service',
    loadState: 'loaded',
    activeState: state === 'active' ? 'active' : 'inactive',
    subState: state === 'active' ? 'running' : 'dead',
    enabledState: 'enabled',
    mainPid,
    observedAtMs: completedAtMs - 1,
  };
  const observation = {
    ...observationPayload,
    observationDigest: localServiceManagerObservationDigest(observationPayload),
  };
  const payload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-service-manager-outcome',
    actionId: prepared.actionId,
    action,
    intentDigest: prepared.intentDigest,
    descriptorDigest: intent.descriptor.sha256,
    state,
    mutationDisposition: 'executed',
    manualReason: null,
    observation,
    completedAtMs,
  };
  writePrivate(prepared.outcomePath, {
    ...payload,
    outcomeDigest: localServiceManagerOutcomeDigest(payload),
  });
}

function publishReceipt(state, processId, startTicks) {
  const executable = fs.realpathSync(process.execPath);
  const payload = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-startup-receipt@v1',
    instanceId: 'edge-router-1',
    profile: 'edge',
    aiStatus: 'deployment_excluded',
    bootId: '00000000-0000-4000-8000-000000000001',
    activeBootAgeMs: 1000,
    processId,
    processStartTicks: startTicks,
    nodeExecutable: executable,
    nodeVersion: 'v24.18.0',
  };
  const digest = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  writePrivate(`${state.applicationPath}.active.json`, {
    ...payload,
    sha256: digest,
  });
  const processRoot = path.join(state.procRoot, String(processId));
  fs.mkdirSync(processRoot, { mode: 0o700 });
  const fields = ['S', ...Array(18).fill('0'), startTicks, '0'];
  fs.writeFileSync(
    path.join(processRoot, 'stat'),
    `${processId} (node) ${fields.join(' ')}\n`,
  );
  fs.symlinkSync(executable, path.join(processRoot, 'exe'));
  return digest;
}

function publishShutdownReceipt(
  state,
  processId,
  startTicks,
  startupReceiptDigest,
) {
  const payload = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-shutdown-receipt@v1',
    instanceId: 'edge-router-1',
    profile: 'edge',
    signal: 'SIGTERM',
    stopResult: 'stopped',
    startupReceiptDigest,
    bootId: '00000000-0000-4000-8000-000000000001',
    stoppedBootAgeMs: 2000,
    processId,
    processStartTicks: startTicks,
    nodeExecutable: fs.realpathSync(process.execPath),
    nodeVersion: 'v24.18.0',
  };
  const digest = crypto
    .createHash('sha256')
    .update('qinglong.local-application-shutdown-receipt.v1\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  writePrivate(`${state.applicationPath}.stopped.json`, {
    ...payload,
    sha256: digest,
  });
  return digest;
}

function consumeCommand(state, prepared) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.cutover.consume',
    options: {
      deploymentRoot: state.root,
      allowRootService: process.getuid() === 0,
      startupTimeoutMs: 100,
      startupPollMs: 10,
    },
    request: {
      actionId: prepared.actionId,
      expectedIntentDigest: prepared.intentDigest,
    },
  };
}

async function stopAdoptedTarget(state, suffix = '031') {
  const active = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    `123e4567-e89b-42d3-a456-426614174${suffix}`,
  );
  publishOutcome(active, 'install-enable-start', 'active', 4723, 1786416000200);
  const startupReceiptDigest = publishReceipt(state, 4723, '100007');
  const activeResult = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, active),
    { procRoot: state.procRoot },
  );
  const stopped = prepare(
    state,
    1,
    'stop',
    activeResult.recordDigest,
    `123e4567-e89b-42d3-a456-426614174${String(Number(suffix) + 1).padStart(
      3,
      '0',
    )}`,
  );
  publishOutcome(stopped, 'stop', 'stopped', 0, 1786416000300);
  publishShutdownReceipt(state, 4723, '100007', startupReceiptDigest);
  fs.rmSync(path.join(state.procRoot, '4723'), {
    recursive: true,
    force: true,
  });
  const stoppedResult = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, stopped),
    { procRoot: state.procRoot },
  );
  const head = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  return { stoppedResult, head };
}

function rollbackPrepareCommand(state, stoppedResult, head) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.prepare',
    options: {
      deploymentRoot: state.root,
      allowRootService: process.getuid() === 0,
    },
    request: {
      cutoverId: state.cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      generation: 1,
      expectedActivationDigest: state.activationDigest,
      expectedStoppedRecordDigest: stoppedResult.recordDigest,
      expectedInstanceHeadDigest: head.headDigest,
      requestedAtMs: 1786416000400,
    },
  };
}

test('commits adopted service active evidence and replays from the instance head', async (t) => {
  const state = fixture(t);
  const prepared = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    '123e4567-e89b-42d3-a456-426614174021',
  );
  publishOutcome(
    prepared,
    'install-enable-start',
    'active',
    4123,
    1786416000200,
  );
  const receiptDigest = publishReceipt(state, 4123, '100001');
  const command = consumeCommand(state, prepared);
  const result = await consumeLocalServiceManagerCutoverOutcome(command, {
    procRoot: state.procRoot,
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.state, 'target_active');
  const head = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(head.state, 'target_active');
  assert.equal(head.sourceRecordDigest, result.recordDigest);
  const recordPath = path.join(
    state.root,
    'service',
    'cutovers',
    state.cutoverId,
    'service-manager-g01-active.json',
  );
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(record.evidence.startupReceiptDigest, receiptDigest);
  assert.match(record.evidence.processIdentityDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    (
      await consumeLocalServiceManagerCutoverOutcome(command, {
        procRoot: state.procRoot,
      })
    ).status,
    'existing',
  );
});

test('restart cannot reuse the previous generation startup receipt', async (t) => {
  const state = fixture(t);
  const first = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    '123e4567-e89b-42d3-a456-426614174022',
  );
  publishOutcome(first, 'install-enable-start', 'active', 4223, 1786416000200);
  publishReceipt(state, 4223, '100002');
  const firstResult = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, first),
    { procRoot: state.procRoot },
  );
  const restart = prepare(
    state,
    2,
    'restart',
    firstResult.recordDigest,
    '123e4567-e89b-42d3-a456-426614174023',
  );
  publishOutcome(restart, 'restart', 'active', 5223, 1786416000300);
  let clock = 0;
  const result = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, restart),
    {
      procRoot: state.procRoot,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );
  assert.equal(result.state, 'manual_required');
  const head = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(head.state, 'manual_required');
});

test('stop advances only after the exact receipted process identity disappears', async (t) => {
  const state = fixture(t);
  const first = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    '123e4567-e89b-42d3-a456-426614174024',
  );
  publishOutcome(first, 'install-enable-start', 'active', 4323, 1786416000200);
  const startupReceiptDigest = publishReceipt(state, 4323, '100003');
  const firstResult = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, first),
    { procRoot: state.procRoot },
  );
  const stopped = prepare(
    state,
    1,
    'stop',
    firstResult.recordDigest,
    '123e4567-e89b-42d3-a456-426614174025',
  );
  publishOutcome(stopped, 'stop', 'stopped', 0, 1786416000300);
  const shutdownReceiptDigest = publishShutdownReceipt(
    state,
    4323,
    '100003',
    startupReceiptDigest,
  );
  fs.rmSync(path.join(state.procRoot, '4323'), {
    recursive: true,
    force: true,
  });
  const result = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, stopped),
    { procRoot: state.procRoot },
  );
  assert.equal(result.state, 'target_stopped');
  const head = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(head.state, 'target_stopped');
  assert.equal(head.sourceRecordDigest, result.recordDigest);
  const record = JSON.parse(
    fs.readFileSync(
      path.join(
        state.root,
        'service',
        'cutovers',
        state.cutoverId,
        'service-manager-g01-stopped.json',
      ),
      'utf8',
    ),
  );
  assert.equal(record.evidence.shutdownReceiptDigest, shutdownReceiptDigest);
});

test('prepares and exactly replays lossless service-manager legacy rollback evidence', async (t) => {
  const state = fixture(t);
  const { stoppedResult, head } = await stopAdoptedTarget(state);
  const command = rollbackPrepareCommand(state, stoppedResult, head);
  const prepared = prepareLocalServiceManagerLegacyRollback(command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'rollback_prepared');
  assert.equal(prepared.rollbackDisposition, 'rollback_candidate');
  assert.match(prepared.preparationDigest, /^[0-9a-f]{64}$/);
  const preparedHead = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(preparedHead.state, 'rollback_prepared');
  assert.equal(preparedHead.sourceRecordDigest, prepared.preparationDigest);
  const record = JSON.parse(
    fs.readFileSync(
      localServiceManagerLegacyRollbackPreparationPath(
        state.root,
        state.cutoverId,
        1,
      ),
      'utf8',
    ),
  );
  assert.equal(record.stoppedRecordDigest, stoppedResult.recordDigest);
  assert.equal(record.reconciliation.targetMatchesActivation, true);
  assert.equal(record.reconciliation.sourceMatchesRecovery, true);
  assert.equal(record.reconciliation.targetSidecarsClear, true);
  assert.equal(record.reconciliation.sourceSidecarsClear, true);
  const replay = prepareLocalServiceManagerLegacyRollback(command);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.preparationDigest, prepared.preparationDigest);
  assert.equal(replay.instanceHeadDigest, prepared.instanceHeadDigest);
});

test('keeps target_stopped when service-manager rollback would discard target writes', async (t) => {
  const state = fixture(t);
  const { stoppedResult, head } = await stopAdoptedTarget(state, '033');
  fs.writeFileSync(state.targetPath, 'target-written-by-qinglong3\n', {
    mode: 0o600,
  });
  const result = prepareLocalServiceManagerLegacyRollback(
    rollbackPrepareCommand(state, stoppedResult, head),
  );
  assert.equal(result.status, 'not-prepared');
  assert.equal(result.state, 'target_stopped');
  assert.equal(result.rollbackDisposition, 'reconciliation_required');
  assert.equal(result.preparationDigest, '0'.repeat(64));
  const unchanged = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(unchanged.state, 'target_stopped');
  assert.equal(unchanged.headDigest, head.headDigest);
  assert.equal(
    fs.existsSync(
      localServiceManagerLegacyRollbackPreparationPath(
        state.root,
        state.cutoverId,
        1,
      ),
    ),
    false,
  );
});

test('rejects application configuration drift before service-manager rollback preparation', async (t) => {
  const state = fixture(t);
  const { stoppedResult, head } = await stopAdoptedTarget(state, '035');
  fs.appendFileSync(state.applicationPath, ' ');
  assert.throws(
    () =>
      prepareLocalServiceManagerLegacyRollback(
        rollbackPrepareCommand(state, stoppedResult, head),
      ),
    /application configuration digest drifted/,
  );
  const unchanged = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(unchanged.state, 'target_stopped');
  assert.equal(unchanged.headDigest, head.headDigest);
});

test('rejects legacy silence commitment drift before service-manager rollback preparation', async (t) => {
  const state = fixture(t);
  const { stoppedResult, head } = await stopAdoptedTarget(state, '037');
  const commitment = JSON.parse(fs.readFileSync(state.commitmentPath, 'utf8'));
  commitment.observedAtMs += 1;
  writePrivate(state.commitmentPath, commitment);
  assert.throws(
    () =>
      prepareLocalServiceManagerLegacyRollback(
        rollbackPrepareCommand(state, stoppedResult, head),
      ),
    /application rollback binding drifted/,
  );
  const unchanged = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(unchanged.state, 'target_stopped');
  assert.equal(unchanged.headDigest, head.headDigest);
});

test('stop without an exact shutdown receipt requires manual resolution', async (t) => {
  const state = fixture(t);
  const first = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    '123e4567-e89b-42d3-a456-426614174028',
  );
  publishOutcome(first, 'install-enable-start', 'active', 4623, 1786416000200);
  publishReceipt(state, 4623, '100006');
  const firstResult = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, first),
    { procRoot: state.procRoot },
  );
  const stopped = prepare(
    state,
    1,
    'stop',
    firstResult.recordDigest,
    '123e4567-e89b-42d3-a456-426614174029',
  );
  publishOutcome(stopped, 'stop', 'stopped', 0, 1786416000300);
  fs.rmSync(path.join(state.procRoot, '4623'), {
    recursive: true,
    force: true,
  });
  const result = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, stopped),
    { procRoot: state.procRoot },
  );
  assert.equal(result.state, 'manual_required');
});

test('rejects legacy source content drift before committing service active', async (t) => {
  const state = fixture(t);
  const prepared = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    '123e4567-e89b-42d3-a456-426614174026',
  );
  publishOutcome(
    prepared,
    'install-enable-start',
    'active',
    4423,
    1786416000200,
  );
  publishReceipt(state, 4423, '100004');
  fs.writeFileSync(state.sourcePath, 'legacy-drifted\n', { mode: 0o600 });
  await assert.rejects(
    consumeLocalServiceManagerCutoverOutcome(consumeCommand(state, prepared), {
      procRoot: state.procRoot,
    }),
    /adopted data evidence drifted/,
  );
  const head = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(head.state, 'legacy_stopped');
});

test('terminalizes a manager PID replaced before Owner receipt verification', async (t) => {
  const state = fixture(t);
  const prepared = prepare(
    state,
    1,
    'install-enable-start',
    state.commitmentDigest,
    '123e4567-e89b-42d3-a456-426614174027',
  );
  publishOutcome(
    prepared,
    'install-enable-start',
    'active',
    4523,
    1786416000200,
  );
  publishReceipt(state, 4524, '100005');
  let clock = 0;
  const result = await consumeLocalServiceManagerCutoverOutcome(
    consumeCommand(state, prepared),
    {
      procRoot: state.procRoot,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );
  assert.equal(result.state, 'manual_required');
  const head = readLocalCutoverInstanceHead(
    state.root,
    'edge-router-1',
    process.getuid(),
  );
  assert.equal(head.state, 'manual_required');
});
