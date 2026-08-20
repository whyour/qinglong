const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  EMPTY_ROLLBACK_PREPARATION_DIGEST,
  EMPTY_RESOLUTION_DIGEST,
  runLocalDeploymentCutoverManualCommand,
  runLocalDeploymentLegacyRollback,
  runLocalDeploymentDockerTarget,
  stopLocalDeploymentDockerTarget,
  stopLegacyDockerForLocalDeployment,
} = require('../dist/deployment/localDeployment.js');

function rootAcknowledgement() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function targetPath(state, hostPath) {
  return path.join('/host', path.relative(state.managementRoot, hostPath));
}

function startupReceipt(state, processId) {
  const payload = {
    schemaVersion: 1,
    schema: 'qinglong/local-application-startup-receipt@v1',
    instanceId: 'edge-router-1',
    profile: 'edge',
    aiStatus: 'deployment_excluded',
    bootId: '00000000-0000-4000-8000-000000000001',
    activeBootAgeMs: 10_000 + processId,
    processId,
    processStartTicks: String(100_000 + processId),
    nodeExecutable: '/usr/local/bin/node',
    nodeVersion: 'v24.18.0',
  };
  const sha256 = crypto
    .createHash('sha256')
    .update('qinglong.local-application-startup-receipt.v1\0', 'utf8')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  fs.writeFileSync(
    `${state.applicationConfigPath}.active.json`,
    `${JSON.stringify({ ...payload, sha256 })}\n`,
    { mode: 0o600 },
  );
  return sha256;
}

function stoppedLegacyInspection(state, running = false) {
  return JSON.stringify([
    {
      Id: state.legacyContainerId,
      Created: '2026-08-09T00:00:00.000000000Z',
      Name: '/qinglong-legacy',
      State: {
        Running: running,
        Restarting: false,
        Paused: false,
        Pid: running ? 42 : 0,
        Status: running ? 'running' : 'exited',
      },
      Config: { Image: 'whyour/qinglong:2.17.17' },
      HostConfig: { RestartPolicy: { Name: 'no' } },
      Mounts: [
        {
          Type: 'bind',
          Source: state.managementRoot,
          Destination: '/ql/data',
          RW: true,
        },
      ],
    },
  ]);
}

function targetInspection(state) {
  return JSON.stringify([
    {
      Id: state.targetContainerId,
      Created: '2026-08-09T01:00:00.000000000Z',
      Name: '/qinglong3-target',
      State: {
        Running: state.targetRunning,
        Restarting: false,
        Paused: false,
        Pid: state.targetRunning ? 100 : 0,
        Status: state.targetRunning ? 'running' : 'exited',
      },
      Config: {
        Image: state.targetImage,
        Cmd: ['--config', state.targetApplicationConfigPath],
      },
      HostConfig: {
        RestartPolicy: { Name: 'no' },
        ReadonlyRootfs: true,
        Privileged: false,
        SecurityOpt: ['no-new-privileges'],
      },
      Mounts: [
        {
          Type: 'bind',
          Source: state.managementRoot,
          Destination: '/host',
          RW: true,
        },
      ],
    },
  ]);
}

