const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
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
const {
  runLocalPluginPackageWorkflowCommandFile,
} = require('@qinglong/local-owner-cli/plugin-package-workflow-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const {
  LocalApplicationPluginPackageRecoveryRequiredError,
  LocalApplicationStartupRecoveryRequiredError,
  bootstrapLocalApplication,
} = require('../dist');
const {
  MAX_LOCAL_RUN_RECOVERY_ITEMS,
} = require('@qinglong/local-execution/recovery');
const {
  LocalAiFeatureApplicationUnavailableError,
  bootstrapLocalAiFeatureApplication,
} = require('../dist/application-runtime/aiFeatureApplication.js');
const { ModelGatewayProfileDrainingError } = require('@qinglong/ai/profile');
const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageInstallActionDigest,
  pluginPackageInstallCreate,
  pluginPackageInstallPlanDigest,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('@qinglong/local-sqlite/plugin-package-automation-publication');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('@qinglong/local-sqlite/plugin-package-materialized-revision');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('@qinglong/local-sqlite/plugin-package-task-reconciliation');
const {
  LocalSqlitePluginPackageWorkflowAdmissionRepository,
} = require('@qinglong/local-sqlite/plugin-package-workflow-admission');
const { CompletionReceiptFileStore } = require('@qinglong/local-process');
const { provisionLocalSecretKeyring } = require('@qinglong/local-secret');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

const RECEIPT_RUN_ID = '019f70c0-0000-7000-8000-000000000001';
const RECEIPT_ATTEMPT_ID = '019f70c0-0000-7000-8000-000000000002';
const RECEIPT_TOKEN = 'A'.repeat(32);
const CLEANUP_RUN_ID = '019f70c0-0000-7000-8000-000000000011';
const CLEANUP_ATTEMPT_ID = '019f70c0-0000-7000-8000-000000000012';
const LOST_RETRY_RUN_ID = '019f70c0-0000-7000-8000-000000000021';
const LOST_RETRY_ATTEMPT_ID = '019f70c0-0000-7000-8000-000000000022';
const WORKFLOW_CANCELLATION_CREDENTIAL_ID = 'application-workflow-owner';
const WORKFLOW_CANCELLATION_PEPPER_KEY_ID = 'application-workflow-owner-v1';
const WORKFLOW_CANCELLATION_PEPPER_BYTES = Buffer.alloc(32, 141);
const WORKFLOW_CANCELLATION_SECRET = Buffer.alloc(32, 142).toString(
  'base64url',
);

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-local-application-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const value = {
    directory,
    sourcePath: path.join(directory, 'database.sqlite'),
    targetPath: path.join(directory, 'qinglong3.sqlite'),
    recoveryPath: path.join(directory, 'database.pre-ql3.sqlite'),
    manifestPath: path.join(directory, 'qinglong3-adoption.json'),
    activationPath: path.join(directory, 'qinglong3-activation.json'),
    secretKeyringPath: path.join(directory, 'qinglong3-secret-keyring.json'),
  };
  const source = new DatabaseSync(value.sourcePath);
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
  return value;
}

async function prepare(t, profile = 'edge') {
  const value = fixture(t);
  const plan = inspectLegacySqlitePath({
    sourcePath: value.sourcePath,
    profile,
  });
  const adoption = await stageLocalSqliteAdoption({
    ...value,
    profile,
    expectedPlanDigest: plan.planDigest,
  });
  const activation = await prepareLocalSqliteActivation({
    ...value,
    expectedManifestDigest: adoption.manifestDigest,
  });
  await provisionLocalSecretKeyring(value.secretKeyringPath);
  return { ...value, activation, profile };
}

function options(value, overrides = {}) {
  const { events = [], ...optionOverrides } = overrides;
  const stagingRoot = path.join(value.directory, 'plugin-staging');
  const activationRoot = path.join(value.directory, 'plugin-activation');
  fs.mkdirSync(stagingRoot, { mode: 0o700, recursive: true });
  fs.mkdirSync(activationRoot, { mode: 0o700, recursive: true });
  return {
    enabled: true,
    profile: value.profile,
    sourcePath: value.sourcePath,
    targetPath: value.targetPath,
    recoveryPath: value.recoveryPath,
    manifestPath: value.manifestPath,
    activationPath: value.activationPath,
    expectedActivationDigest: value.activation.activationDigest,
    receiptRoot: path.join(value.directory, 'receipts'),
    artifactRoot: path.join(value.directory, 'artifacts'),
    secretKeyringPath: value.secretKeyringPath,
    pluginPackages: {
      stagingRoot,
      activationRoot,
      now: () => 1_000,
      stageProvider: {
        async stage() {
          throw new Error('empty recovery queue must not request a stage');
        },
      },
    },
    busyTimeoutMs: 100,
    audit: (record) => events.push(`storage:${record.state}`),
    adoptionAudit: (record) => events.push(`adoption:${record.state}`),
    applicationAudit: (record) => events.push(`application:${record.state}`),
    ...optionOverrides,
  };
}

const AI_PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'local-ai-owner' }),
  authenticationId: 'local-ai-startup-auth',
  assurance: 'local_console',
  authenticatedAtMs: 1,
  expiresAtMs: 300_001,
});

async function activateLocalAiFeature(value) {
  const client = new DatabaseSync(value.targetPath, { timeout: 100 });
  try {
    client.exec('PRAGMA foreign_keys = ON');
    await migrateLocalModelInvocationFeature(client);
    return new LocalModelInvocationFeatureActivationRepository(
      client,
    ).transition(
      createLocalModelInvocationFeatureTransitionCommand({
        featureId: 'model-invocation',
        expectedGeneration: 0,
        expectedState: null,
        state: 'active',
        mutationId: 'local-ai-startup-activate',
        requestId: 'local-ai-startup-request',
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'fresh_database',
          backupEvidenceDigest: null,
        },
        principal: AI_PRINCIPAL,
      }),
    ).transition;
  } finally {
    client.close();
  }
}

function deactivateLocalAiFeature(value, activation) {
  const client = new DatabaseSync(value.targetPath, { timeout: 100 });
  try {
    client.exec('PRAGMA foreign_keys = ON');
    return new LocalModelInvocationFeatureActivationRepository(
      client,
    ).transition(
      createLocalModelInvocationFeatureTransitionCommand({
        featureId: 'model-invocation',
        expectedGeneration: activation.generation,
        expectedState: 'active',
        state: 'inactive',
        mutationId: 'local-ai-startup-deactivate',
        requestId: 'local-ai-shutdown-request',
        expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
        safety: {
          mode: 'preserve_existing',
          backupEvidenceDigest: null,
        },
        principal: AI_PRINCIPAL,
      }),
    ).transition;
  } finally {
    client.close();
  }
}

