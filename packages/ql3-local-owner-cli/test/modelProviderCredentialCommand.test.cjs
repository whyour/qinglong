const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  createLocalModelProviderCredentialCommandRunner,
  runLocalModelProviderCredentialCommandFile,
} = require('@qinglong/local-owner-cli/model-provider-credential-command');
const {
  establishAuthenticatedLocalCommand,
} = require('@qinglong/local-owner-console/authenticated-command');
const {
  provisionLocalOwnerPepperKey,
} = require('@qinglong/local-owner-console');
const { migrateLocalSqlitePath } = require('@qinglong/local-sqlite/migration');
const {
  apiCredentialSecretDigest,
  formatApiCredentialToken,
} = require('@qinglong/runtime-core/api-credential-token');
const {
  createSecretRef,
} = require('@qinglong/runtime-core/secret-reference');
const {
  EncryptedLocalSecretService,
  LocalSecretKeyringFileProvider,
  provisionLocalSecretKeyring,
} = require('@qinglong/local-secret');
const {
  openLocalSqliteRuntimeDatabase,
} = require('@qinglong/local-sqlite/runtime');
const {
  canonicalProjectedModelGatewayAuthorityManifest,
  PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA,
} = require('@qinglong/ai/projected-model-gateway-authority');
const {
  createLocalPluginPackagePromptCommandRunner,
  runLocalPluginPackagePromptCommandFile,
} = require('@qinglong/local-owner-cli/plugin-package-prompt-command');
const {
  provisionPluginPackagePromptOutputFileKeyring,
} = require('@qinglong/ai/plugin-package-prompt-output-file-keyring');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
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
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

const CREDENTIAL_ID = 'model-credential-owner';
const PEPPER_KEY_ID = 'model-credential-owner-v1';
const PEPPER = Buffer.alloc(32, 91).toString('base64url');
const SECRET = Buffer.alloc(32, 92).toString('base64url');
const TOKEN = formatApiCredentialToken(CREDENTIAL_ID, SECRET);
const PROVIDER = 'openai-compatible';
const SECRET_REF = createSecretRef({
  projectId: 'default',
  name: 'openai-token',
  version: 1,
});