function fixture(t) {
  const managementRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-target-cutover-')),
  );
  fs.chmodSync(managementRoot, 0o700);
  t.after(() => fs.rmSync(managementRoot, { recursive: true, force: true }));
  const deploymentRoot = path.join(managementRoot, 'runtime');
  const serviceRoot = path.join(deploymentRoot, 'service');
  const cutoverId = 'cutover-edge-1';
  const journal = path.join(serviceRoot, 'cutovers', cutoverId);
  for (const directory of [deploymentRoot, serviceRoot, path.dirname(journal), journal]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  const legacySourcePath = path.join(managementRoot, 'database.sqlite');
  const targetDatabasePath = path.join(managementRoot, 'database.ql3.sqlite');
  const recoveryPath = path.join(managementRoot, 'database.recovery.sqlite');
  const manifestPath = path.join(managementRoot, 'adoption-manifest.json');
  const activationPath = path.join(managementRoot, 'activation.json');
  fs.writeFileSync(legacySourcePath, 'legacy-source\n', { mode: 0o600 });
  fs.writeFileSync(targetDatabasePath, 'target-initial\n', { mode: 0o600 });
  fs.writeFileSync(recoveryPath, 'legacy-source\n', { mode: 0o600 });
  fs.writeFileSync(manifestPath, '{}\n', { mode: 0o600 });
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
  const state = {
    managementRoot,
    deploymentRoot,
    journal,
    cutoverId,
    legacySourcePath,
    targetDatabasePath,
    recoveryPath,
    manifestPath,
    activationPath,
    activationDigest,
    legacyContainerId: '7'.repeat(64),
    targetContainerId: '8'.repeat(64),
    targetImage: `registry.example/qinglong3@sha256:${'9'.repeat(64)}`,
    targetRunning: false,
    legacyRunning: false,
    nextProcessId: 10,
  };
  const commonOptions = {
    deploymentRoot,
    dockerExecutable: fs.realpathSync(process.execPath),
    dockerSocketPath: path.join(managementRoot, 'docker.sock'),
    allowRootService: rootAcknowledgement(),
  };
  const legacy = stopLegacyDockerForLocalDeployment(
    {
      schemaVersion: 1,
      operation: 'local.deployment.cutover.legacy-stop',
      options: commonOptions,
      request: {
        cutoverId,
        profile: 'edge',
        instanceId: 'edge-router-1',
        activationPath,
        legacySourcePath,
        expectedLegacyDatabasePath: '/ql/data/database.sqlite',
        expectedActivationDigest: activationDigest,
        expectedLegacyContainerId: state.legacyContainerId,
        requestedAtMs: 2_000,
      },
    },
    {
      validateSocket() {},
      runDocker({ args }) {
        return args[1] === 'inspect'
          ? stoppedLegacyInspection(state)
          : `${state.legacyContainerId}\n`;
      },
    },
  );
  state.legacyCommitmentDigest = legacy.commitmentDigest;
  state.legacyCommitmentPath = path.join(journal, '0002-legacy-stopped.json');
  state.applicationConfigPath = path.join(deploymentRoot, 'local-application.json');
  state.targetApplicationConfigPath = targetPath(
    state,
    state.applicationConfigPath,
  );
  state.targetCommitmentPath = targetPath(state, state.legacyCommitmentPath);
  fs.writeFileSync(
    state.applicationConfigPath,
    `${JSON.stringify({
      schema: 'qinglong/local-application-process@v3',
      profile: 'edge',
      instanceId: 'edge-router-1',
      storage: {
        mode: 'adopted',
        sourcePath: targetPath(state, legacySourcePath),
        targetPath: targetPath(state, targetDatabasePath),
        recoveryPath: targetPath(state, recoveryPath),
        manifestPath: targetPath(state, manifestPath),
        activationPath: targetPath(state, activationPath),
        expectedActivationDigest: activationDigest,
      },
      cutover: {
        cutoverId,
        commitmentPath: state.targetCommitmentPath,
        expectedCommitmentDigest: legacy.commitmentDigest,
      },
    })}\n`,
    { mode: 0o600 },
  );
  return state;
}

function command(state, generation = 1) {
  return {
    schemaVersion: 1,
    operation:
      generation === 1
        ? 'local.deployment.cutover.target-start'
        : 'local.deployment.cutover.target-restart',
    options: {
      deploymentRoot: state.deploymentRoot,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
      allowRootService: rootAcknowledgement(),
    },
    request: {
      cutoverId: state.cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      activationPath: state.activationPath,
      legacySourcePath: state.legacySourcePath,
      targetDatabasePath: state.targetDatabasePath,
      recoveryPath: state.recoveryPath,
      manifestPath: state.manifestPath,
      expectedLegacyDatabasePath: '/ql/data/database.sqlite',
      expectedActivationDigest: state.activationDigest,
      expectedLegacyCommitmentDigest: state.legacyCommitmentDigest,
      expectedLegacyContainerId: state.legacyContainerId,
      expectedTargetContainerId: state.targetContainerId,
      expectedTargetImage: state.targetImage,
      applicationConfigPath: state.applicationConfigPath,
      expectedTargetApplicationConfigPath:
        state.targetApplicationConfigPath,
      expectedTargetCommitmentPath: state.targetCommitmentPath,
      generation,
      requestedAtMs: 2_000 + generation,
    },
  };
}

function stopCommand(state, generation = 1) {
  const value = command(state, generation);
  return {
    ...value,
    operation: 'local.deployment.cutover.target-stop',
    request: {
      ...value.request,
      requestedAtMs: 5_000 + generation,
    },
  };
}

