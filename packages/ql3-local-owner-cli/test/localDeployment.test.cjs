const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  applyLocalDeploymentCompose,
  collectLocalDeploymentComposeEvidence,
  inspectLocalDeploymentStatus,
  LocalDeploymentConfigurationError,
  preflightLocalDeploymentCompose,
  prepareLocalDeployment,
  restoreLocalDeploymentCompose,
  stopLegacyDockerForLocalDeployment,
  switchLocalDeploymentComposeRevision,
} = require('../dist/deployment/localDeployment.js');
const {
  createLocalSqliteRolloutBackup,
} = require('../../ql3-local-sqlite/dist/readiness/rolloutSafety.js');

function rootAcknowledgement() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function fixture(t, kind = 'systemd') {
  const managementRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-deployment-')),
  );
  fs.chmodSync(managementRoot, 0o700);
  t.after(() => fs.rmSync(managementRoot, { recursive: true, force: true }));
  const deploymentRoot = path.join(managementRoot, 'runtime');
  const applicationEntrypoint = fs.realpathSync(
    path.resolve(__dirname, '../../ql3-local-application/dist/cli.js'),
  );
  const service =
    kind === 'compose'
      ? {
          kind,
          image: `registry.example/qinglong3-local@sha256:${'a'.repeat(64)}`,
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
    operation: 'local.deployment.prepare',
    options: {
      deploymentRoot,
      profile: 'edge',
      instanceId: 'edge-router-1',
      busyTimeoutMs: 100,
      service,
    },
    request: {
      ownerPepperKeyId: 'owner-v1',
      registerMutationId: '00000000-0000-4000-8000-000000000d01',
      activateMutationId: '00000000-0000-4000-8000-000000000d02',
      registeredAtMs: 2_000,
      activatedAtMs: 2_001,
    },
  };
  const commandFilePath = path.join(managementRoot, 'deployment.json');
  fs.writeFileSync(commandFilePath, `${JSON.stringify(command)}\n`, {
    mode: 0o600,
  });
  return { command, commandFilePath, deploymentRoot, managementRoot };
}

function mode(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function legacyStopCommand(state, cutoverId = 'cutover-edge-1') {
  const activationPath = path.join(state.managementRoot, 'activation.json');
  const legacySourcePath = path.join(state.managementRoot, 'database.sqlite');
  fs.writeFileSync(legacySourcePath, 'legacy-source\n', { mode: 0o600 });
  const payload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-sqlite-activation',
    state: 'prepared',
    profile: 'edge',
    createdAtMs: 1_000,
    adoptionManifestDigest: '1'.repeat(64),
    planDigest: '2'.repeat(64),
    sourcePathDigest: crypto
      .createHash('sha256')
      .update(path.resolve(legacySourcePath), 'utf8')
      .digest('hex'),
    recoverySha256: '4'.repeat(64),
    targetSha256: '5'.repeat(64),
    targetPathDigest: '6'.repeat(64),
    targetDevice: '1',
    targetInode: '2',
  };
  const activationDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  fs.writeFileSync(
    activationPath,
    `${JSON.stringify({ ...payload, activationDigest })}\n`,
    { mode: 0o600 },
  );
  return {
    schemaVersion: 1,
    operation: 'local.deployment.cutover.legacy-stop',
    options: {
      deploymentRoot: state.deploymentRoot,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
      allowRootService: rootAcknowledgement(),
    },
    request: {
      cutoverId,
      profile: 'edge',
      instanceId: 'edge-router-1',
      activationPath,
      legacySourcePath,
      expectedLegacyDatabasePath: '/ql/data/database.sqlite',
      expectedActivationDigest: activationDigest,
      expectedLegacyContainerId: '7'.repeat(64),
      requestedAtMs: 2_000,
    },
  };
}

function composeRevisionCommand(state, operation, request) {
  return {
    schemaVersion: 1,
    operation,
    options: {
      deploymentRoot: state.deploymentRoot,
      allowRootService: rootAcknowledgement(),
    },
    request,
  };
}

function composeApplyCommand(state, expectedGeneration, suffix = '51') {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.compose.apply',
    options: {
      deploymentRoot: state.deploymentRoot,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath: path.join(state.managementRoot, 'docker.sock'),
      allowRootService: rootAcknowledgement(),
    },
    request: {
      expectedGeneration,
      rolloutId: `00000000-0000-4000-8000-000000000d${suffix}`,
      startedAtMs: 7_000,
      failureRollbackMutationId: `00000000-0000-4000-8000-000000000e${suffix}`,
      failureRollbackChangedAtMs: 7_001,
    },
  };
}

function deploymentStatusCommand(state) {
  return {
    schemaVersion: 1,
    operation: 'local.deployment.status',
    options: {
      deploymentRoot: state.deploymentRoot,
      allowRootService: rootAcknowledgement(),
    },
  };
}

function composeRestoreCommands(state, failedCommand, suffix = '71') {
  const options = {
    deploymentRoot: state.deploymentRoot,
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
        preparedAtMs: 8_000,
      },
    },
    commit: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.restore.commit',
      options,
      request: {
        expectedGeneration: failedCommand.request.expectedGeneration + 1,
        restoreId,
        committedAtMs: 8_001,
      },
    },
  };
}

function composeEvidenceCollectionCommands(
  state,
  expectedGeneration,
  rolloutIds,
  restoreIds = [],
  suffix = '91',
) {
  const options = {
    deploymentRoot: state.deploymentRoot,
    allowRootService: rootAcknowledgement(),
  };
  const collectionId = `00000000-0000-4000-8000-000000000d${suffix}`;
  return {
    prepare: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.evidence-collection.prepare',
      options,
      request: {
        expectedGeneration,
        collectionId,
        rolloutIds,
        restoreIds,
        preparedAtMs: 9_000,
      },
    },
    commit: {
      schemaVersion: 1,
      operation: 'local.deployment.compose.evidence-collection.commit',
      options,
      request: {
        expectedGeneration,
        collectionId,
        committedAtMs: 9_001,
      },
    },
  };
}