async function fixture(t, { aiReady = true, owner = true } = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-model-credential-command-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const commandsDirectory = path.join(deploymentRoot, 'commands');
  const ownerPepperKeyringDirectory = path.join(deploymentRoot, 'owner-keys');
  fs.mkdirSync(commandsDirectory, { mode: 0o700 });
  fs.mkdirSync(ownerPepperKeyringDirectory, { mode: 0o700 });
  const databasePath = path.join(deploymentRoot, 'qinglong3.sqlite');
  const credentialFilePath = path.join(deploymentRoot, 'credential.json');
  const secretKeyringPath = path.join(deploymentRoot, 'secret-keyring.json');
  await migrateLocalSqlitePath({ databasePath, profile: 'edge' });
  await provisionLocalSecretKeyring(secretKeyringPath);
  if (aiReady) {
    const aiDatabase = new DatabaseSync(databasePath);
    try {
      await migrateLocalModelInvocationFeature(aiDatabase);
      new LocalModelInvocationFeatureActivationRepository(aiDatabase).transition(
        createLocalModelInvocationFeatureTransitionCommand({
          featureId: 'model-invocation',
          expectedGeneration: 0,
          expectedState: null,
          state: 'active',
          mutationId: 'model-credential-feature-activation',
          requestId: 'model-credential-feature-request',
          expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
          safety: { mode: 'fresh_database', backupEvidenceDigest: null },
          principal: {
            subject: { type: 'user', id: 'owner-user' },
            authenticationId: 'local_ai_feature:fixture-proof',
            authenticatedAtMs: 1,
            expiresAtMs: 301_000,
            assurance: 'local_console',
          },
        }),
      );
    } finally {
      aiDatabase.close();
    }
  }
  const summary = provisionLocalOwnerPepperKey({
    keyringDirectory: ownerPepperKeyringDirectory,
    pepperKeyId: PEPPER_KEY_ID,
    randomBytes: () => Buffer.alloc(32, 91),
  });
  const now = Date.now();
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperKeys" (
           pepper_key_id, material_digest, backup_digest, state, version,
           register_mutation_id, activate_mutation_id,
           registered_at_ms, activated_at_ms
         ) VALUES (?, ?, ?, 'active', 2, ?, ?, ?, ?)`,
      )
      .run(
        PEPPER_KEY_ID,
        summary.digest,
        'b'.repeat(64),
        '51000000-0000-4000-8000-000000000001',
        '51000000-0000-4000-8000-000000000002',
        now - 2_000,
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3LocalOwnerPepperActivations" (
           generation, mutation_id, expected_generation,
           previous_pepper_key_id, active_pepper_key_id,
           material_digest, backup_digest, activated_at_ms
         ) VALUES (1, ?, 0, NULL, ?, ?, ?, ?)`,
      )
      .run(
        '51000000-0000-4000-8000-000000000002',
        PEPPER_KEY_ID,
        summary.digest,
        'b'.repeat(64),
        now - 1_500,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3IdentitySubjects" (
           subject_type, subject_id, status, version,
           created_at_ms, updated_at_ms
         ) VALUES ('user', 'owner-user', 'active', 1, ?, ?)`,
      )
      .run(now - 1_000, now - 1_000);
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentials" (
           credential_id, version, state, subject_type, subject_id,
           secret_digest, created_at_ms, not_before_at_ms, expires_at_ms
         ) VALUES (?, 1, 'active', 'user', 'owner-user', ?, ?, ?, ?)`,
      )
      .run(
        CREDENTIAL_ID,
        apiCredentialSecretDigest(PEPPER, CREDENTIAL_ID, SECRET),
        now - 1_000,
        now - 1_000,
        now + 10 * 60 * 1_000,
      );
    database
      .prepare(
        `INSERT INTO "QingLong3ApiCredentialPepperBindings" (
           credential_id, credential_version, pepper_key_id
         ) VALUES (?, 1, ?)`,
      )
      .run(CREDENTIAL_ID, PEPPER_KEY_ID);
    if (owner) {
      database
        .prepare(
          `INSERT INTO "QingLong3ProjectRoleBindings" (
             project_id, subject_type, subject_id, version, state, role,
             mutation_id, changed_by_type, changed_by_id, created_at_ms
           ) VALUES (
             'default', 'user', 'owner-user', 1, 'active', 'owner',
             'model-credential-owner-binding', 'user', 'owner-user', ?
           )`,
        )
        .run(now - 500);
    }
    database
      .prepare(
        `INSERT INTO "QingLong3LocalSecretEnvelopes" (
           project_id, secret_name, version, mutation_id, key_id, algorithm,
           nonce, ciphertext, auth_tag, created_at_ms
         ) VALUES (?, ?, 1, ?, ?, 'aes-256-gcm', ?, ?, ?, ?)`,
      )
      .run(
        'default',
        'openai-token',
        'model-credential-secret-fixture',
        'secret-key-v1',
        Buffer.alloc(12, 1),
        Buffer.alloc(32, 2),
        Buffer.alloc(16, 3),
        now - 500,
      );
  } finally {
    database.close();
  }
  fs.chmodSync(databasePath, 0o600);
  fs.writeFileSync(
    credentialFilePath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'qinglong3-local-identity-credential-presentation',
      token: TOKEN,
    })}\n`,
    { mode: 0o600 },
  );
  return {
    commandsDirectory,
    databasePath,
    secretKeyringPath,
    options: {
      deploymentRoot,
      databasePath,
      profile: 'edge',
      ownerPepperKeyringDirectory,
      credentialFilePath,
    },
  };
}

function commandFile(value, operation, request, name) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({ schemaVersion: 1, operation, options: value.options, request })}\n`,
    { mode: 0o600 },
  );
  return commandPath;
}

function baseRequest(suffix, failureAuditEventId) {
  return {
    requestId: `model-credential-${suffix}`,
    projectId: 'default',
    provider: PROVIDER,
    failureAuditEventId,
  };
}

function assertNoSensitiveMaterial(value, fixtureValue) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(SECRET_REF), false);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(fixtureValue.databasePath), false);
  assert.doesNotMatch(serialized, /authenticationId|credentialFilePath|secretRef/);
}

async function seedPrompt(value) {
  const prompt = pluginPackageTaskReconciliationFixture(
    'local-prompt-product',
    {
      profile: 'edge',
      tasks: [],
      prompts: [
        {
          schema: 'qinglong/plugin-package-prompt-resource@v1',
          id: 'summary',
          name: 'Summary',
          template: 'Summarize {{subject}}.',
          parameters: [{ name: 'subject', required: true }],
        },
      ],
    },
  );
  const publication = createInitialPluginPackageAutomationPublication(
    prompt.revision,
    prompt.registry,
    Date.now() - 1_000,
  );
  const database = new DatabaseSync(value.databasePath, { timeout: 100 });
  database.exec('PRAGMA foreign_keys = ON');
  try {
    database
      .prepare(
        `INSERT INTO "QingLong3Projects"
         (id, name, slug, status, version, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'active', 1, 1, 1)`,
      )
      .run(prompt.projectId, prompt.projectId, prompt.projectId);
    database
      .prepare(
        `INSERT INTO "QingLong3ProjectRoleBindings" (
           project_id, subject_type, subject_id, version, state, role,
           mutation_id, changed_by_type, changed_by_id, created_at_ms
         ) VALUES (?, 'user', 'owner-user', 1, 'active', 'owner',
                   'prompt-product-owner-binding', 'user', 'owner-user', 1)`,
      )
      .run(prompt.projectId);
    await activateInstall(
      new LocalSqlitePluginPackageInstallRepository(database),
      prompt,
    );
    await new LocalSqlitePluginPackageMaterializedRevisionRepository(
      database,
      prompt.registry,
    ).publish(prompt.revision);
    await new LocalSqlitePluginPackageTaskReconciliationRepository(
      database,
      prompt.registry,
    ).reconcile(prompt.revision, {
      async findActiveResourceGeneration() {
        return prompt.revision.generation;
      },
    });
    await new LocalSqlitePluginPackageAutomationPublicationRepository(
      database,
    ).publish(publication);
  } finally {
    database.close();
  }
  return { prompt, publication };
}

