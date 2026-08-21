#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  consumeLocalServiceManagerOutcome,
  prepareLocalServiceManagerIntent,
} = require('../packages/ql3-local-owner-cli/dist/deployment/service-manager/serviceManagerIntent.js');
const {
  consumeLocalServiceManagerCutoverOutcome,
} = require('../packages/ql3-local-owner-cli/dist/deployment/service-manager/serviceCutoverConsumer.js');
const {
  cutoverDigest,
} = require('../packages/ql3-local-owner-cli/dist/deployment/cutover/targetEvidence.js');
const {
  runLocalServiceBridgeCommandFile,
} = require('../packages/ql3-local-owner-cli/dist/deployment/service-manager/serviceBridge.js');
const {
  runLocalServiceManagerLegacyRollbackBridgeCommandFile,
} = require('../packages/ql3-local-owner-cli/dist/deployment/service-manager/legacy-rollback/bridge.js');
const {
  localServiceManagerLegacyStartOutcomePath,
} = require('../packages/ql3-local-owner-cli/dist/deployment/service-manager/legacy-rollback/contract.js');

const OWNER_DEPLOYMENT_CLI = path.resolve(
  __dirname,
  '../packages/ql3-local-owner-cli/dist/deployment/localDeploymentCli.js',
);
const NON_ROOT_SERVICE_UID = 10001;

class QingLong3ServiceManagerBridgeLiveActorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QingLong3ServiceManagerBridgeLiveActorError';
  }
}

function fail(message) {
  throw new QingLong3ServiceManagerBridgeLiveActorError(message);
}

function run(executable, args, accepted = [0]) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (
    result.error ||
    result.signal !== null ||
    !accepted.includes(result.status)
  ) {
    fail(
      `${path.basename(executable)} ${args.join(' ')} failed: ${String(
        result.stderr ?? '',
      ).slice(0, 512)}`,
    );
  }
  return String(result.stdout ?? '');
}

function responseLossManager(request) {
  const result = spawnSync(request.executable, [...request.args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
    },
    timeout: request.timeoutMs,
    maxBuffer: 64 * 1024,
  });
  const legacyStart =
    (request.args[0] === 'start' && request.args[1] === 'qinglong.service') ||
    (request.args[0] === 'qinglong' && request.args[1] === 'start');
  return {
    status: legacyStart ? null : result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    responseLost:
      legacyStart || result.error !== undefined || result.status === null,
  };
}

function executable(candidates, label) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  fail(`${label} executable is unavailable`);
}

function writePrivate(filePath, contents, mode = 0o600, uid = 0, gid = 0) {
  fs.writeFileSync(filePath, contents, { flag: 'wx', mode });
  fs.chownSync(filePath, uid, gid);
  fs.chmodSync(filePath, mode);
}