function localAiProviders(actions) {
  return {
    providers: [
      {
        type: 'remote',
        async listModels() {
          return [{ id: 'model-a' }];
        },
        async generate() {
          throw new Error('not used');
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    policies: {
      async resolve() {
        throw new Error('not used');
      },
    },
    dispose() {
      actions.push('dispose_ai_providers');
    },
  };
}

function localAiPromptProviders(metrics) {
  return {
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'vendor/model-a' }];
        },
        async generate() {
          metrics.providerCalls += 1;
          return {
            provider: 'openai-compatible',
            model: 'vendor/model-a',
            text: metrics.privateOutput,
            finishReason: 'stop',
            usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
          };
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    policies: {
      async resolve() {
        return {
          revision: 'edge-resource-policy-1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['vendor/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: metrics.maxOutputBytes,
          maxOutputTokens: 512,
          maxTotalTokens: 1024,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    dispose() {
      metrics.providerDisposals += 1;
    },
  };
}

function promptResourceConfiguration() {
  const profile = process.env.QL3_PROMPT_RESOURCE_PROFILE ?? 'edge';
  if (!['edge', 'standalone'].includes(profile)) {
    throw new Error('QL3_PROMPT_RESOURCE_PROFILE must be edge or standalone');
  }
  const prefix = 'private router model output:';
  const minimumOutputBytes = Buffer.byteLength(prefix, 'utf8');
  const rawOutputBytes =
    process.env.QL3_PROMPT_RESOURCE_OUTPUT_BYTES ?? String(minimumOutputBytes);
  const outputBytes = Number(rawOutputBytes);
  if (
    !Number.isSafeInteger(outputBytes) ||
    outputBytes < minimumOutputBytes ||
    outputBytes > 1024 * 1024
  ) {
    throw new Error(
      `QL3_PROMPT_RESOURCE_OUTPUT_BYTES must be an integer from ${minimumOutputBytes} to 1048576`,
    );
  }
  return Object.freeze({
    profile,
    output: prefix + 'x'.repeat(outputBytes - Buffer.byteLength(prefix)),
    outputBytes,
    resourceProbe: process.env.QL3_PROMPT_RESOURCE_OUTPUT_BYTES !== undefined,
  });
}

function sqliteStorageSnapshot(databasePath) {
  const snapshot = {};
  for (const [name, suffix] of [
    ['database', ''],
    ['wal', '-wal'],
    ['journal', '-journal'],
  ]) {
    const stat = fs.statSync(databasePath + suffix, { throwIfNoEntry: false });
    snapshot[name] = Object.freeze({
      logicalBytes: stat?.size ?? 0,
      allocatedBytes: (stat?.blocks ?? 0) * 512,
    });
  }
  return Object.freeze(snapshot);
}

function sqliteStorageGrowth(before, after) {
  const growth = (kind) =>
    Object.keys(before).reduce(
      (total, name) =>
        total + Math.max(0, after[name][kind] - before[name][kind]),
      0,
    );
  return Object.freeze({
    logicalBytes: growth('logicalBytes'),
    allocatedBytes: growth('allocatedBytes'),
    walBytes: Math.max(0, after.wal.logicalBytes - before.wal.logicalBytes),
  });
}

function assertSourceWritable(value, id) {
  const writer = new DatabaseSync(value.sourcePath, { timeout: 100 });
  writer
    .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
    .run(id, `echo ${id}`);
  writer.close();
}

async function insertQueuedPluginPackage(value) {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'startup-probe',
      displayName: 'Startup Probe',
      version: '1.0.0',
      description: 'Startup recovery fixture',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '8Mi' },
        disk: { install: '1Mi', working: '1Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const plan = planPluginPackageInstall(manifest, environment);
  const action = {
    lockId: 'lock-startup-probe',
    projectId: 'default',
    manifest,
    plan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 1024,
      contentDigest: 'b'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
  const lock = createPluginPackageLock({
    ...action,
    approval: {
      requestId: 'approval-startup-probe',
      requestVersion: 1,
      dispatchId: 'dispatch-startup-probe',
      actionDigest: pluginPackageInstallActionDigest(action),
      previewDigest: pluginPackageInstallPlanDigest(plan),
      approvedBy: { type: 'user', id: 'owner-001' },
      approvedAtMs: 100,
      expiresAtMs: 10_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const queued = createPluginPackageInstall(lock, {
    installationId: 'install-startup-probe',
    mutationId: 'mutation-create-startup-probe',
    occurredAtMs: 201,
  });
  const client = new DatabaseSync(value.targetPath);
  try {
    await new LocalSqlitePluginPackageInstallRepository(client).create(
      pluginPackageInstallCreate(lock, queued, null),
    );
  } finally {
    client.close();
  }
}

function insertActiveTargetRun(value, id, status = 'running') {
  const target = new DatabaseSync(value.targetPath);
  const statement = target.prepare(
    `INSERT INTO "Runs" (
        id, project_id, task_id, task_revision, trigger_type,
        execution_origin, execution_owner, status, version, event_sequence,
        priority, created_at_ms
      ) VALUES (?, 'default', 'task-1', 'revision-1', 'manual',
        'manual', 'runtime', ?, 0, 0, 0, 1)`,
  );
  statement.run(id, status);
  target.close();
}

function insertSafeLostTargetRun(value) {
  const now = Date.now();
  const target = new DatabaseSync(value.targetPath);
  target.exec('BEGIN IMMEDIATE');
  try {
    target
      .prepare(
        `INSERT INTO "Runs" (
          id, project_id, task_id, task_revision, trigger_type,
          execution_origin, execution_owner, status, version, event_sequence,
          priority, created_at_ms, queued_at_ms, started_at_ms,
          error_code, error_summary
        ) VALUES (?, 'default', 'task-lost-retry', 'revision-lost-retry',
          'manual', 'manual', 'runtime', 'lost', 1, 0, 0, ?, ?, ?,
          'LOCAL_RECOVERY_EXECUTION_NOT_RUNNING', 'lost')`,
      )
      .run(LOST_RETRY_RUN_ID, now - 300, now - 250, now - 200);
    target
      .prepare(
        `INSERT INTO "RunAttempts" (
          id, run_id, attempt, status, executor_type, callback_sequence,
          created_at_ms, started_at_ms, finished_at_ms,
          error_code, error_summary
        ) VALUES (?, ?, 1, 'lost', 'local_process', 0, ?, ?, ?,
          'LOCAL_RECOVERY_EXECUTION_NOT_RUNNING', 'lost')`,
      )
      .run(
        LOST_RETRY_ATTEMPT_ID,
        LOST_RETRY_RUN_ID,
        now - 250,
        now - 200,
        now - 100,
      );
    target
      .prepare(
        `INSERT INTO "RunRetryPolicies" (
          run_id, max_attempts, retry_on_lost, safety,
          backoff_base_ms, backoff_max_ms, next_attempt_at_ms,
          version, created_at_ms, updated_at_ms
        ) VALUES (?, 3, 1, 'idempotent', 86400000, 86400000,
          NULL, 0, ?, ?)`,
      )
      .run(LOST_RETRY_RUN_ID, now - 300, now - 300);
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
  }
}

function insertManyActiveTargetRuns(value, count) {
  const target = new DatabaseSync(value.targetPath);
  const statement = target.prepare(
    `INSERT INTO "Runs" (
      id, project_id, task_id, task_revision, trigger_type,
      execution_origin, execution_owner, status, version, event_sequence,
      priority, created_at_ms
    ) VALUES (?, 'default', 'task-many', 'revision-many', 'manual',
      'manual', 'runtime', 'running', 0, 0, 0, 1)`,
  );
  target.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < count; index += 1) {
      statement.run(`run-${String(index).padStart(4, '0')}`);
    }
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
  }
}

function workflowFixtureUuid(namespace, kind) {
  const digest = createHash('sha256')
    .update(`${namespace}\0${kind}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(
    13,
    16,
  )}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function insertExecutableWorkflow(value, namespace, options = {}) {
  const fixtureValue = pluginPackageTaskReconciliationFixture(namespace, {
    profile: value.profile,
    tasks: options.tasks ?? [
      ['alpha', 'a'.repeat(12 * 1024)],
      ['beta', 'b'.repeat(12 * 1024)],
    ],
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [
          { id: 'collect', task: 'alpha', needs: [] },
          { id: 'summarize', task: 'beta', needs: ['collect'] },
        ],
      },
    ],
  });
  const publication = createInitialPluginPackageAutomationPublication(
    fixtureValue.revision,
    fixtureValue.registry,
    2_000,
  );
  const workflow = createPluginPackageWorkflowExecutionPlan({
    planId: workflowFixtureUuid(namespace, 'plan'),
    runId: workflowFixtureUuid(namespace, 'run'),
    workflowId: 'daily',
    stepRunIds: {
      collect: workflowFixtureUuid(namespace, 'collect'),
      summarize: workflowFixtureUuid(namespace, 'summarize'),
    },
    publication,
    revision: fixtureValue.revision,
    taskSpecSemanticRegistry: fixtureValue.registry,
    plannedAtMs: 3_000,
  });
  const client = new DatabaseSync(value.targetPath, { timeout: 100 });
  client.exec('PRAGMA foreign_keys = ON');
  try {
    client
      .prepare(
        `INSERT INTO "QingLong3Projects"
         (id, name, slug, status, version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'active', 1, 1, 1)`,
      )
      .run(
        fixtureValue.projectId,
        fixtureValue.projectId,
        fixtureValue.projectId,
      );
    await activateInstall(
      new LocalSqlitePluginPackageInstallRepository(client),
      fixtureValue,
    );
    await new LocalSqlitePluginPackageMaterializedRevisionRepository(
      client,
      fixtureValue.registry,
    ).publish(fixtureValue.revision);
    await new LocalSqlitePluginPackageTaskReconciliationRepository(
      client,
      fixtureValue.registry,
    ).reconcile(fixtureValue.revision, {
      async findActiveResourceGeneration() {
        return fixtureValue.revision.generation;
      },
    });
    await new LocalSqlitePluginPackageAutomationPublicationRepository(
      client,
    ).publish(publication);
    await new LocalSqlitePluginPackageWorkflowAdmissionRepository(client).admit(
      workflow,
    );
  } finally {
    client.close();
  }
  return { fixture: fixtureValue, workflow };
}

function createWorkflowCancellationProductCommand(value, seeded) {
  const ownerPepperKeyringDirectory = path.join(
    value.directory,
    'workflow-owner-keys',
  );
  const commandsDirectory = path.join(value.directory, 'workflow-commands');
  const credentialFilePath = path.join(
    value.directory,
    'workflow-owner-credential.json',
  );
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  const pepper = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: WORKFLOW_CANCELLATION_PEPPER_KEY_ID,
    randomBytes: () => Buffer.from(WORKFLOW_CANCELLATION_PEPPER_BYTES),
  });
  const now = Date.now();
  const database = new DatabaseSync(value.targetPath, { timeout: 100 });
  try {
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           "pepper_key_id", "material_digest", "backup_digest", "state",
           "version", "register_mutation_id", "activate_mutation_id",
           "registered_at_ms", "activated_at_ms"
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        WORKFLOW_CANCELLATION_PEPPER_KEY_ID,
        pepper.digest,
        'f'.repeat(64),
        'a1000000-0000-4000-8000-000000000001',
        'a1000000-0000-4000-8000-000000000002',
        now - 2_000,
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           "generation", "mutation_id", "expected_generation",
           "previous_pepper_key_id", "active_pepper_key_id",
           "material_digest", "backup_digest", "activated_at_ms"
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        'a1000000-0000-4000-8000-000000000002',
        WORKFLOW_CANCELLATION_PEPPER_KEY_ID,
        pepper.digest,
        'f'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           "subject_type", "subject_id", "status", "version",
           "created_at_ms", "updated_at_ms"
         ) VALUES ('user', 'application-workflow-owner', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           "credential_id", "version", "state", "subject_type",
           "subject_id", "secret_digest", "created_at_ms",
           "not_before_at_ms", "expires_at_ms"
         ) VALUES (?, 1, 'active', 'user', 'application-workflow-owner',
                   ?, ?, ?, ?)`,
      )
      .run(
        WORKFLOW_CANCELLATION_CREDENTIAL_ID,
        apiCredentialSecretDigest(
          WORKFLOW_CANCELLATION_PEPPER_BYTES.toString('base64url'),
          WORKFLOW_CANCELLATION_CREDENTIAL_ID,
          WORKFLOW_CANCELLATION_SECRET,
        ),
        now - 1_000,
        now - 1_000,
        now + 10 * 60_000,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           "credential_id", "credential_version", "pepper_key_id"
         ) VALUES (?, 1, ?)`,
      )
      .run(
        WORKFLOW_CANCELLATION_CREDENTIAL_ID,
        WORKFLOW_CANCELLATION_PEPPER_KEY_ID,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           "project_id", "subject_type", "subject_id", "version", "state",
           "role", "mutation_id", "changed_by_type", "changed_by_id",
           "created_at_ms"
         ) VALUES (?, 'user', 'application-workflow-owner', 1, 'active',
                   'owner', ?, 'user', 'application-workflow-owner', ?)`,
      )
      .run(
        seeded.fixture.projectId,
        'application-workflow-owner-binding',
        now - 500,
      );
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: formatApiCredentialToken(
        WORKFLOW_CANCELLATION_CREDENTIAL_ID,
        WORKFLOW_CANCELLATION_SECRET,
      ),
    })}\n`,
    { mode: 0o600 },
  );
  const commandFilePath = path.join(commandsDirectory, 'cancel.json');
  fs.writeFileSync(
    commandFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'workflow.cancel',
      options: {
        deploymentRoot: value.directory,
        databasePath: value.targetPath,
        profile: value.profile,
        ownerPepperKeyringDirectory,
        credentialFilePath,
        busyTimeoutMs: 100,
      },
      request: {
        projectId: seeded.fixture.projectId,
        packageName: seeded.fixture.packageName,
        runId: seeded.workflow.runId,
        mutationId: 'a2000000-0000-4000-8000-000000000001',
        runEventId: 'a2000000-0000-4000-8000-000000000002',
        requestId: 'application-workflow-cancel',
        auditEventId: 'a2000000-0000-4000-8000-000000000003',
        failureAuditEventId: 'a2000000-0000-4000-8000-000000000004',
      },
    })}\n`,
    { mode: 0o600 },
  );
  return commandFilePath;
}

async function insertExecutablePrompt(value, namespace) {
  const fixtureValue = pluginPackageTaskReconciliationFixture(namespace, {
    profile: value.profile,
    tasks: [],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'summary',
        name: 'Summary',
        template: 'Summarize {{subject}} for {{audience}}.',
        parameters: [
          { name: 'audience', required: false },
          { name: 'subject', required: true },
        ],
      },
    ],
  });
  const publication = createInitialPluginPackageAutomationPublication(
    fixtureValue.revision,
    fixtureValue.registry,
    2_000,
  );
  const client = new DatabaseSync(value.targetPath, { timeout: 100 });
  client.exec('PRAGMA foreign_keys = ON');
  try {
    client
      .prepare(
        `INSERT INTO "QingLong3Projects"
         (id, name, slug, status, version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'active', 1, 1, 1)`,
      )
      .run(
        fixtureValue.projectId,
        fixtureValue.projectId,
        fixtureValue.projectId,
      );
    await activateInstall(
      new LocalSqlitePluginPackageInstallRepository(client),
      fixtureValue,
    );
    await new LocalSqlitePluginPackageMaterializedRevisionRepository(
      client,
      fixtureValue.registry,
    ).publish(fixtureValue.revision);
    await new LocalSqlitePluginPackageTaskReconciliationRepository(
      client,
      fixtureValue.registry,
    ).reconcile(fixtureValue.revision, {
      async findActiveResourceGeneration() {
        return fixtureValue.revision.generation;
      },
    });
    await new LocalSqlitePluginPackageAutomationPublicationRepository(
      client,
    ).publish(publication);
  } finally {
    client.close();
  }
  return { fixture: fixtureValue, publication };
}

