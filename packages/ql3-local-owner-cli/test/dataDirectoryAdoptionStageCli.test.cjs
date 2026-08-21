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
const DIRECTORY_TRANSFORM = 'local-data-directory.adoption.transform';
const DIRECTORY_TRANSFORM_VERIFY =
  'local-data-directory.adoption.transform.verify';

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

function createKeyvDatabase(databasePath, values = {}) {
  fs.rmSync(databasePath, { force: true });
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE keyv(key VARCHAR(255) PRIMARY KEY, value TEXT)');
  const insert = database.prepare('INSERT INTO keyv(key, value) VALUES (?, ?)');
  const entries = {
    'keyv:authInfo': {
      value: { token: values.authSecret ?? 'legacy-auth-token-never-carried' },
      expires: null,
    },
    'keyv:apps': { value: [{ id: 'legacy-app' }], expires: null },
    'keyv:lang': { value: 'en', expires: null },
    ...(values.extra ?? {}),
  };
  for (const [key, value] of Object.entries(entries)) {
    insert.run(key, JSON.stringify(value));
  }
  database.close();
  fs.chmodSync(databasePath, 0o600);
}

function configureTransformationInput(value) {
  const secrets = {
    environmentName: 'D386_API_TOKEN',
    environmentValue: 'd386-environment-secret',
    projectId: 'project-d386',
    sshAlias: 'repository-key',
    sshValue:
      '-----BEGIN OPENSSH PRIVATE KEY-----\nZDM4Ni1wcml2YXRlLWtleQ==\n-----END OPENSSH PRIVATE KEY-----\n',
    authValue: 'legacy-auth-token-never-carried',
  };
  privateFile(
    path.join(value.dataRoot, 'config', 'config.sh'),
    [
      `export ${secrets.environmentName}='${secrets.environmentValue}'`,
      'AutoStartBot=false',
      'export EMPTY_VALUE=',
      '',
    ].join('\n'),
  );
  createKeyvDatabase(path.join(value.dataRoot, 'db', 'keyv.sqlite'), {
    authSecret: secrets.authValue,
  });
  privateFile(
    path.join(value.dataRoot, 'ssh.d', secrets.sshAlias),
    secrets.sshValue,
  );
  privateFile(
    path.join(value.dataRoot, 'ssh.d', `${secrets.sshAlias}.config`),
    [
      `Host ${secrets.sshAlias}`,
      `  IdentityFile /root/.ssh/${secrets.sshAlias}`,
      '  StrictHostKeyChecking no',
      '  ProxyCommand nc -x legacy-proxy:1080 %h %p',
      '',
    ].join('\n'),
  );
  value.transformationParent = path.join(
    value.deploymentRoot,
    'transformations',
  );
  value.transformationRoot = path.join(
    value.transformationParent,
    'reviewed-data-v1',
  );
  privateDirectory(value.transformationParent);
  return secrets;
}

function stageForTransformation(value) {
  const prepared = prepare(value);
  const staged = run(
    value,
    'directory-stage-for-transformation',
    DIRECTORY_STAGE,
    stageOptions(value, prepared),
  ).result;
  return { prepared, staged };
}