async function createFailedRollbackRestoreState(state, suffix = '61') {
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'f'.repeat(64)}`,
      mutationId: `00000000-0000-4000-8000-000000000d${suffix}`,
      changedAtMs: 6_900,
    }),
  );
  const failedCommand = composeApplyCommand(state, 2, suffix);
  const intent = `${JSON.stringify(failedCommand, null, 2)}\n`;
  fs.writeFileSync(
    path.join(state.deploymentRoot, 'service', '.compose-rollout.lock'),
    intent,
    { mode: 0o600 },
  );
  await createLocalSqliteRolloutBackup({
    databasePath: path.join(state.deploymentRoot, 'qinglong3.sqlite'),
    backupPath: path.join(
      state.deploymentRoot,
      'service',
      'rollout-backups',
      `${failedCommand.request.rolloutId}.sqlite`,
    ),
    profile: 'edge',
  });
  const writer = new DatabaseSync(
    path.join(state.deploymentRoot, 'qinglong3.sqlite'),
  );
  writer.exec('PRAGMA user_version = 987');
  writer.close();
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.rollback', {
      expectedGeneration: 2,
      targetGeneration: 1,
      mutationId: failedCommand.request.failureRollbackMutationId,
      changedAtMs: failedCommand.request.failureRollbackChangedAtMs,
    }),
    intent,
  );
  return failedCommand;
}

function composeSelection({
  generation,
  previousGeneration,
  rollbackTargetGeneration,
  mutationId,
  changedAtMs,
  image,
}) {
  return [
    'x-qinglong-image-selection:',
    '  schema: qinglong/local-compose-image-selection@v1',
    `  generation: ${generation}`,
    `  previous_generation: ${previousGeneration}`,
    `  rollback_target_generation: ${rollbackTargetGeneration}`,
    `  mutation_id: ${mutationId}`,
    `  changed_at_ms: ${changedAtMs}`,
    'services:',
    '  qinglong3:',
    `    image: ${image}`,
    '    labels:',
    `      io.qinglong.deployment.generation: "${generation}"`,
    `      io.qinglong.deployment.mutation: "${mutationId}"`,
    '',
  ].join('\n');
}

function composeDockerHarness(
  state,
  unhealthyGenerations = new Set(),
  writeGenerations = new Set(),
) {
  const calls = [];
  const containerId = '1'.repeat(64);
  const serviceRoot = path.join(state.deploymentRoot, 'service');
  const application = JSON.parse(
    fs.readFileSync(
      path.join(state.deploymentRoot, 'local-application.json'),
      'utf8',
    ),
  );
  const current = () => {
    const source = fs.readFileSync(
      path.join(serviceRoot, 'compose.image.yaml'),
      'utf8',
    );
    return {
      generation: Number(/^  generation: ([0-9]+)$/m.exec(source)[1]),
      mutationId: /^  mutation_id: ([0-9a-f-]+)$/m.exec(source)[1],
      image: /^    image: ([^\n]+)$/m.exec(source)[1],
    };
  };
  const composeSource = fs.readFileSync(
    path.join(serviceRoot, 'compose.yaml'),
    'utf8',
  );
  const projectName = /^name: ([a-z0-9_-]+)$/m.exec(composeSource)[1];
  let running = true;
  const runDocker = ({ args }) => {
    calls.push(args);
    const selected = current();
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
              'io.qinglong.local.sqlite-contract-min': '45',
              'io.qinglong.local.sqlite-contract-max': '45',
              'io.qinglong.local.sqlite-write-contract': '45',
              'io.qinglong.local.application-config': '2',
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
      return JSON.stringify({
        name: projectName,
        services: {
          qinglong3: {
            image: selected.image,
            user: `${process.getuid()}:${process.getgid()}`,
            read_only: true,
            network_mode: 'none',
            restart: 'unless-stopped',
            mem_limit: 128 * 1024 * 1024,
            pids_limit: 64,
            cap_drop: ['ALL'],
            security_opt: ['no-new-privileges:true'],
            command: ['--config', '/var/lib/qinglong3/local-application.json'],
            labels: {
              'io.qinglong.deployment.generation': String(selected.generation),
              'io.qinglong.deployment.mutation': selected.mutationId,
            },
            volumes: [
              {
                type: 'bind',
                source: state.deploymentRoot,
                target: '/var/lib/qinglong3',
              },
            ],
            tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=16m'],
          },
        },
      });
    }
    if (
      args[0] === 'compose' &&
      args.includes('up') &&
      writeGenerations.has(selected.generation)
    ) {
      const writer = new DatabaseSync(
        path.join(state.deploymentRoot, 'qinglong3.sqlite'),
      );
      writer.exec(`PRAGMA user_version = ${selected.generation}`);
      writer.close();
    }
    if (args[0] === 'compose' && args.includes('up')) running = true;
    if (args[0] === 'compose' && args.includes('stop')) running = false;
    if (args[0] === 'compose' && args.includes('ps')) return `${containerId}\n`;
    if (args[0] === 'container' && args[1] === 'inspect') {
      return JSON.stringify([
        {
          Id: containerId,
          State: {
            Running: running,
            Status: running ? 'running' : 'exited',
          },
          Config: {
            Image: selected.image,
            Labels: {
              'io.qinglong.deployment.generation': String(selected.generation),
              'io.qinglong.deployment.mutation': selected.mutationId,
            },
          },
          HostConfig: {
            ReadonlyRootfs: true,
            NetworkMode: 'none',
            Privileged: false,
          },
        },
      ]);
    }
    if (args[0] === 'container' && args[1] === 'logs') {
      if (unhealthyGenerations.has(selected.generation)) return '';
      return `${JSON.stringify({
        schemaVersion: 1,
        component: 'qinglong3-local-application',
        level: 'info',
        event: 'active',
        instanceId: application.instanceId,
        profile: application.profile,
        aiStatus: 'deployment_excluded',
      })}\n`;
    }
    return '';
  };
  let time = 10_000;
  return {
    calls,
    runDocker,
    now() {
      time += 31_000;
      return time;
    },
    async wait() {},
  };
}

test('prepares and exactly replays a systemd fresh deployment', async (t) => {
  const state = fixture(t);
  const prepared = await prepareLocalDeployment(state.command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.profile, 'edge');
  assert.equal(prepared.service.kind, 'systemd');
  assert.equal(prepared.service.status, 'prepared');
  assert.equal(prepared.applicationConfiguration.status, 'prepared');
  assert.equal(prepared.directories.created, 8);
  assert.equal(prepared.setup.status, 'prepared');

  const replay = await prepareLocalDeployment(state.command);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.directories.created, 0);
  assert.equal(replay.directories.existing, 8);
  assert.equal(replay.setup.status, 'existing');
  assert.equal(replay.service.status, 'existing');

  for (const directory of [
    state.deploymentRoot,
    'owner-peppers',
    'owner-pepper-backup',
    'receipts',
    'artifacts',
    'plugin-staging',
    'plugin-activation',
    'service',
  ]) {
    const target =
      directory === state.deploymentRoot
        ? directory
        : path.join(state.deploymentRoot, directory);
    assert.equal(mode(target), 0o700);
  }
  const applicationConfigPath = path.join(
    state.deploymentRoot,
    'local-application.json',
  );
  const unitPath = path.join(
    state.deploymentRoot,
    'service',
    'qinglong3.service',
  );
  assert.equal(mode(applicationConfigPath), 0o600);
  assert.equal(mode(unitPath), 0o600);
  const applicationConfig = JSON.parse(
    fs.readFileSync(applicationConfigPath, 'utf8'),
  );
  assert.equal(applicationConfig.storage.mode, 'fresh');
  assert.equal(
    applicationConfig.storage.databasePath,
    path.join(state.deploymentRoot, 'qinglong3.sqlite'),
  );
  assert.equal(applicationConfig.ai.deployment, 'excluded');
  const unit = fs.readFileSync(unitPath, 'utf8');
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^MemoryMax=128M$/m);
  assert.match(unit, /^TasksMax=64$/m);
  assert.match(unit, / --config .*local-application\.json$/m);

  const database = new DatabaseSync(
    path.join(state.deploymentRoot, 'qinglong3.sqlite'),
    { readonly: true },
  );
  assert.equal(
    database.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  database.close();
  const serialized = JSON.stringify([prepared, replay]);
  assert.equal(serialized.includes(state.deploymentRoot), false);
  assert.equal(/digest|material|token|image/i.test(serialized), false);
});

test('durably stops one exact legacy Docker owner before publishing commitment', async (t) => {
  const state = fixture(t);
  await prepareLocalDeployment(state.command);
  const command = legacyStopCommand(state);
  const calls = [];
  const dependencies = {
    validateSocket() {},
    runDocker({ args }) {
      calls.push(args);
      if (args[1] !== 'inspect')
        return `${command.request.expectedLegacyContainerId}\n`;
      return JSON.stringify([
        {
          Id: command.request.expectedLegacyContainerId,
          Created: '2026-08-09T00:00:00.000000000Z',
          Name: '/qinglong-legacy',
          State: {
            Running: false,
            Restarting: false,
            Paused: false,
            Pid: 0,
            Status: 'exited',
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
    },
  };
  const prepared = stopLegacyDockerForLocalDeployment(command, dependencies);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.state, 'legacy_stopped');
  assert.match(prepared.commitmentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [
      ['container', 'update', '--restart'],
      ['container', 'stop', '--time'],
      ['container', 'inspect', command.request.expectedLegacyContainerId],
    ],
  );
  const journal = path.join(
    state.deploymentRoot,
    'service',
    'cutovers',
    command.request.cutoverId,
  );
  const commitmentPath = path.join(journal, '0002-legacy-stopped.json');
  assert.equal(mode(journal), 0o700);
  assert.equal(
    mode(path.join(journal, '0001-legacy-stop-requested.json')),
    0o600,
  );
  assert.equal(mode(commitmentPath), 0o600);
  const commitment = JSON.parse(fs.readFileSync(commitmentPath, 'utf8'));
  assert.equal(
    commitment.activationDigest,
    command.request.expectedActivationDigest,
  );
  assert.equal(
    commitment.controller.legacyContainerId,
    command.request.expectedLegacyContainerId,
  );
  assert.match(
    commitment.controller.legacySourceBindingDigest,
    /^[0-9a-f]{64}$/,
  );
  assert.equal(commitment.commitmentDigest, prepared.commitmentDigest);

  const replayCalls = [];
  const replay = stopLegacyDockerForLocalDeployment(command, {
    validateSocket() {
      throw new Error('existing commitment must not reopen Docker authority');
    },
    runDocker(request) {
      replayCalls.push(request);
      throw new Error('existing commitment must not repeat stop');
    },
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.commitmentDigest, prepared.commitmentDigest);
  assert.deepEqual(replayCalls, []);
});

test('keeps the target commitment absent when legacy silence is not proven', async (t) => {
  const state = fixture(t);
  await prepareLocalDeployment(state.command);
  const command = legacyStopCommand(state, 'cutover-running-legacy');
  assert.throws(
    () =>
      stopLegacyDockerForLocalDeployment(command, {
        validateSocket() {},
        runDocker({ args }) {
          if (args[1] !== 'inspect') return 'ok\n';
          return JSON.stringify([
            {
              Id: command.request.expectedLegacyContainerId,
              Created: '2026-08-09T00:00:00.000000000Z',
              Name: '/qinglong-legacy',
              State: {
                Running: true,
                Restarting: false,
                Paused: false,
                Pid: 42,
                Status: 'running',
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
        },
      }),
    LocalDeploymentConfigurationError,
  );
  const journal = path.join(
    state.deploymentRoot,
    'service',
    'cutovers',
    command.request.cutoverId,
  );
  assert.equal(
    fs.existsSync(path.join(journal, '0001-legacy-stop-requested.json')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(journal, '0002-legacy-stopped.json')),
    false,
  );

  const wrongMount = legacyStopCommand(state, 'cutover-wrong-source-mount');
  assert.throws(
    () =>
      stopLegacyDockerForLocalDeployment(wrongMount, {
        validateSocket() {},
        runDocker({ args }) {
          if (args[1] !== 'inspect') return 'ok\n';
          return JSON.stringify([
            {
              Id: wrongMount.request.expectedLegacyContainerId,
              Created: '2026-08-09T00:00:00.000000000Z',
              Name: '/qinglong-legacy',
              State: {
                Running: false,
                Restarting: false,
                Paused: false,
                Pid: 0,
                Status: 'exited',
              },
              Config: { Image: 'whyour/qinglong:2.17.17' },
              HostConfig: { RestartPolicy: { Name: 'no' } },
              Mounts: [
                {
                  Type: 'bind',
                  Source: path.join(state.managementRoot, 'unrelated'),
                  Destination: '/ql/data',
                  RW: true,
                },
              ],
            },
          ]);
        },
      }),
    LocalDeploymentConfigurationError,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        state.deploymentRoot,
        'service',
        'cutovers',
        wrongMount.request.cutoverId,
        '0002-legacy-stopped.json',
      ),
    ),
    false,
  );
});

test('observes durable process deployment state without claiming runtime health', async (t) => {
  const state = fixture(t);
  await prepareLocalDeployment(state.command);

  const observed = inspectLocalDeploymentStatus(deploymentStatusCommand(state));
  assert.deepEqual(observed, {
    schemaVersion: 1,
    operation: 'local.deployment.status',
    status: 'observed',
    observation: 'durable',
    profile: 'edge',
    applicationConfiguration: {
      schema: 'qinglong/local-application-process@v2',
      state: 'present',
    },
    runtime: { health: 'unobserved' },
    service: {
      kind: 'systemd',
      descriptor: 'present',
    },
  });
});

test('observes Compose generation and recovery fences with low constant work', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);

  const stable = inspectLocalDeploymentStatus(deploymentStatusCommand(state));
  assert.equal(stable.service.kind, 'compose');
  assert.equal(stable.service.generation, 1);
  assert.equal(stable.service.rollbackTargetGeneration, null);
  assert.equal(stable.service.transition, 'stable');
  assert.deepEqual(stable.service.fences, {
    revision: 'idle',
    rollout: 'idle',
    restore: 'idle',
    evidenceCollection: 'idle',
  });

  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'b'.repeat(64)}`,
      mutationId: '00000000-0000-4000-8000-000000000d31',
      changedAtMs: 6_000,
    }),
  );
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.rollback', {
      expectedGeneration: 2,
      targetGeneration: 1,
      mutationId: '00000000-0000-4000-8000-000000000d32',
      changedAtMs: 6_001,
    }),
  );
  const rolledBack = inspectLocalDeploymentStatus(
    deploymentStatusCommand(state),
  );
  assert.equal(rolledBack.service.generation, 3);
  assert.equal(rolledBack.service.rollbackTargetGeneration, 1);

  fs.writeFileSync(
    path.join(state.deploymentRoot, 'service', '.compose-rollout.lock'),
    '{}\n',
    { mode: 0o600 },
  );
  const fenced = inspectLocalDeploymentStatus(deploymentStatusCommand(state));
  assert.equal(fenced.service.transition, 'recovery_required');
  assert.equal(fenced.service.fences.rollout, 'in_flight');
  assert.equal(fenced.runtime.health, 'unobserved');
});