function descriptor(kind, uid, gid, root, adopted = false) {
  const command = adopted ? fs.realpathSync(process.execPath) : '/bin/sleep';
  const commandArgs = adopted
    ? `/workspace/scripts/ql3-service-manager-adopted-live-service.cjs ${root}/local-application.json`
    : '300';
  if (kind === 'systemd') {
    return [
      '[Unit]',
      'Description=QingLong 3 bridge live gate',
      '',
      '[Service]',
      'Type=simple',
      `User=${uid}`,
      `Group=${gid}`,
      `ExecStart=${command} ${commandArgs}`,
      'Restart=no',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
  }
  return [
    '#!/sbin/openrc-run',
    'name="qinglong3"',
    'description="QingLong 3 bridge live gate"',
    `command="${command}"`,
    `command_args="${commandArgs}"`,
    `command_user="${uid}:${gid}"`,
    'supervisor="supervise-daemon"',
    'retry="TERM/5/KILL/2"',
    '',
  ].join('\n');
}

function legacyDescriptor(kind, uid, gid, port) {
  const nodeExecutable = fs.realpathSync(process.execPath);
  const commandArgs = `/workspace/scripts/ql3-service-manager-legacy-live-service.cjs ${port}`;
  if (kind === 'systemd') {
    return [
      '[Unit]',
      'Description=QingLong 2 legacy rollback live gate',
      '',
      '[Service]',
      'Type=simple',
      `User=${uid}`,
      `Group=${gid}`,
      `ExecStart=${nodeExecutable} ${commandArgs}`,
      'Restart=no',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
  }
  return [
    '#!/sbin/openrc-run',
    'name="qinglong"',
    'description="QingLong 2 legacy rollback live gate"',
    `command="${nodeExecutable}"`,
    `command_args="${commandArgs}"`,
    `command_user="${uid}:${gid}"`,
    'supervisor="supervise-daemon"',
    'retry="TERM/5/KILL/2"',
    '',
  ].join('\n');
}

function manager(kind) {
  if (kind === 'systemd') {
    return {
      kind,
      executable: executable(
        ['/usr/bin/systemctl', '/bin/systemctl'],
        'systemctl',
      ),
    };
  }
  return {
    kind,
    serviceExecutable: executable(
      ['/sbin/rc-service', '/usr/sbin/rc-service'],
      'rc-service',
    ),
    updateExecutable: executable(
      ['/sbin/rc-update', '/usr/sbin/rc-update'],
      'rc-update',
    ),
  };
}

function actionId(kind, suffix) {
  const prefix = kind === 'systemd' ? '51' : '61';
  return `123e4567-e89b-42d3-a456-42661417${prefix}${suffix}`;
}

function ownerCli(uid, gid, operation, commandPath) {
  const result = spawnSync(
    process.execPath,
    [OWNER_DEPLOYMENT_CLI, operation, '--command-file', commandPath],
    {
      uid,
      gid,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.error || result.signal !== null || result.status !== 0) {
    fail(
      `Owner ${operation} failed: ${String(result.stderr ?? '').slice(0, 512)}`,
    );
  }
  return JSON.parse(String(result.stdout ?? ''));
}

function prepare(
  root,
  kind,
  suffix,
  action,
  uid,
  gid,
  lineage = { mode: 'fresh' },
) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.intent.prepare',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      actionId: actionId(kind, suffix),
      action,
      serviceKind: kind,
      lineage,
      requestedAtMs: Date.now(),
    },
  };
  if (uid === 0) return prepareLocalServiceManagerIntent(command);
  const commandPath = path.join(
    root,
    `${actionId(kind, suffix)}.owner-intent.json`,
  );
  writePrivate(
    commandPath,
    `${JSON.stringify(command, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  return ownerCli(uid, gid, 'service-intent-prepare', commandPath);
}

function replacePrivate(filePath, contents, mode, uid, gid) {
  fs.rmSync(filePath, { force: true });
  writePrivate(filePath, contents, mode, uid, gid);
}

function adoptedFixture(root, kind, uid, gid) {
  const cutoverId = `${kind}-${uid === 0 ? 'root' : 'nonroot'}-cutover`;
  const journal = path.join(root, 'service', 'cutovers', cutoverId);
  fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
  fs.chownSync(path.join(root, 'service', 'cutovers'), uid, gid);
  fs.chownSync(journal, uid, gid);
  const sourcePath = path.join(root, 'legacy.sqlite');
  const targetPath = path.join(root, 'target.sqlite');
  const recoveryPath = path.join(root, 'recovery.sqlite');
  const manifestPath = path.join(root, 'manifest.json');
  const activationPath = path.join(root, 'activation.json');
  writePrivate(sourcePath, 'legacy\n', 0o600, uid, gid);
  writePrivate(targetPath, 'target\n', 0o600, uid, gid);
  writePrivate(recoveryPath, 'legacy\n', 0o600, uid, gid);
  const manifestPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-adoption-manifest-live-fixture',
  };
  const manifestDigest = cutoverDigest(manifestPayload);
  writePrivate(
    manifestPath,
    `${JSON.stringify({ ...manifestPayload, manifestDigest })}\n`,
    0o600,
    uid,
    gid,
  );
  const target = fs.statSync(targetPath, { bigint: true });
  const activationPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-activation',
    state: 'prepared',
    profile: 'edge',
    createdAtMs: Date.now(),
    adoptionManifestDigest: manifestDigest,
    planDigest: '2'.repeat(64),
    sourcePathDigest: crypto
      .createHash('sha256')
      .update(sourcePath)
      .digest('hex'),
    sourceSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(sourcePath))
      .digest('hex'),
    recoverySha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(recoveryPath))
      .digest('hex'),
    targetSha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(targetPath))
      .digest('hex'),
    targetPathDigest: crypto
      .createHash('sha256')
      .update(targetPath)
      .digest('hex'),
    targetDevice: target.dev.toString(),
    targetInode: target.ino.toString(),
  };
  const activationDigest = cutoverDigest(activationPayload);
  writePrivate(
    activationPath,
    `${JSON.stringify({ ...activationPayload, activationDigest })}\n`,
    0o600,
    uid,
    gid,
  );
  const commitmentPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId,
    profile: 'edge',
    instanceId: `${kind}-${uid === 0 ? 'root' : 'nonroot'}-live-edge`,
    activationDigest,
    requestedAtMs: Date.now(),
    observedAtMs: Date.now(),
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
  writePrivate(
    commitmentPath,
    `${JSON.stringify({ ...commitmentPayload, commitmentDigest })}\n`,
    0o600,
    uid,
    gid,
  );
  replacePrivate(
    path.join(root, 'local-application.json'),
    `${JSON.stringify({
      schema: 'qinglong/local-application-process@v3',
      instanceId: commitmentPayload.instanceId,
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
    })}\n`,
    0o600,
    uid,
    gid,
  );
  replacePrivate(
    path.join(
      root,
      'service',
      kind === 'systemd' ? 'qinglong3.service' : 'qinglong3.openrc',
    ),
    descriptor(kind, uid, gid, root, true),
    kind === 'systemd' ? 0o600 : 0o700,
    uid,
    gid,
  );
  const instanceRoot = path.join(root, 'service', 'cutover-instances');
  const instanceDirectory = path.join(
    instanceRoot,
    commitmentPayload.instanceId,
  );
  fs.mkdirSync(instanceDirectory, { recursive: true, mode: 0o700 });
  fs.chownSync(instanceRoot, uid, gid);
  fs.chownSync(instanceDirectory, uid, gid);
  const initialPayload = {
    schema: 'qinglong3-local-cutover-instance-head',
    schemaVersion: 1,
    revision: 1,
    instanceId: commitmentPayload.instanceId,
    profile: 'edge',
    cutoverId,
    activationDigest,
    state: 'legacy_stop_requested',
    generation: 0,
    previousHeadDigest: '0'.repeat(64),
    sourceRecordDigest: '8'.repeat(64),
    updatedAtMs: Date.now(),
  };
  const initialHeadDigest = cutoverDigest(initialPayload);
  const headPayload = {
    ...initialPayload,
    revision: 2,
    state: 'legacy_stopped',
    previousHeadDigest: initialHeadDigest,
    sourceRecordDigest: commitmentDigest,
  };
  writePrivate(
    path.join(instanceDirectory, 'head.json'),
    `${JSON.stringify(
      {
        ...headPayload,
        headDigest: cutoverDigest(headPayload),
      },
      null,
      2,
    )}\n`,
    0o600,
    uid,
    gid,
  );
  return {
    cutoverId,
    instanceId: commitmentPayload.instanceId,
    activationDigest,
    commitmentDigest,
  };
}

async function consumeCutover(root, prepared, uid, gid) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.cutover.consume',
    options: {
      deploymentRoot: root,
      allowRootService: uid === 0,
      startupTimeoutMs: 30_000,
      startupPollMs: 50,
    },
    request: {
      actionId: prepared.actionId,
      expectedIntentDigest: prepared.intentDigest,
    },
  };
  if (uid === 0) return consumeLocalServiceManagerCutoverOutcome(command);
  const commandPath = path.join(
    root,
    `${prepared.actionId}.owner-cutover-consume.json`,
  );
  writePrivate(
    commandPath,
    `${JSON.stringify(command, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  return ownerCli(uid, gid, 'service-cutover-consume', commandPath);
}

function prepareAdoptedRollback(root, adopted, stopped, uid, gid) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.prepare',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      cutoverId: adopted.cutoverId,
      profile: 'edge',
      instanceId: adopted.instanceId,
      generation: 1,
      expectedActivationDigest: adopted.activationDigest,
      expectedStoppedRecordDigest: stopped.recordDigest,
      expectedInstanceHeadDigest: stopped.instanceHeadDigest,
      requestedAtMs: Date.now(),
    },
  };
  const commandPath = path.join(root, 'owner-legacy-rollback-prepare.json');
  writePrivate(
    commandPath,
    `${JSON.stringify(command, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  return {
    commandPath,
    result: ownerCli(uid, gid, 'service-legacy-rollback-prepare', commandPath),
  };
}

function authorizeAdoptedRollback(root, adopted, prepared, uid, gid) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.authorize',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      cutoverId: adopted.cutoverId,
      profile: 'edge',
      instanceId: adopted.instanceId,
      generation: 1,
      expectedActivationDigest: adopted.activationDigest,
      expectedPreparationDigest: prepared.preparationDigest,
      expectedInstanceHeadDigest: prepared.instanceHeadDigest,
      requestedAtMs: Date.now(),
    },
  };
  const commandPath = path.join(root, 'owner-legacy-rollback-authorize.json');
  writePrivate(
    commandPath,
    `${JSON.stringify(command, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  return {
    commandPath,
    result: ownerCli(
      uid,
      gid,
      'service-legacy-rollback-authorize',
      commandPath,
    ),
  };
}

function installLegacyService(kind, managerOptions, uid, gid, port) {
  const descriptorPath =
    kind === 'systemd'
      ? '/etc/systemd/system/qinglong.service'
      : '/etc/init.d/qinglong';
  fs.rmSync(descriptorPath, { force: true });
  writePrivate(
    descriptorPath,
    legacyDescriptor(kind, uid, gid, port),
    kind === 'systemd' ? 0o644 : 0o755,
    0,
    0,
  );
  if (kind === 'systemd') {
    run(managerOptions.executable, ['daemon-reload']);
  }
}

function executeLegacyRollback(
  root,
  controllerRoot,
  managerOptions,
  adopted,
  prepared,
  authorized,
  uid,
  gid,
) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.execute',
    options: {
      deploymentRoot: root,
      controllerRoot,
      allowRootController: true,
      manager: managerOptions,
    },
    request: {
      cutoverId: adopted.cutoverId,
      generation: 1,
      expectedAuthorizationDigest: authorized.authorizationDigest,
    },
  };
  const commandPath = path.join(root, 'root-legacy-rollback-command.json');
  writePrivate(commandPath, `${JSON.stringify(command, null, 2)}\n`);
  const result = runLocalServiceManagerLegacyRollbackBridgeCommandFile(
    commandPath,
    { runManager: responseLossManager },
  );
  const replay =
    runLocalServiceManagerLegacyRollbackBridgeCommandFile(commandPath);
  const consumeCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.consume',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      cutoverId: adopted.cutoverId,
      profile: 'edge',
      instanceId: adopted.instanceId,
      generation: 1,
      expectedActivationDigest: adopted.activationDigest,
      expectedPreparationDigest: prepared.preparationDigest,
      expectedAuthorizationDigest: authorized.authorizationDigest,
      expectedAuthorizationHeadDigest: authorized.instanceHeadDigest,
      requestedAtMs: Date.now(),
    },
  };
  const consumePath = path.join(root, 'owner-legacy-rollback-consume.json');
  writePrivate(
    consumePath,
    `${JSON.stringify(consumeCommand, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  const consumed = ownerCli(
    uid,
    gid,
    'service-legacy-rollback-consume',
    consumePath,
  );
  const outcome = JSON.parse(
    fs.readFileSync(
      localServiceManagerLegacyStartOutcomePath(root, adopted.cutoverId, 1),
      'utf8',
    ),
  );
  return { commandPath, result, replay, consumed, outcome };
}

function proveLegacyReadiness(
  root,
  adopted,
  consumed,
  uid,
  gid,
  legacyHttpPort,
) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.cutover.legacy-readiness-probe',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      cutoverId: adopted.cutoverId,
      profile: 'edge',
      instanceId: adopted.instanceId,
      generation: 1,
      expectedActivationDigest: adopted.activationDigest,
      expectedInstanceHeadDigest: consumed.instanceHeadDigest,
      expectedLegacyRunningRecordDigest: consumed.completionDigest,
      legacyHttpPort,
      expectedLegacyVersion: '2.21.0',
      requestedAtMs: Date.now(),
    },
  };
  const commandPath = path.join(root, 'owner-legacy-readiness-probe.json');
  writePrivate(
    commandPath,
    `${JSON.stringify(command, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  const result = ownerCli(
    uid,
    gid,
    'cutover-legacy-readiness-probe',
    commandPath,
  );
  const replay = ownerCli(
    uid,
    gid,
    'cutover-legacy-readiness-probe',
    commandPath,
  );
  return { commandPath, result, replay };
}

function executeLegacyRollbackBarrierCrash(
  root,
  controllerRoot,
  managerOptions,
  adopted,
  prepared,
  authorized,
  uid,
  gid,
) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.execute',
    options: {
      deploymentRoot: root,
      controllerRoot,
      allowRootController: true,
      manager: managerOptions,
    },
    request: {
      cutoverId: adopted.cutoverId,
      generation: 1,
      expectedAuthorizationDigest: authorized.authorizationDigest,
    },
  };
  const commandPath = path.join(
    root,
    'root-legacy-rollback-barrier-crash-command.json',
  );
  writePrivate(commandPath, `${JSON.stringify(command, null, 2)}\n`);
  let interrupted = false;
  try {
    runLocalServiceManagerLegacyRollbackBridgeCommandFile(commandPath, {
      afterBarrier() {
        throw new QingLong3ServiceManagerBridgeLiveActorError(
          'simulated crash after legacy start barrier',
        );
      },
    });
  } catch (error) {
    interrupted =
      error instanceof QingLong3ServiceManagerBridgeLiveActorError &&
      error.message === 'simulated crash after legacy start barrier';
  }
  if (!interrupted) fail('legacy start barrier crash was not observed');
  const result =
    runLocalServiceManagerLegacyRollbackBridgeCommandFile(commandPath);
  const replay =
    runLocalServiceManagerLegacyRollbackBridgeCommandFile(commandPath);
  const consumeCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.legacy-rollback.consume',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      cutoverId: adopted.cutoverId,
      profile: 'edge',
      instanceId: adopted.instanceId,
      generation: 1,
      expectedActivationDigest: adopted.activationDigest,
      expectedPreparationDigest: prepared.preparationDigest,
      expectedAuthorizationDigest: authorized.authorizationDigest,
      expectedAuthorizationHeadDigest: authorized.instanceHeadDigest,
      requestedAtMs: Date.now(),
    },
  };
  const consumePath = path.join(
    root,
    'owner-legacy-rollback-barrier-crash-consume.json',
  );
  writePrivate(
    consumePath,
    `${JSON.stringify(consumeCommand, null, 2)}\n`,
    0o600,
    uid,
    gid,
  );
  const consumed = ownerCli(
    uid,
    gid,
    'service-legacy-rollback-consume',
    consumePath,
  );
  const outcome = JSON.parse(
    fs.readFileSync(
      localServiceManagerLegacyStartOutcomePath(root, adopted.cutoverId, 1),
      'utf8',
    ),
  );
  return { commandPath, result, replay, consumed, outcome };
}

