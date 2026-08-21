const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalReadinessConfigurationError,
  LocalReadinessIncompatibleError,
  inspectLocalReadiness,
  parseLocalReadinessArguments,
} = require('../dist/lifecycle/localReadiness.js');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');

async function fixture(t, profile = 'edge') {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-readiness-')),
  );
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'qinglong3.sqlite');
  await migrateLocalSqlitePath({ databasePath, profile, busyTimeoutMs: 100 });
  return { databasePath, directory, profile };
}

test('inspects the exact fresh Profile schema without exposing its path', async (t) => {
  const state = await fixture(t);
  const result = await inspectLocalReadiness({
    databasePath: state.databasePath,
    profile: state.profile,
    busyTimeoutMs: 100,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.profile, 'edge');
  assert.equal(result.storage.contractName, 'local-control-core');
  assert.equal(result.storage.contractVersion, 50);
  assert.equal(result.storage.migrationCount, 100);
  assert.equal(result.storage.journalMode, 'delete');
  assert.equal(JSON.stringify(result).includes(state.directory), false);
});

test('CLI is explicit, content-free and rejects a non-private database', async (t) => {
  const state = await fixture(t, 'standalone');
  const cli = path.resolve(__dirname, '../dist/lifecycle/localReadinessCli.js');
  const args = [
    cli,
    `--database=${state.databasePath}`,
    '--profile=standalone',
    '--busy-timeout-ms=100',
  ];
  const accepted = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.storage.journalMode, 'wal');
  assert.equal(accepted.stdout.includes(state.directory), false);

  fs.chmodSync(state.databasePath, 0o644);
  const rejected = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.equal(
    JSON.parse(rejected.stderr).code,
    'QL3_LOCAL_READINESS_CONFIGURATION_INVALID',
  );
  assert.equal(rejected.stderr.includes(state.directory), false);
});

test('rejects implicit, duplicated or cross-Profile inspection', async (t) => {
  assert.throws(
    () => parseLocalReadinessArguments([]),
    LocalReadinessConfigurationError,
  );
  assert.deepEqual(
    parseLocalReadinessArguments([
      '--',
      '--database=/private/a.sqlite',
      '--profile=edge',
    ]),
    {
      databasePath: '/private/a.sqlite',
      profile: 'edge',
    },
  );
  assert.throws(
    () =>
      parseLocalReadinessArguments([
        '--database=/private/a.sqlite',
        '--database=/private/b.sqlite',
        '--profile=edge',
      ]),
    LocalReadinessConfigurationError,
  );
  const state = await fixture(t, 'edge');
  await assert.rejects(
    inspectLocalReadiness({
      databasePath: state.databasePath,
      profile: 'standalone',
      busyTimeoutMs: 100,
    }),
    LocalReadinessIncompatibleError,
  );
});