function rollbackCommand(
  state,
  stopped,
  operation,
  expectedPreparationDigest = EMPTY_ROLLBACK_PREPARATION_DIGEST,
) {
  const value = stopCommand(state, stopped.generation);
  return {
    ...value,
    operation,
    request: {
      ...value.request,
      expectedInstanceHeadDigest: stopped.instanceHeadDigest,
      expectedStoppedRecordDigest: stopped.recordDigest,
      expectedPreparationDigest,
      rollbackRequestedAtMs: 7_000 + stopped.generation,
    },
  };
}

function manualCommand(
  state,
  operation,
  expectedPreparationDigest = EMPTY_RESOLUTION_DIGEST,
) {
  const head = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutover-instances',
        'edge-router-1',
        'head.json',
      ),
      'utf8',
    ),
  );
  return {
    schemaVersion: 1,
    operation,
    options: {
      deploymentRoot: state.deploymentRoot,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
      allowRootService: rootAcknowledgement(),
    },
    request: {
      profile: 'edge',
      instanceId: 'edge-router-1',
      currentCutoverId: state.cutoverId,
      nextCutoverId: 'cutover-edge-2',
      currentActivationDigest: state.activationDigest,
      nextActivationDigest: state.activationDigest,
      expectedInstanceHeadDigest: head.headDigest,
      expectedManualRecordDigest: head.sourceRecordDigest,
      expectedLegacyContainerId: state.legacyContainerId,
      expectedTargetContainerId: state.targetContainerId,
      expectedPreparationDigest,
      requestedAtMs: 3_000,
    },
  };
}

function harness(state, options = {}) {
  const calls = [];
  let time = 10_000;
  return {
    calls,
    validateSocket() {},
    runDocker({ args }) {
      calls.push(args);
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args[2] === state.legacyContainerId
      ) {
        return stoppedLegacyInspection(
          state,
          options.legacyRunning === true || state.legacyRunning === true,
        );
      }
      if (args[0] === 'container' && args[1] === 'inspect') {
        return targetInspection(state);
      }
      if (args[0] === 'container' && args[1] === 'start') {
        if (args[2] === state.legacyContainerId) {
          if (options.leaveLegacyStopped !== true) state.legacyRunning = true;
          if (options.startTargetWithLegacy === true) state.targetRunning = true;
          if (options.loseLegacyStartResponse === true) {
            throw new Error('simulated lost legacy start response');
          }
          return `${state.legacyContainerId}\n`;
        }
        if (options.leaveStopped !== true) {
          state.targetRunning = true;
          startupReceipt(state, ++state.nextProcessId);
        }
        return `${state.targetContainerId}\n`;
      }
      if (args[0] === 'container' && args[1] === 'update') {
        return `${state.targetContainerId}\n`;
      }
      if (args[0] === 'container' && args[1] === 'stop') {
        if (options.leaveRunningOnStop !== true) state.targetRunning = false;
        if (options.loseStopResponse === true) {
          throw new Error('simulated lost stop response');
        }
        return `${state.targetContainerId}\n`;
      }
      throw new Error('unexpected Docker call');
    },
    now() {
      time += options.expireImmediately === true ? 31_000 : 1;
      return time;
    },
    async wait() {
      if (options.crashDuringObservation === true) {
        throw new Error('simulated supervisor crash');
      }
    },
    afterBarrier:
      options.crashAfterStopBarrier === true ||
      options.crashAfterRollbackBarrier === true ||
      options.startTargetAfterRollbackBarrier === true
        ? () => {
            if (options.startTargetAfterRollbackBarrier === true) {
              state.targetRunning = true;
              return;
            }
            throw new Error(
              options.crashAfterRollbackBarrier === true
                ? 'simulated rollback supervisor crash'
                : 'simulated stop supervisor crash',
            );
          }
        : undefined,
    afterStart:
      options.crashAfterLegacyStart === true
        ? () => {
            throw new Error('simulated crash after legacy start');
          }
        : undefined,
  };
}