function execute(root, controllerRoot, managerOptions, prepared, uid, gid) {
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.execute',
    options: {
      controllerRoot,
      allowRootController: true,
      manager: managerOptions,
    },
    request: {
      intentPath: prepared.intentPath,
      expectedIntentDigest: prepared.intentDigest,
    },
  };
  const commandPath = path.join(root, `${prepared.actionId}.root-command.json`);
  writePrivate(commandPath, `${JSON.stringify(command, null, 2)}\n`);
  const result = runLocalServiceBridgeCommandFile(commandPath);
  const consumeCommand = {
    schemaVersion: 1,
    operation: 'local.deployment.service-manager.outcome.consume',
    options: { deploymentRoot: root, allowRootService: uid === 0 },
    request: {
      actionId: prepared.actionId,
      expectedIntentDigest: prepared.intentDigest,
    },
  };
  let consumed;
  if (uid === 0) {
    consumed = consumeLocalServiceManagerOutcome(consumeCommand);
  } else {
    const consumePath = path.join(
      root,
      `${prepared.actionId}.owner-consume.json`,
    );
    writePrivate(
      consumePath,
      `${JSON.stringify(consumeCommand, null, 2)}\n`,
      0o600,
      uid,
      gid,
    );
    consumed = ownerCli(uid, gid, 'service-outcome-consume', consumePath);
  }
  return { commandPath, result, consumed };
}

