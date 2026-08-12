'use strict';

const { execFileSync } = require('node:child_process');

const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u;
const ENTRYPOINT = [
  'node',
  '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js',
];
const COMMANDS = Object.freeze([
  Object.freeze({
    name: 'package',
    usage: 'Usage: ql3-plugin-package-client ',
  }),
  Object.freeze({
    name: 'package-kubernetes',
    usage: 'Usage: ql3-plugin-package-client-kubernetes ',
  }),
  Object.freeze({
    name: 'worker-credential',
    usage: 'Usage: ql3-worker-credential-client ',
  }),
  Object.freeze({ name: 'approval', usage: 'Usage: ql3-approval-client ' }),
  Object.freeze({ name: 'run', usage: 'Usage: ql3-run-client ' }),
  Object.freeze({ name: 'automation', usage: 'Usage: ql3-automation-client ' }),
  Object.freeze({
    name: 'model-credential',
    usage: 'Usage: ql3-provider-credential-client ',
  }),
]);

function fail(message) {
  throw new Error(`ql3 Cluster Admin product live contract failed: ${message}`);
}

function parseArguments(argv) {
  if (argv.length !== 1) fail('exactly one --image argument is required');
  const match = /^--image=(.+)$/u.exec(argv[0]);
  if (!match || !IMAGE_PATTERN.test(match[1]))
    fail('image argument is invalid');
  return match[1];
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runImage(image, args) {
  return docker([
    'run',
    '--rm',
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '10001:10001',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--cpus',
    '0.25',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=8m,mode=700',
    image,
    ...args,
  ]);
}

function main() {
  if (process.env.QL3_CLUSTER_ADMIN_PRODUCT_LIVE !== '1') {
    fail('QL3_CLUSTER_ADMIN_PRODUCT_LIVE=1 is required');
  }
  const image = parseArguments(process.argv.slice(2));
  const inspected = JSON.parse(docker(['image', 'inspect', image]));
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    fail('image inspection shape is invalid');
  }
  const fact = inspected[0];
  if (
    fact?.Os !== 'linux' ||
    (fact?.Architecture !== 'amd64' && fact?.Architecture !== 'arm64') ||
    fact?.Config?.User !== '10001:10001' ||
    JSON.stringify(fact?.Config?.Entrypoint) !== JSON.stringify(ENTRYPOINT) ||
    !Number.isSafeInteger(fact?.Size) ||
    fact.Size <= 0
  ) {
    fail('image platform, identity, entrypoint or size contract drifted');
  }

  const help = runImage(image, ['--help']);
  if (
    !help.startsWith('Usage: ql3-cluster-admin <command> [arguments]\n') ||
    !help.includes(
      'Server, migration, recovery, executor and key-custody authorities remain isolated.',
    )
  ) {
    fail('product help contract drifted');
  }
  for (const { name, usage } of COMMANDS) {
    const output = runImage(image, [name, '--help']);
    if (!output.startsWith(usage)) {
      fail(`${name} delegation contract drifted`);
    }
  }
  const version = runImage(image, ['--version']).trim();
  if (version !== '3.0.0-alpha.0') fail('product version contract drifted');

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      image,
      architecture: fact.Architecture,
      user: fact.Config.User,
      imageBytes: fact.Size,
      commandCount: COMMANDS.length,
      isolation: Object.freeze({
        readOnlyRoot: true,
        network: 'none',
        capabilities: 'none',
        noNewPrivileges: true,
        pids: 32,
        memoryBytes: 128 * 1024 * 1024,
        cpus: 0.25,
      }),
      compatible: true,
    })}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'unknown failure'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = { parseArguments };