test('starts an exact target once and replays the active commitment without Docker', async (t) => {
  const state = fixture(t);
  const controller = harness(state);
  const active = await runLocalDeploymentDockerTarget(command(state), controller);
  assert.equal(active.status, 'prepared');
  assert.equal(active.state, 'target_active');
  assert.equal(active.generation, 1);
  assert.equal(
    controller.calls.filter((args) => args[1] === 'start').length,
    1,
  );
  const request = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0003-target-start-decision.json'),
      'utf8',
    ),
  );
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0004-target-start-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(request.state, 'target_start_requested');
  assert.equal(outcome.state, 'target_active');
  assert.equal(outcome.previousRecordDigest, request.recordDigest);

  const replay = await runLocalDeploymentDockerTarget(command(state), {
    validateSocket() {
      throw new Error('terminal replay must not open Docker authority');
    },
    runDocker() {
      throw new Error('terminal replay must not inspect or start');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.recordDigest, active.recordDigest);
});

test('recovers a crash after the start barrier by inspection without repeating start', async (t) => {
  const state = fixture(t);
  const crashing = harness(state, {
    leaveStopped: true,
    crashDuringObservation: true,
  });
  await assert.rejects(
    runLocalDeploymentDockerTarget(command(state), crashing),
    /simulated supervisor crash/,
  );
  assert.equal(
    fs.existsSync(
      path.join(state.journal, '0003-target-start-decision.json'),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(state.journal, '0004-target-start-outcome.json')),
    false,
  );
  assert.equal(
    crashing.calls.filter((args) => args[1] === 'start').length,
    1,
  );

  state.targetRunning = true;
  startupReceipt(state, ++state.nextProcessId);
  const recovering = harness(state);
  const recovered = await runLocalDeploymentDockerTarget(
    command(state),
    recovering,
  );
  assert.equal(recovered.state, 'target_active');
  assert.equal(
    recovering.calls.filter((args) => args[1] === 'start').length,
    0,
  );
});

test('makes an unproved target start terminal manual_required', async (t) => {
  const state = fixture(t);
  const controller = harness(state, {
    leaveStopped: true,
    expireImmediately: true,
  });
  const unresolved = await runLocalDeploymentDockerTarget(
    command(state),
    controller,
  );
  assert.equal(unresolved.status, 'prepared');
  assert.equal(unresolved.state, 'manual_required');
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0004-target-start-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(outcome.state, 'manual_required');
  assert.equal(outcome.evidence.reason, 'target_start_result_unproved');
  assert.equal(JSON.stringify(outcome).includes('Docker command'), false);

  const replay = await runLocalDeploymentDockerTarget(command(state), {
    validateSocket() {
      throw new Error('manual terminal must not reopen Docker authority');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.state, 'manual_required');
});

test('reproves legacy silence before each target restart generation', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const previousReceipt = JSON.parse(
    fs.readFileSync(`${state.applicationConfigPath}.active.json`, 'utf8'),
  ).sha256;
  state.targetRunning = false;

  const controller = harness(state);
  const restarted = await runLocalDeploymentDockerTarget(
    command(state, 2),
    controller,
  );
  assert.equal(restarted.state, 'target_active');
  const states = [5, 6, 7, 8].map((number) => {
    const file = fs
      .readdirSync(state.journal)
      .find((name) => name.startsWith(String(number).padStart(4, '0')));
    return JSON.parse(fs.readFileSync(path.join(state.journal, file), 'utf8'))
      .state;
  });
  assert.deepEqual(states, [
    'legacy_recheck_requested',
    'legacy_reverified',
    'target_restart_requested',
    'target_active',
  ]);
  const legacyInspectIndex = controller.calls.findIndex(
    (args) => args[1] === 'inspect' && args[2] === state.legacyContainerId,
  );
  const startIndex = controller.calls.findIndex((args) => args[1] === 'start');
  assert.ok(legacyInspectIndex >= 0 && legacyInspectIndex < startIndex);
  const currentReceipt = JSON.parse(
    fs.readFileSync(`${state.applicationConfigPath}.active.json`, 'utf8'),
  ).sha256;
  assert.notEqual(currentReceipt, previousReceipt);
});

test('never restarts target when legacy silence cannot be reverified', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  state.targetRunning = false;
  const controller = harness(state, { legacyRunning: true });
  const unresolved = await runLocalDeploymentDockerTarget(
    command(state, 2),
    controller,
  );
  assert.equal(unresolved.state, 'manual_required');
  assert.equal(
    controller.calls.filter((args) => args[1] === 'start').length,
    0,
  );
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0006-legacy-recheck-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(outcome.evidence.reason, 'legacy_silence_unproved');
});

