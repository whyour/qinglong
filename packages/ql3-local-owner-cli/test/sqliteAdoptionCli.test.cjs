const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  bootstrapLocalAdoptedProfileStorage,
} = require('@qinglong/local-admin/adopted-profile');
const {
  readTargetDataReconciliationEvidenceForPaths,
} = require('../dist/deployment/cutover/targetDataEvidence');

const BINARY = path.join(__dirname, '../dist/lifecycle/adoptionCli.js');

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createLegacyDatabase(sourcePath) {
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE "Crontabs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255),
      command VARCHAR(255), schedule VARCHAR(255), timestamp VARCHAR(255),
      saved TINYINT(1), status DECIMAL, isSystem DECIMAL, pid DECIMAL,
      isDisabled DECIMAL, isPinned DECIMAL, log_path VARCHAR(255), labels JSON,
      last_running_time DECIMAL, last_execution_time DECIMAL, sub_id DECIMAL,
      extra_schedules JSON, task_before VARCHAR(255), task_after VARCHAR(255),
      log_name VARCHAR(255), allow_multiple_instances DECIMAL,
      work_dir VARCHAR(255), createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "Dependences" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), type DECIMAL,
      timestamp VARCHAR(255), status DECIMAL, log JSON, remark VARCHAR(255),
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "Apps" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), scopes JSON,
      client_id VARCHAR(255), client_secret VARCHAR(255), tokens JSON,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "Auths" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ip VARCHAR(255), type VARCHAR(255),
      info JSON, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "Envs" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, value VARCHAR(255),
      timestamp VARCHAR(255), status DECIMAL, position DECIMAL,
      name VARCHAR(255), remarks VARCHAR(255), isPinned DECIMAL, labels JSON,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "Subscriptions" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), url VARCHAR(255),
      schedule VARCHAR(255), interval_schedule JSON, type VARCHAR(255),
      whitelist VARCHAR(255), blacklist VARCHAR(255), status DECIMAL,
      dependences VARCHAR(255), extensions VARCHAR(255), sub_before VARCHAR(255),
      sub_after VARCHAR(255), branch VARCHAR(255), pull_type VARCHAR(255),
      pull_option JSON, pid DECIMAL, is_disabled DECIMAL, log_path VARCHAR(255),
      schedule_type VARCHAR(255), alias VARCHAR(255), proxy VARCHAR(255),
      autoAddCron DECIMAL, autoDelCron DECIMAL,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "CrontabViews" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255), position DECIMAL,
      isDisabled DECIMAL, filters JSON, sorts JSON, filterRelation VARCHAR(255),
      type DECIMAL, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "CrontabStats" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ref_id DECIMAL NOT NULL,
      date VARCHAR(255) NOT NULL, run_count DECIMAL, success_count DECIMAL,
      fail_count DECIMAL, total_time DECIMAL, max_time DECIMAL,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "RunningInstances" (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cron_id DECIMAL NOT NULL,
      run_id VARCHAR(36), attempt_id VARCHAR(36), pid DECIMAL,
      log_path VARCHAR(255), started_at DECIMAL NOT NULL, finished_at DECIMAL,
      status DECIMAL NOT NULL, exit_code DECIMAL,
      createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL
    );
    CREATE TABLE "PluginOwnedState" (
      id INTEGER PRIMARY KEY, payload TEXT NOT NULL
    );
    INSERT INTO "Crontabs" (
      id, name, command, schedule, status, isDisabled, isPinned,
      createdAt, updatedAt
    ) VALUES (
      1, 'Production-shaped legacy task', 'task /scripts/legacy.sh',
      '0 0 * * *', 1, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Envs" (
      id, name, value, status, position, createdAt, updatedAt
    ) VALUES (
      1, 'LEGACY_VALUE', 'preserved', 0, 100,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Auths" (
      id, type, info, createdAt, updatedAt
    ) VALUES (
      1, 'systemConfig', '{"timezone":"UTC"}',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Apps" (
      id, name, scopes, client_id, client_secret, createdAt, updatedAt
    ) VALUES (
      1, 'legacy-app', '["crons"]', 'legacy-client', 'legacy-secret',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Subscriptions" (
      id, name, alias, url, schedule, createdAt, updatedAt
    ) VALUES (
      1, 'legacy-subscription', 'legacy-subscription',
      'https://example.invalid/repo.git', '0 1 * * *',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "PluginOwnedState" (id, payload)
      VALUES (1, '{"preserved":true}');
  `);
  source.close();
  fs.chmodSync(sourcePath, 0o600);
}

function fixture(t) {
  const deploymentRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-sqlite-upgrade-')),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const artifactsDirectory = path.join(deploymentRoot, 'artifacts');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(artifactsDirectory, { mode: 0o700 });
  const value = {
    deploymentRoot,
    commandsDirectory,
    sourcePath: path.join(deploymentRoot, 'database.sqlite'),
    targetPath: path.join(artifactsDirectory, 'qinglong3.sqlite'),
    recoveryPath: path.join(artifactsDirectory, 'database.pre-ql3.sqlite'),
    manifestPath: path.join(artifactsDirectory, 'qinglong3-adoption.json'),
    activationPath: path.join(artifactsDirectory, 'qinglong3-activation.json'),
  };
  createLegacyDatabase(value.sourcePath);
  return value;
}

function runCommand(value, name, operation, options) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({ schemaVersion: 1, operation, options })}\n`,
    { mode: 0o600 },
  );
  const child = spawnSync(
    process.execPath,
    [BINARY, 'run', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

function baseOptions(value) {
  return {
    deploymentRoot: value.deploymentRoot,
    profile: 'edge',
  };
}

function prepareAdoption(t) {
  const value = fixture(t);
  const sourceBefore = sha256(value.sourcePath);
  const inspected = runCommand(
    value,
    'inspect',
    'local-sqlite.adoption.inspect',
    {
      ...baseOptions(value),
      sourcePath: value.sourcePath,
      legacyTimezone: 'UTC',
    },
  );
  const staged = runCommand(value, 'stage', 'local-sqlite.adoption.stage', {
    ...baseOptions(value),
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    recoveryPath: value.recoveryPath,
    manifestPath: value.manifestPath,
    expectedPlanDigest: inspected.evidence.planDigest,
    legacyTimezone: 'UTC',
  });
  const verified = runCommand(value, 'verify', 'local-sqlite.adoption.verify', {
    ...baseOptions(value),
    targetPath: value.targetPath,
    recoveryPath: value.recoveryPath,
    manifestPath: value.manifestPath,
  });
  const prepared = runCommand(
    value,
    'prepare',
    'local-sqlite.activation.prepare',
    {
      ...baseOptions(value),
      sourcePath: value.sourcePath,
      targetPath: value.targetPath,
      recoveryPath: value.recoveryPath,
      manifestPath: value.manifestPath,
      activationPath: value.activationPath,
      expectedManifestDigest: verified.evidence.manifestDigest,
    },
  );
  assert.equal(inspected.status, 'inspected');
  assert.deepEqual(inspected.evidence.catalog.tableNames, [
    'Apps',
    'Auths',
    'CrontabStats',
    'CrontabViews',
    'Crontabs',
    'Dependences',
    'Envs',
    'PluginOwnedState',
    'RunningInstances',
    'Subscriptions',
    'sqlite_sequence',
  ]);
  assert.equal(staged.status, 'staged');
  assert.equal(verified.status, 'verified');
  assert.equal(prepared.status, 'prepared');
  assert.equal(sha256(value.sourcePath), sourceBefore);
  for (const outputPath of [
    value.targetPath,
    value.recoveryPath,
    value.manifestPath,
    value.activationPath,
  ]) {
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  }
  return {
    ...value,
    sourceBefore,
    activationDigest: prepared.evidence.activationDigest,
  };
}

async function startAdoptedStorage(value) {
  return bootstrapLocalAdoptedProfileStorage({
    enabled: true,
    profile: 'edge',
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    recoveryPath: value.recoveryPath,
    manifestPath: value.manifestPath,
    activationPath: value.activationPath,
    expectedActivationDigest: value.activationDigest,
    busyTimeoutMs: 100,
    audit() {},
    adoptionAudit() {},
  });
}

function reconciliation(value) {
  return readTargetDataReconciliationEvidenceForPaths(
    {
      profile: 'edge',
      activationPath: value.activationPath,
      legacySourcePath: value.sourcePath,
      targetDatabasePath: value.targetPath,
      expectedActivationDigest: value.activationDigest,
    },
    process.getuid(),
  );
}

test('upgrades a production-shaped 2.x SQLite database and admits clean rollback', async (t) => {
  const value = prepareAdoption(t);
  const recovery = new DatabaseSync(value.recoveryPath, { readOnly: true });
  assert.equal(
    recovery
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE name LIKE 'QingLong3%'`,
      )
      .get().count,
    0,
  );
  assert.equal(
    recovery.prepare('SELECT payload FROM "PluginOwnedState"').get().payload,
    '{"preserved":true}',
  );
  recovery.close();

  const target = new DatabaseSync(value.targetPath, { readOnly: true });
  assert.equal(
    target.prepare('SELECT COUNT(*) AS count FROM "Crontabs"').get().count,
    1,
  );
  assert.equal(
    target.prepare('SELECT value FROM "Envs" WHERE id = 1').get().value,
    'preserved',
  );
  assert.ok(
    target
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'QingLong3%'`,
      )
      .get().count > 0,
  );
  target.close();

  const storage = await startAdoptedStorage(value);
  assert.equal(storage.status, 'adopted_storage_ready');
  const legacyWriter = new DatabaseSync(value.sourcePath, { timeout: 100 });
  assert.throws(
    () =>
      legacyWriter
        .prepare(
          `INSERT INTO "Envs" (
             name, value, createdAt, updatedAt
           ) VALUES ('BLOCKED', 'blocked', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run(),
    (error) => error && error.errstr === 'database is locked',
  );
  await storage.stop();
  const cleanEvidence = reconciliation(value);
  assert.equal(
    cleanEvidence.disposition,
    'rollback_candidate',
    JSON.stringify(cleanEvidence),
  );
  legacyWriter
    .prepare(
      `INSERT INTO "Envs" (
         name, value, createdAt, updatedAt
       ) VALUES ('AFTER_ROLLBACK', 'released', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run();
  legacyWriter.close();
  const rolledBack = new DatabaseSync(value.sourcePath, { readOnly: true });
  assert.equal(
    rolledBack
      .prepare(`SELECT value FROM "Envs" WHERE name = 'AFTER_ROLLBACK'`)
      .get().value,
    'released',
  );
  rolledBack.close();
});

test('requires reconciliation after the adopted target accepts a Run', async (t) => {
  const value = prepareAdoption(t);
  const storage = await startAdoptedStorage(value);
  assert.equal(storage.status, 'adopted_storage_ready');
  await storage.runs.transaction((transaction) =>
    transaction.insertRun({
      id: '019f9a00-0000-4000-a000-000000000383',
      projectId: 'default',
      taskId: 'legacy-cron:1',
      taskRevision: 'revision-1',
      taskName: 'D383 reconciliation proof',
      legacyCronId: 1,
      triggerType: 'manual',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      triggeredBy: 'user:1',
      status: 'created',
      version: 0,
      eventSequence: 0,
      priority: 0,
      createdAtMs: 1_760_000_000_383,
    }),
  );
  await storage.stop();

  const evidence = reconciliation(value);
  assert.equal(evidence.disposition, 'reconciliation_required');
  assert.equal(evidence.targetMatchesActivation, false);
  assert.equal(
    evidence.sourceMatchesActivation,
    true,
    JSON.stringify(evidence),
  );
  assert.equal(sha256(value.sourcePath), value.sourceBefore);
  const source = new DatabaseSync(value.sourcePath, { readOnly: true });
  assert.equal(
    source
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE name = 'QingLong3Runs'`,
      )
      .get().count,
    0,
  );
  source.close();
});

test('rejects widened SQLite adoption command intent before inspection', (t) => {
  const value = fixture(t);
  const commandPath = path.join(value.commandsDirectory, 'widened.json');
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'local-sqlite.adoption.inspect',
      options: {
        ...baseOptions(value),
        sourcePath: value.sourcePath,
        extraAuthority: true,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const child = spawnSync(
    process.execPath,
    [BINARY, 'run', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(
    JSON.parse(child.stderr).code,
    'LOCAL_SQLITE_ADOPTION_CLI_CONFIGURATION_INVALID',
  );
});