test('status CLI is private-command-only and emits no deployment authority', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const commandPath = path.join(state.managementRoot, 'status.json');
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify(deploymentStatusCommand(state))}\n`,
    { mode: 0o600 },
  );
  const cli = path.resolve(
    __dirname,
    '../dist/deployment/localDeploymentCli.js',
  );
  const observed = spawnSync(
    process.execPath,
    [cli, 'status', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(observed.stderr, '');
  const result = JSON.parse(observed.stdout);
  assert.equal(result.operation, 'local.deployment.status');
  assert.equal(result.observation, 'durable');
  assert.equal(result.service.generation, 1);
  assert.equal(observed.stdout.includes(state.deploymentRoot), false);
  assert.equal(
    /sha256|registry|mutation|instanceId/i.test(observed.stdout),
    false,
  );

  fs.chmodSync(commandPath, 0o644);
  const rejected = spawnSync(
    process.execPath,
    [cli, 'status', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr.includes(state.deploymentRoot), false);
});

test('durable status keeps live supervisor and database authority out of its module', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/deployment/localDeploymentStatus.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /@qinglong\/local-sqlite|node:child_process|from ['"]\.\/docker['"]|spawnSync|execFile/,
  );
});

test('renders bounded OpenRC and immutable rootless Compose descriptors', async (t) => {
  const openrc = fixture(t, 'openrc');
  const openrcResult = await prepareLocalDeployment(openrc.command);
  assert.equal(openrcResult.service.kind, 'openrc');
  const openrcPath = path.join(
    openrc.deploymentRoot,
    'service',
    'qinglong3.openrc',
  );
  assert.equal(mode(openrcPath), 0o700);
  const openrcSource = fs.readFileSync(openrcPath, 'utf8');
  assert.match(openrcSource, /^supervisor="supervise-daemon"$/m);
  assert.match(openrcSource, /^retry="TERM\/30\/KILL\/5"$/m);
  assert.match(openrcSource, /^umask=0077$/m);

  const compose = fixture(t, 'compose');
  const composeResult = await prepareLocalDeployment(compose.command);
  assert.equal(composeResult.service.kind, 'compose');
  const composePath = path.join(
    compose.deploymentRoot,
    'service',
    'compose.yaml',
  );
  assert.equal(mode(composePath), 0o600);
  const source = fs.readFileSync(composePath, 'utf8');
  assert.match(source, /^name: ql3-edge-router-1-[0-9a-f]{12}$/m);
  assert.doesNotMatch(source, /^    image:/m);
  assert.match(source, /^    read_only: true$/m);
  assert.match(source, /^    network_mode: none$/m);
  assert.match(source, /^      - ALL$/m);
  assert.match(source, /^      - no-new-privileges:true$/m);
  assert.match(source, /^    mem_limit: 128m$/m);
  const selectionPath = path.join(
    compose.deploymentRoot,
    'service',
    'compose.image.yaml',
  );
  const revisionPath = path.join(
    compose.deploymentRoot,
    'service',
    'revisions',
    '1.yaml',
  );
  assert.equal(mode(selectionPath), 0o600);
  assert.equal(mode(revisionPath), 0o600);
  assert.equal(
    fs.readFileSync(selectionPath, 'utf8'),
    fs.readFileSync(revisionPath, 'utf8'),
  );
  assert.match(
    fs.readFileSync(selectionPath, 'utf8'),
    /^    image: .*@sha256:[a-f0-9]{64}$/m,
  );
  const config = JSON.parse(
    fs.readFileSync(
      path.join(compose.deploymentRoot, 'local-application.json'),
      'utf8',
    ),
  );
  assert.equal(
    config.storage.databasePath,
    '/var/lib/qinglong3/qinglong3.sqlite',
  );
  assert.equal(
    config.runtime.secretKeyringPath,
    '/var/lib/qinglong3/local-secret-keyring.json',
  );
});

test('preflights exact local image, Compose merge and SQLite capability', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const dockerSocketPath = path.join(state.managementRoot, 'docker.sock');
  const image = state.command.options.service.image;
  const composeSource = fs.readFileSync(
    path.join(state.deploymentRoot, 'service', 'compose.yaml'),
    'utf8',
  );
  const projectName = /^name: ([a-z0-9_-]+)$/m.exec(composeSource)[1];
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.compose.preflight',
    options: {
      deploymentRoot: state.deploymentRoot,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath,
      allowRootService: rootAcknowledgement(),
    },
    request: {
      expectedGeneration: 1,
    },
  };
  const calls = [];
  const runDocker = ({ args }) => {
    calls.push(args);
    if (args[0] === 'image') {
      return JSON.stringify([
        {
          Id: `sha256:${'1'.repeat(64)}`,
          RepoDigests: [image],
          Architecture: 'arm64',
          Os: 'linux',
          Config: {
            User: '65532:65532',
            Entrypoint: [
              'node',
              '/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js',
            ],
            Labels: {
              'io.qinglong.local.sqlite-contract-min': '45',
              'io.qinglong.local.sqlite-contract-max': '45',
              'io.qinglong.local.sqlite-write-contract': '45',
              'io.qinglong.local.application-config': '2',
              'io.qinglong.local.compose-selection': '1',
              'io.qinglong.ai': 'excluded',
              'io.qinglong.profile': 'edge,standalone',
              'org.opencontainers.image.source':
                'https://github.com/whyour/qinglong',
              'org.opencontainers.image.revision': '2'.repeat(40),
              'org.opencontainers.image.version': '3.0.0-alpha.0',
            },
          },
        },
      ]);
    }
    return JSON.stringify({
      name: projectName,
      services: {
        qinglong3: {
          image,
          user: `${process.getuid()}:${process.getgid()}`,
          read_only: true,
          network_mode: 'none',
          restart: 'unless-stopped',
          mem_limit: 128 * 1024 * 1024,
          pids_limit: 64,
          cap_drop: ['ALL'],
          security_opt: ['no-new-privileges:true'],
          command: ['--config', '/var/lib/qinglong3/local-application.json'],
          labels: {
            'io.qinglong.deployment.generation': '1',
            'io.qinglong.deployment.mutation':
              state.command.request.activateMutationId,
          },
          volumes: [
            {
              type: 'bind',
              source: state.deploymentRoot,
              target: '/var/lib/qinglong3',
            },
          ],
          tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=16m'],
        },
      },
    });
  };
  const result = await preflightLocalDeploymentCompose(command, {
    runDocker,
    validateSocket() {},
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.generation, 1);
  assert.equal(result.profile, 'edge');
  assert.equal(result.sqlite.contractVersion, 45);
  assert.equal(result.image.architecture, 'arm64');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ['image', 'inspect']);
  assert.deepEqual(calls[1].slice(0, 2), ['compose', '--project-directory']);
  assert.equal(JSON.stringify(result).includes(state.deploymentRoot), false);
  assert.equal(
    /digest|mutation|socket|executable/i.test(JSON.stringify(result)),
    false,
  );

  await assert.rejects(
    preflightLocalDeploymentCompose(
      {
        ...command,
        request: { expectedGeneration: 2 },
      },
      { runDocker, validateSocket() {} },
    ),
    LocalDeploymentConfigurationError,
  );
  assert.equal(calls.length, 2);
});

test('Compose preflight rejects unproven image compatibility', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const dockerSocketPath = path.join(state.managementRoot, 'docker.sock');
  const command = {
    schemaVersion: 1,
    operation: 'local.deployment.compose.preflight',
    options: {
      deploymentRoot: state.deploymentRoot,
      dockerExecutable: fs.realpathSync(process.execPath),
      dockerSocketPath,
      allowRootService: rootAcknowledgement(),
    },
    request: { expectedGeneration: 1 },
  };
  const incompatibleImage = JSON.stringify([
    {
      Id: `sha256:${'1'.repeat(64)}`,
      RepoDigests: [state.command.options.service.image],
      Architecture: 'amd64',
      Os: 'linux',
      Config: {
        User: '65532:65532',
        Entrypoint: [
          'node',
          '/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js',
        ],
        Labels: {
          'io.qinglong.local.sqlite-contract-min': '40',
          'io.qinglong.local.sqlite-contract-max': '40',
          'io.qinglong.local.sqlite-write-contract': '40',
          'io.qinglong.local.application-config': '2',
          'io.qinglong.local.compose-selection': '1',
          'io.qinglong.ai': 'excluded',
          'io.qinglong.profile': 'edge,standalone',
          'org.opencontainers.image.source':
            'https://github.com/whyour/qinglong',
          'org.opencontainers.image.revision': '2'.repeat(40),
          'org.opencontainers.image.version': '3.0.0-alpha.0',
        },
      },
    },
  ]);
  await assert.rejects(
    preflightLocalDeploymentCompose(command, {
      runDocker: () => incompatibleImage,
      validateSocket() {},
    }),
    LocalDeploymentConfigurationError,
  );
});

test('applies one Compose generation and exactly replays its health receipt', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const harness = composeDockerHarness(state);
  const command = composeApplyCommand(state, 1, '51');
  const first = await applyLocalDeploymentCompose(command, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.equal(first.status, 'active');
  assert.equal(first.attemptedGeneration, 1);
  assert.equal(first.activeGeneration, 1);
  assert.equal(first.health.event, 'active');
  const receiptPath = path.join(
    state.deploymentRoot,
    'service',
    'rollouts',
    `${command.request.rolloutId}.json`,
  );
  assert.equal(mode(receiptPath), 0o600);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.deepEqual(receipt.sqlite, {
    contractVersion: 45,
    writeContractVersion: 45,
    writeObservation: 'unchanged',
    backup: null,
  });
  assert.equal(
    fs.existsSync(
      path.join(state.deploymentRoot, 'service', '.compose-rollout.lock'),
    ),
    false,
  );
  const receiptStagePath = path.join(
    path.dirname(receiptPath),
    `.${path.basename(receiptPath)}.ql3-deploy-stage`,
  );
  fs.linkSync(receiptPath, receiptStagePath);
  assert.equal(fs.statSync(receiptPath).nlink, 2);
  const upCalls = harness.calls.filter(
    (args) => args[0] === 'compose' && args.includes('up'),
  ).length;
  const replay = await applyLocalDeploymentCompose(command, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.deepEqual(replay, first);
  assert.equal(fs.existsSync(receiptStagePath), false);
  assert.equal(fs.statSync(receiptPath).nlink, 1);
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    upCalls,
  );
  assert.equal(JSON.stringify(first).includes(state.deploymentRoot), false);
  assert.equal(
    /digest|mutation|rollout|container/i.test(JSON.stringify(first)),
    false,
  );
  const driftedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  driftedReceipt.unexpected = true;
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify(driftedReceipt, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await assert.rejects(
    applyLocalDeploymentCompose(command, {
      runDocker: harness.runDocker,
      validateSocket() {},
      now: harness.now,
      wait: harness.wait,
    }),
    LocalDeploymentConfigurationError,
  );
});

test('explicitly collects the oldest Compose backup and preserves exact rollout replay', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const harness = composeDockerHarness(state);
  const rolloutCommands = [];
  for (const [generation, suffix, imageCharacter] of [
    [2, '52', 'b'],
    [3, '53', 'c'],
    [4, '54', 'd'],
  ]) {
    await switchLocalDeploymentComposeRevision(
      composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
        expectedGeneration: generation - 1,
        image: `registry.example/qinglong3-local@sha256:${imageCharacter.repeat(
          64,
        )}`,
        mutationId: `00000000-0000-4000-8000-000000000d${generation}0`,
        changedAtMs: 7_100 + generation,
      }),
    );
    const command = composeApplyCommand(state, generation, suffix);
    rolloutCommands.push(command);
    const applied = await applyLocalDeploymentCompose(command, {
      runDocker: harness.runDocker,
      validateSocket() {},
      now: harness.now,
      wait: harness.wait,
    });
    assert.equal(applied.status, 'active');
  }
  const oldest = rolloutCommands[0];
  const commands = composeEvidenceCollectionCommands(state, 4, [
    oldest.request.rolloutId,
  ]);
  const collectionCommandPath = path.join(
    state.managementRoot,
    'evidence-collection.json',
  );
  const collectionCli = path.resolve(
    __dirname,
    '../dist/deployment/localDeploymentCli.js',
  );
  fs.writeFileSync(
    collectionCommandPath,
    `${JSON.stringify(commands.prepare)}\n`,
    { mode: 0o600 },
  );
  const preparedProcess = spawnSync(
    process.execPath,
    [
      collectionCli,
      'compose-evidence-collect-prepare',
      '--command-file',
      collectionCommandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(preparedProcess.status, 0);
  assert.equal(preparedProcess.stderr, '');
  assert.equal(preparedProcess.stdout.includes(state.deploymentRoot), false);
  const prepared = JSON.parse(preparedProcess.stdout);
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.collected, {
    rolloutBackups: 1,
    restoreSafeguards: 0,
    bytes: prepared.collected.bytes,
  });
  assert.ok(prepared.collected.bytes > 0);
  await assert.rejects(
    switchLocalDeploymentComposeRevision(
      composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
        expectedGeneration: 4,
        image: `registry.example/qinglong3-local@sha256:${'e'.repeat(64)}`,
        mutationId: '00000000-0000-4000-8000-000000000d45',
        changedAtMs: 7_200,
      }),
    ),
    LocalDeploymentConfigurationError,
  );
  const backupPath = path.join(
    state.deploymentRoot,
    'service',
    'rollout-backups',
    `${oldest.request.rolloutId}.sqlite`,
  );
  const stagePath = path.join(
    path.dirname(backupPath),
    `.${path.basename(backupPath)}.ql3-collection-stage`,
  );
  fs.renameSync(backupPath, stagePath);
  fs.writeFileSync(
    collectionCommandPath,
    `${JSON.stringify(commands.commit)}\n`,
    { mode: 0o600 },
  );
  const committedProcess = spawnSync(
    process.execPath,
    [
      collectionCli,
      'compose-evidence-collect-commit',
      '--command-file',
      collectionCommandPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(committedProcess.status, 0);
  assert.equal(committedProcess.stderr, '');
  assert.equal(committedProcess.stdout.includes(state.deploymentRoot), false);
  const committed = JSON.parse(committedProcess.stdout);
  assert.equal(committed.status, 'collected');
  assert.equal(fs.existsSync(backupPath), false);
  assert.equal(fs.existsSync(stagePath), false);
  const tombstonePath = path.join(
    state.deploymentRoot,
    'service',
    'collected-evidence',
    'rollout-backups',
    `${oldest.request.rolloutId}.json`,
  );
  assert.equal(mode(tombstonePath), 0o600);
  const tombstone = JSON.parse(fs.readFileSync(tombstonePath, 'utf8'));
  assert.equal(tombstone.collectionId, commands.commit.request.collectionId);
  assert.equal(tombstone.snapshot.bytes, committed.collected.bytes);
  assert.equal(
    fs.existsSync(
      path.join(
        state.deploymentRoot,
        'service',
        '.compose-evidence-collection.lock',
      ),
    ),
    false,
  );
  const upCalls = harness.calls.filter(
    (args) => args[0] === 'compose' && args.includes('up'),
  ).length;
  const replay = await applyLocalDeploymentCompose(oldest, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.equal(replay.status, 'active');
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    upCalls,
  );
  const collectionCommitReceiptPath = path.join(
    state.deploymentRoot,
    'service',
    'evidence-collections',
    `${commands.commit.request.collectionId}.commit.json`,
  );
  const collectionCommitReceiptStagePath = path.join(
    path.dirname(collectionCommitReceiptPath),
    `.${path.basename(collectionCommitReceiptPath)}.ql3-deploy-stage`,
  );
  fs.linkSync(collectionCommitReceiptPath, collectionCommitReceiptStagePath);
  assert.equal(fs.statSync(collectionCommitReceiptPath).nlink, 2);
  const commitReplay = await collectLocalDeploymentComposeEvidence(
    commands.commit,
  );
  assert.equal(commitReplay.status, 'existing');
  assert.equal(fs.existsSync(collectionCommitReceiptStagePath), false);
  assert.equal(fs.statSync(collectionCommitReceiptPath).nlink, 1);
  const retained = fs
    .readdirSync(path.join(state.deploymentRoot, 'service', 'rollout-backups'))
    .filter((entry) => entry.endsWith('.sqlite'));
  assert.equal(retained.length, 2);
  const belowFloor = composeEvidenceCollectionCommands(
    state,
    4,
    [rolloutCommands[1].request.rolloutId],
    [],
    '92',
  );
  await assert.rejects(
    collectLocalDeploymentComposeEvidence(belowFloor.prepare),
    LocalDeploymentConfigurationError,
  );
});

test('rolls a failed Compose candidate forward to a healthy prior digest', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'b'.repeat(64)}`,
      mutationId: '00000000-0000-4000-8000-000000000d52',
      changedAtMs: 6_900,
    }),
  );
  const harness = composeDockerHarness(state, new Set([2]), new Set([2]));
  const command = composeApplyCommand(state, 2, '53');
  const applied = await applyLocalDeploymentCompose(command, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.equal(applied.status, 'rolled_back');
  assert.equal(applied.attemptedGeneration, 2);
  assert.equal(applied.activeGeneration, 3);
  assert.equal(applied.health.event, 'active');
  const selection = fs.readFileSync(
    path.join(state.deploymentRoot, 'service', 'compose.image.yaml'),
    'utf8',
  );
  assert.match(selection, /^  generation: 3$/m);
  assert.match(selection, /^  rollback_target_generation: 1$/m);
  assert.match(
    selection,
    new RegExp(`^    image: ${state.command.options.service.image}$`, 'm'),
  );
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    2,
  );
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'rollouts',
        `${command.request.rolloutId}.json`,
      ),
      'utf8',
    ),
  );
  const backupPath = path.join(
    state.deploymentRoot,
    'service',
    'rollout-backups',
    `${command.request.rolloutId}.sqlite`,
  );
  assert.equal(mode(backupPath), 0o600);
  assert.equal(receipt.sqlite.contractVersion, 45);
  assert.equal(receipt.sqlite.writeContractVersion, 45);
  assert.equal(receipt.sqlite.writeObservation, 'changed');
  assert.match(receipt.sqlite.backup.sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.sqlite.backup.bytes > 0, true);
});