test('rejects a self-consistent restart request detached from legacy reverified evidence', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  state.targetRunning = false;
  await runLocalDeploymentDockerTarget(command(state, 2), harness(state));

  const requestPath = path.join(
    state.journal,
    '0007-target-restart-decision.json',
  );
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  request.previousRecordDigest = 'f'.repeat(64);
  const { recordDigest: ignored, ...payload } = request;
  request.recordDigest = digest(payload);
  fs.writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    mode: 0o600,
  });

  await assert.rejects(
    runLocalDeploymentDockerTarget(command(state, 2), {
      validateSocket() {
        throw new Error('drift must fail before Docker authority');
      },
    }),
    /journal record drifted/,
  );
});

test('refuses target start when the writable target database mount is not bound', async (t) => {
  const state = fixture(t);
  const detached = command(state);
  detached.request.targetDatabasePath = '/var/db/detached-qinglong3.sqlite';
  const controller = harness(state);
  const unresolved = await runLocalDeploymentDockerTarget(
    detached,
    controller,
  );
  assert.equal(unresolved.state, 'manual_required');
  assert.equal(
    controller.calls.filter((args) => args[1] === 'start').length,
    0,
  );
  const decision = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0003-target-start-decision.json'),
      'utf8',
    ),
  );
  assert.equal(decision.evidence.reason, 'target_preflight_unproved');
});

test('prevents a new cutover id from bypassing a manual-required instance head', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(
    command(state),
    harness(state, { leaveStopped: true, expireImmediately: true }),
  );
  let dockerCalls = 0;
  await assert.rejects(
    Promise.resolve().then(() =>
      stopLegacyDockerForLocalDeployment(
        {
          schemaVersion: 1,
          operation: 'local.deployment.cutover.legacy-stop',
          options: command(state).options,
          request: {
            cutoverId: 'cutover-edge-2',
            profile: 'edge',
            instanceId: 'edge-router-1',
            activationPath: state.activationPath,
            legacySourcePath: state.legacySourcePath,
            expectedLegacyDatabasePath: '/ql/data/database.sqlite',
            expectedActivationDigest: state.activationDigest,
            expectedLegacyContainerId: state.legacyContainerId,
            requestedAtMs: 3_000,
          },
        },
        {
          validateSocket() {
            dockerCalls += 1;
          },
          runDocker() {
            dockerCalls += 1;
            throw new Error('must not reach Docker');
          },
        },
      ),
    ),
    /explicit manual resolution is required/,
  );
  assert.equal(dockerCalls, 0);
  assert.equal(
    fs.existsSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutovers',
        'cutover-edge-2',
      ),
    ),
    false,
  );
});