function transformationOptions(value, prepared, staged, projectId) {
  return {
    deploymentRoot: value.deploymentRoot,
    dataRoot: value.dataRoot,
    stagingRoot: value.stagingRoot,
    transformationRoot: value.transformationRoot,
    projectId,
    profile: 'edge',
    expectedManifestDigest: staged.evidence.manifestDigest,
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

test('prepares and exactly verifies a disabled versioned legacy transformation', (t) => {
  const value = fixture(t);
  const secrets = configureTransformationInput(value);
  const { prepared, staged } = stageForTransformation(value);
  const options = transformationOptions(
    value,
    prepared,
    staged,
    secrets.projectId,
  );
  const transformed = run(
    value,
    'directory-transform',
    DIRECTORY_TRANSFORM,
    options,
  );

  assert.equal(transformed.result.status, 'prepared');
  assert.equal(transformed.result.evidence.assessment, 'ready');
  assert.match(
    transformed.result.evidence.transformationDigest,
    /^[0-9a-f]{64}$/,
  );
  for (const sensitive of [
    value.transformationRoot,
    secrets.projectId,
    secrets.environmentName,
    secrets.environmentValue,
    secrets.sshAlias,
    secrets.sshValue,
    secrets.authValue,
  ]) {
    assert.equal(transformed.child.stdout.includes(sensitive), false);
  }
  assert.deepEqual(fs.readdirSync(value.transformationRoot).sort(), [
    'manifest.json',
    'model',
  ]);
  const modelRoot = path.join(value.transformationRoot, 'model');
  const manifestText = fs.readFileSync(
    path.join(value.transformationRoot, 'manifest.json'),
    'utf8',
  );
  for (const sensitive of [
    secrets.projectId,
    secrets.environmentName,
    secrets.environmentValue,
    secrets.sshAlias,
    secrets.sshValue,
    secrets.authValue,
  ]) {
    assert.equal(manifestText.includes(sensitive), false);
  }
  const config = JSON.parse(
    fs.readFileSync(path.join(modelRoot, 'config.json'), 'utf8'),
  );
  assert.deepEqual(
    config.exportedEnvironment.map((entry) => entry.environmentName),
    [secrets.environmentName],
  );
  assert.equal(config.retiredSettings[0].name, 'AutoStartBot');
  assert.equal(config.omittedEmptyExports, 1);
  assert.equal(config.activation, 'disabled');

  const keyv = JSON.parse(
    fs.readFileSync(path.join(modelRoot, 'keyv.json'), 'utf8'),
  );
  assert.equal(keyv.integrity, 'ok');
  assert.equal(keyv.cachedLocale, 'en');
  assert.equal(
    keyv.mappings.find((entry) => entry.legacyKey === 'keyv:authInfo').state,
    'retired',
  );
  assert.equal(JSON.stringify(keyv).includes(secrets.authValue), false);

  const ssh = JSON.parse(
    fs.readFileSync(path.join(modelRoot, 'ssh.json'), 'utf8'),
  );
  assert.equal(ssh.bindings[0].activation, 'disabled');
  assert.equal(ssh.bindings[0].hostKeyPolicy, 'operator_verification_required');
  assert.equal(ssh.bindings[0].legacyProxyCommandPresent, true);
  assert.equal(ssh.bindings[0].legacyHostKeyBypassPresent, true);
  assert.equal(JSON.stringify(ssh).includes('legacy-proxy'), false);
  assert.equal(JSON.stringify(ssh).includes('StrictHostKeyChecking'), false);

  const importPlan = JSON.parse(
    fs.readFileSync(path.join(modelRoot, 'secret-imports.json'), 'utf8'),
  );
  assert.equal(importPlan.state, 'prepared');
  assert.equal(importPlan.projectId, secrets.projectId);
  assert.equal(importPlan.imports.length, 2);
  const secretValues = importPlan.imports.map((entry) => {
    const secretPath = path.join(modelRoot, entry.valueFile);
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    return JSON.parse(fs.readFileSync(secretPath, 'utf8')).value;
  });
  assert.deepEqual(
    secretValues.sort(),
    [secrets.environmentValue, secrets.sshValue].sort(),
  );
  const fullTarget =
    fs.readFileSync(path.join(modelRoot, 'secret-imports.json'), 'utf8') +
    fs.readFileSync(path.join(modelRoot, 'keyv.json'), 'utf8');
  assert.equal(fullTarget.includes(secrets.authValue), false);

  const verified = run(
    value,
    'directory-transform-verify',
    DIRECTORY_TRANSFORM_VERIFY,
    {
      ...options,
      expectedTransformationDigest:
        transformed.result.evidence.transformationDigest,
    },
  ).result;
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.evidence, transformed.result.evidence);
  const replayed = run(
    value,
    'directory-transform-verify-replay',
    DIRECTORY_TRANSFORM_VERIFY,
    {
      ...options,
      expectedTransformationDigest:
        transformed.result.evidence.transformationDigest,
    },
  ).result;
  assert.deepEqual(replayed, verified);
});

test('transformation verification rejects target and current source drift', (t) => {
  const target = fixture(t);
  const targetSecrets = configureTransformationInput(target);
  const targetStage = stageForTransformation(target);
  const targetOptions = transformationOptions(
    target,
    targetStage.prepared,
    targetStage.staged,
    targetSecrets.projectId,
  );
  const transformed = run(
    target,
    'directory-transform-before-target-drift',
    DIRECTORY_TRANSFORM,
    targetOptions,
  ).result;
  const secretFile = fs.readdirSync(
    path.join(target.transformationRoot, 'model', 'secret-values'),
  )[0];
  privateFile(
    path.join(target.transformationRoot, 'model', 'secret-values', secretFile),
    '{"schemaVersion":1,"kind":"qinglong3-local-secret-value","value":"tampered"}\n',
  );
  const targetDrift = runRaw(
    target,
    'directory-transform-target-drift',
    DIRECTORY_TRANSFORM_VERIFY,
    {
      ...targetOptions,
      expectedTransformationDigest: transformed.evidence.transformationDigest,
    },
  );
  assert.equal(targetDrift.status, 1);
  assert.equal(
    JSON.parse(targetDrift.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );

  const source = fixture(t);
  const sourceSecrets = configureTransformationInput(source);
  const sourceStage = stageForTransformation(source);
  const sourceOptions = transformationOptions(
    source,
    sourceStage.prepared,
    sourceStage.staged,
    sourceSecrets.projectId,
  );
  const sourceTransformed = run(
    source,
    'directory-transform-before-source-drift',
    DIRECTORY_TRANSFORM,
    sourceOptions,
  ).result;
  privateFile(
    path.join(source.dataRoot, 'config', 'config.sh'),
    'export D386_API_TOKEN=source-drift\n',
  );
  const sourceDrift = runRaw(
    source,
    'directory-transform-source-drift',
    DIRECTORY_TRANSFORM_VERIFY,
    {
      ...sourceOptions,
      expectedTransformationDigest:
        sourceTransformed.evidence.transformationDigest,
    },
  );
  assert.equal(sourceDrift.status, 1);
  assert.equal(
    JSON.parse(sourceDrift.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
});

test('unknown legacy behavior is retained as disabled manual-review evidence', (t) => {
  const value = fixture(t);
  const secrets = configureTransformationInput(value);
  privateFile(
    path.join(value.dataRoot, 'config', 'config.sh'),
    `export ${secrets.environmentName}=${secrets.environmentValue}\neval dangerous\n`,
  );
  const keyvPath = path.join(value.dataRoot, 'db', 'keyv.sqlite');
  const keyv = new DatabaseSync(keyvPath);
  keyv
    .prepare('INSERT INTO keyv(key, value) VALUES (?, ?)')
    .run('keyv:unknown', JSON.stringify({ value: 'retain', expires: null }));
  keyv.close();
  privateFile(path.join(value.dataRoot, 'ssh.d', 'unpaired-key'), 'manual');
  const { prepared, staged } = stageForTransformation(value);
  const transformed = run(
    value,
    'directory-transform-manual',
    DIRECTORY_TRANSFORM,
    transformationOptions(value, prepared, staged, secrets.projectId),
  ).result;

  assert.equal(transformed.evidence.assessment, 'manual_required');
  assert.equal(transformed.evidence.model.manualCategories, 3);
  const modelRoot = path.join(value.transformationRoot, 'model');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(modelRoot, 'config.json'), 'utf8'))
      .unsupportedLines,
    1,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(modelRoot, 'keyv.json'), 'utf8'))
      .unknownEntries,
    1,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(modelRoot, 'ssh.json'), 'utf8'))
      .manualEntries,
    1,
  );
  const manual = JSON.parse(
    fs.readFileSync(path.join(modelRoot, 'manual-review.json'), 'utf8'),
  );
  assert.equal(manual.required, true);
  assert.equal(manual.activation, 'disabled');
});

