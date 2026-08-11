const assert = require('node:assert/strict');
const test = require('node:test');

const {
  postgresModelInvocationMigrationDefinition,
} = require('@qinglong/ai/model-invocation-migration');
const {
  PostgresPluginPackagePromptApplicationUnavailableError,
  PostgresPluginPackagePromptExecutionService,
  assertPostgresPluginPackagePromptApplicationReady,
  bootstrapPostgresPluginPackagePromptApplication,
} = require('../dist/prompt/postgresPluginPackagePromptApplication.js');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function providers(onDispose) {
  return {
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'test/model-a' }];
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
    dispose: onDispose,
  };
}

function recoveryPool() {
  return {
    async query(sql) {
      if (sql.includes('statement_timestamp()')) {
        return { rows: [{ observedAtMs: '1000' }], rowCount: 1 };
      }
      if (sql.includes('model_invocation_starts')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async connect() {
      throw new Error('not used');
    },
  };
}

function readiness() {
  return Object.freeze({
    schema: 'ql3_ai',
    migrationStreamId: postgresModelInvocationMigrationDefinition.id,
    migrationCount:
      postgresModelInvocationMigrationDefinition.migrations.length,
    currentUser: 'ql3_runtime',
    runtimeAuthority: true,
    appendOnly: true,
  });
}

function promptProductFixture() {
  const source = pluginPackageTaskReconciliationFixture('prompt-product', {
    profile: 'cluster-control',
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'summary',
        name: 'Summary',
        template: 'Summarize {{subject}}.',
        parameters: [{ name: 'subject', required: true }],
      },
    ],
  });
  return createInitialPluginPackageAutomationPublication(
    source.revision,
    source.registry,
    20_000,
  );
}

test('Cluster Prompt product derives current publication and guards admission atomically', async () => {
  const publication = promptProductFixture();
  const productQueries = [];
  const pool = {
    async query(sql) {
      productQueries.push(sql);
      if (sql.includes('model_invocation_prompt_admissions'))
        return { rows: [] };
      if (sql.includes('plugin_package_automation_publication_heads')) {
        return { rows: [{ publicationJson: publication }] };
      }
      throw new Error(`unexpected product query: ${sql}`);
    },
    async connect() {
      throw new Error('not used');
    },
  };
  const transactionQueries = [];
  let credentialState = 'active';
  const client = {
    async query(sql, parameters = []) {
      transactionQueries.push({ sql, parameters });
      if (sql.includes('plugin_package_prompt_authorize_admission')) {
        return { rows: [{ authorized: credentialState === 'active' }] };
      }
      return { rows: [] };
    },
  };
  let executorInput;
  let providerCalls = 0;
  const service = new PostgresPluginPackagePromptExecutionService(
    pool,
    (guard) => ({
      async execute(input) {
        executorInput = input;
        await guard.confirm({
          client,
          replay: false,
          plan: {
            requestId: input.requestId,
            plannedAtMs: input.plannedAtMs,
            requestedBySubject: input.requestedBySubject,
            policyFence: input.policyFence,
            target: {
              ...publication.target,
              publicationDigest: publication.publicationDigest,
              promptId: input.promptId,
            },
          },
        });
        providerCalls += 1;
        return {
          status: 'executed',
          admission: { requestId: input.requestId },
          finalization: { runStatus: 'succeeded' },
          result: { text: 'live result' },
        };
      },
    }),
  );
  const command = {
    projectId: publication.target.projectId,
    packageName: publication.target.packageName,
    promptId: 'summary',
    requestId: 'prompt-request-1',
    traceId: 'prompt-trace-1',
    auditEventId: '00000000-0000-4000-8000-000000000001',
    principal: {
      subject: { type: 'user', id: 'user-a' },
      authenticationId: 'api_credential:prompt-credential:1',
      authenticatedAtMs: 1,
      expiresAtMs: 100_000,
      assurance: 'single_factor',
    },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { subject: 'private input' },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 128,
    plannedAtMs: 30_000,
    deadlineAtMs: 90_000,
  };
  const result = await service.execute(command);
  assert.equal(result.result.text, 'live result');
  assert.equal(
    executorInput.expectedPublicationDigest,
    publication.publicationDigest,
  );
  assert.equal('publicationDigest' in command, false);
  assert.equal(
    productQueries.some((sql) =>
      sql.includes('plugin_package_automation_publication_heads'),
    ),
    true,
  );
  const authorization = transactionQueries.find(({ sql }) =>
    sql.includes('plugin_package_prompt_authorize_admission'),
  );
  assert.equal(authorization.parameters[7], command.auditEventId);
  assert.equal(authorization.parameters[8], command.requestId);
  assert.equal(authorization.parameters[10], false);
  assert.equal(authorization.parameters.includes('private input'), false);
  assert.equal(providerCalls, 1);
  credentialState = 'revoked';
  await assert.rejects(
    service.execute({
      ...command,
      requestId: 'prompt-request-revoked',
      auditEventId: '00000000-0000-4000-8000-000000000002',
    }),
    (error) => error?.code === 'PLUGIN_PACKAGE_PROMPT_ADMISSION_NOT_ALLOWED',
  );
  assert.equal(providerCalls, 1);
});