test('diagnoses and resolves manual-required through inspect-only prepare and CAS commit', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(
    command(state),
    harness(state, { leaveStopped: true, expireImmediately: true }),
  );
  const controller = harness(state, { leaveStopped: true });
  const diagnosed = runLocalDeploymentCutoverManualCommand(
    manualCommand(state, 'local.deployment.cutover.manual-diagnose'),
    controller,
  );
  assert.equal(diagnosed.state, 'manual_diagnosed');
  assert.equal(diagnosed.legacyState, 'stopped');
  assert.equal(diagnosed.targetState, 'stopped');
  assert.ok(controller.calls.every((args) => args[1] === 'inspect'));

  const prepared = runLocalDeploymentCutoverManualCommand(
    manualCommand(
      state,
      'local.deployment.cutover.manual-resolution-prepare',
    ),
    harness(state, { leaveStopped: true }),
  );
  assert.equal(prepared.state, 'resolution_prepared');
  assert.match(prepared.preparationDigest, /^[0-9a-f]{64}$/);

  const commitCommand = manualCommand(
    state,
    'local.deployment.cutover.manual-resolution-commit',
    prepared.preparationDigest,
  );
  const committed = runLocalDeploymentCutoverManualCommand(
    commitCommand,
    harness(state, { leaveStopped: true }),
  );
  assert.equal(committed.state, 'resolution_authorized');
  assert.equal(committed.status, 'prepared');
  const head = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutover-instances',
        'edge-router-1',
        'head.json',
      ),
      'utf8',
    ),
  );
  assert.equal(head.cutoverId, 'cutover-edge-2');
  assert.equal(head.state, 'resolution_authorized');
  assert.equal(head.previousHeadDigest, diagnosed.instanceHeadDigest);

  const replay = runLocalDeploymentCutoverManualCommand(
    commitCommand,
    {
      validateSocket() {
        throw new Error('commit replay must not reopen Docker authority');
      },
      runDocker() {
        throw new Error('commit replay must not inspect or mutate');
      },
    },
  );
  assert.equal(replay.status, 'existing');
  assert.equal(replay.instanceHeadDigest, committed.instanceHeadDigest);

  await assert.rejects(
    runLocalDeploymentDockerTarget(command(state), {
      validateSocket() {
        throw new Error('stale cutover must fail before Docker authority');
      },
    }),
    /not bound to the instance lineage head/,
  );

  const nextLegacy = stopLegacyDockerForLocalDeployment(
    {
      schemaVersion: 1,
      operation: 'local.deployment.cutover.legacy-stop',
      options: command(state).options,
      request: {
        cutoverId: 'cutover-edge-2',
        profile: 'edge',
        instanceId: 'edge-router-1',
        activationPath: state.activationPath,
        legacySourcePath: state.legacySourcePath,
        expectedLegacyDatabasePath: '/ql/data/database.sqlite',
        expectedActivationDigest: state.activationDigest,
        expectedLegacyContainerId: state.legacyContainerId,
        requestedAtMs: 4_000,
      },
    },
    {
      validateSocket() {},
      runDocker({ args }) {
        return args[1] === 'inspect'
          ? stoppedLegacyInspection(state)
          : `${state.legacyContainerId}\n`;
      },
    },
  );
  assert.equal(nextLegacy.state, 'legacy_stopped');
  const nextHead = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutover-instances',
        'edge-router-1',
        'head.json',
      ),
      'utf8',
    ),
  );
  assert.equal(nextHead.cutoverId, 'cutover-edge-2');
  assert.equal(nextHead.state, 'legacy_stopped');
});

test('rejects manual resolution commit when stopped evidence drifts', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(
    command(state),
    harness(state, { leaveStopped: true, expireImmediately: true }),
  );
  const prepared = runLocalDeploymentCutoverManualCommand(
    manualCommand(
      state,
      'local.deployment.cutover.manual-resolution-prepare',
    ),
    harness(state, { leaveStopped: true }),
  );
  state.targetRunning = true;
  assert.throws(
    () =>
      runLocalDeploymentCutoverManualCommand(
        manualCommand(
          state,
          'local.deployment.cutover.manual-resolution-commit',
          prepared.preparationDigest,
        ),
        harness(state),
      ),
    /requires both legacy and target to be proved stopped/,
  );
  const head = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutover-instances',
        'edge-router-1',
        'head.json',
      ),
      'utf8',
    ),
  );
  assert.equal(head.state, 'manual_required');
});

test('stops an active target and proves an unchanged rollback candidate', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const controller = harness(state);
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    controller,
  );
  assert.equal(stopped.state, 'target_stopped');
  assert.equal(stopped.reconciliation, 'rollback_candidate');
  assert.equal(
    controller.calls.filter((args) => args[1] === 'stop').length,
    1,
  );
  const request = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0005-target-stop-decision.json'),
      'utf8',
    ),
  );
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0006-target-stop-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(request.state, 'target_stop_requested');
  assert.equal(outcome.state, 'target_stopped');
  assert.equal(outcome.evidence.reconciliation.targetMatchesActivation, true);
  assert.equal(outcome.evidence.reconciliation.sourceMatchesActivation, true);

  const replay = stopLocalDeploymentDockerTarget(stopCommand(state), {
    validateSocket() {
      throw new Error('stopped replay must not open Docker authority');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.recordDigest, stopped.recordDigest);

  await assert.rejects(
    runLocalDeploymentDockerTarget(command(state, 2), {
      validateSocket() {
        throw new Error('stopped target must fail before Docker authority');
      },
    }),
    /target command is not bound to the instance lineage head/,
  );
});

