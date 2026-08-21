const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const BINARY = path.join(__dirname, '../dist/lifecycle/adoptionCli.js');
const DIRECTORY_INSPECT = 'local-data-directory.adoption.inspect';
const DIRECTORY_STAGE = 'local-data-directory.adoption.stage';
const DIRECTORY_VERIFY = 'local-data-directory.adoption.verify';

function privateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(directoryPath, 0o700);
}

function privateFile(filePath, content) {
  privateDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
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
      1, 'Legacy task', 'task /scripts/legacy.sh', '0 0 * * *',
      1, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    INSERT INTO "Envs" (
      id, name, value, status, position, createdAt, updatedAt
    ) VALUES (
      1, 'LEGACY_VALUE', 'preserved', 0, 100,
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
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-directory-stage-')),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const value = {
    deploymentRoot,
    commandsDirectory: path.join(deploymentRoot, 'commands'),
    artifactsDirectory: path.join(deploymentRoot, 'artifacts'),
    stagingParent: path.join(deploymentRoot, 'staging'),
    dataRoot: path.join(deploymentRoot, 'legacy-data'),
  };
  privateDirectory(value.commandsDirectory);
  privateDirectory(value.artifactsDirectory);
  privateDirectory(value.stagingParent);
  privateDirectory(value.dataRoot);
  Object.assign(value, {
    sourcePath: path.join(value.dataRoot, 'db', 'database.sqlite'),
    targetPath: path.join(value.artifactsDirectory, 'qinglong3.sqlite'),
    recoveryPath: path.join(
      value.artifactsDirectory,
      'database.pre-ql3.sqlite',
    ),
    sqliteManifestPath: path.join(
      value.artifactsDirectory,
      'qinglong3-sqlite-adoption.json',
    ),
    activationPath: path.join(
      value.artifactsDirectory,
      'qinglong3-sqlite-activation.json',
    ),
    stagingRoot: path.join(value.stagingParent, 'reviewed-data'),
  });
  privateDirectory(path.dirname(value.sourcePath));
  createLegacyDatabase(value.sourcePath);
  privateFile(path.join(value.dataRoot, 'db', 'keyv.sqlite'), 'legacy-keyv');
  privateFile(path.join(value.dataRoot, 'config', 'config.sh'), 'export A=1\n');
  privateFile(
    path.join(value.dataRoot, 'scripts', 'jobs', 'example.sh'),
    'echo qinglong\n',
  );
  privateFile(
    path.join(value.dataRoot, 'upload', 'avatar.bin'),
    Buffer.from([1, 2, 3]),
  );
  privateFile(
    path.join(value.dataRoot, 'ssh.d', 'repository-key'),
    'private-key',
  );
  privateFile(
    path.join(value.dataRoot, 'repo', 'cache', 'ignored'),
    'regenerate-me',
  );
  privateFile(
    path.join(value.dataRoot, 'log', 'history', 'ignored'),
    'retain-me',
  );
  return value;
}

function runRaw(value, name, operation, options) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({ schemaVersion: 1, operation, options })}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(commandPath, 0o600);
  return spawnSync(
    process.execPath,
    [BINARY, 'run', '--command-file', commandPath],
    { encoding: 'utf8' },
  );
}

function run(value, name, operation, options) {
  const child = runRaw(value, name, operation, options);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  return { child, result: JSON.parse(child.stdout) };
}