function promptCommandFile(value, request, name, extra = {}) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation: 'prompt.execute',
      options: {
        ...value.options,
        secretKeyringPath: path.join(
          value.options.deploymentRoot,
          'secret-keyring.json',
        ),
        providerAuthorityFilePath: path.join(
          value.options.deploymentRoot,
          'provider-authority.json',
        ),
      },
      request: { ...request, ...extra },
    })}\n`,
    { mode: 0o600 },
  );
  return commandPath;
}

function durablePromptCommandFile(
  value,
  operation,
  request,
  name,
  promptOutputKeyringPath,
) {
  const commandPath = path.join(value.commandsDirectory, `${name}.json`);
  const execution = operation === 'prompt.execute';
  fs.writeFileSync(
    commandPath,
    `${JSON.stringify({
      schemaVersion: 1,
      operation,
      options: {
        ...value.options,
        promptOutputKeyringPath,
        ...(execution
          ? {
              secretKeyringPath: value.secretKeyringPath,
              providerAuthorityFilePath: path.join(
                value.options.deploymentRoot,
                'provider-authority.json',
              ),
            }
          : {}),
      },
      request,
    })}\n`,
    { mode: 0o600 },
  );
  return commandPath;
}

test('runs a private replay-safe bind, inspect and revoke lifecycle', async (t) => {
  const value = await fixture(t);
  const bindFile = commandFile(
    value,
    'model-credential.bind',
    {
      ...baseRequest('bind-1', '52000000-0000-4000-8000-000000000001'),
      mutationId: '52000000-0000-4000-8000-000000000002',
      expectedGeneration: 0,
      revision: 'credential-v1',
      secretRef: SECRET_REF,
    },
    '01-bind',
  );
  const bound = await runLocalModelProviderCredentialCommandFile(bindFile);
  assert.equal(bound.status, 'created');
  assert.equal(bound.state, 'bound');
  assert.equal(bound.generation, 1);
  assert.equal(bound.bindingRevision, 'credential-v1');
  assertNoSensitiveMaterial(bound, value);

  const replay = await runLocalModelProviderCredentialCommandFile(bindFile);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.transitionDigest, bound.transitionDigest);

  const inspectFile = commandFile(
    value,
    'model-credential.inspect',
    {
      ...baseRequest('inspect-1', '52000000-0000-4000-8000-000000000003'),
      auditEventId: '52000000-0000-4000-8000-000000000004',
    },
    '02-inspect',
  );
  const inspected = await runLocalModelProviderCredentialCommandFile(inspectFile);
  assert.equal(inspected.state, 'bound');
  assert.equal(inspected.transitionDigest, bound.transitionDigest);
  assertNoSensitiveMaterial(inspected, value);

  const cliInspectFile = commandFile(
    value,
    'model-credential.inspect',
    {
      ...baseRequest(
        'inspect-cli',
        '52000000-0000-4000-8000-000000000007',
      ),
      auditEventId: '52000000-0000-4000-8000-000000000008',
    },
    '02-inspect-cli',
  );
  const child = spawnSync(
    process.execPath,
    [
      path.join(
        __dirname,
        '../dist/ai-management/modelProviderCredentialCli.js',
      ),
      'run',
      '--command-file',
      cliInspectFile,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.equal(JSON.parse(child.stdout).state, 'bound');
  assert.equal(child.stdout.includes(SECRET_REF), false);

  const revokeFile = commandFile(
    value,
    'model-credential.revoke',
    {
      ...baseRequest('revoke-1', '52000000-0000-4000-8000-000000000005'),
      mutationId: '52000000-0000-4000-8000-000000000006',
      expectedGeneration: 1,
    },
    '03-revoke',
  );
  const revoked = await runLocalModelProviderCredentialCommandFile(revokeFile);
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.generation, 2);
  assert.equal(revoked.bindingRevision, null);
  assertNoSensitiveMaterial(revoked, value);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT count(*) FROM "ModelInvocationProviderCredentialBindings") AS bindings,
               (SELECT count(*) FROM "ModelInvocationProviderCredentialTransitions") AS transitions,
               (SELECT count(*) FROM "QingLong3SecurityAuditEvents"
                 WHERE operation_id LIKE 'model_provider_credential.%') AS audits`,
          )
          .get(),
      },
      { bindings: 1, transitions: 2, audits: 4 },
    );
  } finally {
    database.close();
  }
});