test('edge Secret budget leaves no-replace recovery residue', (t) => {
  const value = fixture(t);
  const secrets = configureTransformationInput(value);
  privateFile(
    path.join(value.dataRoot, 'config', 'config.sh'),
    `${Array.from(
      { length: 129 },
      (_, index) => `export D386_${index}=value`,
    ).join('\n')}\n`,
  );
  const { prepared, staged } = stageForTransformation(value);
  const options = transformationOptions(
    value,
    prepared,
    staged,
    secrets.projectId,
  );
  const overBudget = runRaw(
    value,
    'directory-transform-over-budget',
    DIRECTORY_TRANSFORM,
    options,
  );
  assert.equal(overBudget.status, 1);
  assert.equal(
    JSON.parse(overBudget.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
  const marker = path.join(value.transformationRoot, '.incomplete');
  const residue = fs.readFileSync(marker, 'utf8');
  const replay = runRaw(
    value,
    'directory-transform-over-budget-replay',
    DIRECTORY_TRANSFORM,
    options,
  );
  assert.equal(replay.status, 1);
  assert.equal(fs.readFileSync(marker, 'utf8'), residue);
});

test('widened transformation commands fail closed before source access', (t) => {
  const value = fixture(t);
  const missingData = path.join(value.deploymentRoot, 'missing-source');
  const child = runRaw(value, 'widened-transform', DIRECTORY_TRANSFORM, {
    deploymentRoot: value.deploymentRoot,
    dataRoot: missingData,
    stagingRoot: path.join(value.deploymentRoot, 'missing-stage'),
    transformationRoot: path.join(value.deploymentRoot, 'missing-transform'),
    projectId: 'project-d386',
    profile: 'edge',
    expectedManifestDigest: '0'.repeat(64),
    sqlite: {
      sourcePath: path.join(missingData, 'db', 'database.sqlite'),
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

  const invalidProject = runRaw(
    value,
    'invalid-transform-project',
    DIRECTORY_TRANSFORM,
    {
      deploymentRoot: value.deploymentRoot,
      dataRoot: missingData,
      stagingRoot: path.join(value.deploymentRoot, 'missing-stage'),
      transformationRoot: path.join(value.deploymentRoot, 'missing-transform'),
      projectId: 'project with spaces',
      profile: 'edge',
      expectedManifestDigest: '0'.repeat(64),
      sqlite: {
        sourcePath: path.join(missingData, 'db', 'database.sqlite'),
        targetPath: path.join(value.artifactsDirectory, 'missing-target'),
        recoveryPath: path.join(value.artifactsDirectory, 'missing-recovery'),
        manifestPath: path.join(value.artifactsDirectory, 'missing-manifest'),
        activationPath: path.join(
          value.artifactsDirectory,
          'missing-activation',
        ),
        expectedActivationDigest: '0'.repeat(64),
      },
    },
  );
  assert.equal(invalidProject.status, 1);
  assert.equal(invalidProject.stdout, '');
  assert.equal(
    JSON.parse(invalidProject.stderr).code,
    'LOCAL_DATA_DIRECTORY_ADOPTION_CONFIGURATION_INVALID',
  );
});