function serviceProcessUid(
  kind,
  outcome,
  expectedCommand = '/bin/sleep',
  expectedArguments = ['300'],
) {
  let pid = kind === 'systemd' ? outcome.observation.mainPid : 0;
  if (kind === 'openrc') {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const command = fs
          .readFileSync(`/proc/${entry}/cmdline`, 'utf8')
          .split('\0');
        if (
          command[0] === expectedCommand &&
          expectedArguments.every(
            (argument, index) => command[index + 1] === argument,
          )
        ) {
          pid = Number(entry);
          break;
        }
      } catch {
        // Processes can disappear during the bounded scan.
      }
    }
  }
  if (!Number.isSafeInteger(pid) || pid < 1) fail('service PID is unproved');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = /^Uid:\s+(\d+)\s/m.exec(status);
  if (!match) fail('service process UID is unavailable');
  return Number(match[1]);
}

function cleanup(kind, managerOptions) {
  if (kind === 'systemd') {
    for (const serviceName of ['qinglong', 'qinglong3']) {
      spawnSync(
        managerOptions.executable,
        ['disable', '--now', `${serviceName}.service`],
        { timeout: 10_000 },
      );
      fs.rmSync(`/etc/systemd/system/${serviceName}.service`, { force: true });
    }
    spawnSync(managerOptions.executable, ['daemon-reload'], {
      timeout: 10_000,
    });
    return;
  }
  for (const serviceName of ['qinglong', 'qinglong3']) {
    spawnSync(managerOptions.serviceExecutable, [serviceName, 'stop'], {
      timeout: 10_000,
    });
    spawnSync(
      managerOptions.updateExecutable,
      ['del', serviceName, 'default'],
      { timeout: 10_000 },
    );
    fs.rmSync(`/etc/init.d/${serviceName}`, { force: true });
  }
}