test('fails before authentication when the optional AI feature is not active', async (t) => {
  const value = await fixture(t, { aiReady: false });
  let authenticated = 0;
  const runner = createLocalModelProviderCredentialCommandRunner({
    async openDatabase(options) {
      const {
        openLocalSqliteAuthenticatedManagementDatabase,
      } = require('@qinglong/local-sqlite/authenticated-management');
      return openLocalSqliteAuthenticatedManagementDatabase(options);
    },
    async authenticate(...args) {
      authenticated += 1;
      return establishAuthenticatedLocalCommand(...args);
    },
    now: Date.now,
  });
  await assert.rejects(
    runner.run(
      commandFile(
        value,
        'model-credential.inspect',
        {
          ...baseRequest(
            'not-ready',
            '53000000-0000-4000-8000-000000000001',
          ),
          auditEventId: '53000000-0000-4000-8000-000000000002',
        },
        'not-ready',
      ),
    ),
    { code: 'LOCAL_MODEL_INVOCATION_FEATURE_NOT_READY' },
  );
  assert.equal(authenticated, 0);
});

test('denies a strong User without secret.manage and writes no transition', async (t) => {
  const value = await fixture(t, { owner: false });
  await assert.rejects(
    runLocalModelProviderCredentialCommandFile(
      commandFile(
        value,
        'model-credential.bind',
        {
          ...baseRequest('forbidden', '54000000-0000-4000-8000-000000000001'),
          mutationId: '54000000-0000-4000-8000-000000000002',
          expectedGeneration: 0,
          revision: 'credential-v1',
          secretRef: SECRET_REF,
        },
        'forbidden',
      ),
    ),
    { code: 'LOCAL_MODEL_PROVIDER_CREDENTIAL_FORBIDDEN' },
  );
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "ModelInvocationProviderCredentialTransitions"`,
        )
        .get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test('executes and exactly replays a server-derived local Prompt with one atomic audit', async (t) => {
  const value = await fixture(t);
  const seeded = await seedPrompt(value);
  const metrics = { providerCalls: 0, providerDisposals: 0 };
  const runner = createLocalPluginPackagePromptCommandRunner({
    async openDatabase(options) {
      const {
        openLocalSqliteOptionalFeatureRuntimeDatabase,
      } = require('@qinglong/local-sqlite/optional-feature-runtime');
      return openLocalSqliteOptionalFeatureRuntimeDatabase(options);
    },
    authenticate: establishAuthenticatedLocalCommand,
    async loadProviders() {
      return {
        providers: [
          {
            type: 'openai-compatible',
            async listModels() {
              return [{ id: 'vendor/model-a' }];
            },
            async generate(request) {
              metrics.providerCalls += 1;
              assert.equal(request.messages[0].content, 'Summarize private input.');
              return {
                provider: 'openai-compatible',
                model: 'vendor/model-a',
                text: 'private output',
                finishReason: 'stop',
                usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
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
              revision: 'prompt-product-policy-v1',
              allowedProviders: ['openai-compatible'],
              allowedModels: ['vendor/model-a'],
              maxInputBytes: 4096,
              maxOutputBytes: 4096,
              maxOutputTokens: 128,
              maxTotalTokens: 256,
              maxCostMicros: null,
              priceRevision: null,
            };
          },
        },
        dispose() {
          metrics.providerDisposals += 1;
        },
      };
    },
    now: Date.now,
  });
  const request = {
    projectId: seeded.prompt.projectId,
    packageName: seeded.prompt.packageName,
    promptId: 'summary',
    requestId: 'prompt-product-request-1',
    traceId: 'prompt-product-trace-1',
    auditEventId: '55000000-0000-4000-8000-000000000001',
    failureAuditEventId: '55000000-0000-4000-8000-000000000002',
    parameters: { subject: 'private input' },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 128,
    temperature: 0.2,
    timeoutMs: 60_000,
    output: { mode: 'live_only' },
  };
  const commandPath = promptCommandFile(value, request, 'prompt-execute');
  const first = await runner.run(commandPath);
  const replay = await runner.run(commandPath);
  assert.equal(first.status, 'executed');
  assert.equal(first.result.text, 'private output');
  assert.equal(first.runStatus, 'succeeded');
  assert.equal(replay.status, 'existing');
  assert.equal(replay.result, null);
  assert.equal(replay.planDigest, first.planDigest);
  assert.equal(replay.receiptDigest, first.receiptDigest);
  assert.equal(replay.finalizationDigest, first.finalizationDigest);
  assert.equal(metrics.providerCalls, 1);
  assert.equal(metrics.providerDisposals, 2);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT count(*) FROM "ModelInvocationPromptAdmissions"
                 WHERE request_id = ?) AS admissions,
               (SELECT count(*) FROM "Runs" WHERE id = ?) AS runs,
               (SELECT count(*) FROM "QingLong3SecurityAuditEvents"
                 WHERE event_id = ? AND operation_id = 'prompt.execute') AS audits`,
          )
          .get(first.requestId, first.runId, request.auditEventId),
      },
      { admissions: 1, runs: 1, audits: 1 },
    );
    const plan = JSON.parse(
      database
        .prepare(
          `SELECT plan_json AS planJson
             FROM "ModelInvocationPromptAdmissions" WHERE request_id = ?`,
        )
        .get(first.requestId).planJson,
    );
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes('private input'), false);
    assert.equal(serialized.includes('private output'), false);
    assert.equal(plan.target.publicationDigest, seeded.publication.publicationDigest);
    assert.equal(plan.requestedBySubject.id, 'owner-user');
    assert.equal(plan.policyFence.projectVersion, 1);
    assert.equal(plan.policyFence.bindingVersion, 1);
  } finally {
    database.close();
  }
});

