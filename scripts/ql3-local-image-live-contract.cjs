#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const MAX_OUTPUT_BYTES = 64 * 1024;
const ACTIVE_TIMEOUT_MS = 45_000;

function fail(message) {
  throw new Error(`QingLong local image live contract failed: ${message}`);
}

function imageArgument(argv) {
  if (
    argv.length < 1 ||
    argv.length > 2 ||
    !argv[0].startsWith('--image=')
  ) {
    fail('usage: --image=immutable-local-image [--profile=edge|standalone]');
  }
  const image = argv[0].slice('--image='.length);
  if (
    image.length < 1 ||
    image.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]+$/.test(image)
  ) {
    fail('image argument is invalid');
  }
  return image;
}

function profileArgument(argv) {
  if (argv.length === 1) return 'edge';
  if (argv[1] === '--profile=edge') return 'edge';
  if (argv[1] === '--profile=standalone') return 'standalone';
  fail('profile argument is invalid');
}

function runDocker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `docker ${args[0]} failed with ${result.status}: ${(
        result.stderr || result.stdout
      )
        .trim()
        .slice(0, 2048)}`,
    );
  }
  return result.stdout.trim();
}

function inspectImage(image) {
  const output = runDocker([
    'image',
    'inspect',
    '--format',
    '{{.Id}} {{.Architecture}} {{.Config.User}}',
    image,
  ]);
  const match = /^(sha256:[0-9a-f]{64}) (amd64|arm64) (65532:65532)$/.exec(
    output,
  );
  if (!match) fail('image identity, architecture or default user drifted');
  return Object.freeze({
    id: match[1],
    architecture: match[2],
    user: match[3],
  });
}

function parseLines(buffer, events) {
  let remaining = buffer;
  while (remaining.includes('\n')) {
    const index = remaining.indexOf('\n');
    const line = remaining.slice(0, index);
    remaining = remaining.slice(index + 1);
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail('application emitted non-JSON stdout');
    }
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      typeof record.event !== 'string'
    ) {
      fail('application event shape is invalid');
    }
    events.push(record);
  }
  return remaining;
}

async function runApplication(
  image,
  deploymentRoot,
  uid,
  gid,
  profile,
) {
  const containerName = `ql3-local-image-${process.pid}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
  const memory = profile === 'edge' ? '128m' : '256m';
  const pids = profile === 'edge' ? 64 : 256;
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      containerName,
      '--read-only',
      '--user',
      `${uid}:${gid}`,
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
      String(pids),
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,noexec,size=16m',
      '--volume',
      `${deploymentRoot}:/var/lib/qinglong3`,
      image,
      '--config',
      '/var/lib/qinglong3/local-application.json',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const events = [];
  let stdout = '';
  let stderr = '';
  let stopped = false;
  let settled = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr, 'utf8') > MAX_OUTPUT_BYTES) {
      child.kill('SIGKILL');
    }
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
      child.kill('SIGKILL');
      return;
    }
    stdout = parseLines(stdout, events);
    if (
      !stopped &&
      events.some(({ event }) => event === 'active')
    ) {
      stopped = true;
      runDocker(['stop', '--time', '30', containerName]);
    }
  });

  try {
    const outcome = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('application did not converge before timeout'));
      }, ACTIVE_TIMEOUT_MS);
      timeout.unref();
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    if (
      outcome.code !== 0 ||
      outcome.signal !== null ||
      stdout !== '' ||
      stderr !== '' ||
      !stopped ||
      !events.some(({ event }) => event === 'active') ||
      !events.some(
        ({ event, signal }) =>
          event === 'shutdown_requested' && signal === 'SIGTERM',
      ) ||
      !events.some(
        ({ event, stopResult }) =>
          event === 'stopped' && stopResult === 'stopped',
      )
    ) {
      fail(
        `application lifecycle drifted: ${JSON.stringify({
          code: outcome.code,
          signal: outcome.signal,
          stderr: stderr.slice(0, 2048),
          events,
        })}`,
      );
    }
    return Object.freeze({
      active: true,
      gracefulStop: true,
      eventCount: events.length,
    });
  } finally {
    spawnSync('docker', ['rm', '--force', containerName], {
      stdio: 'ignore',
    });
  }
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
  const image = imageArgument(process.argv.slice(2));
  const profile = profileArgument(process.argv.slice(2));
  const imageIdentity = inspectImage(image);
  const root = path.resolve(__dirname, '..');
  const {
    prepareLocalDeployment,
  } = require(path.join(
    root,
    'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
  ));
  const temporaryRoot = fs.realpathSync(
    fs.mkdtempSync(
      path.join(os.tmpdir(), 'ql3-local-image-live-'),
    ),
  );
  const deploymentRoot = path.join(temporaryRoot, 'deployment');
  const uid = process.getuid();
  const gid = process.getgid();

  try {
    const setup = await prepareLocalDeployment({
      schemaVersion: 1,
      operation: 'local.deployment.prepare',
      options: {
        deploymentRoot,
        profile,
        instanceId: 'local-image-live',
        busyTimeoutMs: 100,
        service: {
          kind: 'compose',
          image: `local/qinglong3@${imageIdentity.id}`,
          allowRootService: uid === 0,
        },
      },
      request: {
        ownerPepperKeyId: 'owner-v1',
        registerMutationId: '019f8680-143d-4000-8000-000000000001',
        activateMutationId: '019f8680-143d-4000-8000-000000000002',
        registeredAtMs: 1_785_254_400_000,
        activatedAtMs: 1_785_254_400_001,
      },
    });
    if (setup.status !== 'prepared' || setup.profile !== profile) {
      fail('fresh deployment was not prepared');
    }

    const lifecycle = await runApplication(
      image,
      deploymentRoot,
      uid,
      gid,
      profile,
    );
    const database = new DatabaseSync(
      path.join(deploymentRoot, 'qinglong3.sqlite'),
      { readOnly: true },
    );
    let integrity;
    try {
      integrity = database.prepare('PRAGMA integrity_check').get()
        .integrity_check;
    } finally {
      database.close();
    }
    if (integrity !== 'ok') fail('SQLite integrity check failed');

    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        imageId: imageIdentity.id,
        architecture: imageIdentity.architecture,
        user: imageIdentity.user,
        profile,
        memoryBytes:
          (profile === 'edge' ? 128 : 256) * 1024 * 1024,
        pids: profile === 'edge' ? 64 : 256,
        network: 'none',
        readOnlyRoot: true,
        ai: 'excluded',
        lifecycle,
        sqliteIntegrity: integrity,
        compatible: true,
      })}\n`,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