function prepare(value) {
  const base = { deploymentRoot: value.deploymentRoot, profile: 'edge' };
  const sqlitePlan = run(
    value,
    'sqlite-inspect',
    'local-sqlite.adoption.inspect',
    { ...base, sourcePath: value.sourcePath, legacyTimezone: 'UTC' },
  ).result;
  run(value, 'sqlite-stage', 'local-sqlite.adoption.stage', {
    ...base,
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    recoveryPath: value.recoveryPath,
    manifestPath: value.sqliteManifestPath,
    expectedPlanDigest: sqlitePlan.evidence.planDigest,
    legacyTimezone: 'UTC',
  });
  const sqliteVerified = run(
    value,
    'sqlite-verify',
    'local-sqlite.adoption.verify',
    {
      ...base,
      targetPath: value.targetPath,
      recoveryPath: value.recoveryPath,
      manifestPath: value.sqliteManifestPath,
    },
  ).result;
  const activation = run(
    value,
    'sqlite-activate',
    'local-sqlite.activation.prepare',
    {
      ...base,
      sourcePath: value.sourcePath,
      targetPath: value.targetPath,
      recoveryPath: value.recoveryPath,
      manifestPath: value.sqliteManifestPath,
      activationPath: value.activationPath,
      expectedManifestDigest: sqliteVerified.evidence.manifestDigest,
    },
  ).result;
  const directoryPlan = run(value, 'directory-inspect', DIRECTORY_INSPECT, {
    dataRoot: value.dataRoot,
    profile: 'edge',
  }).result;
  return {
    directoryPlanDigest: directoryPlan.evidence.planDigest,
    activationDigest: activation.evidence.activationDigest,
  };
}

function sqliteBinding(value, activationDigest) {
  return {
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    recoveryPath: value.recoveryPath,
    manifestPath: value.sqliteManifestPath,
    activationPath: value.activationPath,
    expectedActivationDigest: activationDigest,
  };
}

function stageOptions(value, prepared) {
  return {
    deploymentRoot: value.deploymentRoot,
    dataRoot: value.dataRoot,
    stagingRoot: value.stagingRoot,
    profile: 'edge',
    expectedPlanDigest: prepared.directoryPlanDigest,
    sqlite: sqliteBinding(value, prepared.activationDigest),
  };
}

function verifyOptions(value, prepared, manifestDigest) {
  return {
    deploymentRoot: value.deploymentRoot,
    dataRoot: value.dataRoot,
    stagingRoot: value.stagingRoot,
    profile: 'edge',
    expectedManifestDigest: manifestDigest,
    sqlite: sqliteBinding(value, prepared.activationDigest),
  };
}

test('stages only reviewed payloads behind the real SQLite activation fence', (t) => {
  const value = fixture(t);
  const prepared = prepare(value);
  const staged = run(
    value,
    'directory-stage',
    DIRECTORY_STAGE,
    stageOptions(value, prepared),
  );

  assert.equal(staged.result.status, 'staged');
  assert.match(staged.result.evidence.manifestDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readdirSync(value.stagingRoot).sort(), [
    'manifest.json',
    'payload',
  ]);
  const expectedFiles = [
    ['payload', 'copy-reviewed', 'scripts', 'jobs', 'example.sh'],
    ['payload', 'copy-reviewed', 'upload', 'avatar.bin'],
    ['payload', 'transform-input', 'config', 'config.sh'],
    ['payload', 'transform-input', 'db', 'keyv.sqlite'],
    ['payload', 'transform-input', 'ssh.d', 'repository-key'],
  ];
  for (const parts of expectedFiles) {
    const filePath = path.join(value.stagingRoot, ...parts);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
  assert.equal(
    fs.existsSync(
      path.join(
        value.stagingRoot,
        'payload',
        'transform-input',
        'db',
        'database.sqlite',
      ),
    ),
    false,
  );
  assert.equal(staged.child.stdout.includes(value.dataRoot), false);
  assert.equal(staged.child.stdout.includes('example.sh'), false);
  assert.equal(staged.child.stdout.includes('private-key'), false);

  const verified = run(
    value,
    'directory-verify',
    DIRECTORY_VERIFY,
    verifyOptions(value, prepared, staged.result.evidence.manifestDigest),
  ).result;
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.evidence, staged.result.evidence);
  const replayed = run(
    value,
    'directory-verify-replay',
    DIRECTORY_VERIFY,
    verifyOptions(value, prepared, staged.result.evidence.manifestDigest),
  ).result;
  assert.deepEqual(replayed, verified);
});