test('inspects one durable Prompt execution without loading Provider authority', async (t) => {
  const value = await fixture(t);
  const seeded = await seedPrompt(value);
  let providerLoads = 0;
  const runner = createLocalPluginPackagePromptCommandRunner({
    async openDatabase(options) {
      const {
        openLocalSqliteOptionalFeatureRuntimeDatabase,
      } = require('@qinglong/local-sqlite/optional-feature-runtime');
      return openLocalSqliteOptionalFeatureRuntimeDatabase(options);
    },
    authenticate: establishAuthenticatedLocalCommand,
    async loadProviders() {
      providerLoads += 1;
      return {
        providers: [{
          type: 'openai-compatible',
          async listModels() { return [{ id: 'vendor/model-a' }]; },
          async generate() {
            return {
              provider: 'openai-compatible',
              model: 'vendor/model-a',
              text: 'private inspection output',
              finishReason: 'stop',
              usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
            };
          },
          async *stream() { throw new Error('not used'); },
        }],
        policies: {
          async resolve() {
            return {
              revision: 'prompt-inspection-policy-v1',
              allowedProviders: ['openai-compatible'],
              allowedModels: ['vendor/model-a'],
              maxInputBytes: 4096,
              maxOutputBytes: 4096,
              maxOutputTokens: 128,
              maxTotalTokens: 256,
              maxCostMicros: null,
              priceRevision: null,
            };
          },
        },
        dispose() {},
      };
    },
    now: Date.now,
  });
  const executionRequestId = 'prompt-inspection-target-1';
  const executed = await runner.run(promptCommandFile(value, {
    projectId: seeded.prompt.projectId,
    packageName: seeded.prompt.packageName,
    promptId: 'summary',
    requestId: executionRequestId,
    traceId: 'prompt-inspection-trace-1',
    auditEventId: '55100000-0000-4000-8000-000000000001',
    failureAuditEventId: '55100000-0000-4000-8000-000000000002',
    parameters: { subject: 'private inspection input' },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 128,
    timeoutMs: 60_000,
    output: { mode: 'live_only' },
  }, 'prompt-inspection-execute'));
  assert.equal(executed.runStatus, 'succeeded');

  const inspectPath = commandFile(
    value,
    'prompt.execution.inspect',
    {
      projectId: seeded.prompt.projectId,
      packageName: seeded.prompt.packageName,
      promptId: 'summary',
      executionRequestId,
      requestId: 'prompt-inspection-query-1',
      auditEventId: '55100000-0000-4000-8000-000000000003',
      failureAuditEventId: '55100000-0000-4000-8000-000000000004',
    },
    'prompt-inspection-read',
  );
  const inspected = await runner.run(inspectPath);
  const replay = await runner.run(inspectPath);
  assert.equal(inspected.operation, 'prompt.execution.inspect');
  assert.equal(inspected.found, true);
  assert.equal(inspected.execution.runId, executed.runId);
  assert.equal(inspected.execution.runStatus, 'succeeded');
  assert.deepEqual(replay, inspected);
  assert.equal(providerLoads, 1);
  const serialized = JSON.stringify(inspected);
  assert.equal(serialized.includes('private inspection input'), false);
  assert.equal(serialized.includes('private inspection output'), false);
  assert.equal(serialized.includes('planDigest'), false);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database.prepare(
        `SELECT count(*) AS count
           FROM "QingLong3SecurityAuditEvents"
          WHERE event_id = ? AND operation_id = 'prompt.execution.read'`,
      ).get('55100000-0000-4000-8000-000000000003').count,
      1,
    );
  } finally {
    database.close();
  }
});