test('disabled Cluster Package Prompt application is database/provider loader-free', async () => {
  const audits = [];
  const result = await bootstrapPostgresPluginPackagePromptApplication({
    async audit(record) {
      audits.push(record);
    },
  });
  assert.equal(result.status, 'disabled');
  assert.equal(result.profile, 'cluster');
  assert.equal(await result.stop(), 'stopped');
  assert.deepEqual(audits, [{ profile: 'cluster', state: 'disabled' }]);
});

test('PostgreSQL readiness binds the exact migration stream and runtime authority', async () => {
  let queries = 0;
  const pool = {
    async query(sql) {
      queries += 1;
      if (sql.includes('ai_schema_migrations')) {
        return {
          rows: postgresModelInvocationMigrationDefinition.migrations.map(
            (migration) => ({
              migrationId: migration.id,
              streamId: postgresModelInvocationMigrationDefinition.id,
              dialect: postgresModelInvocationMigrationDefinition.dialect,
              checksum: migration.checksum,
            }),
          ),
        };
      }
      return {
        rows: [
          {
            currentUser: 'ql3_runtime',
            runtimeAuthority: true,
            schemaUsage: true,
            invocationAppendOnly: true,
            promptAppendOnly: true,
            catalogReadable: true,
            promptSnapshotExecutable: true,
            promptAuthorizationExecutable: true,
          },
        ],
      };
    },
  };
  assert.deepEqual(
    await assertPostgresPluginPackagePromptApplicationReady(pool),
    readiness(),
  );
  assert.equal(queries, 2);
});

test('active Cluster Package Prompt application recovers before provider load and owns shutdown', async () => {
  const events = [];
  let databaseCloses = 0;
  let providerLoads = 0;
  let providerDisposals = 0;
  const result = await bootstrapPostgresPluginPackagePromptApplication({
    enabled: true,
    async openDatabase() {
      events.push('database_open');
      return {
        pool: recoveryPool(),
        async close() {
          databaseCloses += 1;
          events.push('database_close');
        },
      };
    },
    async assertReady() {
      events.push('readiness');
      return readiness();
    },
    async loadProviders() {
      providerLoads += 1;
      events.push('providers_load');
      return providers(async () => {
        providerDisposals += 1;
        events.push('providers_dispose');
      });
    },
    async audit(record) {
      events.push(record.state);
    },
    maxConcurrent: 2,
    recoveryLimit: 4,
  });
  assert.equal(result.status, 'active');
  assert.equal(result.profile, 'cluster');
  assert.deepEqual(result.readiness, readiness());
  assert.equal(typeof result.prompts.execute, 'function');
  assert.equal(typeof result.promptExecutions.execute, 'function');
  assert.equal(providerLoads, 1);
  assert.ok(events.indexOf('readiness') < events.indexOf('storage_ready'));
  assert.ok(
    events.indexOf('recovery_ready') < events.indexOf('providers_load'),
  );
  assert.ok(events.indexOf('providers_load') < events.indexOf('active'));
  assert.equal(await result.stop(), 'stopped');
  assert.equal(await result.stop(), 'stopped');
  assert.equal(providerDisposals, 1);
  assert.equal(databaseCloses, 1);
  assert.ok(
    events.indexOf('providers_dispose') < events.indexOf('database_close'),
  );
  assert.equal(events.at(-1), 'stopped');
});

test('readiness failure closes PostgreSQL before provider credentials are reachable', async () => {
  let databaseCloses = 0;
  let providerLoads = 0;
  await assert.rejects(
    bootstrapPostgresPluginPackagePromptApplication({
      enabled: true,
      async openDatabase() {
        return {
          pool: recoveryPool(),
          async close() {
            databaseCloses += 1;
          },
        };
      },
      async assertReady() {
        throw new Error('schema drift');
      },
      async loadProviders() {
        providerLoads += 1;
        return providers(async () => {});
      },
      async audit() {},
    }),
    PostgresPluginPackagePromptApplicationUnavailableError,
  );
  assert.equal(databaseCloses, 1);
  assert.equal(providerLoads, 0);
});

test('readiness rejects migration checksum drift', async () => {
  const migrations = postgresModelInvocationMigrationDefinition.migrations.map(
    (migration, index) => ({
      migrationId: migration.id,
      streamId: postgresModelInvocationMigrationDefinition.id,
      dialect: postgresModelInvocationMigrationDefinition.dialect,
      checksum: index === 7 ? '0'.repeat(64) : migration.checksum,
    }),
  );
  await assert.rejects(
    assertPostgresPluginPackagePromptApplicationReady({
      async query() {
        return { rows: migrations };
      },
    }),
    PostgresPluginPackagePromptApplicationUnavailableError,
  );
});