async function main(argv) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    fail('live actor must run as root');
  }
  const kind = argv[0];
  const identityMode = argv[1];
  const scenario = argv[2] ?? 'success';
  if (
    (kind !== 'systemd' && kind !== 'openrc') ||
    (identityMode !== 'root' && identityMode !== 'nonroot') ||
    (scenario !== 'success' && scenario !== 'barrier-crash')
  ) {
    fail(
      'usage: ql3-service-manager-bridge-live-actor.cjs <systemd|openrc> <root|nonroot> [success|barrier-crash]',
    );
  }
  const uid = identityMode === 'root' ? 0 : NON_ROOT_SERVICE_UID;
  const gid = uid;
  const legacyHttpPort = 15_700;
  const root = `/var/lib/ql3-service-manager-${kind}-${identityMode}`;
  const controllerRoot = `/var/lib/ql3-service-bridge-${kind}-${identityMode}`;
  fs.rmSync(root, { force: true, recursive: true });
  fs.rmSync(controllerRoot, { force: true, recursive: true });
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'service'), { mode: 0o700 });
  fs.chownSync(root, uid, gid);
  fs.chownSync(path.join(root, 'service'), uid, gid);
  writePrivate(
    path.join(root, 'local-application.json'),
    `${JSON.stringify({
      schema: 'qinglong/local-application-process@v2',
      instanceId: `${kind}-${identityMode}-live-edge`,
      profile: 'edge',
      storage: { mode: 'fresh' },
    })}\n`,
    0o600,
    uid,
    gid,
  );
  writePrivate(
    path.join(
      root,
      'service',
      kind === 'systemd' ? 'qinglong3.service' : 'qinglong3.openrc',
    ),
    descriptor(kind, uid, gid),
    kind === 'systemd' ? 0o600 : 0o700,
    uid,
    gid,
  );
  const managerOptions = manager(kind);
  try {
    const install = prepare(root, kind, '01', 'install-enable-start', uid, gid);
    const installed = execute(
      root,
      controllerRoot,
      managerOptions,
      install,
      uid,
      gid,
    );
    if (
      installed.result.state !== 'active' ||
      installed.consumed.state !== 'active'
    ) {
      fail(
        `install-enable-start did not prove active: ${JSON.stringify(
          installed,
        )} outcome=${fs.readFileSync(install.outcomePath, 'utf8').trim()}`,
      );
    }
    const installedOutcome = JSON.parse(
      fs.readFileSync(install.outcomePath, 'utf8'),
    );
    const installedUid = serviceProcessUid(kind, installedOutcome);
    if (installedUid !== uid) {
      fail(`installed service process UID drifted: ${installedUid} != ${uid}`);
    }
    const replay = runLocalServiceBridgeCommandFile(installed.commandPath);
    if (replay.status !== 'existing' || replay.state !== 'active') {
      fail('exact replay did not reuse the durable outcome');
    }
    const restartRequired = kind !== 'openrc' || identityMode === 'root';
    let restarted;
    if (restartRequired) {
      const restart = prepare(root, kind, '02', 'restart', uid, gid);
      restarted = execute(
        root,
        controllerRoot,
        managerOptions,
        restart,
        uid,
        gid,
      );
      if (
        restarted.result.state !== 'active' ||
        restarted.consumed.state !== 'active'
      ) {
        fail('restart did not prove active');
      }
      const restartedOutcome = JSON.parse(
        fs.readFileSync(restart.outcomePath, 'utf8'),
      );
      const restartedUid = serviceProcessUid(kind, restartedOutcome);
      if (restartedUid !== uid) {
        fail(
          `restarted service process UID drifted: ${restartedUid} != ${uid}`,
        );
      }
    }
    const stop = prepare(root, kind, '03', 'stop', uid, gid);
    const stopped = execute(
      root,
      controllerRoot,
      managerOptions,
      stop,
      uid,
      gid,
    );
    if (
      stopped.result.state !== 'stopped' ||
      stopped.consumed.state !== 'stopped'
    ) {
      fail('stop did not prove stopped');
    }
    cleanup(kind, managerOptions);
    const adopted = adoptedFixture(root, kind, uid, gid);
    const adoptedStart = prepare(
      root,
      kind,
      '11',
      'install-enable-start',
      uid,
      gid,
      {
        mode: 'adopted',
        cutoverId: adopted.cutoverId,
        generation: 1,
        expectedActivationDigest: adopted.activationDigest,
        previousRecordDigest: adopted.commitmentDigest,
      },
    );
    const adoptedStarted = execute(
      root,
      controllerRoot,
      managerOptions,
      adoptedStart,
      uid,
      gid,
    );
    const adoptedActive = await consumeCutover(root, adoptedStart, uid, gid);
    if (
      adoptedStarted.result.state !== 'active' ||
      adoptedActive.state !== 'target_active'
    ) {
      fail('adopted service did not commit target_active');
    }
    const adoptedStop = prepare(root, kind, '13', 'stop', uid, gid, {
      mode: 'adopted',
      cutoverId: adopted.cutoverId,
      generation: 1,
      expectedActivationDigest: adopted.activationDigest,
      previousRecordDigest: adoptedActive.recordDigest,
    });
    const adoptedStoppedManager = execute(
      root,
      controllerRoot,
      managerOptions,
      adoptedStop,
      uid,
      gid,
    );
    const adoptedStopped = await consumeCutover(root, adoptedStop, uid, gid);
    if (
      adoptedStoppedManager.result.state !== 'stopped' ||
      adoptedStopped.state !== 'target_stopped'
    ) {
      fail('adopted service did not commit target_stopped');
    }
    const adoptedRollback = prepareAdoptedRollback(
      root,
      adopted,
      adoptedStopped,
      uid,
      gid,
    );
    const adoptedRollbackReplay = ownerCli(
      uid,
      gid,
      'service-legacy-rollback-prepare',
      adoptedRollback.commandPath,
    );
    if (
      adoptedRollback.result.status !== 'prepared' ||
      adoptedRollback.result.state !== 'rollback_prepared' ||
      adoptedRollback.result.rollbackDisposition !== 'rollback_candidate' ||
      adoptedRollbackReplay.status !== 'existing' ||
      adoptedRollbackReplay.preparationDigest !==
        adoptedRollback.result.preparationDigest
    ) {
      fail('adopted rollback preparation did not converge exactly');
    }
    const adoptedAuthorization = authorizeAdoptedRollback(
      root,
      adopted,
      adoptedRollback.result,
      uid,
      gid,
    );
    const adoptedAuthorizationReplay = ownerCli(
      uid,
      gid,
      'service-legacy-rollback-authorize',
      adoptedAuthorization.commandPath,
    );
    if (
      adoptedAuthorization.result.status !== 'prepared' ||
      adoptedAuthorization.result.state !== 'legacy_restart_requested' ||
      adoptedAuthorizationReplay.status !== 'existing' ||
      adoptedAuthorizationReplay.authorizationDigest !==
        adoptedAuthorization.result.authorizationDigest
    ) {
      fail('adopted rollback authorization did not converge exactly');
    }
    installLegacyService(kind, managerOptions, uid, gid, legacyHttpPort);
    const adoptedLegacyStarted =
      scenario === 'success'
        ? executeLegacyRollback(
            root,
            controllerRoot,
            managerOptions,
            adopted,
            adoptedRollback.result,
            adoptedAuthorization.result,
            uid,
            gid,
          )
        : executeLegacyRollbackBarrierCrash(
            root,
            controllerRoot,
            managerOptions,
            adopted,
            adoptedRollback.result,
            adoptedAuthorization.result,
            uid,
            gid,
          );
    let adoptedLegacyReadiness;
    if (scenario === 'success') {
      if (
        adoptedLegacyStarted.result.state !== 'legacy_running' ||
        adoptedLegacyStarted.replay.status !== 'existing' ||
        adoptedLegacyStarted.replay.state !== 'legacy_running' ||
        adoptedLegacyStarted.consumed.state !== 'legacy_running' ||
        adoptedLegacyStarted.outcome.mutationDisposition !==
          'response-loss-inspected' ||
        adoptedLegacyStarted.outcome.targetObservation.activeState !==
          'inactive' ||
        adoptedLegacyStarted.outcome.legacyObservation.activeState !== 'active'
      ) {
        fail('adopted legacy rollback did not converge to legacy_running');
      }
      const legacyUid = serviceProcessUid(
        kind,
        {
          observation: adoptedLegacyStarted.outcome.legacyObservation,
        },
        fs.realpathSync(process.execPath),
        [
          '/workspace/scripts/ql3-service-manager-legacy-live-service.cjs',
          String(legacyHttpPort),
        ],
      );
      if (legacyUid !== uid) {
        fail(`legacy service process UID drifted: ${legacyUid} != ${uid}`);
      }
      adoptedLegacyReadiness = proveLegacyReadiness(
        root,
        adopted,
        adoptedLegacyStarted.consumed,
        uid,
        gid,
        legacyHttpPort,
      );
      if (
        adoptedLegacyReadiness.result.status !== 'prepared' ||
        adoptedLegacyReadiness.result.state !== 'legacy_ready' ||
        adoptedLegacyReadiness.replay.status !== 'existing' ||
        adoptedLegacyReadiness.replay.state !== 'legacy_ready' ||
        adoptedLegacyReadiness.replay.receiptDigest !==
          adoptedLegacyReadiness.result.receiptDigest ||
        adoptedLegacyReadiness.replay.instanceHeadDigest !==
          adoptedLegacyReadiness.result.instanceHeadDigest
      ) {
        fail('legacy readiness proof did not converge exactly');
      }
    } else if (
      adoptedLegacyStarted.result.state !== 'manual_required' ||
      adoptedLegacyStarted.result.status !== 'prepared' ||
      adoptedLegacyStarted.replay.status !== 'existing' ||
      adoptedLegacyStarted.replay.state !== 'manual_required' ||
      adoptedLegacyStarted.consumed.state !== 'manual_required' ||
      adoptedLegacyStarted.outcome.mutationDisposition !== 'replay-inspected' ||
      adoptedLegacyStarted.outcome.manualReason !== 'manager_state_unproved' ||
      adoptedLegacyStarted.outcome.targetObservation.activeState !==
        'inactive' ||
      adoptedLegacyStarted.outcome.legacyObservation.activeState !== 'inactive'
    ) {
      fail('legacy barrier replay did not fail closed without a second start');
    }
    const payload = {
      schemaVersion: 1,
      evidenceClass: 'qinglong3_service_manager_bridge_live_actor',
      managerKind: kind,
      identityMode,
      scenario,
      serviceUid: uid,
      manager: managerOptions,
      actions: [
        installed.result,
        replay,
        ...(restarted ? [restarted.result] : []),
        stopped.result,
      ],
      adoptedCutover: {
        active: adoptedActive,
        stopped: adoptedStopped,
        rollbackPrepared: adoptedRollback.result,
        rollbackReplay: adoptedRollbackReplay,
        rollbackAuthorized: adoptedAuthorization.result,
        rollbackAuthorizationReplay: adoptedAuthorizationReplay,
        legacyStarted: adoptedLegacyStarted.result,
        legacyStartReplay: adoptedLegacyStarted.replay,
        legacyConsumed: adoptedLegacyStarted.consumed,
        legacyReadiness: adoptedLegacyReadiness?.result ?? null,
        legacyReadinessReplay: adoptedLegacyReadiness?.replay ?? null,
      },
      gates: {
        rootCommandFile: true,
        descriptorInstalled: true,
        enabledAndStarted: true,
        exactReplay: true,
        restartRequired,
        restarted: restarted !== undefined,
        stopped: true,
        ownerOutcomeVerified: true,
        serviceProcessIdentity: true,
        adoptedCutoverActive: true,
        adoptedCutoverStopped: true,
        adoptedRollbackPrepared: true,
        adoptedRollbackReplay: true,
        adoptedRollbackCandidate: true,
        adoptedRollbackAuthorized: true,
        adoptedRollbackAuthorizationReplay: true,
        adoptedLegacyStarted: scenario === 'success',
        adoptedLegacyStartReplay: true,
        adoptedLegacyConsumed: true,
        adoptedTargetRemainedStopped: true,
        adoptedLegacyProcessIdentity: scenario === 'success',
        adoptedLegacyResponseLossInspected: scenario === 'success',
        adoptedLegacyReady: scenario === 'success',
        adoptedLegacyReadinessReplay: scenario === 'success',
        adoptedLegacyBarrierCrash: scenario === 'barrier-crash',
        adoptedLegacyInspectOnlyConvergence: scenario === 'barrier-crash',
        adoptedLegacyRemainedStopped: scenario === 'barrier-crash',
        adoptedLegacyManualConsumed: scenario === 'barrier-crash',
      },
    };
    process.stdout.write(
      `${JSON.stringify({
        ...payload,
        sha256: crypto
          .createHash('sha256')
          .update(JSON.stringify(payload))
          .digest('hex'),
      })}\n`,
    );
  } finally {
    cleanup(kind, managerOptions);
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(controllerRoot, { force: true, recursive: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      code: 'QL3_SERVICE_MANAGER_BRIDGE_LIVE_ACTOR_FAILED',
      name: error?.name ?? 'Error',
      message: error?.message ?? 'live actor failed',
    })}\n`,
  );
  process.exitCode = 1;
});