test('persists and recovers Prompt output by execution requestId without Provider reload', async (t) => {
  const value = await fixture(t);
  const seeded = await seedPrompt(value);
  const promptOutputKeyringPath = path.join(
    value.options.deploymentRoot,
    'prompt-output-keyring.json',
  );
  await provisionPluginPackagePromptOutputFileKeyring(
    promptOutputKeyringPath,
  );
  let providerLoads = 0;
  let providerCalls = 0;
  const runner = createLocalPluginPackagePromptCommandRunner({
    async openDatabase(options) {
      const {
        openLocalSqliteOptionalFeatureRuntimeDatabase,
      } = require('@qinglong/local-sqlite/optional-feature-runtime');
      return openLocalSqliteOptionalFeatureRuntimeDatabase(options);
    },
    authenticate: establishAuthenticatedLocalCommand,
    async loadProviders() {
      providerLoads += 1;
      return {
        providers: [{
          type: 'openai-compatible',
          async listModels() { return [{ id: 'vendor/model-a' }]; },
          async generate() {
            providerCalls += 1;
            return {
              provider: 'openai-compatible',
              model: 'vendor/model-a',
              text: 'private recoverable output',
              finishReason: 'stop',
              usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            };
          },
          async *stream() { throw new Error('not used'); },
        }],
        policies: {
          async resolve() {
            return {
              revision: 'prompt-output-recovery-policy-v1',
              allowedProviders: ['openai-compatible'],
              allowedModels: ['vendor/model-a'],
              maxInputBytes: 4096,
              maxOutputBytes: 4096,
              maxOutputTokens: 128,
              maxTotalTokens: 256,
              maxCostMicros: null,
              priceRevision: null,
            };
          },
        },
        dispose() {},
      };
    },
    now: Date.now,
  });
  const executionRequestId = 'prompt-output-recovery-target-1';
  const executePath = durablePromptCommandFile(
    value,
    'prompt.execute',
    {
      projectId: seeded.prompt.projectId,
      packageName: seeded.prompt.packageName,
      promptId: 'summary',
      requestId: executionRequestId,
      traceId: 'prompt-output-recovery-trace-1',
      auditEventId: '55200000-0000-4000-8000-000000000001',
      failureAuditEventId: '55200000-0000-4000-8000-000000000002',
      parameters: { subject: 'private recoverable input' },
      provider: 'openai-compatible',
      model: 'vendor/model-a',
      maxOutputTokens: 128,
      timeoutMs: 60_000,
      output: {
        mode: 'durable_artifact',
        retentionPolicy: {
          revision: 'local-output-v1',
          retentionMs: 24 * 60 * 60_000,
        },
      },
    },
    'prompt-output-recovery-execute',
    promptOutputKeyringPath,
  );
  const executed = await runner.run(executePath);
  const replay = await runner.run(executePath);
  assert.equal(executed.status, 'executed');
  assert.equal(executed.result.text, 'private recoverable output');
  assert.equal(executed.outputArtifact.artifactId.startsWith('pao:'), true);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.result, null);
  assert.deepEqual(replay.outputArtifact, executed.outputArtifact);
  assert.equal(providerCalls, 1);
  const providerLoadsAfterExecution = providerLoads;

  const readPath = durablePromptCommandFile(
    value,
    'prompt.execution.output.read',
    {
      projectId: seeded.prompt.projectId,
      packageName: seeded.prompt.packageName,
      promptId: 'summary',
      executionRequestId,
      requestId: 'prompt-output-recovery-read-1',
      auditEventId: '55200000-0000-4000-8000-000000000003',
      failureAuditEventId: '55200000-0000-4000-8000-000000000004',
    },
    'prompt-output-recovery-read',
    promptOutputKeyringPath,
  );
  const recovered = await runner.run(readPath);
  const recoveredReplay = await runner.run(readPath);
  assert.equal(recovered.operation, 'prompt.execution.output.read');
  assert.equal(recovered.status, 'available');
  assert.equal(recovered.result.text, 'private recoverable output');
  assert.deepEqual(recovered.reference, executed.outputArtifact);
  assert.deepEqual(recoveredReplay, recovered);
  assert.equal(providerLoads, providerLoadsAfterExecution);
  assert.equal(providerCalls, 1);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database.prepare(
        `SELECT count(*) AS count
           FROM "QingLong3SecurityAuditEvents"
          WHERE event_id = ?
            AND operation_id = 'prompt.execution.output.read'`,
      ).get('55200000-0000-4000-8000-000000000003').count,
      1,
    );
  } finally {
    database.close();
  }
});

