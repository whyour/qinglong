const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createLocalDataDirectoryApplicationCommit,
} = require('@qinglong/local-sqlite/data-directory-application-commit');
const {
  LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3,
  LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V4,
  LocalApplicationProcessConfigError,
  normalizeLocalApplicationProcessConfig,
} = require('../dist/production-process/processConfig.js');
const {
  LocalApplicationLegacyDataCommitmentError,
  verifyLocalApplicationLegacyDataCommitment,
} = require('../dist/production-process/legacyDataApplicationCommitment.js');
const {
  runProductionLocalApplicationProcess,
} = require('../dist/production-process/processApplication.js');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-data-commitment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function commitDocument(profile = 'edge') {
  return createLocalDataDirectoryApplicationCommit({
    mutationId: '00000000-0000-4000-8000-000000000001',
    projectId: 'project-edge-1',
    profile,
    sourceStageManifestDigest: '1'.repeat(64),
    transformationDigest: '2'.repeat(64),
    modelDigest: '3'.repeat(64),
    publicationDigest: '4'.repeat(64),
    receiptDigest: '5'.repeat(64),
    committedAtMs: 1_000,
    receipt: {
      secretCount: 2,
      environmentSecretCount: 1,
      sshSecretCount: 1,
    },
  });
}

function v4Config(root, commit) {
  const cutoverPayload = {
    schemaVersion: 1,
    kind: 'qinglong3-local-legacy-silence-commitment',
    state: 'legacy_stopped',
    cutoverId: 'cutover-data-1',
    profile: 'edge',
    instanceId: 'edge-router-1',
    activationDigest: 'a'.repeat(64),
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
  return {
    schema: LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V4,
    instanceId: 'edge-router-1',
    profile: 'edge',
    storage: {
      mode: 'adopted',
      sourcePath: path.join(root, 'legacy.sqlite'),
      targetPath: path.join(root, 'qinglong3.sqlite'),
      recoveryPath: path.join(root, 'recovery.sqlite'),
      manifestPath: path.join(root, 'manifest.json'),
      activationPath: path.join(root, 'activation.json'),
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
    cutover: {
      cutoverId: cutoverPayload.cutoverId,
      commitmentPath: path.join(root, 'legacy-stopped.json'),
      expectedCommitmentDigest: crypto
        .createHash('sha256')
        .update(JSON.stringify(cutoverPayload), 'utf8')
        .digest('hex'),
    },
    legacyDataApplication: {
      commitPath: path.join(root, 'commit.json'),
      expectedCommitDigest: commit.commitDigest,
      expectedReceiptDigest: commit.receiptDigest,
    },
  };
}

function writeCommit(config, commit) {
  fs.writeFileSync(
    config.legacyDataApplication.commitPath,
    `${JSON.stringify(commit)}\n`,
    { mode: 0o600 },
  );
}

test('v4 config binds and verifies a canonical committed data application', (t) => {
  const root = temporaryRoot(t);
  const commit = commitDocument();
  const config = v4Config(root, commit);
  writeCommit(config, commit);
  const normalized = normalizeLocalApplicationProcessConfig(config);
  assert.equal(normalized.schema, LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V4);
  assert.deepEqual(
    verifyLocalApplicationLegacyDataCommitment(normalized),
    commit,
  );
});

test('v4 config rejects fresh storage and missing receipt binding', (t) => {
  const root = temporaryRoot(t);
  const commit = commitDocument();
  const config = v4Config(root, commit);
  assert.throws(
    () =>
      normalizeLocalApplicationProcessConfig({
        ...config,
        storage: {
          mode: 'fresh',
          databasePath: path.join(root, 'fresh.sqlite'),
        },
      }),
    LocalApplicationProcessConfigError,
  );
  const { legacyDataApplication, ...missing } = config;
  assert.ok(legacyDataApplication);
  assert.throws(
    () => normalizeLocalApplicationProcessConfig(missing),
    LocalApplicationProcessConfigError,
  );
});

test('commit and receipt drift fail before signal or storage authority', async (t) => {
  const root = temporaryRoot(t);
  const commit = commitDocument();
  const config = v4Config(root, commit);
  writeCommit(config, commit);
  config.legacyDataApplication.expectedReceiptDigest = '0'.repeat(64);
  const configPath = path.join(root, 'local-application.json');
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  let subscriptions = 0;
  let starts = 0;
  await assert.rejects(
    () =>
      runProductionLocalApplicationProcess({
        configFilePath: configPath,
        signals: {
          subscribe() {
            subscriptions += 1;
            return () => undefined;
          },
        },
        emit() {},
        async start() {
          starts += 1;
          throw new Error('must not start');
        },
      }),
    (error) =>
      error instanceof LocalApplicationLegacyDataCommitmentError &&
      error.code === 'QL3_LOCAL_APPLICATION_LEGACY_DATA_COMMITMENT_INVALID',
  );
  assert.equal(subscriptions, 0);
  assert.equal(starts, 0);
});

test('v3 remains SQLite-only and does not claim a data application receipt', (t) => {
  const root = temporaryRoot(t);
  const commit = commitDocument();
  const config = v4Config(root, commit);
  const { legacyDataApplication, ...withoutDataApplication } = config;
  assert.ok(legacyDataApplication);
  const v3 = normalizeLocalApplicationProcessConfig({
    ...withoutDataApplication,
    schema: LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3,
  });
  assert.equal(verifyLocalApplicationLegacyDataCommitment(v3), undefined);
});