test('prepares and commits an exact legacy rollback without mutating target data', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const preparing = harness(state);
  const prepared = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-prepare',
    ),
    preparing,
  );
  assert.equal(prepared.state, 'rollback_prepared');
  assert.match(prepared.preparationDigest, /^[0-9a-f]{64}$/);
  assert.equal(
    preparing.calls.filter((args) => args[1] === 'start').length,
    0,
  );
  const targetBefore = fs.readFileSync(state.targetDatabasePath);
  const commitCommand = rollbackCommand(
    state,
    stopped,
    'local.deployment.cutover.legacy-rollback-commit',
    prepared.preparationDigest,
  );
  const committing = harness(state);
  const committed = runLocalDeploymentLegacyRollback(
    commitCommand,
    committing,
  );
  assert.equal(committed.state, 'legacy_running');
  assert.equal(
    committing.calls.filter(
      (args) =>
        args[1] === 'start' && args[2] === state.legacyContainerId,
    ).length,
    1,
  );
  assert.deepEqual(fs.readFileSync(state.targetDatabasePath), targetBefore);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(state.journal, '0007-legacy-rollback-start-decision.json'),
        'utf8',
      ),
    ).state,
    'legacy_restart_requested',
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(state.journal, '0008-legacy-rollback-start-outcome.json'),
        'utf8',
      ),
    ).state,
    'legacy_running',
  );

  const replay = runLocalDeploymentLegacyRollback(commitCommand, {
    validateSocket() {
      throw new Error('terminal rollback replay must not open Docker');
    },
    runDocker() {
      throw new Error('terminal rollback replay must not inspect or start');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.recordDigest, committed.recordDigest);
});

test('refuses rollback preparation after the target has produced new facts', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  fs.appendFileSync(state.targetDatabasePath, 'new-qinglong3-fact\n');
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  assert.equal(stopped.reconciliation, 'reconciliation_required');
  let dockerCalls = 0;
  assert.throws(
    () =>
      runLocalDeploymentLegacyRollback(
        rollbackCommand(
          state,
          stopped,
          'local.deployment.cutover.legacy-rollback-prepare',
        ),
        {
          validateSocket() {
            dockerCalls += 1;
          },
        },
      ),
    /requires the exact rollback candidate/,
  );
  assert.equal(dockerCalls, 0);
});

test('terminalizes rollback when data drifts between prepare and commit', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const prepared = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-prepare',
    ),
    harness(state),
  );
  fs.appendFileSync(state.targetDatabasePath, 'post-prepare-drift\n');
  const controller = harness(state);
  const result = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-commit',
      prepared.preparationDigest,
    ),
    controller,
  );
  assert.equal(result.state, 'manual_required');
  assert.equal(
    controller.calls.filter((args) => args[1] === 'start').length,
    0,
  );
  const decision = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0007-legacy-rollback-start-decision.json'),
      'utf8',
    ),
  );
  assert.equal(decision.evidence.reason, 'legacy_restart_preflight_unproved');
});

test('does not blindly start legacy after a crash at the rollback barrier', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const prepared = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-prepare',
    ),
    harness(state),
  );
  const commitCommand = rollbackCommand(
    state,
    stopped,
    'local.deployment.cutover.legacy-rollback-commit',
    prepared.preparationDigest,
  );
  assert.throws(
    () =>
      runLocalDeploymentLegacyRollback(
        commitCommand,
        harness(state, { crashAfterRollbackBarrier: true }),
      ),
    /simulated rollback supervisor crash/,
  );
  const recovering = harness(state);
  const result = runLocalDeploymentLegacyRollback(
    commitCommand,
    recovering,
  );
  assert.equal(result.state, 'manual_required');
  assert.equal(
    recovering.calls.filter((args) => args[1] === 'start').length,
    0,
  );
});

test('rechecks target stopped after the rollback barrier before starting legacy', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const prepared = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-prepare',
    ),
    harness(state),
  );
  const controller = harness(state, {
    startTargetAfterRollbackBarrier: true,
  });
  const result = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-commit',
      prepared.preparationDigest,
    ),
    controller,
  );
  assert.equal(result.state, 'manual_required');
  assert.equal(
    controller.calls.some(
      (args) =>
        args[1] === 'start' && args[2] === state.legacyContainerId,
    ),
    false,
  );
});

