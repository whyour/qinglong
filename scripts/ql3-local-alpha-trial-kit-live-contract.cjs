#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const MAX_OUTPUT_BYTES = 64 * 1024;
const ACTIVE_TIMEOUT_MS = 45_000;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;

function fail(message) {
  throw new Error(`QingLong Local Alpha trial kit failed: ${message}`);
}

function argumentsFrom(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(application-image|operator-image|profile)=(.+)$/u.exec(
      argument,
    );
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (
    Object.keys(values).length !== 3 ||
    !IMAGE_PATTERN.test(values['application-image'] ?? '') ||
    !IMAGE_PATTERN.test(values['operator-image'] ?? '') ||
    !['edge', 'standalone'].includes(values.profile)
  ) {
    fail(
      'usage: --application-image=... --operator-image=... --profile=edge|standalone',
    );
  }
  return Object.freeze({
    applicationImage: values['application-image'],
    operatorImage: values['operator-image'],
    profile: values.profile,
  });
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `docker ${args[0]} failed: ${(result.stderr || result.stdout)
        .trim()
        .slice(0, 2048)}`,
    );
  }
  return result.stdout.trim();
}

function inspectImages(applicationImage, operatorImage) {
  const application = docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}} {{.Architecture}} {{.Config.User}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}',
    applicationImage,
  ]).split(' ');
  const operator = docker([
    'image',
    'inspect',
    '--format',
    '{{.Id}} {{.Architecture}} {{.Config.User}} {{index .Config.Labels "io.qinglong.lifecycle"}} {{index .Config.Labels "io.qinglong.authority"}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}',
    operatorImage,
  ]).split(' ');
  if (
    !/^sha256:[0-9a-f]{64}$/u.test(application[0] ?? '') ||
    !/^sha256:[0-9a-f]{64}$/u.test(operator[0] ?? '') ||
    application[1] !== operator[1] ||
    !['amd64', 'arm64'].includes(application[1]) ||
    application[2] !== '65532:65532' ||
    operator[2] !== '65532:65532' ||
    operator[3] !== 'short-lived' ||
    operator[4] !== 'local-owner-management' ||
    !/^[0-9a-f]{40}$/u.test(application[3] ?? '') ||
    application[3] !== operator[5] ||
    application[4] !== operator[6] ||
    !/^3\.0\.0-alpha\.[0-9]+$/u.test(application[4] ?? '')
  ) {
    fail('image identity, architecture or authority labels drifted');
  }
  return Object.freeze({
    architecture: application[1],
    applicationId: application[0],
    operatorId: operator[0],
  });
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function operatorArguments(state, command, ...argv) {
  return [
    'run',
    '--rm',
    '--read-only',
    '--user',
    `${state.uid}:${state.gid}`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '128m',
    '--memory-swap',
    '128m',
    '--cpus',
    '0.5',
    '--pids-limit',
    '32',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=8m',
    '--volume',
    `${state.root}:/var/lib/qinglong3`,
    state.operatorImage,
    command,
    ...argv,
  ];
}

function runOperator(state, command, commandFileName) {
  let output;
  try {
    output = docker(
      operatorArguments(
        state,
        command,
        'run',
        '--command-file',
        `/var/lib/qinglong3/${commandFileName}`,
      ),
    );
  } catch (error) {
    fail(
      `operator stage ${command}/${commandFileName} failed: ${
        error instanceof Error ? error.message : 'unknown failure'
      }`,
    );
  }
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    fail('operator emitted non-JSON output');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('operator result shape is invalid');
  }
  return result;
}

function ownerCommand(state, fileName, operation, request) {
  writePrivateJson(path.join(state.root, fileName), {
    schemaVersion: 1,
    operation,
    options: {
      deploymentRoot: '/var/lib/qinglong3',
      databasePath: '/var/lib/qinglong3/qinglong3.sqlite',
      pepperPath: '/var/lib/qinglong3/owner-peppers/b3duZXItdjE.pepper',
      pepperKeyId: 'owner-v1',
      secretDeliveryDirectory: '/var/lib/qinglong3/owner-delivery',
      profile: state.profile,
      busyTimeoutMs: 100,
    },
    request,
  });
  return runOperator(state, 'owner', fileName);
}