test('records an unhealthy candidate observation failure as recovery unknown', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'b'.repeat(64)}`,
      mutationId: '00000000-0000-4000-8000-000000000d65',
      changedAtMs: 6_900,
    }),
  );
  const harness = composeDockerHarness(state, new Set([2]));
  const command = composeApplyCommand(state, 2, '66');
  const applied = await applyLocalDeploymentCompose(command, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
    openChangeObserver() {
      return {
        changed() {
          throw new Error('injected unavailable data_version');
        },
        close() {},
      };
    },
  });
  assert.equal(applied.status, 'rolled_back');
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'rollouts',
        `${command.request.rolloutId}.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.sqlite.writeObservation, 'recovery_unknown');
});

test('resumes a rollback generation after response loss without restarting the failed candidate', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'c'.repeat(64)}`,
      mutationId: '00000000-0000-4000-8000-000000000d55',
      changedAtMs: 6_950,
    }),
  );
  const command = composeApplyCommand(state, 2, '56');
  const intent = `${JSON.stringify(command, null, 2)}\n`;
  const lockPath = path.join(
    state.deploymentRoot,
    'service',
    '.compose-rollout.lock',
  );
  fs.writeFileSync(lockPath, intent, { mode: 0o600 });
  await createLocalSqliteRolloutBackup({
    databasePath: path.join(state.deploymentRoot, 'qinglong3.sqlite'),
    backupPath: path.join(
      state.deploymentRoot,
      'service',
      'rollout-backups',
      `${command.request.rolloutId}.sqlite`,
    ),
    profile: 'edge',
  });
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.rollback', {
      expectedGeneration: 2,
      targetGeneration: 1,
      mutationId: command.request.failureRollbackMutationId,
      changedAtMs: command.request.failureRollbackChangedAtMs,
    }),
    intent,
  );
  const harness = composeDockerHarness(state);
  const recovered = await applyLocalDeploymentCompose(command, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.equal(recovered.status, 'rolled_back');
  assert.equal(recovered.activeGeneration, 3);
  assert.equal(
    harness.calls.filter((args) => args[0] === 'compose' && args.includes('up'))
      .length,
    1,
  );
  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'service',
        'rollouts',
        `${command.request.rolloutId}.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.sqlite.writeObservation, 'recovery_unknown');
  assert.match(receipt.sqlite.backup.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(lockPath), false);
});