async function waitForWorkflowStatus(
  databasePath,
  runId,
  expectedStatus,
  timeoutMs = 30_000,
) {
  const client = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 100,
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const row = client
        .prepare(
          `SELECT status
             FROM "Runs"
            WHERE id = ?`,
        )
        .get(runId);
      if (row?.status === expectedStatus) return;
      if (
        row &&
        ['succeeded', 'failed', 'cancelled', 'timed_out', 'lost'].includes(
          row.status,
        )
      ) {
        const attempts = client
          .prepare(
            `SELECT attempt, status, error_code AS "errorCode",
                    error_summary AS "errorSummary", exit_code AS "exitCode"
               FROM "RunAttempts"
              WHERE run_id = ?
              ORDER BY attempt`,
          )
          .all(runId)
          .map((attempt) => ({ ...attempt }));
        const steps = client
          .prepare(
            `SELECT step_key AS "stepKey", status,
                    result_code AS "resultCode",
                    error_summary AS "errorSummary"
               FROM "StepRuns"
              WHERE run_id = ?
              ORDER BY step_key`,
          )
          .all(runId)
          .map((step) => ({ ...step }));
        assert.fail(
          `Workflow ${runId} became ${row.status}: ${JSON.stringify({
            attempts,
            steps,
          })}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const row = client
      .prepare(
        `SELECT status
           FROM "Runs"
          WHERE id = ?`,
      )
      .get(runId);
    if (row?.status === expectedStatus) return;
    const attempts = client
      .prepare(
        `SELECT attempt, status, callback_sequence AS "callbackSequence",
                error_code AS "errorCode", error_summary AS "errorSummary",
                exit_code AS "exitCode"
           FROM "RunAttempts"
          WHERE run_id = ?
          ORDER BY attempt`,
      )
      .all(runId)
      .map((attempt) => ({ ...attempt }));
    const steps = client
      .prepare(
        `SELECT step_key AS "stepKey", status,
                result_code AS "resultCode",
                error_summary AS "errorSummary"
           FROM "StepRuns"
          WHERE run_id = ?
          ORDER BY step_key`,
      )
      .all(runId)
      .map((step) => ({ ...step }));
    const journal = client
      .prepare(
        `SELECT state, COUNT(*) AS count
           FROM "LocalCompletionReceiptJournal"
          WHERE run_id = ?
          GROUP BY state
          ORDER BY state`,
      )
      .all(runId)
      .map((entry) => ({ ...entry }));
    assert.fail(
      `Workflow ${runId} stayed ${
        row?.status ?? 'missing'
      } instead of ${expectedStatus}: ${JSON.stringify({
        attempts,
        steps,
        journal,
      })}`,
    );
  } finally {
    client.close();
  }
}

async function waitForWorkflowAttemptStatus(
  databasePath,
  runId,
  expectedStatus,
  timeoutMs = 30_000,
) {
  const client = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: 100,
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const row = client
        .prepare(
          `SELECT attempt.id, attempt.status, attempt.pid,
                  attempt.executor_handle AS "executorHandle",
                  step.status AS "stepStatus"
             FROM "RunAttempts" AS attempt
             JOIN "StepRuns" AS step
               ON step.run_id = attempt.run_id
              AND step.id = attempt.step_run_id
            WHERE attempt.run_id = ?
            ORDER BY attempt.attempt DESC
            LIMIT 1`,
        )
        .get(runId);
      if (row?.status === expectedStatus) return { ...row };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const row = client
      .prepare(
        `SELECT attempt.id, attempt.status, attempt.pid,
                attempt.executor_handle AS "executorHandle",
                step.status AS "stepStatus"
           FROM "RunAttempts" AS attempt
           JOIN "StepRuns" AS step
             ON step.run_id = attempt.run_id
            AND step.id = attempt.step_run_id
          WHERE attempt.run_id = ?
          ORDER BY attempt.attempt DESC
          LIMIT 1`,
      )
      .get(runId);
    if (row?.status === expectedStatus) return { ...row };
    assert.fail(
      `Workflow ${runId} Attempt stayed ${
        row?.status ?? 'missing'
      } instead of ${expectedStatus}`,
    );
  } finally {
    client.close();
  }
}

function insertReceiptedTargetRun(value) {
  const target = new DatabaseSync(value.targetPath);
  target.exec('BEGIN IMMEDIATE');
  try {
    target
      .prepare(
        `INSERT INTO "Runs" (
          id, project_id, task_id, task_revision, trigger_type,
          execution_origin, execution_owner, status, version, event_sequence,
          priority, created_at_ms, started_at_ms
        ) VALUES (?, 'default', 'task-receipt', 'revision-receipt', 'manual',
          'manual', 'runtime', 'running', 0, 0, 0, 1, 2)`,
      )
      .run(RECEIPT_RUN_ID);
    target
      .prepare(
        `INSERT INTO "RunAttempts" (
          id, run_id, attempt, status, executor_type, executor_handle, pid,
          callback_token_hash, callback_sequence, created_at_ms, started_at_ms
        ) VALUES (?, ?, 1, 'running', 'local_process', 'invalid-unused', 123,
          ?, 0, 1, 2)`,
      )
      .run(
        RECEIPT_ATTEMPT_ID,
        RECEIPT_RUN_ID,
        createHash('sha256').update(RECEIPT_TOKEN).digest('hex'),
      );
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
  }
}

function insertTerminalReceiptJournalCandidate(value) {
  const target = new DatabaseSync(value.targetPath);
  target.exec('BEGIN IMMEDIATE');
  try {
    target
      .prepare(
        `INSERT INTO "Runs" (
          id, project_id, task_id, task_revision, trigger_type,
          execution_origin, execution_owner, status, version, event_sequence,
          priority, created_at_ms, started_at_ms, finished_at_ms
        ) VALUES (?, 'default', 'task-cleanup', 'revision-cleanup', 'manual',
          'manual', 'runtime', 'succeeded', 0, 0, 0, 1, 2, 3)`,
      )
      .run(CLEANUP_RUN_ID);
    target
      .prepare(
        `INSERT INTO "RunAttempts" (
          id, run_id, attempt, status, executor_type, callback_sequence,
          created_at_ms, started_at_ms, finished_at_ms, exit_code
        ) VALUES (?, ?, 1, 'succeeded', 'local_process', 1, 1, 2, 3, 0)`,
      )
      .run(CLEANUP_ATTEMPT_ID, CLEANUP_RUN_ID);
    target
      .prepare(
        `INSERT INTO "LocalCompletionReceiptJournal" (
          attempt_id, run_id, state, registered_at_ms, updated_at_ms
        ) VALUES (?, ?, 'pending', 2, 2)`,
      )
      .run(CLEANUP_ATTEMPT_ID, CLEANUP_RUN_ID);
    target.exec('COMMIT');
  } catch (error) {
    if (target.isTransaction) target.exec('ROLLBACK');
    throw error;
  } finally {
    target.close();
  }
}

test('disabled application does not inspect paths or assemble a stack', async () => {
  const records = [];
  const result = await bootstrapLocalApplication({
    enabled: false,
    profile: 'edge',
    applicationAudit: (record) => records.push(record),
  });

  assert.equal(result.status, 'disabled');
  assert.equal(await result.stop(), 'stopped');
  assert.deepEqual(records, [{ profile: 'edge', state: 'disabled' }]);
});

test('excluded or disabled product startup does not load the optional AI package', () => {
  const script = `
    const modulePath = ${JSON.stringify(
      path.resolve(
        __dirname,
        '../dist/application-runtime/aiFeatureApplication.js',
      ),
    )};
    const { bootstrapLocalAiFeatureApplication } = require(modulePath);
    bootstrapLocalAiFeatureApplication({
      application: {
        enabled: false,
        profile: 'edge',
        applicationAudit() {},
      },
      ai: {
        deployment: 'excluded',
        audit() {},
      },
    }).then(async (result) => {
      await result.stop();
      const loaded = Object.keys(require.cache).filter((file) =>
        file.includes('/ql3-ai/')
      );
      process.stdout.write(JSON.stringify({ status: result.status, loaded }));
    }).catch((error) => {
      process.stderr.write(error.stack || String(error));
      process.exitCode = 1;
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    status: 'disabled',
    loaded: [],
  });
});

test('installed AI deployment keeps providers unreachable without an active schema', async (t) => {
  const value = await prepare(t, 'edge');
  const actions = [];
  const aiAudits = [];
  let providerLoads = 0;
  const result = await bootstrapLocalAiFeatureApplication({
    application: options(value),
    ai: {
      deployment: 'installed',
      async loadProviders() {
        providerLoads += 1;
        return localAiProviders(actions);
      },
      audit(record) {
        aiAudits.push(record);
      },
    },
  });

  assert.equal(result.status, 'active');
  assert.deepEqual(result.ai, { status: 'schema_absent' });
  assert.equal(providerLoads, 0);
  assert.deepEqual(aiAudits, [{ profile: 'edge', state: 'schema_absent' }]);
  assert.equal(await result.stop(), 'stopped');
  assert.equal(actions.includes('dispose_ai_providers'), false);
});

test('active head drives startup, request-time deactivation drain and inactive restart', async (t) => {
  const value = await prepare(t, 'edge');
  const activation = await activateLocalAiFeature(value);
  const actions = [];
  const aiAudits = [];
  let providerLoads = 0;
  const ai = {
    deployment: 'installed',
    async loadProviders() {
      providerLoads += 1;
      return localAiProviders(actions);
    },
    audit(record) {
      aiAudits.push(record);
    },
    drainTimeoutMs: 1_000,
    drainPollMs: 10,
  };
  const result = await bootstrapLocalAiFeatureApplication({
    application: options(value, { events: actions }),
    ai,
  });

  assert.equal(result.status, 'active');
  assert.equal(result.ai.status, 'active');
  assert.equal(result.ai.generation, activation.generation);
  assert.equal(typeof result.ai.prompts.execute, 'function');
  assert.equal(providerLoads, 1);
  assert.deepEqual(
    await result.ai.capability.listProjectUsage({
      projectId: 'default',
      fromMsInclusive: 0,
      toMsExclusive: 1,
      limit: 1,
    }),
    { records: [], hasMore: false },
  );

  const deactivation = deactivateLocalAiFeature(value, activation);
  assert.equal(deactivation.state, 'inactive');
  await assert.rejects(
    result.ai.capability.listProjectUsage({
      projectId: 'default',
      fromMsInclusive: 0,
      toMsExclusive: 1,
      limit: 1,
    }),
    ModelGatewayProfileDrainingError,
  );
  assert.equal(result.ai.capability.accepting, false);
  assert.equal(
    actions.filter((item) => item === 'dispose_ai_providers').length,
    1,
  );
  assert.equal(await result.stop(), 'stopped');
  assert.ok(
    actions.indexOf('dispose_ai_providers') <
      actions.indexOf('application:draining'),
  );
  assert.equal(
    aiAudits.some(({ state }) => state === 'draining'),
    true,
  );
  assert.equal(
    aiAudits.some(({ state }) => state === 'stopped'),
    true,
  );

  const restartActions = [];
  let restartProviderLoads = 0;
  const restarted = await bootstrapLocalAiFeatureApplication({
    application: options(value),
    ai: {
      deployment: 'installed',
      async loadProviders() {
        restartProviderLoads += 1;
        return localAiProviders(restartActions);
      },
      audit() {},
    },
  });
  assert.equal(restarted.status, 'active');
  assert.deepEqual(restarted.ai, {
    status: 'inactive',
    generation: deactivation.generation,
  });
  assert.equal(restartProviderLoads, 0);
  assert.equal(await restarted.stop(), 'stopped');
});

test('executes one active Package Prompt through local AI composition with content-free exact replay', async (t) => {
  const resource = promptResourceConfiguration();
  const rssBeforeBytes = process.memoryUsage().rss;
  let peakProcessRssBytes = rssBeforeBytes;
  const rssSampler = setInterval(() => {
    peakProcessRssBytes = Math.max(
      peakProcessRssBytes,
      process.memoryUsage().rss,
    );
  }, 5);
  rssSampler.unref?.();
  t.after(() => clearInterval(rssSampler));

  const value = await prepare(t, resource.profile);
  await activateLocalAiFeature(value);
  const seeded = await insertExecutablePrompt(
    value,
    'application-prompt-resource',
  );
  const databaseBefore = fs.statSync(value.targetPath);
  const metrics = {
    privateInput: 'private router prompt input',
    privateOutput: resource.output,
    maxOutputBytes: resource.outputBytes,
    providerCalls: 0,
    providerDisposals: 0,
    keyLoads: 0,
    keyResolutions: 0,
    lastResolvedKey: null,
  };
  const result = await bootstrapLocalAiFeatureApplication({
    application: options(value),
    ai: {
      deployment: 'installed',
      loadProviders: async () => localAiPromptProviders(metrics),
      audit() {},
      maxConcurrent: 1,
      recoveryLimit: 16,
      now: () => 3_000,
      promptOutputKeys: {
        async active() {
          metrics.keyLoads += 1;
          return {
            keyId: 'edge-prompt-output-key-1',
            key: Buffer.alloc(32, 7),
          };
        },
        async resolve(keyId) {
          metrics.keyResolutions += 1;
          metrics.lastResolvedKey = Buffer.alloc(32, 7);
          return { keyId, key: metrics.lastResolvedKey };
        },
      },
      promptOutputRead: {
        authorizer: {
          async authorize(request) {
            assert.equal(
              request.projectId,
              'project-application-prompt-resource',
            );
            assert.equal(request.principal.subject.id, 'edge-resource-owner');
            return { effect: 'allow' };
          },
        },
        retention: {
          async inspect() {
            return { state: 'retained' };
          },
        },
      },
    },
  });

  assert.equal(result.status, 'active');
  assert.equal(result.ai.status, 'active');
  const execution = {
    publication: seeded.publication,
    expectedPublicationDigest: seeded.publication.publicationDigest,
    promptId: 'summary',
    requestId: 'edge-resource-prompt-request',
    traceId: 'edge-resource-prompt-trace',
    requestedBySubject: { type: 'user', id: 'edge-resource-owner' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { subject: metrics.privateInput },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 512,
    temperature: 0.2,
    plannedAtMs: 2_000,
    deadlineAtMs: 62_000,
  };
  const first = await result.ai.prompts.execute(execution);
  const replay = await result.ai.prompts.execute(execution);

  assert.equal(first.status, 'executed');
  assert.equal(first.result.text, metrics.privateOutput);
  assert.equal(first.finalization.runStatus, 'succeeded');
  assert.equal(replay.status, 'existing');
  assert.equal(replay.result, null);
  assert.deepEqual(replay.admission, first.admission);
  assert.deepEqual(replay.finalization, first.finalization);
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.keyLoads, 0);
  const durableStorageBefore = sqliteStorageSnapshot(value.targetPath);
  const durableExecution = {
    ...execution,
    requestId: 'edge-resource-prompt-durable-request',
    traceId: 'edge-resource-prompt-durable-trace',
    output: {
      mode: 'durable_artifact',
      retentionPolicy: {
        revision: 'edge-prompt-output-v1',
        retentionMs: 86_400_000,
      },
    },
  };
  const durableFirst = await result.ai.prompts.execute(durableExecution);
  const durableReplay = await result.ai.prompts.execute(durableExecution);
  assert.equal(durableFirst.status, 'executed');
  assert.equal(durableFirst.result.text, metrics.privateOutput);
  assert.equal(durableFirst.outputArtifact.artifactId.startsWith('pao:'), true);
  assert.equal(durableReplay.status, 'existing');
  assert.equal(durableReplay.result, null);
  assert.deepEqual(durableReplay.outputArtifact, durableFirst.outputArtifact);
  assert.equal(metrics.providerCalls, 2);
  assert.equal(metrics.keyLoads, 1);
  assert.ok(result.ai.promptOutputs);
  const durableRead = await result.ai.promptOutputs.read({
    principal: {
      subject: { type: 'user', id: 'edge-resource-owner' },
      authenticationId: 'edge-resource-auth',
      authenticatedAtMs: 2_000,
      expiresAtMs: 62_000,
      assurance: 'local_console',
    },
    projectId: durableFirst.outputArtifact.projectId,
    runId: durableFirst.outputArtifact.runId,
    artifactId: durableFirst.outputArtifact.artifactId,
    artifactDigest: durableFirst.outputArtifact.artifactDigest,
  });
  assert.equal(durableRead.status, 'available');
  assert.equal(durableRead.result.text, metrics.privateOutput);
  assert.deepEqual(durableRead.reference, durableFirst.outputArtifact);
  assert.ok(result.ai.promptExecutionOutputs);
  const recoveredByRequest = await result.ai.promptExecutionOutputs.read({
    principal: {
      subject: { type: 'user', id: 'edge-resource-owner' },
      authenticationId: 'edge-resource-auth',
      authenticatedAtMs: 2_000,
      expiresAtMs: 62_000,
      assurance: 'local_console',
    },
    projectId: seeded.publication.target.projectId,
    packageName: seeded.publication.target.packageName,
    promptId: durableExecution.promptId,
    executionRequestId: durableExecution.requestId,
  });
  assert.equal(recoveredByRequest.status, 'available');
  assert.equal(recoveredByRequest.result.text, metrics.privateOutput);
  assert.deepEqual(recoveredByRequest.reference, durableFirst.outputArtifact);
  assert.equal(metrics.keyResolutions, 2);
  assert.equal(
    metrics.lastResolvedKey.every((byte) => byte === 0),
    true,
  );
  const durableStorageAfter = sqliteStorageSnapshot(value.targetPath);
  const durableStorageGrowth = sqliteStorageGrowth(
    durableStorageBefore,
    durableStorageAfter,
  );
  assert.equal(await result.stop(), 'stopped');
  assert.equal(metrics.providerDisposals, 1);

  const reader = new DatabaseSync(value.targetPath, {
    readOnly: true,
    timeout: 100,
  });
  let durableFacts;
  try {
    durableFacts = {
      run: {
        ...reader
          .prepare(
            `SELECT status, version, event_sequence AS "eventSequence"
               FROM "Runs" WHERE id = ?`,
          )
          .get(first.admission.runId),
      },
      step: {
        ...reader
          .prepare(
            `SELECT kind, status, version
               FROM "StepRuns" WHERE id = ?`,
          )
          .get(first.admission.stepRunId),
      },
      runEvents: reader
        .prepare(`SELECT count(*) AS count FROM "RunEvents" WHERE run_id = ?`)
        .get(first.admission.runId).count,
      attempts: reader
        .prepare(`SELECT count(*) AS count FROM "RunAttempts" WHERE run_id = ?`)
        .get(first.admission.runId).count,
      starts: reader
        .prepare(
          `SELECT count(*) AS count FROM "ModelInvocationStarts"
            WHERE invocation_id = ?`,
        )
        .get(first.admission.invocationId).count,
      completions: reader
        .prepare(
          `SELECT count(*) AS count FROM "ModelInvocationCompletions"
            WHERE invocation_id = ?`,
        )
        .get(first.admission.invocationId).count,
      admissions: reader
        .prepare(
          `SELECT count(*) AS count FROM "ModelInvocationPromptAdmissions"
            WHERE request_id = ?`,
        )
        .get(first.admission.requestId).count,
      finalizations: reader
        .prepare(
          `SELECT count(*) AS count FROM "ModelInvocationPromptFinalizations"
            WHERE request_id = ?`,
        )
        .get(first.admission.requestId).count,
      durableOutput: {
        ...reader
          .prepare(
            `SELECT artifact.artifact_id AS "artifactId",
                    artifact.artifact_digest AS "artifactDigest",
                    step.output_ref AS "outputRef"
               FROM "ModelInvocationPromptOutputArtifacts" AS artifact
               JOIN "StepRuns" AS step ON step.id = artifact.step_run_id
              WHERE artifact.invocation_id = ?`,
          )
          .get(durableFirst.admission.invocationId),
      },
      integrityCheck: reader.prepare('PRAGMA integrity_check').get()
        .integrity_check,
    };
  } finally {
    reader.close();
  }
  assert.deepEqual(durableFacts, {
    run: { status: 'succeeded', version: 5, eventSequence: 5 },
    step: { kind: 'model', status: 'succeeded', version: 3 },
    runEvents: 5,
    attempts: 0,
    starts: 1,
    completions: 1,
    admissions: 1,
    finalizations: 1,
    durableOutput: {
      artifactId: durableFirst.outputArtifact.artifactId,
      artifactDigest: durableFirst.outputArtifact.artifactDigest,
      outputRef: durableFirst.outputArtifact.artifactId,
    },
    integrityCheck: 'ok',
  });

  const databaseAfter = fs.statSync(value.targetPath);
  const databaseFileGrowthBytes = Math.max(
    0,
    databaseAfter.size - databaseBefore.size,
  );
  const databaseAllocatedGrowthBytes = Math.max(
    0,
    databaseAfter.blocks * 512 - databaseBefore.blocks * 512,
  );
  const durableBytes = fs.readFileSync(value.targetPath);
  const contentFree =
    !durableBytes.includes(Buffer.from(metrics.privateInput)) &&
    !durableBytes.includes(Buffer.from(metrics.privateOutput));
  assert.equal(contentFree, true);
  const writeAmplification = (bytes) =>
    Math.ceil((bytes * 1000) / resource.outputBytes);
  const databaseLogicalWriteAmplificationPermille = writeAmplification(
    durableStorageGrowth.logicalBytes,
  );
  const databaseAllocatedWriteAmplificationPermille = writeAmplification(
    durableStorageGrowth.allocatedBytes,
  );
  const walWriteAmplificationPermille = writeAmplification(
    durableStorageGrowth.walBytes,
  );
  if (!resource.resourceProbe) {
    assert.ok(
      databaseFileGrowthBytes <= 1024 * 1024,
      `Prompt database growth ${databaseFileGrowthBytes} exceeded 1 MiB`,
    );
  }

  clearInterval(rssSampler);
  peakProcessRssBytes = Math.max(
    peakProcessRssBytes,
    process.memoryUsage().rss,
  );
  t.diagnostic(
    `QL3_RESOURCE_EVIDENCE=${JSON.stringify({
      schemaVersion: 1,
      profile: resource.profile,
      workload: 'active_plugin_package_prompt',
      rssBeforeBytes,
      peakProcessRssBytes,
      rssDeltaBytes: Math.max(0, peakProcessRssBytes - rssBeforeBytes),
      databaseBytesBefore: databaseBefore.size,
      databaseBytesAfter: databaseAfter.size,
      databaseFileGrowthBytes,
      databaseAllocatedGrowthBytes,
      durableOutputBytes: resource.outputBytes,
      durableStorageBefore,
      durableStorageAfter,
      durableStorageLogicalGrowthBytes: durableStorageGrowth.logicalBytes,
      durableStorageAllocatedGrowthBytes: durableStorageGrowth.allocatedBytes,
      walGrowthBytes: durableStorageGrowth.walBytes,
      databaseLogicalWriteAmplificationPermille,
      databaseAllocatedWriteAmplificationPermille,
      walWriteAmplificationPermille,
      journalMode: resource.profile === 'edge' ? 'delete' : 'wal',
      providerCalls: metrics.providerCalls,
      keyLoads: metrics.keyLoads,
      keyResolutions: metrics.keyResolutions,
      liveOnlyKeyLoads: 0,
      exactReplay:
        replay.status === 'existing' &&
        replay.result === null &&
        durableReplay.status === 'existing' &&
        durableReplay.result === null,
      contentFree,
      durableFacts,
      physicalPowerLossProven: false,
    })}`,
  );
});

test('active feature startup failure closes the base application and optional authority', async (t) => {
  const value = await prepare(t, 'edge');
  await activateLocalAiFeature(value);
  const events = [];
  await assert.rejects(
    bootstrapLocalAiFeatureApplication({
      application: options(value, { events }),
      ai: {
        deployment: 'installed',
        async loadProviders() {
          throw new Error('provider configuration unavailable');
        },
        audit() {},
      },
    }),
    LocalAiFeatureApplicationUnavailableError,
  );
  assert.equal(events.includes('application:active'), true);
  assert.equal(events.at(-1), 'application:stopped');
  assertSourceWritable(value, 118);
});

test('activates the concrete headless runtime in recovery and lifecycle order', async (t) => {
  const value = await prepare(t, 'edge');
  const events = [];
  const result = await bootstrapLocalApplication(options(value, { events }));

  assert.equal(result.status, 'active');
  assert.equal(await result.runs.findRunById('missing'), null);
  assert.deepEqual(events, [
    'adoption:fence_acquired',
    'storage:storage_ready',
    'adoption:storage_ready',
    'application:storage_ready',
    'application:plugin_packages_recovered',
    'application:plugin_package_tasks_published',
    'application:plugin_package_automations_published',
    'application:plugin_package_tools_snapshotted',
    'application:secrets_ready',
    'application:runs_recovered',
    'application:receipts_reconciled',
    'application:recovered',
    'application:lifecycles_started',
    'application:active',
  ]);
  assert.deepEqual(result.pluginPackageRecovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    deferred: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.pluginPackageTaskPublicationRecovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.pluginPackageAutomationPublicationRecovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.pluginPackageToolSnapshotRecovery, {
    pages: 1,
    scanned: 1,
    settled: 1,
    retry: 0,
    manualRequired: 0,
    remaining: false,
    safeToAdmit: true,
  });
  const snapshotReader = new DatabaseSync(value.targetPath, {
    readOnly: true,
  });
  const snapshotRow = snapshotReader
    .prepare(
      `SELECT project_id, snapshot_json
         FROM "QingLong3ProjectToolDefinitionSnapshots"
        WHERE project_id = 'default'`,
    )
    .get();
  const snapshotSourceCount = snapshotReader
    .prepare(
      `SELECT count(*) AS count
         FROM "QingLong3ProjectToolDefinitionSnapshotSources"
        WHERE project_id = 'default'`,
    )
    .get().count;
  snapshotReader.close();
  assert.equal(snapshotRow.project_id, 'default');
  const snapshot = JSON.parse(snapshotRow.snapshot_json);
  assert.deepEqual(snapshot.sources, []);
  assert.deepEqual(snapshot.definitions, []);
  assert.equal(snapshotSourceCount, 0);
  const legacyWriter = new DatabaseSync(value.sourcePath, { timeout: 100 });
  assert.throws(
    () =>
      legacyWriter
        .prepare('INSERT INTO "Crontabs" (id, command) VALUES (?, ?)')
        .run(2, 'echo blocked'),
    (error) => error && error.errstr === 'database is locked',
  );
  legacyWriter.close();

  assert.equal(await result.stop(), 'stopped');
  assert.deepEqual(events.slice(-4), [
    'application:draining',
    'storage:stopped',
    'adoption:stopped',
    'application:stopped',
  ]);
  assertSourceWritable(value, 2);
});

test('starts an optional product surface after recovery and drains it before owned runtime authorities', async (t) => {
  const value = await prepare(t, 'edge');
  const events = [];
  const result = await bootstrapLocalApplication(
    options(value, {
      events,
      productSurface: {
        async start(authority) {
          events.push('surface:started');
          assert.equal(authority.profile, 'edge');
          assert.equal(typeof authority.runs.findRunById, 'function');
          assert.equal(
            typeof authority.runCancellation.requestUserCancellation,
            'function',
          );
          assert.equal(
            typeof authority.taskDefinitions.findCurrentTaskDefinition,
            'function',
          );
          assert.equal(
            typeof authority.taskDefinitions.listTaskDefinitions,
            'function',
          );
          assert.equal(typeof authority.runAttemptLogRead.read, 'function');
          assert.equal(typeof authority.apiCredentials.resolve, 'function');
          assert.equal(typeof authority.ownerPepper.resolveKey, 'function');
          assert.equal(typeof authority.projectPolicy.resolve, 'function');
          assert.equal(typeof authority.securityAudit.record, 'function');
          return {
            async stopAndDrain() {
              events.push('surface:stopped');
              return 'stopped';
            },
          };
        },
      },
    }),
  );

  assert.ok(
    events.indexOf('application:lifecycles_started') <
      events.indexOf('surface:started'),
  );
  assert.ok(
    events.indexOf('surface:started') < events.indexOf('application:active'),
  );
  assert.equal(await result.stop(), 'stopped');
  assert.ok(
    events.indexOf('surface:stopped') < events.indexOf('storage:stopped'),
  );
});

test('retires one eligible Local log before product reads and returns durable 410 state', async (t) => {
  const value = await prepare(t, 'edge');
  const runId = 'retention-run-1';
  const attemptId = 'retention-attempt-1';
  const artifactId = `local-${'b'.repeat(30)}`;
  const database = new DatabaseSync(value.targetPath);
  database
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version, event_sequence,
         priority, created_at_ms, finished_at_ms
       ) VALUES (?, 'default', 'task-retention', 'revision-1', 'manual',
                 'manual', 'runtime', 'succeeded', 1, 1, 0, 1, 1)`,
    )
    .run(runId);
  database
    .prepare(
      `INSERT INTO "RunAttempts" (
         id, run_id, attempt, status, executor_type, log_artifact_id,
         callback_sequence, created_at_ms, finished_at_ms
       ) VALUES (?, ?, 1, 'succeeded', 'local_process', ?, 0, 1, 1)`,
    )
    .run(attemptId, runId, artifactId);
  database.close();

  const artifactRoot = path.join(value.directory, 'artifacts');
  const shard = path.join(artifactRoot, 'bb');
  fs.mkdirSync(shard, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactRoot, 0o700);
  fs.chmodSync(shard, 0o700);
  const logPath = path.join(shard, `${artifactId}.log`);
  fs.writeFileSync(logPath, 'expired', { mode: 0o600 });
  fs.chmodSync(logPath, 0o600);

  let readResult;
  const result = await bootstrapLocalApplication(
    options(value, {
      productSurface: {
        async start(authority) {
          readResult = await authority.runAttemptLogRead.read({
            projectId: 'default',
            runId,
            attemptId,
            range: { offset: 0, length: 16 },
          });
          return { stopAndDrain: async () => 'stopped' };
        },
      },
    }),
  );
  assert.equal(readResult.status, 'retired');
  assert.equal(readResult.byteLength, 7);
  assert.equal(readResult.truncation.truncated, 'unknown');
  assert.equal(fs.existsSync(logPath), false);
  const evidence = new DatabaseSync(value.targetPath, { readonly: true });
  const tombstone = evidence
    .prepare(
      `SELECT disposition, byte_length AS "byteLength", record_digest AS "recordDigest"
       FROM "QingLong3RunAttemptLogArtifactTombstones"
       WHERE attempt_id = ?`,
    )
    .get(attemptId);
  evidence.close();
  assert.equal(tombstone.disposition, 'deleted');
  assert.equal(tombstone.byteLength, 7);
  assert.match(tombstone.recordDigest, /^[a-f0-9]{64}$/);
  assert.equal(await result.stop(), 'stopped');
});

test('executes one admitted Workflow through the single application cadence without duplicate Tasks', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('durable local process identity requires Linux /proc');
    return;
  }
  const rssBeforeBytes = process.memoryUsage().rss;
  let peakProcessRssBytes = rssBeforeBytes;
  const rssSampler = setInterval(() => {
    peakProcessRssBytes = Math.max(
      peakProcessRssBytes,
      process.memoryUsage().rss,
    );
  }, 10);
  rssSampler.unref?.();
  t.after(() => clearInterval(rssSampler));
  const value = await prepare(t, 'edge');
  const seeded = await insertExecutableWorkflow(
    value,
    'application-workflow-success',
  );
  const result = await bootstrapLocalApplication(options(value));

  assert.equal(result.status, 'active');
  assert.equal(result.runRecovery.scanned, 0);
  assert.equal(result.workflowTaskRecovery.scanned, 0);
  await waitForWorkflowStatus(
    value.targetPath,
    seeded.workflow.runId,
    'succeeded',
  );

  const reader = new DatabaseSync(value.targetPath, {
    readOnly: true,
    timeout: 100,
  });
  try {
    const run = reader
      .prepare(
        `SELECT status, version, event_sequence AS "eventSequence"
           FROM "Runs"
          WHERE id = ?`,
      )
      .get(seeded.workflow.runId);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.version, run.eventSequence);
    assert.ok(run.version >= 12);
    assert.deepEqual(
      reader
        .prepare(
          `SELECT status, attempt_count AS "attemptCount"
             FROM "StepRuns"
            WHERE run_id = ?
            ORDER BY id`,
        )
        .all(seeded.workflow.runId)
        .map((row) => ({ ...row })),
      [
        { status: 'succeeded', attemptCount: 1 },
        { status: 'succeeded', attemptCount: 1 },
      ],
    );
    assert.deepEqual(
      reader
        .prepare(
          `SELECT attempt, status
             FROM "RunAttempts"
            WHERE run_id = ?
            ORDER BY attempt`,
        )
        .all(seeded.workflow.runId)
        .map((row) => ({ ...row })),
      [
        { attempt: 1, status: 'succeeded' },
        { attempt: 2, status: 'succeeded' },
      ],
    );
    assert.equal(
      reader
        .prepare(
          `SELECT COUNT(*) AS count
             FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
            WHERE run_id = ?`,
        )
        .get(seeded.workflow.runId).count,
      2,
    );
  } finally {
    reader.close();
  }

  assert.deepEqual(await Promise.all([result.stop(), result.stop()]), [
    'stopped',
    'stopped',
  ]);
  clearInterval(rssSampler);
  peakProcessRssBytes = Math.max(
    peakProcessRssBytes,
    process.memoryUsage().rss,
  );
  t.diagnostic(
    `QL3_RESOURCE_EVIDENCE=${JSON.stringify({
      schemaVersion: 1,
      profile: 'edge',
      rssBeforeBytes,
      peakProcessRssBytes,
      rssDeltaBytes: Math.max(0, peakProcessRssBytes - rssBeforeBytes),
      workflowSteps: 2,
      attempts: 2,
    })}`,
  );
  assertSourceWritable(value, 121);
});

test('stops one running Workflow Task before terminalizing its parent cancellation', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('durable local process identity requires Linux /proc');
    return;
  }
  const value = await prepare(t, 'edge');
  const seeded = await insertExecutableWorkflow(
    value,
    'application-workflow-running-cancel',
    {
      tasks: [
        [
          'alpha',
          {
            kind: 'argv',
            file: process.execPath,
            args: [
              '-e',
              "process.stdout.write('running\\n'); setInterval(() => undefined, 1000)",
            ],
          },
        ],
        ['beta', 'must-not-run'],
      ],
    },
  );
  const cancelCommandFilePath = createWorkflowCancellationProductCommand(
    value,
    seeded,
  );
  const rssBeforeBytes = process.memoryUsage().rss;
  let peakProcessRssBytes = rssBeforeBytes;
  const rssSampler = setInterval(() => {
    peakProcessRssBytes = Math.max(
      peakProcessRssBytes,
      process.memoryUsage().rss,
    );
  }, 5);
  t.after(() => clearInterval(rssSampler));
  const result = await bootstrapLocalApplication(options(value));
  t.after(() => result.stop());
  const active = await waitForWorkflowAttemptStatus(
    value.targetPath,
    seeded.workflow.runId,
    'running',
  );
  assert.equal(active.stepStatus, 'running');
  assert.equal(typeof active.executorHandle, 'string');
  assert.equal(Number.isSafeInteger(active.pid), true);
  assert.equal(fs.existsSync(`/proc/${active.pid}`), true);

  const cancellation = await runLocalPluginPackageWorkflowCommandFile(
    cancelCommandFilePath,
  );
  assert.equal(cancellation.status, 'accepted');
  assert.equal(cancellation.runId, seeded.workflow.runId);

  await waitForWorkflowStatus(
    value.targetPath,
    seeded.workflow.runId,
    'cancelled',
  );
  const reader = new DatabaseSync(value.targetPath, {
    readOnly: true,
    timeout: 100,
  });
  let cancelEvents;
  let cancelAudits;
  try {
    assert.deepEqual(
      reader
        .prepare(
          `SELECT status
             FROM "RunAttempts"
            WHERE run_id = ?
            ORDER BY attempt`,
        )
        .all(seeded.workflow.runId)
        .map((row) => row.status),
      ['cancelled'],
    );
    assert.deepEqual(
      reader
        .prepare(
          `SELECT status
             FROM "StepRuns"
            WHERE run_id = ?
            ORDER BY id`,
        )
        .all(seeded.workflow.runId)
        .map((row) => row.status),
      ['cancelled', 'cancelled'],
    );
    const events = reader
      .prepare(
        `SELECT type
           FROM "RunEvents"
          WHERE run_id = ?
          ORDER BY sequence`,
      )
      .all(seeded.workflow.runId)
      .map((row) => row.type);
    assert.equal(events.includes('workflow.task_attempt.cancelled'), true);
    assert.equal(events.filter((type) => type === 'step.cancelled').length, 2);
    assert.equal(events.at(-1), 'workflow.cancelled');
    cancelEvents = events.filter(
      (type) => type === 'run.cancel_requested',
    ).length;
    cancelAudits = reader
      .prepare(
        `SELECT COUNT(*) AS count
           FROM "QingLong3SecurityAuditEvents"
          WHERE operation_id = 'workflow.cancel' AND outcome = 'allowed'`,
      )
      .get().count;
    assert.equal(cancelEvents, 1);
    assert.equal(cancelAudits, 1);
  } finally {
    reader.close();
  }
  assert.equal(fs.existsSync(`/proc/${active.pid}`), false);
  const replay = await runLocalPluginPackageWorkflowCommandFile(
    cancelCommandFilePath,
  );
  assert.equal(replay.status, 'existing');
  assert.equal(await result.stop(), 'stopped');
  clearInterval(rssSampler);
  peakProcessRssBytes = Math.max(
    peakProcessRssBytes,
    process.memoryUsage().rss,
  );
  t.diagnostic(
    `QL3_RESOURCE_EVIDENCE=${JSON.stringify({
      schemaVersion: 1,
      profile: 'edge',
      cancelCommandStatus: cancellation.status,
      exactReplay: replay.status === 'existing',
      processIdentityObserved: true,
      processExited: !fs.existsSync(`/proc/${active.pid}`),
      parentRunStatus: 'cancelled',
      attemptStatus: 'cancelled',
      cancelledStepRuns: 2,
      cancelEvents,
      cancelAudits,
      rssBeforeBytes,
      peakProcessRssBytes,
      physicalPowerLossProven: false,
    })}`,
  );
  assertSourceWritable(value, 122);
});

test('converges a cancelled Workflow before application dispatch and bypasses generic Run recovery', async (t) => {
  const value = await prepare(t, 'standalone');
  const seeded = await insertExecutableWorkflow(
    value,
    'application-workflow-cancel',
  );
  const writer = new DatabaseSync(value.targetPath, { timeout: 100 });
  writer
    .prepare(
      `UPDATE "Runs"
          SET cancel_requested_at_ms = 4_000,
              cancel_reason = 'user'
        WHERE id = ? AND status = 'running'`,
    )
    .run(seeded.workflow.runId);
  writer.close();

  const result = await bootstrapLocalApplication(options(value));
  assert.equal(result.status, 'active');
  assert.equal(result.runRecovery.scanned, 0);
  assert.equal(result.workflowTaskRecovery.scanned, 0);
  await waitForWorkflowStatus(
    value.targetPath,
    seeded.workflow.runId,
    'cancelled',
  );

  const reader = new DatabaseSync(value.targetPath, {
    readOnly: true,
    timeout: 100,
  });
  try {
    assert.equal(
      reader
        .prepare(
          `SELECT COUNT(*) AS count
             FROM "RunAttempts"
            WHERE run_id = ?`,
        )
        .get(seeded.workflow.runId).count,
      0,
    );
    assert.deepEqual(
      reader
        .prepare(
          `SELECT status
             FROM "StepRuns"
            WHERE run_id = ?
            ORDER BY id`,
        )
        .all(seeded.workflow.runId)
        .map(({ status }) => status),
      ['cancelled', 'cancelled'],
    );
  } finally {
    reader.close();
  }
  assert.equal(await result.stop(), 'stopped');
  assertSourceWritable(value, 122);
});

test('missing or non-private Secret keyring fails before runtime construction', async (t) => {
  const value = await prepare(t);
  const events = [];
  fs.chmodSync(value.secretKeyringPath, 0o644);

  await assert.rejects(
    bootstrapLocalApplication(options(value, { events })),
    /Local Secret is unavailable/,
  );
  assert.equal(events.includes('application:storage_ready'), true);
  assert.equal(events.includes('application:secrets_ready'), false);
  assert.equal(events.includes('application:runs_recovered'), false);
  assert.equal(events.at(-1), 'application:failed');
  assertSourceWritable(value, 119);
});

test('unavailable queued Plugin Package source fails closed before secrets and releases storage', async (t) => {
  const value = await prepare(t);
  await insertQueuedPluginPackage(value);
  const events = [];

  await assert.rejects(
    bootstrapLocalApplication(options(value, { events })),
    (error) =>
      error instanceof LocalApplicationPluginPackageRecoveryRequiredError &&
      error.recovery.scanned === 1 &&
      error.recovery.retry === 1 &&
      error.recovery.remaining === true &&
      error.recovery.safeToAdmit === false,
  );
  assert.equal(events.includes('application:plugin_packages_recovered'), false);
  assert.equal(events.includes('application:secrets_ready'), false);
  assert.equal(events.at(-1), 'application:failed');
  assertSourceWritable(value, 120);
});

test('durable Run candidates block lifecycle activation', async (t) => {
  const value = await prepare(t, 'edge');
  insertActiveTargetRun(value, '00000000-0000-7000-8000-000000000001');

  await assert.rejects(
    bootstrapLocalApplication(options(value)),
    (error) =>
      error instanceof LocalApplicationStartupRecoveryRequiredError &&
      error.observedCandidates === 1 &&
      error.truncated === false,
  );
  assertSourceWritable(value, 2);
});

test('reconciles a safe lost Run before the first Local scheduler pass', async (t) => {
  const value = await prepare(t, 'edge');
  insertSafeLostTargetRun(value);
  const audits = [];
  const result = await bootstrapLocalApplication(
    options(value, {
      applicationAudit: (record) => audits.push(record),
    }),
  );

  assert.equal(result.status, 'active');
  assert.equal(
    (await result.runs.findRunById(LOST_RETRY_RUN_ID)).status,
    'retry_wait',
  );
  const reconciled = audits.find(
    (record) => record.state === 'receipts_reconciled',
  );
  assert.deepEqual(reconciled.executionControl.lostRetry, {
    scanned: 1,
    scheduled: 1,
    requeued: 0,
    failed: 0,
    raced: 0,
    hasMore: false,
  });
  assert.equal(
    (await result.runs.findLatestAttemptByRunId(LOST_RETRY_RUN_ID)).attempt,
    1,
  );
  assert.equal(await result.stop(), 'stopped');
});

test('startup recovery candidate overflow fails closed at the hard page bound', async (t) => {
  const value = await prepare(t, 'edge');
  insertManyActiveTargetRuns(value, MAX_LOCAL_RUN_RECOVERY_ITEMS + 1);

  await assert.rejects(
    bootstrapLocalApplication(options(value)),
    (error) =>
      error instanceof LocalApplicationStartupRecoveryRequiredError &&
      error.observedCandidates === MAX_LOCAL_RUN_RECOVERY_ITEMS &&
      error.truncated === true,
  );
  assertSourceWritable(value, 2);
});

test('trusted receipt converges the real SQLite aggregate before runtime activation', async (t) => {
  const value = await prepare(t, 'edge');
  insertReceiptedTargetRun(value);
  const receiptRoot = path.join(value.directory, 'receipts');
  await new CompletionReceiptFileStore(receiptRoot).publish({
    schemaVersion: 1,
    runId: RECEIPT_RUN_ID,
    attemptId: RECEIPT_ATTEMPT_ID,
    callbackSequence: 1,
    token: RECEIPT_TOKEN,
    startedAtMs: 2,
    finishedAtMs: 3,
    exitCode: 0,
  });
  const events = [];
  const result = await bootstrapLocalApplication(
    options(value, { events, receiptRoot }),
  );

  assert.equal(result.status, 'active');
  assert.deepEqual(result.runRecovery, {
    safe: true,
    scanned: 1,
    recovered: 1,
    remaining: 0,
    failed: 0,
    truncated: false,
  });
  assert.equal(
    (await result.runs.findRunById(RECEIPT_RUN_ID)).status,
    'succeeded',
  );
  assert.equal(
    (await result.runs.findAttemptById(RECEIPT_ATTEMPT_ID)).status,
    'succeeded',
  );
  assert.deepEqual(
    (await result.runs.listEvents(RECEIPT_RUN_ID)).map((event) => event.type),
    ['attempt.succeeded', 'run.succeeded'],
  );
  assert.ok(
    events.indexOf('application:runs_recovered') <
      events.indexOf('application:recovered'),
  );
  assert.equal(
    await new CompletionReceiptFileStore(receiptRoot).read(RECEIPT_ATTEMPT_ID),
    undefined,
  );
  assert.equal(await result.stop(), 'stopped');
});

test('startup cleanup uses the SQLite journal and removes one exact terminal receipt', async (t) => {
  const value = await prepare(t, 'edge');
  insertTerminalReceiptJournalCandidate(value);
  const receiptRoot = path.join(value.directory, 'receipts');
  const receiptStore = new CompletionReceiptFileStore(receiptRoot);
  await receiptStore.publish({
    schemaVersion: 1,
    runId: CLEANUP_RUN_ID,
    attemptId: CLEANUP_ATTEMPT_ID,
    callbackSequence: 1,
    token: RECEIPT_TOKEN,
    startedAtMs: 2,
    finishedAtMs: 3,
    exitCode: 0,
  });

  const result = await bootstrapLocalApplication(
    options(value, { receiptRoot }),
  );

  assert.deepEqual(result.receiptCleanup, {
    scanned: 1,
    removed: 1,
    expiredMissing: 0,
    purgedQuarantines: 0,
    remaining: 0,
    failed: 0,
    truncated: false,
    nextCursor: {
      updatedAtMs: 2,
      attemptId: CLEANUP_ATTEMPT_ID,
    },
  });
  assert.equal(await receiptStore.read(CLEANUP_ATTEMPT_ID), undefined);
  const target = new DatabaseSync(value.targetPath);
  assert.equal(
    target
      .prepare('SELECT COUNT(*) AS count FROM "LocalCompletionReceiptJournal"')
      .get().count,
    0,
  );
  target.close();
  assert.equal(await result.stop(), 'stopped');
});

test('failure after lifecycle activation stops owned runtime and storage', async (t) => {
  const value = await prepare(t, 'edge');
  const base = options(value);
  await assert.rejects(
    bootstrapLocalApplication({
      ...base,
      applicationAudit(record) {
        if (record.state === 'active') throw new Error('audit unavailable');
      },
    }),
    /audit unavailable/,
  );
  assertSourceWritable(value, 2);
});

test('concurrent stop is idempotent and releases the adopted source fence', async (t) => {
  const value = await prepare(t, 'standalone');
  const result = await bootstrapLocalApplication(options(value));
  assert.equal(result.status, 'active');

  assert.deepEqual(await Promise.all([result.stop(), result.stop()]), [
    'stopped',
    'stopped',
  ]);
  assertSourceWritable(value, 2);
});