test('recovers a crash after legacy start by inspection without starting twice', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const prepared = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-prepare',
    ),
    harness(state),
  );
  const commitCommand = rollbackCommand(
    state,
    stopped,
    'local.deployment.cutover.legacy-rollback-commit',
    prepared.preparationDigest,
  );
  assert.throws(
    () =>
      runLocalDeploymentLegacyRollback(
        commitCommand,
        harness(state, { crashAfterLegacyStart: true }),
      ),
    /simulated crash after legacy start/,
  );
  const recovering = harness(state);
  const result = runLocalDeploymentLegacyRollback(
    commitCommand,
    recovering,
  );
  assert.equal(result.state, 'legacy_running');
  assert.equal(
    recovering.calls.filter((args) => args[1] === 'start').length,
    0,
  );
});

test('does not claim rollback success when target is also running', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const prepared = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-prepare',
    ),
    harness(state),
  );
  const result = runLocalDeploymentLegacyRollback(
    rollbackCommand(
      state,
      stopped,
      'local.deployment.cutover.legacy-rollback-commit',
      prepared.preparationDigest,
    ),
    harness(state, { startTargetWithLegacy: true }),
  );
  assert.equal(result.state, 'manual_required');
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0008-legacy-rollback-start-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(outcome.evidence.reason, 'legacy_restart_result_unproved');
});

test('rejects unsafe rollback preparation directory entries', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  const instanceDirectory = path.join(
    state.deploymentRoot,
    'service',
    'cutover-instances',
    'edge-router-1',
  );
  fs.symlinkSync(
    state.activationPath,
    path.join(instanceDirectory, 'rollback-untrusted.json'),
  );
  assert.throws(
    () =>
      runLocalDeploymentLegacyRollback(
        rollbackCommand(
          state,
          stopped,
          'local.deployment.cutover.legacy-rollback-prepare',
        ),
        harness(state),
      ),
    /preparation directory contains an unsafe entry/,
  );
});

test('classifies a written target as reconciliation-required without restarting legacy', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  fs.appendFileSync(state.targetDatabasePath, 'new-qinglong3-fact\n');
  const controller = harness(state);
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    controller,
  );
  assert.equal(stopped.state, 'target_stopped');
  assert.equal(stopped.reconciliation, 'reconciliation_required');
  assert.equal(
    controller.calls.some(
      (args) => args[1] === 'start' && args[2] === state.legacyContainerId,
    ),
    false,
  );
});

test('treats target SQLite sidecars as reconciliation-required', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  fs.writeFileSync(`${state.targetDatabasePath}-wal`, 'pending-wal\n', {
    mode: 0o600,
  });
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  assert.equal(stopped.reconciliation, 'reconciliation_required');
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0006-target-stop-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(outcome.evidence.reconciliation.targetMatchesActivation, true);
  assert.equal(outcome.evidence.reconciliation.targetSidecarsClear, false);
});

test('requires manual review when legacy source no longer matches activation', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  fs.appendFileSync(state.legacySourcePath, 'offline-legacy-drift\n');
  const stopped = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  assert.equal(stopped.reconciliation, 'manual_review');
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0006-target-stop-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(outcome.evidence.reconciliation.targetMatchesActivation, true);
  assert.equal(outcome.evidence.reconciliation.sourceMatchesActivation, false);
});

test('recovers a crash after the stop barrier by converging stop-and-inspect', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  assert.throws(
    () =>
      stopLocalDeploymentDockerTarget(
        stopCommand(state),
        harness(state, { crashAfterStopBarrier: true }),
      ),
    /simulated stop supervisor crash/,
  );
  assert.equal(
    fs.existsSync(path.join(state.journal, '0005-target-stop-decision.json')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(state.journal, '0006-target-stop-outcome.json')),
    false,
  );
  const recovered = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    harness(state),
  );
  assert.equal(recovered.state, 'target_stopped');
});

test('makes an unproved target stop terminal manual-required', async (t) => {
  const state = fixture(t);
  await runLocalDeploymentDockerTarget(command(state), harness(state));
  const controller = harness(state, { leaveRunningOnStop: true });
  const unresolved = stopLocalDeploymentDockerTarget(
    stopCommand(state),
    controller,
  );
  assert.equal(unresolved.state, 'manual_required');
  assert.equal(unresolved.reconciliation, 'manual_review');
  const outcome = JSON.parse(
    fs.readFileSync(
      path.join(state.journal, '0006-target-stop-outcome.json'),
      'utf8',
    ),
  );
  assert.equal(outcome.evidence.reason, 'target_stop_result_unproved');
});
