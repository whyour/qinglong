const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const moduleDirectory = path.join(packageRoot, 'dist', 'product-cli');
const cliPath = path.join(moduleDirectory, 'cli.js');
const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
);
const {
  QINGLONG3_CLUSTER_PRODUCT_COMMANDS,
  loadQingLong3ClusterProductVersion,
  qingLong3ClusterProductHelp,
  resolveQingLong3ClusterProductCommand,
} = require('../dist/product-cli/productCommand.js');
const {
  clusterProductSignalExitCode,
  forwardClusterProductSignals,
} = require('../dist/product-cli/cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

test('catalog exposes only reviewed remote clients from the same package', () => {
  assert.equal(manifest.bin['ql3-cluster-admin'], 'dist/product-cli/cli.js');
  assert.equal(QINGLONG3_CLUSTER_PRODUCT_COMMANDS.length, 7);
  assert.equal(
    new Set(QINGLONG3_CLUSTER_PRODUCT_COMMANDS.map(({ name }) => name)).size,
    QINGLONG3_CLUSTER_PRODUCT_COMMANDS.length,
  );
  assert.equal(
    new Set(QINGLONG3_CLUSTER_PRODUCT_COMMANDS.map(({ binary }) => binary))
      .size,
    QINGLONG3_CLUSTER_PRODUCT_COMMANDS.length,
  );
  for (const command of QINGLONG3_CLUSTER_PRODUCT_COMMANDS) {
    assert.equal(manifest.bin[command.binary], `dist/${command.target}`);
    assert.equal(
      fs.lstatSync(path.join(packageRoot, 'dist', command.target)).isFile(),
      true,
    );
    assert.equal(command.binary.includes('-client'), true);
  }
  for (const forbidden of [
    'ql3-cluster-migrate',
    'ql3-plugin-package-recover',
    'ql3-plugin-package-manage',
    'ql3-plugin-package-execute',
    'ql3-worker-credential-manage',
    'ql3-worker-credential-execute',
    'ql3-prompt-output-key-rotate',
    'ql3-prompt-output-gc',
  ]) {
    assert.equal(
      QINGLONG3_CLUSTER_PRODUCT_COMMANDS.some(
        ({ binary }) => binary === forbidden,
      ),
      false,
    );
  }
});

test('help and version are bounded installation-derived product facts', () => {
  const help = qingLong3ClusterProductHelp();
  assert.match(help, /^Usage: ql3-cluster-admin <command> \[arguments\]/);
  assert.match(help, /\n  run\s+retry or stop Runs/);
  assert.match(help, /Server, migration, recovery, executor and key-custody/);
  assert.equal(help.includes('plugin-package-manage'), false);
  assert.equal(
    loadQingLong3ClusterProductVersion(moduleDirectory),
    manifest.version,
  );
  assert.deepEqual(resolveQingLong3ClusterProductCommand([], moduleDirectory), {
    kind: 'help',
    output: help,
  });
  assert.deepEqual(
    resolveQingLong3ClusterProductCommand(['--version'], moduleDirectory),
    { kind: 'version', output: manifest.version },
  );
});

test('resolves only static remote-client targets and preserves opaque arguments', () => {
  const argv = [
    'run',
    '--config=/private/client config.json',
    '--literal=$() && *',
  ];
  const result = resolveQingLong3ClusterProductCommand(argv, moduleDirectory);
  assert.equal(result.kind, 'invoke');
  assert.equal(result.command.binary, 'ql3-run-client');
  assert.equal(
    result.targetFilePath,
    path.join(
      packageRoot,
      'dist',
      'run-management',
      'runManagementClientCli.js',
    ),
  );
  assert.deepEqual(result.argv, argv.slice(1));
  assert.equal(Object.isFrozen(result.argv), true);
  assert.equal(Object.isFrozen(result), true);

  for (const candidate of [
    '../../tmp/owned',
    '/absolute/command',
    'run/../../owned',
    'run-manage',
    'migrate',
    'execute',
  ]) {
    const rejected = resolveQingLong3ClusterProductCommand(
      [candidate, '--help'],
      moduleDirectory,
    );
    assert.equal(rejected.kind, 'invalid');
    assert.equal(rejected.code, 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID');
  }
});

test('rejects symlink targets and package manifests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-cluster-product-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakePackageRoot = path.join(root, 'package');
  const fakeModuleDirectory = path.join(fakePackageRoot, 'dist', 'product-cli');
  const targetDirectory = path.join(fakePackageRoot, 'dist', 'run-management');
  fs.mkdirSync(fakeModuleDirectory, { recursive: true });
  fs.mkdirSync(targetDirectory, { recursive: true });
  const external = path.join(root, 'external.js');
  fs.writeFileSync(external, 'process.exit(0);\n');
  fs.symlinkSync(
    external,
    path.join(targetDirectory, 'runManagementClientCli.js'),
  );
  assert.throws(
    () =>
      resolveQingLong3ClusterProductCommand(
        ['run', '--help'],
        fakeModuleDirectory,
      ),
    /unavailable/,
  );

  fs.writeFileSync(
    path.join(fakePackageRoot, 'package.real.json'),
    JSON.stringify({ name: '@qinglong/cluster-admin', version: '3.0.0' }),
  );
  fs.symlinkSync(
    path.join(fakePackageRoot, 'package.real.json'),
    path.join(fakePackageRoot, 'package.json'),
  );
  assert.throws(
    () => loadQingLong3ClusterProductVersion(fakeModuleDirectory),
    /unavailable/,
  );
});

test('binary exposes help/version and delegates without a shell', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3-cluster-admin <command>/);
  assert.equal(help.stderr, '');

  const version = runCli(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), manifest.version);
  assert.equal(version.stderr, '');

  const delegatedHelp = runCli(['run', '--help']);
  assert.equal(delegatedHelp.status, 0);
  assert.match(delegatedHelp.stdout, /^Usage: ql3-run-client /);
  assert.equal(delegatedHelp.stderr, '');

  const rejected = runCli(['../../tmp/not-a-command']);
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout, '');
  const failure = JSON.parse(rejected.stderr);
  assert.equal(failure.code, 'QL3_CLUSTER_PRODUCT_CLI_USAGE_INVALID');
  assert.equal(JSON.stringify(failure).includes('/tmp'), false);
});

test('forwards only bounded signals and removes handlers', () => {
  const signalHost = new EventEmitter();
  const received = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      received.push(signal);
      return true;
    },
  };
  const remove = forwardClusterProductSignals(child, signalHost);
  signalHost.emit('SIGINT');
  signalHost.emit('SIGTERM');
  signalHost.emit('SIGHUP');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  assert.equal(clusterProductSignalExitCode('SIGINT'), 130);
  assert.equal(clusterProductSignalExitCode('SIGTERM'), 143);
  remove();
  signalHost.emit('SIGTERM');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);

  child.exitCode = 0;
  const removeTerminal = forwardClusterProductSignals(child, signalHost);
  signalHost.emit('SIGTERM');
  removeTerminal();
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);
});