test('uses the production durable binding, encrypted Secret and read-only provider manifest', async (t) => {
  const value = await fixture(t);
  const seeded = await seedPrompt(value);
  const token = 'sk-local-prompt-product-token';
  const secretName = 'prompt-provider-token';
  const secretRef = createSecretRef({
    projectId: seeded.prompt.projectId,
    name: secretName,
    version: 1,
  });
  const runtime = await openLocalSqliteRuntimeDatabase({
    databasePath: value.databasePath,
    profile: 'edge',
    busyTimeoutMs: 100,
  });
  try {
    await new EncryptedLocalSecretService(
      runtime.localSecrets,
      new LocalSecretKeyringFileProvider(value.secretKeyringPath),
    ).put({
      projectId: seeded.prompt.projectId,
      name: secretName,
      plaintext: token,
      mutationId: 'prompt-product-secret-v1',
      expectedCurrentVersion: 0,
      createdAtMs: Date.now() - 500,
    });
  } finally {
    await runtime.close();
  }
  const bindPath = commandFile(
    value,
    'model-credential.bind',
    {
      requestId: 'prompt-product-provider-bind',
      projectId: seeded.prompt.projectId,
      provider: 'openai-compatible',
      failureAuditEventId: '57000000-0000-4000-8000-000000000001',
      mutationId: '57000000-0000-4000-8000-000000000002',
      expectedGeneration: 0,
      revision: 'prompt-provider-credential-v1',
      secretRef,
    },
    'prompt-provider-bind',
  );
  const bound = await runLocalModelProviderCredentialCommandFile(bindPath);
  assert.equal(bound.state, 'bound');

  let providerCalls = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(body.messages[0].content, 'Summarize encrypted input.');
        providerCalls += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            model: 'vendor/model-a',
            choices: [
              {
                message: { content: 'encrypted-chain-output' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5,
            },
          }),
        );
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const providerAuthorityFilePath = path.join(
    value.options.deploymentRoot,
    'provider-authority.json',
  );
  fs.writeFileSync(
    providerAuthorityFilePath,
    canonicalProjectedModelGatewayAuthorityManifest({
      schema: PROJECTED_MODEL_GATEWAY_AUTHORITY_SCHEMA,
      providers: [
        {
          type: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1/`,
          allowPlaintextLoopback: true,
          maxResponseBytes: 16 * 1024,
        },
      ],
      projects: [
        {
          projectId: seeded.prompt.projectId,
          policy: {
            revision: 'prompt-product-policy-v1',
            allowedProviders: ['openai-compatible'],
            allowedModels: ['vendor/model-a'],
            maxInputBytes: 4096,
            maxOutputBytes: 4096,
            maxOutputTokens: 128,
            maxTotalTokens: 256,
            maxCostMicros: null,
            priceRevision: null,
          },
        },
      ],
    }),
    { mode: 0o400 },
  );
  fs.chmodSync(providerAuthorityFilePath, 0o400);
  const commandPath = promptCommandFile(
    value,
    {
      projectId: seeded.prompt.projectId,
      packageName: seeded.prompt.packageName,
      promptId: 'summary',
      requestId: 'prompt-product-production-request',
      traceId: 'prompt-product-production-trace',
      auditEventId: '57000000-0000-4000-8000-000000000003',
      failureAuditEventId: '57000000-0000-4000-8000-000000000004',
      parameters: { subject: 'encrypted input' },
      provider: 'openai-compatible',
      model: 'vendor/model-a',
      maxOutputTokens: 128,
      timeoutMs: 60_000,
      output: { mode: 'live_only' },
    },
    'prompt-production',
  );
  const result = await runLocalPluginPackagePromptCommandFile(commandPath);
  assert.equal(result.status, 'executed');
  assert.equal(result.result.text, 'encrypted-chain-output');
  assert.equal(providerCalls, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(secretRef), false);
  assert.equal(serialized.includes(value.databasePath), false);

  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.equal(
      database
        .prepare(
          `SELECT count(*) AS count
             FROM "ModelInvocationProviderCredentialAudits"
            WHERE project_id = ? AND provider = 'openai-compatible'
              AND request_id = ?`,
        )
        .get(seeded.prompt.projectId, result.invocationId).count,
      1,
    );
  } finally {
    database.close();
  }
});

test('rechecks credential and Project fences inside Prompt admission before Provider I/O', async (t) => {
  const value = await fixture(t);
  const seeded = await seedPrompt(value);
  let providerCalls = 0;
  const runner = createLocalPluginPackagePromptCommandRunner({
    async openDatabase(options) {
      const {
        openLocalSqliteOptionalFeatureRuntimeDatabase,
      } = require('@qinglong/local-sqlite/optional-feature-runtime');
      return openLocalSqliteOptionalFeatureRuntimeDatabase(options);
    },
    authenticate: establishAuthenticatedLocalCommand,
    async loadProviders({ database }) {
      database.authority.client
        .prepare(
          `INSERT INTO "QingLong3ProjectRoleBindings" (
             project_id, subject_type, subject_id, version, state, role,
             mutation_id, changed_by_type, changed_by_id, created_at_ms
           ) VALUES (?, 'user', 'owner-user', 2, 'revoked', NULL,
                     'prompt-product-revoke-race', 'user', 'owner-user', ?)`,
        )
        .run(seeded.prompt.projectId, Date.now());
      return {
        providers: [
          {
            type: 'openai-compatible',
            async listModels() {
              return [];
            },
            async generate() {
              providerCalls += 1;
              throw new Error('must remain unreachable');
            },
            async *stream() {
              throw new Error('must remain unreachable');
            },
          },
        ],
        policies: {
          async resolve() {
            throw new Error('must remain unreachable');
          },
        },
      };
    },
    now: Date.now,
  });
  const auditEventId = '58000000-0000-4000-8000-000000000001';
  await assert.rejects(
    runner.run(
      promptCommandFile(
        value,
        {
          projectId: seeded.prompt.projectId,
          packageName: seeded.prompt.packageName,
          promptId: 'summary',
          requestId: 'prompt-product-fence-race',
          traceId: 'prompt-product-fence-race-trace',
          auditEventId,
          failureAuditEventId: '58000000-0000-4000-8000-000000000002',
          parameters: { subject: 'private input' },
          provider: 'openai-compatible',
          model: 'vendor/model-a',
          maxOutputTokens: 128,
          timeoutMs: 60_000,
          output: { mode: 'live_only' },
        },
        'prompt-fence-race',
      ),
    ),
    { code: 'LOCAL_PLUGIN_PACKAGE_PROMPT_UNAVAILABLE' },
  );
  assert.equal(providerCalls, 0);
  const database = new DatabaseSync(value.databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT count(*) FROM "ModelInvocationPromptAdmissions"
                 WHERE request_id = 'prompt-product-fence-race') AS admissions,
               (SELECT count(*) FROM "Runs"
                 WHERE request_id = 'prompt-product-fence-race') AS runs,
               (SELECT count(*) FROM "QingLong3SecurityAuditEvents"
                 WHERE event_id = ?) AS allowedAudits,
               (SELECT count(*) FROM "QingLong3SecurityAuditEvents"
                 WHERE event_id = '58000000-0000-4000-8000-000000000002'
                   AND outcome = 'authorization_unavailable') AS failureAudits`,
          )
          .get(auditEventId),
      },
      { admissions: 0, runs: 0, allowedAudits: 0, failureAudits: 1 },
    );
  } finally {
    database.close();
  }
});