test('prepares and explicitly commits a fenced Compose SQLite restore', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const failedCommand = await createFailedRollbackRestoreState(state, '61');
  const commands = composeRestoreCommands(state, failedCommand, '71');
  const harness = composeDockerHarness(state);
  const sourcePath = path.join(
    state.deploymentRoot,
    'service',
    'rollout-backups',
    `${failedCommand.request.rolloutId}.sqlite`,
  );
  const sourceReader = new DatabaseSync(sourcePath, { readonly: true });
  const sourceUserVersion = sourceReader
    .prepare('PRAGMA user_version')
    .get().user_version;
  sourceReader.close();
  assert.notEqual(sourceUserVersion, 987);

  const prepared = await restoreLocalDeploymentCompose(commands.prepare, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.service.state, 'stopped');
  const serviceRoot = path.join(state.deploymentRoot, 'service');
  const restoreLockPath = path.join(serviceRoot, '.compose-restore.lock');
  const rolloutLockPath = path.join(serviceRoot, '.compose-rollout.lock');
  const prepareReceiptPath = path.join(
    serviceRoot,
    'restores',
    `${commands.prepare.request.restoreId}.prepare.json`,
  );
  const prepareReceiptStagePath = path.join(
    path.dirname(prepareReceiptPath),
    `.${path.basename(prepareReceiptPath)}.ql3-deploy-stage`,
  );
  fs.linkSync(prepareReceiptPath, prepareReceiptStagePath);
  assert.equal(mode(restoreLockPath), 0o600);
  assert.equal(mode(rolloutLockPath), 0o600);
  assert.equal(
    mode(
      path.join(
        serviceRoot,
        'restore-safeguards',
        `${commands.prepare.request.restoreId}.sqlite`,
      ),
    ),
    0o600,
  );

  await assert.rejects(
    applyLocalDeploymentCompose(failedCommand, {
      runDocker: harness.runDocker,
      validateSocket() {},
      now: harness.now,
      wait: harness.wait,
    }),
    LocalDeploymentConfigurationError,
  );

  const committed = await restoreLocalDeploymentCompose(commands.commit, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  assert.equal(committed.status, 'restored');
  assert.equal(fs.existsSync(prepareReceiptStagePath), false);
  assert.equal(fs.existsSync(restoreLockPath), false);
  assert.equal(fs.existsSync(rolloutLockPath), true);
  const restoredReader = new DatabaseSync(
    path.join(state.deploymentRoot, 'qinglong3.sqlite'),
    { readonly: true },
  );
  assert.equal(
    restoredReader.prepare('PRAGMA user_version').get().user_version,
    sourceUserVersion,
  );
  restoredReader.close();

  const resumed = await applyLocalDeploymentCompose(failedCommand, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.equal(resumed.status, 'rolled_back');
  assert.equal(fs.existsSync(rolloutLockPath), false);
  const commitReceiptPath = path.join(
    serviceRoot,
    'restores',
    `${commands.commit.request.restoreId}.commit.json`,
  );
  const commitReceiptStagePath = path.join(
    path.dirname(commitReceiptPath),
    `.${path.basename(commitReceiptPath)}.ql3-deploy-stage`,
  );
  fs.linkSync(commitReceiptPath, commitReceiptStagePath);
  const commitReplay = await restoreLocalDeploymentCompose(commands.commit, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  assert.equal(commitReplay.status, 'existing');
  assert.equal(commitReplay.service.state, 'unchanged');
  assert.equal(fs.existsSync(commitReceiptStagePath), false);
  await assert.rejects(
    restoreLocalDeploymentCompose(commands.prepare, {
      runDocker: harness.runDocker,
      validateSocket() {},
    }),
    LocalDeploymentConfigurationError,
  );
});

test('collects a committed restore safeguard and preserves restore replay', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const failedCommand = await createFailedRollbackRestoreState(state, '67');
  const restoreCommands = composeRestoreCommands(state, failedCommand, '77');
  const harness = composeDockerHarness(state);
  await restoreLocalDeploymentCompose(restoreCommands.prepare, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  await restoreLocalDeploymentCompose(restoreCommands.commit, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  await applyLocalDeploymentCompose(failedCommand, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });

  const serviceRoot = path.join(state.deploymentRoot, 'service');
  const secondRestoreId = '00000000-0000-4000-8000-000000000d78';
  const secondSafeguard = await createLocalSqliteRolloutBackup({
    databasePath: path.join(state.deploymentRoot, 'qinglong3.sqlite'),
    backupPath: path.join(
      serviceRoot,
      'restore-safeguards',
      `${secondRestoreId}.sqlite`,
    ),
    profile: 'edge',
  });
  const firstCommitPath = path.join(
    serviceRoot,
    'restores',
    `${restoreCommands.commit.request.restoreId}.commit.json`,
  );
  const secondCommit = JSON.parse(fs.readFileSync(firstCommitPath, 'utf8'));
  secondCommit.restoreId = secondRestoreId;
  secondCommit.recordedAtMs += 1;
  secondCommit.commandDigest = 'a'.repeat(64);
  secondCommit.safeguard = {
    contractVersion: secondSafeguard.contractVersion,
    sha256: secondSafeguard.sha256,
    bytes: secondSafeguard.bytes,
    pageCount: secondSafeguard.pageCount,
    pageSize: secondSafeguard.pageSize,
  };
  fs.writeFileSync(
    path.join(serviceRoot, 'restores', `${secondRestoreId}.commit.json`),
    `${JSON.stringify(secondCommit, null, 2)}\n`,
    { mode: 0o600 },
  );

  const collection = composeEvidenceCollectionCommands(
    state,
    3,
    [],
    [restoreCommands.commit.request.restoreId],
    '97',
  );
  const prepared = await collectLocalDeploymentComposeEvidence(
    collection.prepare,
  );
  assert.equal(prepared.collected.restoreSafeguards, 1);
  const committed = await collectLocalDeploymentComposeEvidence(
    collection.commit,
  );
  assert.equal(committed.status, 'collected');
  const collectedSafeguard = path.join(
    serviceRoot,
    'restore-safeguards',
    `${restoreCommands.commit.request.restoreId}.sqlite`,
  );
  assert.equal(fs.existsSync(collectedSafeguard), false);
  const replay = await restoreLocalDeploymentCompose(restoreCommands.commit, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  assert.equal(replay.status, 'existing');
  assert.equal(replay.sqlite.source, 'ready');
  assert.equal(replay.sqlite.safeguard, 'collected');
  assert.equal(replay.service.state, 'unchanged');
  assert.equal(
    fs.existsSync(
      path.join(serviceRoot, 'restore-safeguards', `${secondRestoreId}.sqlite`),
    ),
    true,
  );
});

test('resumes a Compose restore after the current database was moved', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const failedCommand = await createFailedRollbackRestoreState(state, '64');
  const commands = composeRestoreCommands(state, failedCommand, '74');
  const harness = composeDockerHarness(state);
  await restoreLocalDeploymentCompose(commands.prepare, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  const databasePath = path.join(state.deploymentRoot, 'qinglong3.sqlite');
  const replacedPath = path.join(
    state.deploymentRoot,
    'service',
    'restores',
    `${commands.prepare.request.restoreId}.replaced.sqlite`,
  );
  fs.renameSync(databasePath, replacedPath);

  const committed = await restoreLocalDeploymentCompose(commands.commit, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  assert.equal(committed.status, 'restored');
  assert.equal(fs.existsSync(databasePath), true);
  assert.equal(fs.existsSync(replacedPath), false);
});

test('fails a Compose restore commit on post-prepare SQLite drift', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const failedCommand = await createFailedRollbackRestoreState(state, '62');
  const commands = composeRestoreCommands(state, failedCommand, '72');
  const harness = composeDockerHarness(state);
  await restoreLocalDeploymentCompose(commands.prepare, {
    runDocker: harness.runDocker,
    validateSocket() {},
  });
  const databasePath = path.join(state.deploymentRoot, 'qinglong3.sqlite');
  const writer = new DatabaseSync(databasePath);
  writer.exec('PRAGMA user_version = 988');
  writer.close();

  await assert.rejects(
    restoreLocalDeploymentCompose(commands.commit, {
      runDocker: harness.runDocker,
      validateSocket() {},
    }),
    LocalDeploymentConfigurationError,
  );
  const reader = new DatabaseSync(databasePath, { readonly: true });
  assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 988);
  reader.close();
  assert.equal(
    fs.existsSync(
      path.join(state.deploymentRoot, 'service', '.compose-restore.lock'),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        state.deploymentRoot,
        'service',
        'restores',
        `${commands.commit.request.restoreId}.commit.json`,
      ),
    ),
    false,
  );
});

test('keeps SQLite unchanged when a restore safeguard cannot be created', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const failedCommand = await createFailedRollbackRestoreState(state, '63');
  const commands = composeRestoreCommands(state, failedCommand, '73');
  const harness = composeDockerHarness(state);
  await assert.rejects(
    restoreLocalDeploymentCompose(commands.prepare, {
      runDocker: harness.runDocker,
      validateSocket() {},
      async createSafeguard() {
        throw Object.assign(new Error('injected restore capacity failure'), {
          code: 'ENOSPC',
        });
      },
    }),
    /injected restore capacity failure/,
  );
  const reader = new DatabaseSync(
    path.join(state.deploymentRoot, 'qinglong3.sqlite'),
    { readonly: true },
  );
  assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 987);
  reader.close();
  assert.equal(
    fs.existsSync(
      path.join(state.deploymentRoot, 'service', '.compose-restore.lock'),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        state.deploymentRoot,
        'service',
        'restores',
        `${commands.prepare.request.restoreId}.prepare.json`,
      ),
    ),
    false,
  );
});