function prepareFreshAuthority(state) {
  for (const directory of [
    'owner-peppers',
    'owner-pepper-backup',
    'owner-delivery',
    'receipts',
    'artifacts',
    'plugin-staging',
    'plugin-activation',
  ]) {
    fs.mkdirSync(path.join(state.root, directory), { mode: 0o700 });
  }
  writePrivateJson(path.join(state.root, 'setup.json'), {
    schemaVersion: 1,
    operation: 'local.setup.prepare',
    options: {
      deploymentRoot: '/var/lib/qinglong3',
      databasePath: '/var/lib/qinglong3/qinglong3.sqlite',
      profile: state.profile,
      ownerPepperKeyringDirectory: '/var/lib/qinglong3/owner-peppers',
      ownerPepperBackupDirectory: '/var/lib/qinglong3/owner-pepper-backup',
      ownerPepperKeyId: 'owner-v1',
      localSecretKeyringPath: '/var/lib/qinglong3/local-secret-keyring.json',
      busyTimeoutMs: 100,
    },
    request: {
      registerMutationId: '019f8680-143d-4000-8000-000000000011',
      activateMutationId: '019f8680-143d-4000-8000-000000000012',
      registeredAtMs: 1_785_254_400_000,
      activatedAtMs: 1_785_254_400_001,
    },
  });
  const prepared = runOperator(state, 'setup', 'setup.json');
  const replay = runOperator(state, 'setup', 'setup.json');
  if (prepared.status !== 'prepared' || replay.status !== 'existing') {
    fail('fresh setup did not converge through the operator image');
  }
  return Object.freeze({ prepared: true, replay: true });
}

function establishFirstOwner(state) {
  const credentialMutationId = '019f8680-143d-4000-8000-000000000021';
  const challengeMutationId = '019f8680-143d-4000-8000-000000000022';
  const provisioned = ownerCommand(
    state,
    'owner-provision.json',
    'owner.identity.provision',
    {
      mutationId: credentialMutationId,
      requestId: 'alpha-trial-owner-provision',
    },
  );
  const issued = ownerCommand(
    state,
    'owner-challenge.json',
    'owner.challenge.issue',
    {
      projectId: 'default',
      mutationId: challengeMutationId,
      requestId: 'alpha-trial-owner-challenge',
    },
  );
  const claimed = ownerCommand(
    state,
    'owner-claim.json',
    'owner.claim.from-deliveries',
    {
      projectId: 'default',
      mutationId: '019f8680-143d-4000-8000-000000000023',
      requestId: 'alpha-trial-owner-claim',
      credentialMutationId,
      challengeMutationId,
    },
  );
  if (
    provisioned.status !== 'inserted' ||
    issued.status !== 'inserted' ||
    claimed.status !== 'inserted' ||
    claimed.role !== 'owner'
  ) {
    fail('first Owner ceremony did not converge');
  }
  for (const acknowledgement of [
    {
      file: 'owner-credential-ack.json',
      purpose: 'credential-provisioning',
      mutationId: credentialMutationId,
      digest: provisioned.delivery?.deliveryDigest,
    },
    {
      file: 'owner-challenge-ack.json',
      purpose: 'challenge',
      mutationId: challengeMutationId,
      digest: issued.delivery?.deliveryDigest,
    },
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(acknowledgement.digest ?? '')) {
      fail('Owner delivery digest is unavailable');
    }
    ownerCommand(state, acknowledgement.file, 'owner.delivery.acknowledge', {
      purpose: acknowledgement.purpose,
      mutationId: acknowledgement.mutationId,
      expectedDeliveryDigest: acknowledgement.digest,
    });
  }
  return Object.freeze({
    provisioned: true,
    challenged: true,
    claimed: true,
    acknowledged: true,
  });
}

