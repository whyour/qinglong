const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  inspectLegacySqlitePath,
  prepareLocalSqliteActivation,
  stageLocalSqliteAdoption,
} = require('@qinglong/local-admin');
const { provisionLocalSecretKeyring } = require('@qinglong/local-secret');
const {
  LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA,
  LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V2,
  LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3,
  LocalApplicationProcessConfigError,
  loadLocalApplicationProcessConfig,
} = require('../dist/production-process/processConfig.js');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  LocalApplicationProcessError,
  runProductionLocalApplicationProcess,
} = require('../dist/production-process/processApplication.js');
const {
  localApplicationStartupReceiptPath,
  parseLocalApplicationStartupReceipt,
} = require('../dist/production-process/startupReceipt.js');
const {
  localApplicationShutdownReceiptPath,
  parseLocalApplicationShutdownReceipt,
} = require('../dist/production-process/shutdownReceipt.js');

function directory(t, prefix = 'ql3-local-process-') {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function configValue(root, overrides = {}) {
  const value = {
    schema: LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3,
    instanceId: 'edge-router-1',
    profile: 'edge',
    storage: {
      mode: 'adopted',
      sourcePath: path.join(root, 'database.sqlite'),
      targetPath: path.join(root, 'qinglong3.sqlite'),
      recoveryPath: path.join(root, 'database.pre-ql3.sqlite'),
      manifestPath: path.join(root, 'qinglong3-adoption.json'),
      activationPath: path.join(root, 'qinglong3-activation.json'),
      expectedActivationDigest: 'a'.repeat(64),
      busyTimeoutMs: 100,
    },
    runtime: {
      receiptRoot: path.join(root, 'receipts'),
      artifactRoot: path.join(root, 'artifacts'),
      secretKeyringPath: path.join(root, 'secret-keyring.json'),
    },
    pluginPackages: {
      stagingRoot: path.join(root, 'plugin-staging'),
      activationRoot: path.join(root, 'plugin-activation'),
      recoverySource: { mode: 'disabled' },
      pageSize: 4,
      maxPages: 4,
      taskPublicationPageSize: 4,
      taskPublicationMaxPages: 4,
    },
    ai: { deployment: 'excluded' },
    ...overrides,
  };
  const payload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId: 'cutover-test-1',
    profile: value.profile,
    instanceId: value.instanceId,
    activationDigest: value.storage.expectedActivationDigest,
    previousRecordDigest: 'b'.repeat(64),
    requestedAtMs: 1_000,
    observedAtMs: 1_000,
    controller: {
      kind: 'docker',
      endpointDigest: 'c'.repeat(64),
      legacyContainerId: 'd'.repeat(64),
      legacyContainerIdentityDigest: 'e'.repeat(64),
      legacySourceBindingDigest: 'f'.repeat(64),
    },
  };
  const commitmentDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  return {
    ...value,
    cutover: {
      cutoverId: payload.cutoverId,
      commitmentPath: path.join(root, 'legacy-stopped.json'),
      expectedCommitmentDigest: commitmentDigest,
    },
  };
}

function writeCutoverCommitment(value) {
  const payload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId: value.cutover.cutoverId,
    profile: value.profile,
    instanceId: value.instanceId,
    activationDigest: value.storage.expectedActivationDigest,
    previousRecordDigest: 'b'.repeat(64),
    requestedAtMs: 1_000,
    observedAtMs: 1_000,
    controller: {
      kind: 'docker',
      endpointDigest: 'c'.repeat(64),
      legacyContainerId: 'd'.repeat(64),
      legacyContainerIdentityDigest: 'e'.repeat(64),
      legacySourceBindingDigest: 'f'.repeat(64),
    },
  };
  const commitment = {
    ...payload,
    commitmentDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(payload), 'utf8')
      .digest('hex'),
  };
  fs.writeFileSync(
    value.cutover.commitmentPath,
    `${JSON.stringify(commitment)}\n`,
    { mode: 0o600 },
  );
  return commitment.commitmentDigest;
}

