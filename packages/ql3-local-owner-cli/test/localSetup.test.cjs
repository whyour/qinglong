const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LocalSetupConfigurationError,
  executeLocalSetup,
} = require('../dist/lifecycle/localSetup.js');

function fixture(t) {
  const deploymentRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-setup-')),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() =>
    fs.rmSync(deploymentRoot, { recursive: true, force: true }),
  );
  const ownerPepperKeyringDirectory = path.join(
    deploymentRoot,
    'owner-peppers',
  );
  const ownerPepperBackupDirectory = path.join(
    deploymentRoot,
    'owner-pepper-backup',
  );
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperBackupDirectory, { mode: 0o700 });
  const command = {
    schemaVersion: 1,
    operation: 'local.setup.prepare',
    options: {
      deploymentRoot,
      databasePath: path.join(deploymentRoot, 'qinglong3.sqlite'),
      profile: 'edge',
      ownerPepperKeyringDirectory,
      ownerPepperBackupDirectory,
      ownerPepperKeyId: 'owner-v1',
      localSecretKeyringPath: path.join(
        deploymentRoot,
        'local-secret-keyring.json',
      ),
      busyTimeoutMs: 100,
    },
    request: {
      registerMutationId: '00000000-0000-4000-8000-000000000f01',
      activateMutationId: '00000000-0000-4000-8000-000000000f02',
      registeredAtMs: 1_000,
      activatedAtMs: 1_001,
    },
  };
  const commandFilePath = path.join(deploymentRoot, 'setup.json');
  fs.writeFileSync(commandFilePath, `${JSON.stringify(command)}\n`, {
    mode: 0o600,
  });
  return { command, commandFilePath, deploymentRoot };
}

test('prepares and exactly replays one fresh local authority set', async (t) => {
  const state = fixture(t);
  const prepared = await executeLocalSetup(state.command);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.ownerPepper.registerStatus, 'inserted');
  assert.equal(prepared.ownerPepper.activateStatus, 'inserted');
  assert.equal(prepared.ownerPepper.generation, 1);
  assert.equal(prepared.envelopeKeyring.keyCount, 1);

  const replay = await executeLocalSetup(state.command);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.ownerPepper.registerStatus, 'existing');
  assert.equal(replay.ownerPepper.activateStatus, 'existing');
  assert.deepEqual(replay.storage, prepared.storage);

  const database = new DatabaseSync(state.command.options.databasePath, {
    readonly: true,
  });
  assert.equal(
    database.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM "QingLong3LocalOwnerPepperKeys"',
      )
      .get().count,
    1,
  );
  database.close();

  const serialized = JSON.stringify([prepared, replay]);
  assert.equal(serialized.includes(state.deploymentRoot), false);
  assert.equal(/token|material|digest/i.test(serialized), false);
});

test('CLI consumes only a private command file and emits a low-sensitivity replay', async (t) => {
  const state = fixture(t);
  const cli = path.resolve(__dirname, '../dist/lifecycle/localSetupCli.js');
  const first = spawnSync(
    process.execPath,
    [cli, 'run', '--command-file', state.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'prepared');

  const second = spawnSync(
    process.execPath,
    [cli, 'run', '--command-file', state.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'existing');
  assert.equal(second.stdout.includes(state.deploymentRoot), false);

  fs.chmodSync(state.commandFilePath, 0o644);
  const rejected = spawnSync(
    process.execPath,
    [cli, 'run', '--command-file', state.commandFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stderr.includes(state.deploymentRoot), false);
});

test('rejects widened or non-private setup authorities before mutation', async (t) => {
  const state = fixture(t);
  await assert.rejects(
    executeLocalSetup({
      ...state.command,
      options: { ...state.command.options, unexpected: true },
    }),
    LocalSetupConfigurationError,
  );
  fs.chmodSync(state.command.options.ownerPepperBackupDirectory, 0o755);
  await assert.rejects(
    executeLocalSetup(state.command),
    LocalSetupConfigurationError,
  );
  assert.equal(fs.existsSync(state.command.options.databasePath), false);
});
