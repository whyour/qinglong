#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const IMAGE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`QingLong local Compose rollout failed: ${message}`);
}

function argumentsValue(argv) {
  const values = Object.fromEntries(
    argv.map((argument) => {
      const separator = argument.indexOf('=');
      if (separator < 3 || !argument.startsWith('--')) {
        fail('arguments must use --name=value');
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
  );
  if (
    Object.keys(values).length !== argv.length ||
    !IMAGE_PATTERN.test(values.image ?? '') ||
    (values.profile !== 'edge' && values.profile !== 'standalone') ||
    typeof values['docker-executable'] !== 'string' ||
    typeof values['docker-socket'] !== 'string'
  ) {
    fail(
      'usage: --image=repository@sha256:digest --docker-executable=/absolute/docker --docker-socket=/absolute/docker.sock --profile=edge|standalone',
    );
  }
  const dockerExecutable = fs.realpathSync(values['docker-executable']);
  const dockerSocket = fs.realpathSync(values['docker-socket']);
  if (
    dockerExecutable !== values['docker-executable'] ||
    dockerSocket !== values['docker-socket']
  ) {
    fail('Docker executable and socket must be canonical paths');
  }
  return Object.freeze({
    image: values.image,
    profile: values.profile,
    dockerExecutable,
    dockerSocket,
  });
}

function docker(input, configRoot, args, timeout = 45_000) {
  return spawnSync(
    input.dockerExecutable,
    ['--host', `unix://${input.dockerSocket}`, '--config', configRoot, ...args],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
      timeout,
      killSignal: 'SIGKILL',
      env: {
        PATH: `${path.dirname(
          input.dockerExecutable,
        )}:/usr/local/bin:/usr/bin:/bin`,
        HOME: configRoot,
        DOCKER_CONFIG: configRoot,
        NO_PROXY: '*',
        no_proxy: '*',
      },
    },
  );
}

function composeArguments(deploymentRoot, args) {
  const serviceRoot = path.join(deploymentRoot, 'service');
  return [
    'compose',
    '--project-directory',
    serviceRoot,
    '-f',
    path.join(serviceRoot, 'compose.yaml'),
    '-f',
    path.join(serviceRoot, 'compose.image.yaml'),
    ...args,
  ];
}

function cleanup(input, configRoot, deploymentRoot, requireGracefulStop) {
  if (!fs.existsSync(path.join(deploymentRoot, 'service', 'compose.yaml'))) {
    return;
  }
  let cleanupFailure;
  if (requireGracefulStop) {
    const stopped = docker(
      input,
      configRoot,
      composeArguments(deploymentRoot, [
        'stop',
        '--timeout',
        '30',
        'qinglong3',
      ]),
      45_000,
    );
    const logs = docker(
      input,
      configRoot,
      composeArguments(deploymentRoot, [
        'logs',
        '--no-color',
        '--tail',
        '256',
        'qinglong3',
      ]),
    );
    if (
      stopped.error ||
      stopped.status !== 0 ||
      logs.error ||
      logs.status !== 0 ||
      !logs.stdout.includes('"event":"stopped"') ||
      !logs.stdout.includes('"stopResult":"stopped"')
    ) {
      cleanupFailure = 'container did not publish graceful stop evidence';
    }
  }
  const removed = docker(
    input,
    configRoot,
    composeArguments(deploymentRoot, [
      'down',
      '--timeout',
      '30',
      '--remove-orphans',
    ]),
    45_000,
  );
  if (removed.error || removed.status !== 0) {
    cleanupFailure ??= 'Compose resources could not be removed';
  }
  if (cleanupFailure) fail(cleanupFailure);
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24') {
    fail('Node 24 is required');
  }
  if (
    typeof process.getuid !== 'function' ||
    typeof process.getgid !== 'function'
  ) {
    fail('a POSIX identity is required');
  }
  const input = argumentsValue(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const {
    applyLocalDeploymentCompose,
    collectLocalDeploymentComposeEvidence,
    prepareLocalDeployment,
    switchLocalDeploymentComposeRevision,
  } = require(path.join(
    root,
    'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
  ));
  const { inspectLocalSqliteRolloutBackup } = require(path.join(
    root,
    'packages/ql3-local-sqlite/dist/readiness/rolloutSafety.js',
  ));
  const temporaryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-compose-rollout-')),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const dockerConfigRoot = path.join(temporaryRoot, 'docker-config');
  fs.mkdirSync(dockerConfigRoot, { mode: 0o700 });
  const deploymentRoot = path.join(temporaryRoot, 'deployment');
  const commandPath = path.join(temporaryRoot, 'rollout.json');
  const uid = process.getuid();
  let composeResourcesPresent = false;

  try {
    const setup = await prepareLocalDeployment({
      schemaVersion: 1,
      operation: 'local.deployment.prepare',
      options: {
        deploymentRoot,
        profile: input.profile,
        instanceId: `compose-rollout-${input.profile}`,
        busyTimeoutMs: 100,
        service: {
          kind: 'compose',
          image: input.image,
          allowRootService: uid === 0,
        },
      },
      request: {
        ownerPepperKeyId: 'owner-v1',
        registerMutationId: '019f8680-143d-4000-8000-000000000201',
        activateMutationId: '019f8680-143d-4000-8000-000000000202',
        registeredAtMs: 1_785_254_600_000,
        activatedAtMs: 1_785_254_600_001,
      },
    });
    if (setup.status !== 'prepared' || setup.profile !== input.profile) {
      fail('fresh deployment did not prepare');
    }
    const firstCommand = {
      schemaVersion: 1,
      operation: 'local.deployment.compose.apply',
      options: {
        deploymentRoot,
        dockerExecutable: input.dockerExecutable,
        dockerSocketPath: input.dockerSocket,
        allowRootService: uid === 0,
      },
      request: {
        expectedGeneration: 1,
        rolloutId: '019f8680-143d-4000-8000-000000000203',
        startedAtMs: 1_785_254_600_002,
        failureRollbackMutationId: '019f8680-143d-4000-8000-000000000204',
        failureRollbackChangedAtMs: 1_785_254_600_003,
      },
    };
    fs.writeFileSync(commandPath, `${JSON.stringify(firstCommand)}\n`, {
      mode: 0o600,
    });
    const cli = path.join(
      root,
      'packages/ql3-local-owner-cli/dist/deployment/localDeploymentCli.js',
    );
    const invoked = spawnSync(
      process.execPath,
      [cli, 'compose-apply', '--command-file', commandPath],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: input.profile === 'edge' ? 75_000 : 105_000,
        killSignal: 'SIGKILL',
      },
    );
    if (
      invoked.error ||
      invoked.status !== 0 ||
      invoked.stderr !== '' ||
      typeof invoked.stdout !== 'string' ||
      invoked.stdout.includes(deploymentRoot) ||
      /sha256|mutation|rollout|socket|executable|container/i.test(
        invoked.stdout,
      )
    ) {
      fail('private CLI did not return a low-sensitive active result');
    }
    const firstReport = JSON.parse(invoked.stdout);
    if (
      firstReport.schemaVersion !== 1 ||
      firstReport.operation !== 'local.deployment.compose.apply' ||
      firstReport.status !== 'active' ||
      firstReport.attemptedGeneration !== 1 ||
      firstReport.activeGeneration !== 1 ||
      firstReport.profile !== input.profile ||
      firstReport.health?.event !== 'active' ||
      firstReport.service?.kind !== 'compose'
    ) {
      fail('first rollout report is incompatible');
    }
    composeResourcesPresent = true;
    const revision = await switchLocalDeploymentComposeRevision({
      schemaVersion: 1,
      operation: 'local.deployment.compose.upgrade',
      options: {
        deploymentRoot,
        allowRootService: uid === 0,
      },
      request: {
        expectedGeneration: 1,
        image: input.image,
        mutationId: '019f8680-143d-4000-8000-000000000205',
        changedAtMs: 1_785_254_600_004,
      },
    });
    if (
      revision.status !== 'prepared' ||
      revision.operation !== 'local.deployment.compose.upgrade' ||
      revision.generation !== 2
    ) {
      fail('second generation did not publish');
    }
    const secondCommand = {
      ...firstCommand,
      request: {
        expectedGeneration: 2,
        rolloutId: '019f8680-143d-4000-8000-000000000206',
        startedAtMs: 1_785_254_600_005,
        failureRollbackMutationId: '019f8680-143d-4000-8000-000000000207',
        failureRollbackChangedAtMs: 1_785_254_600_006,
      },
    };
    fs.writeFileSync(commandPath, `${JSON.stringify(secondCommand)}\n`, {
      mode: 0o600,
    });
    const upgraded = spawnSync(
      process.execPath,
      [cli, 'compose-apply', '--command-file', commandPath],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: input.profile === 'edge' ? 75_000 : 105_000,
        killSignal: 'SIGKILL',
      },
    );
    if (
      upgraded.error ||
      upgraded.status !== 0 ||
      upgraded.stderr !== '' ||
      typeof upgraded.stdout !== 'string' ||
      upgraded.stdout.includes(deploymentRoot) ||
      /sha256|mutation|rollout|socket|executable|container/i.test(
        upgraded.stdout,
      )
    ) {
      fail('second private CLI did not return a low-sensitive active result');
    }
    const report = JSON.parse(upgraded.stdout);
    if (
      report.schemaVersion !== 1 ||
      report.operation !== 'local.deployment.compose.apply' ||
      report.status !== 'active' ||
      report.attemptedGeneration !== 2 ||
      report.activeGeneration !== 2 ||
      report.profile !== input.profile ||
      report.health?.event !== 'active' ||
      report.service?.kind !== 'compose'
    ) {
      fail('second rollout report is incompatible');
    }
    const serviceRoot = path.join(deploymentRoot, 'service');
    const rolloutRoot = path.join(serviceRoot, 'rollouts');
    const receipts = fs.readdirSync(rolloutRoot).sort();
    const backupPath = path.join(
      serviceRoot,
      'rollout-backups',
      `${secondCommand.request.rolloutId}.sqlite`,
    );
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(rolloutRoot, `${secondCommand.request.rolloutId}.json`),
        'utf8',
      ),
    );
    const backup = await inspectLocalSqliteRolloutBackup({
      databasePath: path.join(deploymentRoot, 'qinglong3.sqlite'),
      backupPath,
      profile: input.profile,
    });
    if (
      receipts.length !== 2 ||
      receipts.some(
        (name) =>
          (fs.statSync(path.join(rolloutRoot, name)).mode & 0o777) !== 0o600,
      ) ||
      (fs.statSync(backupPath).mode & 0o777) !== 0o600 ||
      receipt.sqlite?.contractVersion !== 43 ||
      receipt.sqlite?.writeContractVersion !== 43 ||
      (receipt.sqlite?.writeObservation !== 'unchanged' &&
        receipt.sqlite?.writeObservation !== 'changed') ||
      receipt.sqlite?.backup?.sha256 !== backup.sha256 ||
      receipt.sqlite?.backup?.bytes !== backup.bytes ||
      receipt.sqlite?.backup?.pageCount !== backup.pageCount ||
      receipt.sqlite?.backup?.pageSize !== backup.pageSize ||
      fs.existsSync(
        path.join(deploymentRoot, 'service', '.compose-rollout.lock'),
      )
    ) {
      fail('durable rollout backup or receipt is incomplete');
    }

    const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
    const beforeRestore = new DatabaseSync(databasePath, { readonly: true });
    const sourceUserVersion = beforeRestore
      .prepare('PRAGMA user_version')
      .get().user_version;
    beforeRestore.close();
    const mutatedUserVersion = sourceUserVersion === 987 ? 988 : 987;
    const thirdRevision = await switchLocalDeploymentComposeRevision({
      schemaVersion: 1,
      operation: 'local.deployment.compose.upgrade',
      options: {
        deploymentRoot,
        allowRootService: uid === 0,
      },
      request: {
        expectedGeneration: 2,
        image: input.image,
        mutationId: '019f8680-143d-4000-8000-000000000208',
        changedAtMs: 1_785_254_600_007,
      },
    });
    if (thirdRevision.status !== 'prepared' || thirdRevision.generation !== 3) {
      fail('restore exercise generation did not publish');
    }
    const restoreRolloutCommand = {
      ...firstCommand,
      request: {
        expectedGeneration: 3,
        rolloutId: '019f8680-143d-4000-8000-000000000209',
        startedAtMs: 1_785_254_600_008,
        failureRollbackMutationId: '019f8680-143d-4000-8000-00000000020a',
        failureRollbackChangedAtMs: 1_785_254_600_009,
      },
    };
    let injectedWrite = false;
    let faultNow = 0;
    const failedHealthRunner = ({ args, timeoutMs }) => {
      const executed = docker(
        input,
        dockerConfigRoot,
        args,
        timeoutMs ?? 45_000,
      );
      if (executed.error || executed.status !== 0) {
        throw new Error(
          executed.stderr || 'Docker restore exercise command failed',
        );
      }
      const selection = fs.readFileSync(
        path.join(serviceRoot, 'compose.image.yaml'),
        'utf8',
      );
      const generation = Number(
        /^  generation: ([0-9]+)$/m.exec(selection)?.[1],
      );
      if (
        args[0] === 'compose' &&
        args.includes('up') &&
        generation === 3 &&
        !injectedWrite
      ) {
        const writer = new DatabaseSync(databasePath);
        writer.exec(`PRAGMA user_version = ${mutatedUserVersion}`);
        writer.close();
        injectedWrite = true;
      }
      if (
        args[0] === 'container' &&
        args[1] === 'logs' &&
        (generation === 3 || generation === 4)
      ) {
        return '';
      }
      return executed.stdout;
    };
    let failedHealthError;
    try {
      await applyLocalDeploymentCompose(restoreRolloutCommand, {
        runDocker: failedHealthRunner,
        now() {
          faultNow += 61_000;
          return faultNow;
        },
        async wait() {},
      });
    } catch (error) {
      failedHealthError = error;
    }
    const restoreRolloutLock = path.join(serviceRoot, '.compose-rollout.lock');
    const restoreRolloutReceipt = path.join(
      rolloutRoot,
      `${restoreRolloutCommand.request.rolloutId}.json`,
    );
    const restoreSourcePath = path.join(
      serviceRoot,
      'rollout-backups',
      `${restoreRolloutCommand.request.rolloutId}.sqlite`,
    );
    const failedSelection = fs.readFileSync(
      path.join(serviceRoot, 'compose.image.yaml'),
      'utf8',
    );
    const failedGeneration = Number(
      /^  generation: ([0-9]+)$/m.exec(failedSelection)?.[1],
    );
    const changedDatabase = new DatabaseSync(databasePath, {
      readonly: true,
    });
    const changedUserVersion = changedDatabase
      .prepare('PRAGMA user_version')
      .get().user_version;
    changedDatabase.close();
    if (
      !(failedHealthError instanceof Error) ||
      !injectedWrite ||
      changedUserVersion !== mutatedUserVersion ||
      !/^  generation: 4$/m.test(failedSelection) ||
      !fs.existsSync(restoreRolloutLock) ||
      fs.existsSync(restoreRolloutReceipt) ||
      !fs.existsSync(restoreSourcePath)
    ) {
      fail(
        `failed rollout did not preserve a restorable fenced state ${JSON.stringify(
          {
            failedHealthError: failedHealthError instanceof Error,
            injectedWrite,
            changedDatabase: changedUserVersion === mutatedUserVersion,
            failedGeneration,
            rolloutLock: fs.existsSync(restoreRolloutLock),
            rolloutReceipt: fs.existsSync(restoreRolloutReceipt),
            sourceSnapshot: fs.existsSync(restoreSourcePath),
          },
        )}`,
      );
    }

    const restoreId = '019f8680-143d-4000-8000-00000000020b';
    const prepareRestoreCommand = {
      schemaVersion: 1,
      operation: 'local.deployment.compose.restore.prepare',
      options: restoreRolloutCommand.options,
      request: {
        expectedGeneration: 4,
        restoreId,
        sourceRolloutId: restoreRolloutCommand.request.rolloutId,
        preparedAtMs: 1_785_254_600_010,
      },
    };
    const commitRestoreCommand = {
      schemaVersion: 1,
      operation: 'local.deployment.compose.restore.commit',
      options: restoreRolloutCommand.options,
      request: {
        expectedGeneration: 4,
        restoreId,
        committedAtMs: 1_785_254_600_011,
      },
    };
    const invokeRestoreCli = (verb, command) => {
      fs.writeFileSync(commandPath, `${JSON.stringify(command)}\n`, {
        mode: 0o600,
      });
      const invokedRestore = spawnSync(
        process.execPath,
        [cli, verb, '--command-file', commandPath],
        {
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
          timeout: 75_000,
          killSignal: 'SIGKILL',
        },
      );
      if (
        invokedRestore.error ||
        invokedRestore.status !== 0 ||
        invokedRestore.stderr !== '' ||
        invokedRestore.stdout.includes(deploymentRoot) ||
        /sha256|mutation|rollout|socket|executable|container/i.test(
          invokedRestore.stdout,
        )
      ) {
        fail(
          `${verb} did not return a low-sensitive result ${JSON.stringify({
            status: invokedRestore.status,
            hasProcessError: invokedRestore.error !== undefined,
            stderr: invokedRestore.stderr.trim(),
            containsDeploymentRoot:
              invokedRestore.stdout.includes(deploymentRoot),
            containsForbiddenOutput:
              /sha256|mutation|rollout|socket|executable|container/i.test(
                invokedRestore.stdout,
              ),
          })}`,
        );
      }
      return JSON.parse(invokedRestore.stdout);
    };
    const preparedRestore = invokeRestoreCli(
      'compose-restore-prepare',
      prepareRestoreCommand,
    );
    const safeguardPath = path.join(
      serviceRoot,
      'restore-safeguards',
      `${restoreId}.sqlite`,
    );
    if (
      preparedRestore.status !== 'prepared' ||
      preparedRestore.generation !== 4 ||
      preparedRestore.profile !== input.profile ||
      preparedRestore.service?.state !== 'stopped' ||
      !fs.existsSync(safeguardPath)
    ) {
      fail('restore prepare evidence is incomplete');
    }
    const committedRestore = invokeRestoreCli(
      'compose-restore-commit',
      commitRestoreCommand,
    );
    const restoredDatabase = new DatabaseSync(databasePath, {
      readonly: true,
    });
    const restoredUserVersion = restoredDatabase
      .prepare('PRAGMA user_version')
      .get().user_version;
    restoredDatabase.close();
    if (
      committedRestore.status !== 'restored' ||
      committedRestore.service?.state !== 'stopped' ||
      restoredUserVersion !== sourceUserVersion ||
      fs.existsSync(path.join(serviceRoot, '.compose-restore.lock')) ||
      !fs.existsSync(restoreRolloutLock)
    ) {
      fail('restore commit did not restore the exact source snapshot');
    }

    fs.writeFileSync(
      commandPath,
      `${JSON.stringify(restoreRolloutCommand)}\n`,
      { mode: 0o600 },
    );
    const resumedRollout = spawnSync(
      process.execPath,
      [cli, 'compose-apply', '--command-file', commandPath],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: input.profile === 'edge' ? 75_000 : 105_000,
        killSignal: 'SIGKILL',
      },
    );
    if (
      resumedRollout.error ||
      resumedRollout.status !== 2 ||
      resumedRollout.stderr !== '' ||
      resumedRollout.stdout.includes(deploymentRoot) ||
      /sha256|mutation|rollout|socket|executable|container/i.test(
        resumedRollout.stdout,
      )
    ) {
      fail('restored rollout did not return a low-sensitive recovery result');
    }
    const recoveredReport = JSON.parse(resumedRollout.stdout);
    if (
      recoveredReport.status !== 'rolled_back' ||
      recoveredReport.attemptedGeneration !== 3 ||
      recoveredReport.activeGeneration !== 4 ||
      recoveredReport.health?.event !== 'active' ||
      fs.existsSync(restoreRolloutLock) ||
      !fs.existsSync(restoreRolloutReceipt)
    ) {
      fail('restored rollout did not recover the rollback generation');
    }
    const commitReplay = invokeRestoreCli(
      'compose-restore-commit',
      commitRestoreCommand,
    );
    const runningAfterReplay = docker(
      input,
      dockerConfigRoot,
      composeArguments(deploymentRoot, [
        'ps',
        '--status',
        'running',
        '--quiet',
        'qinglong3',
      ]),
    );
    if (
      commitReplay.status !== 'existing' ||
      commitReplay.service?.state !== 'unchanged' ||
      runningAfterReplay.error ||
      runningAfterReplay.status !== 0 ||
      runningAfterReplay.stdout.trim() === ''
    ) {
      fail('commit replay changed the recovered service');
    }

    const extraTransactions =
      input.profile === 'edge'
        ? [
            {
              revisionId: '019f8680-143d-4000-8000-00000000020c',
              rolloutId: '019f8680-143d-4000-8000-00000000020d',
              rollbackId: '019f8680-143d-4000-8000-00000000020e',
            },
          ]
        : [
            {
              revisionId: '019f8680-143d-4000-8000-00000000020c',
              rolloutId: '019f8680-143d-4000-8000-00000000020d',
              rollbackId: '019f8680-143d-4000-8000-00000000020e',
            },
            {
              revisionId: '019f8680-143d-4000-8000-00000000020f',
              rolloutId: '019f8680-143d-4000-8000-000000000210',
              rollbackId: '019f8680-143d-4000-8000-000000000211',
            },
            {
              revisionId: '019f8680-143d-4000-8000-000000000212',
              rolloutId: '019f8680-143d-4000-8000-000000000213',
              rollbackId: '019f8680-143d-4000-8000-000000000214',
            },
          ];
    let evidenceGeneration = 4;
    for (const [index, transaction] of extraTransactions.entries()) {
      const revisionResult = await switchLocalDeploymentComposeRevision({
        schemaVersion: 1,
        operation: 'local.deployment.compose.upgrade',
        options: {
          deploymentRoot,
          allowRootService: uid === 0,
        },
        request: {
          expectedGeneration: evidenceGeneration,
          image: input.image,
          mutationId: transaction.revisionId,
          changedAtMs: 1_785_254_600_012 + index * 3,
        },
      });
      evidenceGeneration += 1;
      if (
        revisionResult.status !== 'prepared' ||
        revisionResult.generation !== evidenceGeneration
      ) {
        fail('evidence collection setup revision did not publish');
      }
      const extraRollout = await applyLocalDeploymentCompose({
        ...firstCommand,
        request: {
          expectedGeneration: evidenceGeneration,
          rolloutId: transaction.rolloutId,
          startedAtMs: 1_785_254_600_013 + index * 3,
          failureRollbackMutationId: transaction.rollbackId,
          failureRollbackChangedAtMs: 1_785_254_600_014 + index * 3,
        },
      });
      if (
        extraRollout.status !== 'active' ||
        extraRollout.activeGeneration !== evidenceGeneration
      ) {
        fail('evidence collection setup rollout did not become active');
      }
    }
    const collectionId = '019f8680-143d-4000-8000-000000000215';
    const collectionOptions = {
      deploymentRoot,
      allowRootService: uid === 0,
    };
    const collectionPrepare = await collectLocalDeploymentComposeEvidence({
      schemaVersion: 1,
      operation: 'local.deployment.compose.evidence-collection.prepare',
      options: collectionOptions,
      request: {
        expectedGeneration: evidenceGeneration,
        collectionId,
        rolloutIds: [secondCommand.request.rolloutId],
        restoreIds: [],
        preparedAtMs: 1_785_254_600_100,
      },
    });
    const runningBeforeCollectionReplay = docker(
      input,
      dockerConfigRoot,
      composeArguments(deploymentRoot, [
        'ps',
        '--status',
        'running',
        '--quiet',
        'qinglong3',
      ]),
    );
    const collectionCommitCommand = {
      schemaVersion: 1,
      operation: 'local.deployment.compose.evidence-collection.commit',
      options: collectionOptions,
      request: {
        expectedGeneration: evidenceGeneration,
        collectionId,
        committedAtMs: 1_785_254_600_101,
      },
    };
    const collectionCommit = await collectLocalDeploymentComposeEvidence(
      collectionCommitCommand,
    );
    const historicalReplay = await applyLocalDeploymentCompose(secondCommand);
    const collectionReplay = await collectLocalDeploymentComposeEvidence(
      collectionCommitCommand,
    );
    const runningAfterCollectionReplay = docker(
      input,
      dockerConfigRoot,
      composeArguments(deploymentRoot, [
        'ps',
        '--status',
        'running',
        '--quiet',
        'qinglong3',
      ]),
    );
    const collectedTombstone = path.join(
      serviceRoot,
      'collected-evidence',
      'rollout-backups',
      `${secondCommand.request.rolloutId}.json`,
    );
    if (
      collectionPrepare.status !== 'prepared' ||
      collectionCommit.status !== 'collected' ||
      collectionReplay.status !== 'existing' ||
      collectionCommit.collected?.rolloutBackups !== 1 ||
      collectionCommit.collected?.bytes !== backup.bytes ||
      historicalReplay.status !== 'active' ||
      fs.existsSync(backupPath) ||
      !fs.existsSync(collectedTombstone) ||
      runningBeforeCollectionReplay.error ||
      runningBeforeCollectionReplay.status !== 0 ||
      runningBeforeCollectionReplay.stdout.trim() === '' ||
      runningAfterCollectionReplay.error ||
      runningAfterCollectionReplay.status !== 0 ||
      runningAfterCollectionReplay.stdout.trim() !==
        runningBeforeCollectionReplay.stdout.trim()
    ) {
      fail('explicit evidence collection or historical replay drifted');
    }

    cleanup(input, dockerConfigRoot, deploymentRoot, true);
    composeResourcesPresent = false;
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        profile: recoveredReport.profile,
        generation: evidenceGeneration,
        exactRepoDigest: true,
        composeMerge: true,
        rolloutActive: true,
        durableReceipt: true,
        sqliteWriteContract: 37,
        sqliteBackup: true,
        sqliteWriteObservation: receipt.sqlite.writeObservation,
        sqliteRestorePrepared: true,
        sqliteRestoreCommitted: true,
        sqliteRestoreRolloutRecovered: true,
        sqliteRestoreReplayUnchanged: true,
        sqliteEvidenceCollected: true,
        sqliteCollectedRolloutReplayUnchanged: true,
        gracefulCleanup: true,
        compatible: true,
      })}\n`,
    );
  } finally {
    if (composeResourcesPresent) {
      try {
        cleanup(input, dockerConfigRoot, deploymentRoot, false);
      } catch {
        // The original failure remains authoritative.
      }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