function writeConfig(t, value = configValue(directory(t))) {
  const configFilePath = path.join(
    path.dirname(value.storage.sourcePath),
    'local-application.json',
  );
  if (value.schema === LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3) {
    value.cutover.expectedCommitmentDigest = writeCutoverCommitment(value);
  }
  fs.writeFileSync(configFilePath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(configFilePath, 0o600);
  return { configFilePath, value };
}

function freshConfigValue(root) {
  return {
    schema: LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V2,
    instanceId: 'fresh-edge-router-1',
    profile: 'edge',
    storage: {
      mode: 'fresh',
      databasePath: path.join(root, 'qinglong3.sqlite'),
      busyTimeoutMs: 100,
    },
    runtime: {
      receiptRoot: path.join(root, 'receipts'),
      artifactRoot: path.join(root, 'artifacts'),
      secretKeyringPath: path.join(root, 'secret-keyring.json'),
    },
    pluginPackages: {
      stagingRoot: path.join(root, 'plugin-staging'),
      activationRoot: path.join(root, 'plugin-activation'),
      recoverySource: { mode: 'disabled' },
      pageSize: 4,
      maxPages: 4,
      taskPublicationPageSize: 4,
      taskPublicationMaxPages: 4,
    },
    ai: { deployment: 'excluded' },
  };
}

function writeFreshConfig(root, value = freshConfigValue(root)) {
  const configFilePath = path.join(root, 'local-application-fresh.json');
  fs.writeFileSync(configFilePath, `${JSON.stringify(value)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(configFilePath, 0o600);
  return { configFilePath, value };
}

test('loads one exact private process configuration', (t) => {
  const root = directory(t);
  const { configFilePath, value } = writeConfig(t, configValue(root));
  assert.deepEqual(loadLocalApplicationProcessConfig(configFilePath), value);

  fs.chmodSync(configFilePath, 0o644);
  assert.throws(
    () => loadLocalApplicationProcessConfig(configFilePath),
    /private regular file/,
  );
});

test('requires an exact v3 commitment before adopted startup authority', async (t) => {
  const root = directory(t, 'ql3-local-cutover-config-');
  const v3 = configValue(root);
  const { cutover: _cutover, ...legacy } = v3;
  const v1 = {
    ...legacy,
    schema: LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA,
    storage: Object.fromEntries(
      Object.entries(legacy.storage).filter(([key]) => key !== 'mode'),
    ),
  };
  const legacyConfig = writeConfig(t, v1);
  let subscribed = false;
  await assert.rejects(
    runProductionLocalApplicationProcess({
      configFilePath: legacyConfig.configFilePath,
      signals: {
        subscribe() {
          subscribed = true;
          return () => {};
        },
      },
      emit() {},
      async start() {
        throw new Error('must not start');
      },
    }),
    (error) =>
      error.code === 'QL3_LOCAL_APPLICATION_CUTOVER_COMMITMENT_INVALID',
  );
  assert.equal(subscribed, false);

  const ready = writeConfig(t, v3);
  const commitment = JSON.parse(
    fs.readFileSync(v3.cutover.commitmentPath, 'utf8'),
  );
  fs.writeFileSync(
    v3.cutover.commitmentPath,
    `${JSON.stringify({ ...commitment, instanceId: 'other-instance' })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    runProductionLocalApplicationProcess({
      configFilePath: ready.configFilePath,
      signals: { subscribe: () => () => {} },
      emit() {},
    }),
    (error) =>
      error.code === 'QL3_LOCAL_APPLICATION_CUTOVER_COMMITMENT_INVALID',
  );
});

test('loads an exact v2 fresh storage configuration', (t) => {
  const root = directory(t, 'ql3-local-fresh-config-');
  const { configFilePath, value } = writeFreshConfig(root);
  assert.deepEqual(loadLocalApplicationProcessConfig(configFilePath), value);

  const widened = {
    ...value,
    storage: { ...value.storage, sourcePath: path.join(root, 'legacy.sqlite') },
  };
  fs.writeFileSync(configFilePath, JSON.stringify(widened), { mode: 0o600 });
  assert.throws(
    () => loadLocalApplicationProcessConfig(configFilePath),
    LocalApplicationProcessConfigError,
  );
});

test('boots a migrated fresh database without an adoption fence', async (t) => {
  const root = directory(t, 'ql3-local-fresh-live-');
  const { configFilePath, value } = writeFreshConfig(root);
  await migrateLocalSqlitePath({
    databasePath: value.storage.databasePath,
    profile: value.profile,
    busyTimeoutMs: value.storage.busyTimeoutMs,
  });
  await provisionLocalSecretKeyring(value.runtime.secretKeyringPath);
  fs.mkdirSync(value.pluginPackages.stagingRoot, {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(value.pluginPackages.activationRoot, {
    recursive: true,
    mode: 0o700,
  });

  const events = [];
  let listener;
  const result = await runProductionLocalApplicationProcess({
    configFilePath,
    signals: {
      subscribe(receive) {
        listener = receive;
        return () => {};
      },
    },
    emit(record) {
      events.push(record);
      if (record.event === 'active') setImmediate(() => listener('SIGTERM'));
    },
  });

  assert.equal(result, 'stopped');
  assert.equal(
    events.some(({ event }) => event === 'active'),
    true,
  );
  assert.equal(
    events.some(
      ({ dependencyActivation }) => dependencyActivation?.scope === 'adoption',
    ),
    false,
  );
  const database = new DatabaseSync(value.storage.databasePath, {
    readonly: true,
  });
  assert.equal(
    database.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  database.close();
});

test('rejects widened, relative, aliased and unbounded process authority', (t) => {
  const root = directory(t);
  const cases = [
    {
      ...configValue(root),
      unexpected: true,
    },
    {
      ...configValue(root),
      storage: {
        ...configValue(root).storage,
        sourcePath: 'database.sqlite',
      },
    },
    {
      ...configValue(root),
      runtime: {
        ...configValue(root).runtime,
        artifactRoot: path.join(root, 'receipts'),
      },
    },
    {
      ...configValue(root),
      ai: { deployment: 'installed', maxConcurrent: 65 },
    },
    {
      ...configValue(root),
      pluginPackages: {
        ...configValue(root).pluginPackages,
        recoverySource: {
          mode: 'materialized_catalog',
          catalogRoot: path.join(root, 'plugin-staging'),
          bundleRoot: path.join(root, 'plugin-bundles'),
          publisherTrustFilePath: path.join(
            root,
            'publisher-trust',
            'current.json',
          ),
        },
      },
    },
  ];
  for (const [index, value] of cases.entries()) {
    const configFilePath = path.join(root, `invalid-${index}.json`);
    fs.writeFileSync(configFilePath, JSON.stringify(value), { mode: 0o600 });
    assert.throws(
      () => loadLocalApplicationProcessConfig(configFilePath),
      LocalApplicationProcessConfigError,
    );
  }
});

test('subscribes before startup, accepts the first signal and drains once', async (t) => {
  const root = directory(t);
  const { configFilePath, value } = writeConfig(t, configValue(root));
  const actions = [];
  const events = [];
  let listener;
  let stops = 0;
  const result = await runProductionLocalApplicationProcess({
    configFilePath,
    signals: {
      subscribe(receive) {
        actions.push('subscribe');
        listener = receive;
        return () => actions.push('unsubscribe');
      },
    },
    emit(record) {
      events.push(record);
    },
    async start(options) {
      actions.push('start');
      assert.equal('create' in options.application, false);
      assert.equal(options.application.profile, value.profile);
      assert.equal(
        typeof options.application.pluginPackages.stageProvider.stage,
        'function',
      );
      await options.application.applicationAudit({
        profile: value.profile,
        state: 'active',
      });
      listener('SIGTERM');
      listener('SIGINT');
      return {
        status: 'active',
        profile: value.profile,
        application: {},
        ai: { status: 'deployment_excluded' },
        async stop() {
          stops += 1;
          actions.push('stop');
          return 'stopped';
        },
      };
    },
  });

  assert.equal(result, 'stopped');
  assert.equal(stops, 1);
  assert.deepEqual(actions, ['subscribe', 'start', 'stop', 'unsubscribe']);
  assert.deepEqual(
    events.map(({ event }) => event),
    ['application_activation', 'active', 'shutdown_requested', 'stopped'],
  );
  assert.equal(events[2].signal, 'SIGTERM');
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(root), false);
  assert.equal(
    serialized.includes(value.storage.expectedActivationDigest),
    false,
  );
  if (process.platform === 'linux') {
    const receipt = parseLocalApplicationStartupReceipt(
      fs.readFileSync(
        localApplicationStartupReceiptPath(configFilePath),
        'utf8',
      ),
    );
    assert.equal(receipt.instanceId, value.instanceId);
    assert.equal(receipt.profile, value.profile);
    assert.equal(receipt.aiStatus, 'deployment_excluded');
    assert.equal(receipt.processId, process.pid);
  }
});

test('installed AI fails before storage startup without provider authority', async (t) => {
  const root = directory(t);
  const { configFilePath } = writeConfig(
    t,
    configValue(root, { ai: { deployment: 'installed' } }),
  );
  let subscribed = false;
  let started = false;
  await assert.rejects(
    runProductionLocalApplicationProcess({
      configFilePath,
      signals: {
        subscribe() {
          subscribed = true;
          return () => {};
        },
      },
      emit() {},
      async start() {
        started = true;
        throw new Error('must not start');
      },
    }),
    (error) =>
      error instanceof LocalApplicationProcessError &&
      error.code === 'QL3_LOCAL_APPLICATION_PROCESS_AI_PROVIDER_UNAVAILABLE',
  );
  assert.equal(subscribed, false);
  assert.equal(started, false);
});

test('default Plugin Package recovery source fails closed and unsubscribes', async (t) => {
  const root = directory(t);
  const { configFilePath } = writeConfig(t, configValue(root));
  let unsubscribed = false;
  await assert.rejects(
    runProductionLocalApplicationProcess({
      configFilePath,
      signals: {
        subscribe() {
          return () => {
            unsubscribed = true;
          };
        },
      },
      emit() {},
      async start(options) {
        await options.application.pluginPackages.stageProvider.stage({});
        throw new Error('unreachable');
      },
    }),
    (error) =>
      error instanceof LocalApplicationProcessError &&
      error.code === 'QL3_LOCAL_APPLICATION_PLUGIN_SOURCE_UNAVAILABLE',
  );
  assert.equal(unsubscribed, true);
});

test('materialized catalog stays unloaded when recovery has no queued source', async (t) => {
  const root = directory(t);
  const { configFilePath } = writeConfig(
    t,
    configValue(root, {
      pluginPackages: {
        ...configValue(root).pluginPackages,
        recoverySource: {
          mode: 'materialized_catalog',
          catalogRoot: path.join(root, 'plugin-catalog'),
          bundleRoot: path.join(root, 'plugin-bundles'),
          publisherTrustFilePath: path.join(
            root,
            'publisher-trust',
            'current.json',
          ),
        },
      },
    }),
  );
  const catalogModule = require.resolve(
    '../dist/production-process/pluginPackageRecoveryCatalog.js',
  );
  assert.equal(require.cache[catalogModule], undefined);
  let listener;
  const result = await runProductionLocalApplicationProcess({
    configFilePath,
    signals: {
      subscribe(receive) {
        listener = receive;
        return () => {};
      },
    },
    emit() {},
    async start(options) {
      assert.equal(
        typeof options.application.pluginPackages.stageProvider.stage,
        'function',
      );
      listener('SIGTERM');
      return {
        status: 'active',
        profile: 'edge',
        application: {},
        ai: { status: 'deployment_excluded' },
        async stop() {
          return 'stopped';
        },
      };
    },
  });
  assert.equal(result, 'stopped');
  assert.equal(require.cache[catalogModule], undefined);
});

test('CLI exposes bounded usage and redacted configuration failures', (t) => {
  const cli = path.resolve(__dirname, '../dist/cli.js');
  const help = spawnSync(process.execPath, [cli, '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(
    help.stdout,
    'Usage: ql3-local-application --config /absolute/private-config.json\n',
  );

  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
  assert.equal(
    JSON.parse(usage.stderr).code,
    'QL3_LOCAL_APPLICATION_CLI_USAGE_INVALID',
  );

  const root = directory(t, 'ql3-local-cli-failure-');
  const { configFilePath } = writeConfig(
    t,
    configValue(root, { ai: { deployment: 'installed' } }),
  );
  const failed = spawnSync(
    process.execPath,
    [cli, '--config', configFilePath],
    { encoding: 'utf8' },
  );
  assert.equal(failed.status, 1, failed.stdout);
  assert.equal(
    JSON.parse(failed.stderr).code,
    'QL3_LOCAL_APPLICATION_PROCESS_AI_PROVIDER_UNAVAILABLE',
  );
  assert.equal(failed.stderr.includes(root), false);
});

async function prepareCliFixture(t) {
  const root = directory(t, 'ql3-local-cli-live-');
  const value = configValue(root);
  const source = new DatabaseSync(value.storage.sourcePath);
  source.exec(`
    CREATE TABLE "Auths" (id INTEGER PRIMARY KEY, type TEXT, info TEXT);
    CREATE TABLE "Crontabs" (
      id INTEGER PRIMARY KEY, command TEXT NOT NULL, schedule TEXT
    );
    CREATE TABLE "Envs" (
      id INTEGER PRIMARY KEY, name TEXT, value TEXT
    );
    INSERT INTO "Crontabs" (id, command, schedule)
      VALUES (1, 'echo legacy', '0 0 * * *');
  `);
  source.close();
  const plan = inspectLegacySqlitePath({
    sourcePath: value.storage.sourcePath,
    profile: value.profile,
  });
  const adoption = await stageLocalSqliteAdoption({
    sourcePath: value.storage.sourcePath,
    targetPath: value.storage.targetPath,
    recoveryPath: value.storage.recoveryPath,
    manifestPath: value.storage.manifestPath,
    profile: value.profile,
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    sourcePath: value.storage.sourcePath,
    targetPath: value.storage.targetPath,
    recoveryPath: value.storage.recoveryPath,
    manifestPath: value.storage.manifestPath,
    activationPath: value.storage.activationPath,
    expectedManifestDigest: adoption.manifestDigest,
  });
  await provisionLocalSecretKeyring(value.runtime.secretKeyringPath);
  fs.mkdirSync(value.pluginPackages.stagingRoot, {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(value.pluginPackages.activationRoot, {
    recursive: true,
    mode: 0o700,
  });
  const ready = {
    ...value,
    storage: {
      ...value.storage,
      expectedActivationDigest: activation.activationDigest,
    },
  };
  return { root, ...writeConfig(t, ready) };
}

test('CLI boots the real headless runtime and releases it on SIGTERM', async (t) => {
  const { configFilePath, value } = await prepareCliFixture(t);
  const cli = path.resolve(__dirname, '../dist/cli.js');
  const child = spawn(process.execPath, [cli, '--config', configFilePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const index = stdout.indexOf('\n');
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      const record = JSON.parse(line);
      events.push(record);
      if (record.event === 'active' && !signalled) {
        signalled = true;
        child.kill('SIGTERM');
      }
    }
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
  timeout.unref();
  const [code, signal] = await new Promise((resolve) => {
    child.once('exit', (...args) => resolve(args));
  });
  clearTimeout(timeout);

  assert.equal(code, 0, JSON.stringify({ stderr, signal, events }));
  assert.equal(signal, null);
  assert.equal(signalled, true);
  assert.equal(
    events.some(({ event }) => event === 'active'),
    true,
  );
  assert.equal(
    events.some(
      ({ event, signal: observed }) =>
        event === 'shutdown_requested' && observed === 'SIGTERM',
    ),
    true,
  );
  assert.equal(
    events.some(
      ({ event, stopResult }) =>
        event === 'stopped' && stopResult === 'stopped',
    ),
    true,
  );
  if (process.platform === 'linux') {
    const receipt = parseLocalApplicationStartupReceipt(
      fs.readFileSync(
        localApplicationStartupReceiptPath(configFilePath),
        'utf8',
      ),
    );
    assert.equal(receipt.processId, child.pid);
    assert.equal(receipt.aiStatus, 'deployment_excluded');
    const shutdown = parseLocalApplicationShutdownReceipt(
      fs.readFileSync(
        localApplicationShutdownReceiptPath(configFilePath),
        'utf8',
      ),
    );
    assert.equal(shutdown.processId, child.pid);
    assert.equal(shutdown.processStartTicks, receipt.processStartTicks);
    assert.equal(shutdown.bootId, receipt.bootId);
    assert.equal(shutdown.signal, 'SIGTERM');
    assert.equal(shutdown.stopResult, 'stopped');
    assert.equal(shutdown.startupReceiptDigest, receipt.sha256);
    assert.ok(shutdown.stoppedBootAgeMs >= receipt.activeBootAgeMs);
  }
  const writer = new DatabaseSync(value.storage.sourcePath, { timeout: 100 });
  writer
    .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
    .run(2, 'echo released');
  writer.close();
});
