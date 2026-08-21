'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const { migrateLocalSqlitePath } = require('../dist/migration/migration.js');
const {
  checkpointLocalSqliteForRestore,
  createLocalSqliteRolloutBackup,
  inspectLocalSqliteRolloutBackup,
  inspectLocalSqliteSnapshot,
  LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
  openLocalSqliteChangeObserver,
  restoreLocalSqliteSnapshot,
} = require('../dist/readiness/rolloutSafety.js');

function fixture(t, profile = 'edge') {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-rollout-safety-')),
  );
  fs.chmodSync(root, 0o700);
  const backupRoot = path.join(root, 'backups');
  fs.mkdirSync(backupRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    profile,
    databasePath: path.join(root, 'qinglong3.sqlite'),
    backupPath: path.join(backupRoot, 'rollout.sqlite'),
  };
}

test('creates and exactly replays a reviewed rollout backup', async (t) => {
  const state = fixture(t);
  await migrateLocalSqlitePath(state);
  const prepared = await createLocalSqliteRolloutBackup(state);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.contractVersion, 50);
  assert.equal(prepared.writeContractVersion, 50);
  assert.equal(LOCAL_SQLITE_WRITE_CONTRACT_VERSION, 50);
  assert.match(prepared.sha256, /^[0-9a-f]{64}$/);
  assert.equal(prepared.bytes > 0, true);
  assert.equal(prepared.pageCount > 0, true);
  assert.equal(prepared.pageSize >= 512, true);
  assert.equal(fs.statSync(state.backupPath).mode & 0o777, 0o600);

  const replay = await createLocalSqliteRolloutBackup(state);
  assert.deepEqual(replay, { ...prepared, status: 'existing' });
  assert.deepEqual(await inspectLocalSqliteRolloutBackup(state), replay);
  const linkedStagePath = path.join(
    path.dirname(state.backupPath),
    `.${path.basename(state.backupPath)}.ql3-backup-stage`,
  );
  fs.linkSync(state.backupPath, linkedStagePath);
  assert.equal(fs.statSync(state.backupPath).nlink, 2);
  assert.deepEqual(await createLocalSqliteRolloutBackup(state), replay);
  assert.equal(fs.existsSync(linkedStagePath), false);
  assert.equal(fs.statSync(state.backupPath).nlink, 1);

  const source = new DatabaseSync(state.databasePath);
  source.exec('PRAGMA user_version = 7');
  source.close();
  assert.deepEqual(await inspectLocalSqliteRolloutBackup(state), replay);
});

test('observes external commits across an online standalone WAL backup', async (t) => {
  const state = fixture(t, 'standalone');
  await migrateLocalSqlitePath(state);
  const observer = openLocalSqliteChangeObserver(state);
  assert.equal(observer.changed(), false);
  const writer = new DatabaseSync(state.databasePath);
  writer.exec('PRAGMA user_version = 9');
  writer.close();
  assert.equal(observer.changed(), true);
  const backup = await createLocalSqliteRolloutBackup(state);
  assert.equal(backup.status, 'prepared');
  observer.close();
  observer.close();
  assert.throws(() => observer.changed(), /observer is closed/);
});

test('recovers an incomplete stage and cleans a failed backup attempt', async (t) => {
  const state = fixture(t);
  await migrateLocalSqlitePath(state);
  const stagePath = path.join(
    path.dirname(state.backupPath),
    `.${path.basename(state.backupPath)}.ql3-backup-stage`,
  );
  fs.writeFileSync(stagePath, 'incomplete', { mode: 0o600 });
  const recovered = await createLocalSqliteRolloutBackup(state);
  assert.equal(recovered.status, 'prepared');
  assert.equal(fs.existsSync(stagePath), false);

  const failed = fixture(t);
  await migrateLocalSqlitePath(failed);
  const failedStagePath = path.join(
    path.dirname(failed.backupPath),
    `.${path.basename(failed.backupPath)}.ql3-backup-stage`,
  );
  await assert.rejects(
    createLocalSqliteRolloutBackup(failed, {
      async performBackup(_source, target) {
        fs.writeFileSync(target, 'partial', { mode: 0o600 });
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      },
    }),
    /could not be created/,
  );
  assert.equal(fs.existsSync(failed.backupPath), false);
  assert.equal(fs.existsSync(failedStagePath), false);
});