test('rejects caller-supplied Prompt authority and gates inactive AI before authentication', async (t) => {
  const value = await fixture(t, { aiReady: false });
  let authenticated = 0;
  const runner = createLocalPluginPackagePromptCommandRunner({
    async openDatabase(options) {
      const {
        openLocalSqliteOptionalFeatureRuntimeDatabase,
      } = require('@qinglong/local-sqlite/optional-feature-runtime');
      return openLocalSqliteOptionalFeatureRuntimeDatabase(options);
    },
    async authenticate(...args) {
      authenticated += 1;
      return establishAuthenticatedLocalCommand(...args);
    },
    async loadProviders() {
      throw new Error('provider authority must remain unreachable');
    },
    now: Date.now,
  });
  const request = {
    projectId: 'default',
    packageName: 'sample-package',
    promptId: 'summary',
    requestId: 'prompt-product-inactive',
    traceId: 'prompt-product-inactive-trace',
    auditEventId: '56000000-0000-4000-8000-000000000001',
    failureAuditEventId: '56000000-0000-4000-8000-000000000002',
    parameters: { subject: 'private input' },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 128,
    timeoutMs: 60_000,
    output: { mode: 'live_only' },
  };
  await assert.rejects(
    runner.run(promptCommandFile(value, request, 'inactive')),
    { code: 'LOCAL_PLUGIN_PACKAGE_PROMPT_UNAVAILABLE' },
  );
  assert.equal(authenticated, 0);

  await assert.rejects(
    runner.run(
      promptCommandFile(value, request, 'caller-authority', {
        publicationDigest: 'a'.repeat(64),
      }),
    ),
    { code: 'LOCAL_PLUGIN_PACKAGE_PROMPT_COMMAND_CONFIGURATION_INVALID' },
  );
  assert.equal(authenticated, 0);

  const help = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '../dist/plugin-package/pluginPackagePromptCli.js'),
      '--help',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.equal(
    help.stdout,
    'Usage: ql3-prompt run --command-file /absolute/private-command.json\n',
  );
});