test('verification rejects staged payload and source drift', (t) => {
  const value = fixture(t);
  const prepared = prepare(value);
  const staged = run(
    value,
    'stage-before-drift',
    DIRECTORY_STAGE,
    stageOptions(value, prepared),
  ).result;
  const stagedScript = path.join(
    value.stagingRoot,
    'payload',
    'copy-reviewed',
    'scripts',
    'jobs',
    'example.sh',
  );
  fs.writeFileSync(stagedScript, 'tampered\n');
  const targetDrift = runRaw(
    value,
    'verify-target-drift',
    DIRECTORY_VERIFY,
    verifyOptions(value, prepared, staged.evidence.manifestDigest),
  );
  assert.equal(targetDrift.status, 1);
  assert.equal(
    JSON.parse(targetDrift.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );

  fs.writeFileSync(stagedScript, 'echo qinglong\n');
  fs.chmodSync(stagedScript, 0o600);

  privateFile(
    path.join(value.dataRoot, 'scripts', 'jobs', 'example.sh'),
    'source-drift\n',
  );
  const sourceDrift = runRaw(
    value,
    'verify-source-drift',
    DIRECTORY_VERIFY,
    verifyOptions(value, prepared, staged.evidence.manifestDigest),
  );
  assert.equal(sourceDrift.status, 1);
  assert.equal(
    JSON.parse(sourceDrift.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
});

test('verification never follows a staged payload symlink', (t) => {
  const value = fixture(t);
  const prepared = prepare(value);
  const staged = run(
    value,
    'stage-before-link',
    DIRECTORY_STAGE,
    stageOptions(value, prepared),
  ).result;
  const stagedScript = path.join(
    value.stagingRoot,
    'payload',
    'copy-reviewed',
    'scripts',
    'jobs',
    'example.sh',
  );
  fs.unlinkSync(stagedScript);
  fs.symlinkSync(value.sourcePath, stagedScript);

  const child = runRaw(
    value,
    'verify-link',
    DIRECTORY_VERIFY,
    verifyOptions(value, prepared, staged.evidence.manifestDigest),
  );
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(
    JSON.parse(child.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
});

test('staging is no-replace and fails before copying on activation drift', (t) => {
  const value = fixture(t);
  const prepared = prepare(value);
  privateDirectory(value.stagingRoot);
  privateFile(path.join(value.stagingRoot, '.incomplete'), 'crash-residue');
  const residue = runRaw(
    value,
    'stage-residue',
    DIRECTORY_STAGE,
    stageOptions(value, prepared),
  );
  assert.equal(residue.status, 1);
  assert.equal(
    fs.readFileSync(path.join(value.stagingRoot, '.incomplete'), 'utf8'),
    'crash-residue',
  );
  fs.rmSync(value.stagingRoot, { recursive: true });

  const drifted = stageOptions(value, prepared);
  drifted.sqlite.expectedActivationDigest = '0'.repeat(64);
  const activationDrift = runRaw(
    value,
    'stage-activation-drift',
    DIRECTORY_STAGE,
    drifted,
  );
  assert.equal(activationDrift.status, 1);
  assert.equal(fs.existsSync(value.stagingRoot), false);
});

test('widened directory staging commands fail closed before source access', (t) => {
  const value = fixture(t);
  const child = runRaw(value, 'widened-stage', DIRECTORY_STAGE, {
    deploymentRoot: value.deploymentRoot,
    dataRoot: path.join(value.deploymentRoot, 'missing-source'),
    stagingRoot: value.stagingRoot,
    profile: 'edge',
    expectedPlanDigest: '0'.repeat(64),
    sqlite: {
      sourcePath: path.join(
        value.deploymentRoot,
        'missing-source',
        'db',
        'database.sqlite',
      ),
      targetPath: path.join(value.artifactsDirectory, 'missing-target'),
      recoveryPath: path.join(value.artifactsDirectory, 'missing-recovery'),
      manifestPath: path.join(value.artifactsDirectory, 'missing-manifest'),
      activationPath: path.join(value.artifactsDirectory, 'missing-activation'),
      expectedActivationDigest: '0'.repeat(64),
    },
    extraAuthority: true,
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.equal(
    JSON.parse(child.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
});
