#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const IMAGE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`QingLong local Compose preflight failed: ${message}`);
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
    (values.profile !== undefined &&
      values.profile !== 'edge' &&
      values.profile !== 'standalone') ||
    typeof values['docker-executable'] !== 'string' ||
    typeof values['docker-socket'] !== 'string'
  ) {
    fail(
      'usage: --image=repository@sha256:digest --docker-executable=/absolute/docker --docker-socket=/absolute/docker.sock [--profile=edge|standalone]',
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
    profile: values.profile ?? 'edge',
    dockerExecutable,
    dockerSocket,
  });
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
  const { prepareLocalDeployment } = require(path.join(
    root,
    'packages/ql3-local-owner-cli/dist/deployment/localDeployment.js',
  ));
  const temporaryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-compose-preflight-')),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const deploymentRoot = path.join(temporaryRoot, 'deployment');
  const commandPath = path.join(temporaryRoot, 'preflight.json');
  const uid = process.getuid();

  try {
    const setup = await prepareLocalDeployment({
      schemaVersion: 1,
      operation: 'local.deployment.prepare',
      options: {
        deploymentRoot,
        profile: input.profile,
        instanceId: 'compose-preflight-live',
        busyTimeoutMs: 100,
        service: {
          kind: 'compose',
          image: input.image,
          allowRootService: uid === 0,
        },
      },
      request: {
        ownerPepperKeyId: 'owner-v1',
        registerMutationId: '019f8680-143d-4000-8000-000000000101',
        activateMutationId: '019f8680-143d-4000-8000-000000000102',
        registeredAtMs: 1_785_254_500_000,
        activatedAtMs: 1_785_254_500_001,
      },
    });
    if (setup.status !== 'prepared' || setup.profile !== input.profile) {
      fail('fresh deployment did not prepare');
    }
    const command = {
      schemaVersion: 1,
      operation: 'local.deployment.compose.preflight',
      options: {
        deploymentRoot,
        dockerExecutable: input.dockerExecutable,
        dockerSocketPath: input.dockerSocket,
        allowRootService: uid === 0,
      },
      request: {
        expectedGeneration: 1,
      },
    };
    fs.writeFileSync(commandPath, `${JSON.stringify(command)}\n`, {
      mode: 0o600,
    });
    const cli = path.join(
      root,
      'packages/ql3-local-owner-cli/dist/deployment/localDeploymentCli.js',
    );
    const result = spawnSync(
      process.execPath,
      [cli, 'compose-preflight', '--command-file', commandPath],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 45_000,
        killSignal: 'SIGKILL',
      },
    );
    if (
      result.error ||
      result.status !== 0 ||
      result.stderr !== '' ||
      typeof result.stdout !== 'string' ||
      result.stdout.includes(deploymentRoot) ||
      /sha256|mutation|socket|executable/i.test(result.stdout)
    ) {
      fail('private CLI did not return a low-sensitive ready result');
    }
    const report = JSON.parse(result.stdout);
    if (
      report.schemaVersion !== 1 ||
      report.operation !== 'local.deployment.compose.preflight' ||
      report.status !== 'ready' ||
      report.generation !== 1 ||
      report.profile !== input.profile ||
      report.sqlite?.contractVersion !== 43 ||
      (report.image?.architecture !== 'amd64' &&
        report.image?.architecture !== 'arm64') ||
      report.service?.kind !== 'compose'
    ) {
      fail('preflight report is incompatible');
    }
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        profile: report.profile,
        generation: report.generation,
        sqliteContractVersion: report.sqlite.contractVersion,
        architecture: report.image.architecture,
        exactRepoDigest: true,
        composeMerge: true,
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