for (const profile of ['edge', 'standalone']) {
  test(`checkpoints and restores one exact ${profile} snapshot`, async (t) => {
    const state = fixture(t, profile);
    await migrateLocalSqlitePath(state);
    const source = await createLocalSqliteRolloutBackup(state);
    const writer = new DatabaseSync(state.databasePath);
    writer.exec('PRAGMA user_version = 19');
    writer.close();
    const current = await checkpointLocalSqliteForRestore(state);
    assert.notEqual(current.sha256, source.sha256);
    assert.deepEqual(await checkpointLocalSqliteForRestore(state), current);
    assert.equal(fs.existsSync(`${state.databasePath}-wal`), false);
    assert.equal(fs.existsSync(`${state.databasePath}-shm`), false);

    const restoreStagePath = path.join(
      state.root,
      `.qinglong3.${profile}.restore-stage`,
    );
    const replacedDatabasePath = path.join(
      path.dirname(state.backupPath),
      `${profile}.replaced.sqlite`,
    );
    const restoreOptions = {
      databasePath: state.databasePath,
      profile,
      sourceSnapshotPath: state.backupPath,
      restoreStagePath,
      replacedDatabasePath,
      expectedCurrentSha256: current.sha256,
      expectedSourceSha256: source.sha256,
    };
    const restored = await restoreLocalSqliteSnapshot(restoreOptions);
    assert.equal(restored.status, 'restored');
    assert.equal(restored.sha256, source.sha256);
    assert.equal(fs.existsSync(restoreStagePath), false);
    assert.equal(fs.existsSync(replacedDatabasePath), false);
    assert.equal(
      (await inspectLocalSqliteSnapshot(state)).sha256,
      source.sha256,
    );
    assert.equal(
      (await restoreLocalSqliteSnapshot(restoreOptions)).status,
      'existing',
    );
  });
}

test('converges the moved-current restore window and cleans ENOSPC stage', async (t) => {
  const state = fixture(t);
  await migrateLocalSqlitePath(state);
  const source = await createLocalSqliteRolloutBackup(state);
  const writer = new DatabaseSync(state.databasePath);
  writer.exec('PRAGMA user_version = 23');
  writer.close();
  const current = await checkpointLocalSqliteForRestore(state);
  const restoreStagePath = path.join(state.root, '.restore-stage');
  const replacedDatabasePath = path.join(
    path.dirname(state.backupPath),
    'replaced.sqlite',
  );
  const restoreOptions = {
    databasePath: state.databasePath,
    profile: state.profile,
    sourceSnapshotPath: state.backupPath,
    restoreStagePath,
    replacedDatabasePath,
    expectedCurrentSha256: current.sha256,
    expectedSourceSha256: source.sha256,
  };
  await assert.rejects(
    restoreLocalSqliteSnapshot(restoreOptions, {
      copySnapshot(_sourcePath, targetPath) {
        fs.writeFileSync(targetPath, 'partial', { mode: 0o600 });
        throw Object.assign(new Error('injected restore ENOSPC'), {
          code: 'ENOSPC',
        });
      },
    }),
    /restore stage could not be created/,
  );
  assert.equal(fs.existsSync(restoreStagePath), false);
  assert.equal(
    (await inspectLocalSqliteSnapshot(state)).sha256,
    current.sha256,
  );

  fs.copyFileSync(state.backupPath, restoreStagePath);
  fs.chmodSync(restoreStagePath, 0o600);
  fs.renameSync(state.databasePath, replacedDatabasePath);
  const recovered = await restoreLocalSqliteSnapshot(restoreOptions);
  assert.equal(recovered.status, 'restored');
  assert.equal(recovered.sha256, source.sha256);
  assert.equal(fs.existsSync(replacedDatabasePath), false);
});

test('rollout safety subpath excludes DDL and mutable repositories', () => {
  const script = `
    const safety = require(${JSON.stringify(
      path.resolve(__dirname, '../dist/readiness/rolloutSafety.js'),
    )});
    const loaded = Object.keys(require.cache)
      .filter((entry) =>
        /[\\/]migrations[\\/]|[\\/]migration\\.js$|runRepository\\.js$|pluginPackageInstallRepository\\.js$/.test(entry),
      );
    process.stdout.write(JSON.stringify({
      backup: typeof safety.createLocalSqliteRolloutBackup,
      checkpoint: typeof safety.checkpointLocalSqliteForRestore,
      observer: typeof safety.openLocalSqliteChangeObserver,
      restore: typeof safety.restoreLocalSqliteSnapshot,
      loaded,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    backup: 'function',
    checkpoint: 'function',
    observer: 'function',
    restore: 'function',
    loaded: [],
  });
});