function writeApplicationConfig(state) {
  writePrivateJson(path.join(state.root, 'local-application.json'), {
    schema: 'qinglong/local-application-process@v2',
    instanceId: 'alpha-trial-local',
    profile: state.profile,
    storage: {
      mode: 'fresh',
      databasePath: '/var/lib/qinglong3/qinglong3.sqlite',
      busyTimeoutMs: 100,
    },
    runtime: {
      receiptRoot: '/var/lib/qinglong3/receipts',
      artifactRoot: '/var/lib/qinglong3/artifacts',
      secretKeyringPath: '/var/lib/qinglong3/local-secret-keyring.json',
    },
    pluginPackages: {
      stagingRoot: '/var/lib/qinglong3/plugin-staging',
      activationRoot: '/var/lib/qinglong3/plugin-activation',
      recoverySource: { mode: 'disabled' },
      pageSize: 4,
      maxPages: 4,
      taskPublicationPageSize: 4,
      taskPublicationMaxPages: 4,
    },
    ai: { deployment: 'excluded' },
  });
}

async function runApplication(state) {
  const name = `ql3-alpha-trial-${process.pid}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const memory = state.profile === 'edge' ? '128m' : '256m';
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '--read-only',
      '--user',
      `${state.uid}:${state.gid}`,
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      memory,
      '--memory-swap',
      memory,
      '--cpus',
      '0.5',
      '--pids-limit',
      state.profile === 'edge' ? '64' : '256',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=16m',
      '--volume',
      `${state.root}:/var/lib/qinglong3`,
      state.applicationImage,
      '--config',
      '/var/lib/qinglong3/local-application.json',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  let active = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (
      !active &&
      stdout.split('\n').some((line) => {
        try {
          return JSON.parse(line).event === 'active';
        } catch {
          return false;
        }
      })
    ) {
      active = true;
      docker(['stop', '--time', '30', name]);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const outcome = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('application lifecycle timed out')),
        ACTIVE_TIMEOUT_MS,
      );
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    const events = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      outcome.code !== 0 ||
      outcome.signal !== null ||
      stderr !== '' ||
      !active ||
      !events.some(
        ({ event, stopResult }) =>
          event === 'stopped' && stopResult === 'stopped',
      )
    ) {
      fail(
        `application lifecycle drifted: ${JSON.stringify({
          outcome,
          stderr: stderr.slice(0, 2048),
          events,
        })}`,
      );
    }
    return Object.freeze({ active: true, gracefulStop: true });
  } finally {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
  }
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24') fail('Node 24 is required');
  if (
    typeof process.getuid !== 'function' ||
    typeof process.getgid !== 'function'
  ) {
    fail('a POSIX identity is required');
  }
  const options = argumentsFrom(process.argv.slice(2));
  const images = inspectImages(options.applicationImage, options.operatorImage);
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-alpha-trial-')),
  );
  fs.chmodSync(root, 0o700);
  const state = Object.freeze({
    ...options,
    ...images,
    root,
    uid: process.getuid(),
    gid: process.getgid(),
  });
  try {
    const setup = prepareFreshAuthority(state);
    const owner = establishFirstOwner(state);
    writeApplicationConfig(state);
    const lifecycle = await runApplication(state);
    const database = new DatabaseSync(path.join(root, 'qinglong3.sqlite'), {
      readOnly: true,
    });
    let integrity;
    let ownerCount;
    try {
      integrity = database
        .prepare('PRAGMA integrity_check')
        .get().integrity_check;
      ownerCount = database
        .prepare(
          `SELECT COUNT(*) AS count FROM "QingLong3ProjectRoleBindings" WHERE "project_id" = 'default' AND "role" = 'owner' AND "state" = 'active'`,
        )
        .get().count;
    } finally {
      database.close();
    }
    if (integrity !== 'ok' || ownerCount !== 1)
      fail('durable SQLite result is invalid');
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        schema: 'qinglong/local-alpha-trial-kit-live@v1',
        profile: options.profile,
        architecture: images.architecture,
        images: {
          applicationId: images.applicationId,
          operatorId: images.operatorId,
        },
        setup,
        owner,
        lifecycle,
        sqliteIntegrity: integrity,
        activeOwnerBindings: ownerCount,
        operatorNetwork: 'none',
        compatible: true,
      })}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
