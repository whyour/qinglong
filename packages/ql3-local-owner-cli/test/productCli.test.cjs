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
  QINGLONG3_PRODUCT_COMMANDS,
  loadQingLong3ProductVersion,
  qingLong3ProductHelp,
  resolveQingLong3ProductCommand,
} = require('../dist/product-cli/productCommand.js');
const {
  forwardSignals,
  signalExitCode,
} = require('../dist/product-cli/cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

test('catalog maps every product subcommand to an existing same-package binary', () => {
  assert.equal(manifest.bin.ql3, 'dist/product-cli/cli.js');
  assert.equal(QINGLONG3_PRODUCT_COMMANDS.length, 20);
  assert.equal(
    new Set(QINGLONG3_PRODUCT_COMMANDS.map(({ name }) => name)).size,
    QINGLONG3_PRODUCT_COMMANDS.length,
  );
  assert.equal(
    new Set(QINGLONG3_PRODUCT_COMMANDS.map(({ binary }) => binary)).size,
    QINGLONG3_PRODUCT_COMMANDS.length,
  );
  assert.equal(
    QINGLONG3_PRODUCT_COMMANDS.some(
      ({ binary }) => binary === 'ql3-service-bridge',
    ),
    false,
  );
  for (const command of QINGLONG3_PRODUCT_COMMANDS) {
    assert.equal(manifest.bin[command.binary], `dist/${command.target}`);
    assert.equal(
      fs.statSync(path.join(packageRoot, 'dist', command.target)).isFile(),
      true,
    );
  }
});

test('help and version are bounded installation-derived product facts', () => {
  const help = qingLong3ProductHelp();
  assert.match(help, /^Usage: ql3 <command> \[arguments\]/);
  assert.match(help, /\n  task\s+manage Task definitions\n/);
  assert.match(help, /Root service mutation remains isolated/);
  assert.equal(help.includes('ql3-service-bridge  '), false);
  assert.equal(loadQingLong3ProductVersion(moduleDirectory), manifest.version);
  assert.deepEqual(resolveQingLong3ProductCommand([], moduleDirectory), {
    kind: 'help',
    output: help,
  });
  assert.deepEqual(
    resolveQingLong3ProductCommand(['--version'], moduleDirectory),
    { kind: 'version', output: manifest.version },
  );
});

test('resolves only a static target and preserves opaque child arguments', () => {
  const argv = [
    'task',
    'run',
    '--command-file',
    '/private/operator command.json',
    '--literal=$() && *',
  ];
  const result = resolveQingLong3ProductCommand(argv, moduleDirectory);
  assert.equal(result.kind, 'invoke');
  assert.equal(result.command.binary, 'ql3-task');
  assert.equal(
    result.targetFilePath,
    path.join(
      packageRoot,
      'dist',
      'automation-management',
      'taskDefinitionCli.js',
    ),
  );
  assert.deepEqual(result.argv, argv.slice(1));
  assert.equal(Object.isFrozen(result.argv), true);
  assert.equal(Object.isFrozen(result), true);

  for (const candidate of [
    '../../tmp/owned',
    '/absolute/command',
    'task/../../owned',
    'service-bridge',
  ]) {
    const rejected = resolveQingLong3ProductCommand(
      [candidate, '--help'],
      moduleDirectory,
    );
    assert.equal(rejected.kind, 'invalid');
    assert.equal(rejected.code, 'QL3_PRODUCT_CLI_USAGE_INVALID');
  }
});

test('rejects a catalog target that escapes through a symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-product-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeModuleDirectory = path.join(root, 'package', 'dist', 'product-cli');
  const targetDirectory = path.join(
    root,
    'package',
    'dist',
    'automation-management',
  );
  fs.mkdirSync(fakeModuleDirectory, { recursive: true });
  fs.mkdirSync(targetDirectory, { recursive: true });
  const external = path.join(root, 'external.js');
  fs.writeFileSync(external, 'process.exit(0);\n');
  fs.symlinkSync(external, path.join(targetDirectory, 'taskDefinitionCli.js'));
  assert.throws(
    () =>
      resolveQingLong3ProductCommand(['task', '--help'], fakeModuleDirectory),
    /canonical package root/,
  );
});

test('product binary exposes help/version and delegates without a shell', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ql3 <command>/);
  assert.equal(help.stderr, '');

  const version = runCli(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), manifest.version);
  assert.equal(version.stderr, '');

  const delegatedHelp = runCli(['task', '--help']);
  assert.equal(delegatedHelp.status, 0);
  assert.equal(
    delegatedHelp.stdout.trim(),
    'Usage: ql3-task run --command-file /absolute/private-command.json',
  );
  assert.equal(delegatedHelp.stderr, '');

  const delegatedFailure = runCli(['task']);
  assert.equal(delegatedFailure.status, 64);
  assert.equal(delegatedFailure.stdout, '');
  assert.equal(
    JSON.parse(delegatedFailure.stderr).code,
    'LOCAL_TASK_DEFINITION_CLI_USAGE_INVALID',
  );

  const rejected = runCli(['../../tmp/not-a-command']);
  assert.equal(rejected.status, 64);
  assert.equal(rejected.stdout, '');
  const failure = JSON.parse(rejected.stderr);
  assert.equal(failure.code, 'QL3_PRODUCT_CLI_USAGE_INVALID');
  assert.equal(JSON.stringify(failure).includes('/tmp'), false);
});

test('forwards only bounded signals to the active child and removes handlers', () => {
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
  const remove = forwardSignals(child, signalHost);
  signalHost.emit('SIGINT');
  signalHost.emit('SIGTERM');
  signalHost.emit('SIGHUP');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  assert.equal(signalExitCode('SIGINT'), 130);
  assert.equal(signalExitCode('SIGTERM'), 143);
  remove();
  signalHost.emit('SIGTERM');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);

  child.exitCode = 0;
  const removeTerminal = forwardSignals(child, signalHost);
  signalHost.emit('SIGTERM');
  removeTerminal();
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGHUP']);
});