test('fails closed before Compose up when the rollout backup cannot be created', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  await switchLocalDeploymentComposeRevision(
    composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'d'.repeat(64)}`,
      mutationId: '00000000-0000-4000-8000-000000000d57',
      changedAtMs: 6_975,
    }),
  );
  const harness = composeDockerHarness(state);
  const command = composeApplyCommand(state, 2, '58');
  await assert.rejects(
    applyLocalDeploymentCompose(command, {
      runDocker: harness.runDocker,
      validateSocket() {},
      now: harness.now,
      wait: harness.wait,
      async createBackup() {
        throw Object.assign(new Error('injected backup capacity failure'), {
          code: 'ENOSPC',
        });
      },
    }),
    /injected backup capacity failure/,
  );
  assert.equal(
    harness.calls.some((args) => args[0] === 'compose' && args.includes('up')),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(state.deploymentRoot, 'service', '.compose-rollout.lock'),
    ),
    true,
  );
});

test('stops an unhealthy first Compose generation with a durable outcome', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const harness = composeDockerHarness(state, new Set([1]));
  const command = composeApplyCommand(state, 1, '54');
  const applied = await applyLocalDeploymentCompose(command, {
    runDocker: harness.runDocker,
    validateSocket() {},
    now: harness.now,
    wait: harness.wait,
  });
  assert.equal(applied.status, 'failed_stopped');
  assert.equal(applied.activeGeneration, null);
  assert.equal(applied.health.event, 'unavailable');
  assert.equal(
    harness.calls.some(
      (args) => args[0] === 'compose' && args.includes('stop'),
    ),
    true,
  );
});

test('upgrades and rolls back Compose image selections with generation CAS', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const composePath = path.join(
    state.deploymentRoot,
    'service',
    'compose.yaml',
  );
  const selectionPath = path.join(
    state.deploymentRoot,
    'service',
    'compose.image.yaml',
  );
  const revisions = path.join(state.deploymentRoot, 'service', 'revisions');
  const stableDescriptor = fs.readFileSync(composePath, 'utf8');
  const upgradedImage = `registry.example/qinglong3-local@sha256:${'b'.repeat(
    64,
  )}`;
  const upgrade = composeRevisionCommand(
    state,
    'local.deployment.compose.upgrade',
    {
      expectedGeneration: 1,
      image: upgradedImage,
      mutationId: '00000000-0000-4000-8000-000000000d11',
      changedAtMs: 3_000,
    },
  );
  const upgraded = await switchLocalDeploymentComposeRevision(upgrade);
  assert.equal(upgraded.status, 'prepared');
  assert.equal(upgraded.generation, 2);
  assert.equal(upgraded.service.kind, 'compose');
  assert.match(
    fs.readFileSync(selectionPath, 'utf8'),
    new RegExp(`^    image: ${upgradedImage}$`, 'm'),
  );
  assert.equal(mode(path.join(revisions, '2.yaml')), 0o600);
  assert.equal(fs.readFileSync(composePath, 'utf8'), stableDescriptor);

  const upgradeReplay = await switchLocalDeploymentComposeRevision(upgrade);
  assert.equal(upgradeReplay.status, 'existing');
  assert.equal(upgradeReplay.generation, 2);

  const rollback = composeRevisionCommand(
    state,
    'local.deployment.compose.rollback',
    {
      expectedGeneration: 2,
      targetGeneration: 1,
      mutationId: '00000000-0000-4000-8000-000000000d12',
      changedAtMs: 3_001,
    },
  );
  const rolledBack = await switchLocalDeploymentComposeRevision(rollback);
  assert.equal(rolledBack.status, 'prepared');
  assert.equal(rolledBack.generation, 3);
  const active = fs.readFileSync(selectionPath, 'utf8');
  assert.match(active, /^  generation: 3$/m);
  assert.match(active, /^  rollback_target_generation: 1$/m);
  assert.match(
    active,
    new RegExp(`^    image: ${state.command.options.service.image}$`, 'm'),
  );
  assert.equal(
    fs
      .readFileSync(path.join(revisions, '2.yaml'), 'utf8')
      .includes(upgradedImage),
    true,
  );
  assert.equal(
    (await switchLocalDeploymentComposeRevision(rollback)).status,
    'existing',
  );
  const prepareReplay = await prepareLocalDeployment(state.command);
  assert.equal(prepareReplay.status, 'existing');
  assert.match(fs.readFileSync(selectionPath, 'utf8'), /^  generation: 3$/m);

  await assert.rejects(
    switchLocalDeploymentComposeRevision(
      composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
        expectedGeneration: 2,
        image: upgradedImage,
        mutationId: '00000000-0000-4000-8000-000000000d13',
        changedAtMs: 3_002,
      }),
    ),
    LocalDeploymentConfigurationError,
  );
  await assert.rejects(
    switchLocalDeploymentComposeRevision(
      composeRevisionCommand(state, 'local.deployment.compose.upgrade', {
        expectedGeneration: 3,
        image: upgradedImage,
        mutationId: '00000000-0000-4000-8000-000000000d14',
        changedAtMs: 3_000,
      }),
    ),
    LocalDeploymentConfigurationError,
  );
});

test('recovers Compose response-loss and deterministic stage windows', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const image = `registry.example/qinglong3-local@sha256:${'c'.repeat(64)}`;
  const mutationId = '00000000-0000-4000-8000-000000000d21';
  const command = composeRevisionCommand(
    state,
    'local.deployment.compose.upgrade',
    {
      expectedGeneration: 1,
      image,
      mutationId,
      changedAtMs: 4_000,
    },
  );
  const serviceRoot = path.join(state.deploymentRoot, 'service');
  const selectionPath = path.join(serviceRoot, 'compose.image.yaml');
  const selectionStagePath = path.join(
    serviceRoot,
    '.compose.image.yaml.ql3-deploy-stage',
  );
  const next = composeSelection({
    generation: 2,
    previousGeneration: 1,
    rollbackTargetGeneration: 0,
    mutationId,
    changedAtMs: 4_000,
    image,
  });
  fs.writeFileSync(selectionStagePath, next, { mode: 0o600 });
  const recoveredStage = await switchLocalDeploymentComposeRevision(command);
  assert.equal(recoveredStage.status, 'prepared');
  assert.equal(fs.existsSync(selectionStagePath), false);
  assert.equal(fs.readFileSync(selectionPath, 'utf8'), next);

  fs.rmSync(path.join(serviceRoot, 'revisions', '2.yaml'));
  const recoveredResponseLoss = await switchLocalDeploymentComposeRevision(
    command,
  );
  assert.equal(recoveredResponseLoss.status, 'prepared');
  assert.equal(
    fs.readFileSync(path.join(serviceRoot, 'revisions', '2.yaml'), 'utf8'),
    next,
  );
  assert.equal(
    (await switchLocalDeploymentComposeRevision(command)).status,
    'existing',
  );
});

test('fails closed on Compose revision drift and an unrelated in-flight lock', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const revisionOne = path.join(
    state.deploymentRoot,
    'service',
    'revisions',
    '1.yaml',
  );
  fs.appendFileSync(revisionOne, 'DRIFT=true\n');
  await assert.rejects(
    switchLocalDeploymentComposeRevision(
      composeRevisionCommand(state, 'local.deployment.compose.rollback', {
        expectedGeneration: 2,
        targetGeneration: 1,
        mutationId: '00000000-0000-4000-8000-000000000d31',
        changedAtMs: 5_000,
      }),
    ),
    LocalDeploymentConfigurationError,
  );

  const clean = fixture(t, 'compose');
  await prepareLocalDeployment(clean.command);
  const lockPath = path.join(
    clean.deploymentRoot,
    'service',
    '.compose-revision.lock',
  );
  fs.writeFileSync(lockPath, '{"different":"intent"}\n', { mode: 0o600 });
  await assert.rejects(
    switchLocalDeploymentComposeRevision(
      composeRevisionCommand(clean, 'local.deployment.compose.upgrade', {
        expectedGeneration: 1,
        image: `registry.example/qinglong3-local@sha256:${'d'.repeat(64)}`,
        mutationId: '00000000-0000-4000-8000-000000000d32',
        changedAtMs: 5_001,
      }),
    ),
    LocalDeploymentConfigurationError,
  );

  const rolloutFenced = fixture(t, 'compose');
  await prepareLocalDeployment(rolloutFenced.command);
  fs.writeFileSync(
    path.join(rolloutFenced.deploymentRoot, 'service', '.compose-rollout.lock'),
    '{"different":"rollout"}\n',
    { mode: 0o600 },
  );
  await assert.rejects(
    switchLocalDeploymentComposeRevision(
      composeRevisionCommand(
        rolloutFenced,
        'local.deployment.compose.upgrade',
        {
          expectedGeneration: 1,
          image: `registry.example/qinglong3-local@sha256:${'f'.repeat(64)}`,
          mutationId: '00000000-0000-4000-8000-000000000d57',
          changedAtMs: 5_002,
        },
      ),
    ),
    LocalDeploymentConfigurationError,
  );
});

test('CLI is private-command-only, replay-safe and low-sensitive', async (t) => {
  const state = fixture(t);
  const cli = path.resolve(
    __dirname,
    '../dist/deployment/localDeploymentCli.js',
  );
  const first = spawnSync(
    process.execPath,
    [cli, 'prepare', '--command-file', state.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'prepared');
  assert.equal(first.stdout.includes(state.deploymentRoot), false);

  const second = spawnSync(
    process.execPath,
    [cli, 'prepare', '--command-file', state.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'existing');

  fs.chmodSync(state.commandFilePath, 0o644);
  const rejected = spawnSync(
    process.execPath,
    [cli, 'prepare', '--command-file', state.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.includes(state.deploymentRoot), false);
});

test('Compose revision CLI emits only a low-sensitive generation result', async (t) => {
  const state = fixture(t, 'compose');
  await prepareLocalDeployment(state.command);
  const command = composeRevisionCommand(
    state,
    'local.deployment.compose.upgrade',
    {
      expectedGeneration: 1,
      image: `registry.example/qinglong3-local@sha256:${'e'.repeat(64)}`,
      mutationId: '00000000-0000-4000-8000-000000000d41',
      changedAtMs: 6_000,
    },
  );
  const commandPath = path.join(state.managementRoot, 'compose-revision.json');
  fs.writeFileSync(commandPath, `${JSON.stringify(command)}\n`, {
    mode: 0o600,
  });
  const cli = path.resolve(
    __dirname,
    '../dist/deployment/localDeploymentCli.js',
  );
  const first = spawnSync(
    process.execPath,
    [cli, 'compose-revision', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.status, 'prepared');
  assert.equal(result.generation, 2);
  assert.equal(first.stdout.includes(state.deploymentRoot), false);
  assert.equal(/sha256|registry|image|mutation/i.test(first.stdout), false);

  const replay = spawnSync(
    process.execPath,
    [cli, 'compose-revision', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).status, 'existing');
});

test('rejects drift, widening, mutable images and unacknowledged root', async (t) => {
  const state = fixture(t);
  await assert.rejects(
    prepareLocalDeployment({
      ...state.command,
      options: { ...state.command.options, unexpected: true },
    }),
    LocalDeploymentConfigurationError,
  );
  const mutable = fixture(t, 'compose');
  await assert.rejects(
    prepareLocalDeployment({
      ...mutable.command,
      options: {
        ...mutable.command.options,
        service: {
          ...mutable.command.options.service,
          image: 'registry.example/qinglong3-local:latest',
        },
      },
    }),
    LocalDeploymentConfigurationError,
  );
  if (rootAcknowledgement()) {
    await assert.rejects(
      prepareLocalDeployment({
        ...state.command,
        options: {
          ...state.command.options,
          service: {
            ...state.command.options.service,
            allowRootService: false,
          },
        },
      }),
      LocalDeploymentConfigurationError,
    );
  }

  await prepareLocalDeployment(state.command);
  const unitPath = path.join(
    state.deploymentRoot,
    'service',
    'qinglong3.service',
  );
  fs.appendFileSync(unitPath, '# drift\n');
  await assert.rejects(
    prepareLocalDeployment(state.command),
    LocalDeploymentConfigurationError,
  );
});

test('recovers deterministic stage and link-cleanup crash windows', async (t) => {
  const state = fixture(t);
  await prepareLocalDeployment(state.command);

  const configPath = path.join(state.deploymentRoot, 'local-application.json');
  const configStagePath = path.join(
    state.deploymentRoot,
    '.local-application.json.ql3-deploy-stage',
  );
  fs.renameSync(configPath, configStagePath);
  const recoveredStage = await prepareLocalDeployment(state.command);
  assert.equal(recoveredStage.status, 'prepared');
  assert.equal(recoveredStage.applicationConfiguration.status, 'prepared');
  assert.equal(fs.existsSync(configPath), true);
  assert.equal(fs.existsSync(configStagePath), false);
  assert.equal(fs.statSync(configPath).nlink, 1);

  const unitPath = path.join(
    state.deploymentRoot,
    'service',
    'qinglong3.service',
  );
  const unitStagePath = path.join(
    state.deploymentRoot,
    'service',
    '.qinglong3.service.ql3-deploy-stage',
  );
  fs.linkSync(unitPath, unitStagePath);
  assert.equal(fs.statSync(unitPath).nlink, 2);
  const recoveredCleanup = await prepareLocalDeployment(state.command);
  assert.equal(recoveredCleanup.status, 'existing');
  assert.equal(recoveredCleanup.service.status, 'existing');
  assert.equal(fs.existsSync(unitStagePath), false);
  assert.equal(fs.statSync(unitPath).nlink, 1);
});
