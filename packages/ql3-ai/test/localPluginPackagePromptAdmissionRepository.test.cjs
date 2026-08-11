const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  pluginPackageAutomationPublicationDigest,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  LocalPluginPackagePromptAdmissionRepository,
} = require('../dist/prompt/localPluginPackagePromptAdmissionRepository.js');
const {
  LocalModelInvocationRepository,
} = require('../dist/model-invocation/localModelInvocationRepository.js');
const {
  DurableModelInvocationCoordinator,
  DurableModelInvocationRecovery,
} = require('../dist/model-invocation/durableModelInvocationCoordinator.js');
const { BoundedModelGateway } = require('../dist/model-gateway/gateway.js');
const {
  PluginPackagePromptExecutor,
} = require('../dist/prompt/pluginPackagePromptExecutor.js');
const {
  LocalPluginPackagePromptOutputArtifactRepository,
} = require('../dist/prompt-output/storage/localPluginPackagePromptOutputArtifactRepository.js');
const {
  createPluginPackagePromptOutputArtifact,
  openPluginPackagePromptOutputArtifact,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  PluginPackagePromptOutputCompletionCoordinator,
} = require('../dist/prompt-output/pluginPackagePromptOutputCompletion.js');
const {
  LocalPluginPackagePromptOutputGarbageCollector,
  LocalPluginPackagePromptOutputRetentionRepository,
} = require('../dist/prompt-output/storage/localPluginPackagePromptOutputRetentionRepository.js');
const {
  PluginPackagePromptAdmissionConflictError,
  PluginPackagePromptAdmissionNotAllowedError,
  preparePluginPackagePromptExecution,
} = require('../dist/prompt/pluginPackagePromptExecution.js');

function createMainContract(client) {
  client.exec(`
    CREATE TABLE "QingLong3SchemaMigrations" (
      migration_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      dialect TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "Runs" (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision TEXT NOT NULL,
      task_name TEXT,
      task_snapshot_ref TEXT,
      trigger_type TEXT NOT NULL,
      execution_origin TEXT NOT NULL,
      execution_owner TEXT NOT NULL,
      triggered_by TEXT,
      request_id TEXT,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      event_sequence INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      idempotency_key TEXT,
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      error_code TEXT,
      error_summary TEXT
    );
    CREATE TABLE "RunEvents" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      dedupe_key TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      attempt_id TEXT,
      step_run_id TEXT,
      payload TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (run_id, sequence),
      UNIQUE (run_id, dedupe_key)
    );
    CREATE TABLE "StepRuns" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      parent_step_run_id TEXT,
      step_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      definition_ref TEXT NOT NULL,
      definition_digest TEXT NOT NULL,
      required INTEGER NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      input_ref TEXT,
      output_ref TEXT,
      approval_request_id TEXT,
      ready_at_ms INTEGER,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      result_code TEXT,
      error_summary TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      last_mutation_id TEXT NOT NULL,
      step_run_digest TEXT NOT NULL,
      step_run_json TEXT NOT NULL,
      UNIQUE (run_id, id)
    );
    CREATE TABLE "StepRunMutations" (
      mutation_id TEXT PRIMARY KEY,
      mutation_digest TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_run_id TEXT NOT NULL,
      step_run_digest TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL,
      run_version INTEGER NOT NULL,
      step_run_json TEXT NOT NULL,
      committed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "QingLong3PluginPackageAutomationPublications" (
      publication_digest TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      lock_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      publication_json TEXT NOT NULL
    );
    CREATE TABLE "QingLong3PluginPackageAutomationPublicationHeads" (
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      publication_digest TEXT NOT NULL,
      PRIMARY KEY (project_id, package_name)
    );
    CREATE TABLE "QingLong3PluginPackageInstallHeads" (
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      PRIMARY KEY (project_id, package_name)
    );
    CREATE TABLE "QingLong3PluginPackageInstalls" (
      installation_id TEXT NOT NULL,
      lock_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      active_lock_digest TEXT,
      PRIMARY KEY (installation_id, lock_digest)
    );
    CREATE TABLE "QingLong3PluginPackageLifecycleHeads" (
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      event_digest TEXT,
      disposition TEXT,
      PRIMARY KEY (project_id, package_name)
    );
    CREATE TABLE "QingLong3PluginPackageQuarantineEvents" (
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      lock_digest TEXT NOT NULL
    );
    CREATE TABLE "QingLong3PluginPackageMaterializedRevisions" (
      generation_digest TEXT NOT NULL,
      project_id TEXT NOT NULL,
      package_name TEXT NOT NULL,
      generation INTEGER NOT NULL,
      lock_digest TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      revision_json TEXT NOT NULL,
      PRIMARY KEY (generation_digest, revision_digest)
    );
  `);
}

function publication() {
  const unsigned = {
    schema: 'qinglong/plugin-package-automation-publication@v1',
    target: {
      projectId: 'project-a',
      packageName: 'package-a',
      installationId: 'installation-a',
      lockDigest: '1'.repeat(64),
      generation: 3,
      generationDigest: '2'.repeat(64),
      materializedRevisionDigest: '3'.repeat(64),
    },
    state: 'active',
    version: 1,
    previousPublicationDigest: null,
    lifecycleEventDigest: null,
    definitions: {
      workflows: [],
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
    },
    publishedAtMs: 1_000,
  };
  return {
    ...unsigned,
    publicationDigest: pluginPackageAutomationPublicationDigest(unsigned),
  };
}

function executionInput(active, overrides = {}) {
  return {
    publication: active,
    expectedPublicationDigest: active.publicationDigest,
    promptId: 'summary',
    requestId: 'prompt-request-a',
    traceId: 'trace-a',
    requestedBySubject: { type: 'user', id: 'user-a' },
    policyFence: { projectVersion: 1, bindingVersion: 1 },
    parameters: { subject: 'private QingLong input' },
    provider: 'openai-compatible',
    model: 'vendor/model-a',
    maxOutputTokens: 512,
    temperature: 0.2,
    plannedAtMs: 2_000,
    deadlineAtMs: 62_000,
    ...overrides,
  };
}

function prepared(active, overrides = {}) {
  return preparePluginPackagePromptExecution(executionInput(active, overrides));
}

async function fixture() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainContract(client);
  await migrateLocalModelInvocationFeature(client);
  new LocalModelInvocationFeatureActivationRepository(client).transition(
    createLocalModelInvocationFeatureTransitionCommand({
      featureId: 'model-invocation',
      expectedGeneration: 0,
      expectedState: null,
      state: 'active',
      mutationId: 'prompt-test-feature-activation',
      requestId: 'prompt-test-feature-request',
      expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
      safety: { mode: 'fresh_database', backupEvidenceDigest: null },
      principal: {
        subject: { type: 'user', id: 'test-owner' },
        authenticationId: 'local_ai_feature:prompt-test',
        authenticatedAtMs: 1,
        expiresAtMs: 301_000,
        assurance: 'local_console',
      },
    }),
  );
  const active = publication();
  const prompt = active.definitions.prompts[0];
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageAutomationPublications" (
         publication_digest, project_id, package_name, installation_id,
         lock_digest, state, publication_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      active.publicationDigest,
      active.target.projectId,
      active.target.packageName,
      active.target.installationId,
      active.target.lockDigest,
      active.state,
      JSON.stringify(active),
    );
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageAutomationPublicationHeads"
       (project_id, package_name, publication_digest) VALUES (?, ?, ?)`,
    )
    .run('project-a', 'package-a', active.publicationDigest);
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageInstallHeads"
       (project_id, package_name, installation_id) VALUES (?, ?, ?)`,
    )
    .run('project-a', 'package-a', 'installation-a');
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageInstalls"
       (installation_id, lock_digest, state, active_lock_digest)
       VALUES (?, ?, 'active', ?)`,
    )
    .run('installation-a', '1'.repeat(64), '1'.repeat(64));
  client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageMaterializedRevisions" (
         generation_digest, project_id, package_name, generation,
         lock_digest, revision_digest, revision_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      '2'.repeat(64),
      'project-a',
      'package-a',
      3,
      '1'.repeat(64),
      '3'.repeat(64),
      JSON.stringify({ resources: [{ kind: 'prompt', value: prompt }] }),
    );
  return {
    active,
    client,
    repository: new LocalPluginPackagePromptAdmissionRepository(client),
  };
}

test('SQLite atomically admits one content-free Package Prompt Run', async () => {
  const { active, client, repository } = await fixture();
  const execution = prepared(active);
  const created = await repository.admit(execution.plan);
  assert.equal(created.status, 'created');
  assert.deepEqual(
    await repository.findByRequestId(execution.plan.requestId),
    created.receipt,
  );
  assert.deepEqual(
    await repository.findByInvocationId(execution.plan.invocationId),
    created.receipt,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(`SELECT status, version, event_sequence FROM "Runs"`)
        .get(),
    },
    { status: 'running', version: 2, event_sequence: 2 },
  );
  assert.deepEqual(
    {
      ...client.prepare(`SELECT kind, status, version FROM "StepRuns"`).get(),
    },
    { kind: 'model', status: 'ready', version: 1 },
  );
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "RunEvents"`).get().count,
    2,
  );
  const durable = JSON.stringify(
    client
      .prepare(
        `SELECT plan_json, receipt_json, parameter_digest,
                model_request_digest
         FROM "ModelInvocationPromptAdmissions"`,
      )
      .get(),
  );
  assert.equal(durable.includes('private QingLong input'), false);
  assert.equal(durable.includes('Summarize '), false);
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});

test('SQLite exact replay survives publication withdrawal without new writes', async () => {
  const { active, client, repository } = await fixture();
  const execution = prepared(active);
  const created = await repository.admit(execution.plan);
  client
    .prepare(
      `UPDATE "QingLong3PluginPackageAutomationPublications"
       SET state = 'withdrawn' WHERE publication_digest = ?`,
    )
    .run(active.publicationDigest);
  const replay = await repository.admit(execution.plan);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.receipt, created.receipt);
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "Runs"`).get().count,
    1,
  );
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "RunEvents"`).get().count,
    2,
  );
  await assert.rejects(
    repository.admit(
      prepared(active, {
        requestId: 'prompt-request-b',
        traceId: 'trace-b',
      }).plan,
    ),
    PluginPackagePromptAdmissionNotAllowedError,
  );
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "Runs"`).get().count,
    1,
  );
  client.close();
});

test('SQLite rejects request drift and rolls missing materialization back', async () => {
  const { active, client, repository } = await fixture();
  const execution = prepared(active);
  await repository.admit(execution.plan);
  await assert.rejects(
    repository.admit(prepared(active, { model: 'vendor/model-b' }).plan),
    PluginPackagePromptAdmissionConflictError,
  );
  client.exec(`DELETE FROM "QingLong3PluginPackageMaterializedRevisions"`);
  await assert.rejects(
    repository.admit(
      prepared(active, {
        requestId: 'prompt-request-c',
        traceId: 'trace-c',
      }).plan,
    ),
    PluginPackagePromptAdmissionConflictError,
  );
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "Runs"`).get().count,
    1,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "ModelInvocationPromptAdmissions"`,
      )
      .get().count,
    1,
  );
  client.close();
});

test('SQLite finalizes the parent Prompt Run from exact ModelInvocation evidence', async () => {
  const { active, client, repository } = await fixture();
  const execution = prepared(active);
  await repository.admit(execution.plan);
  const modelRepository = new LocalModelInvocationRepository(client);
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'vendor/model-a' }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: 'openai-compatible',
            model: 'vendor/model-a',
            text: 'private model output',
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
          revision: 'policy-1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['vendor/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 512,
          maxTotalTokens: 1024,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    audit: new DurableModelInvocationCoordinator(modelRepository),
    maxConcurrent: 1,
    now: () => 3_000,
  });
  const result = await gateway.generate(execution.request, {
    projectId: execution.plan.target.projectId,
    runId: execution.plan.runId,
    stepRunId: execution.plan.stepRunId,
    traceId: execution.plan.traceId,
    requestId: execution.plan.invocationId,
    deadlineAtMs: execution.plan.deadlineAtMs,
  });
  assert.equal(result.text, 'private model output');
  assert.equal(providerCalls, 1);
  const finalized = await repository.finalize(execution.plan.requestId);
  assert.equal(finalized.status, 'created');
  assert.equal(finalized.receipt.terminalEvidenceKind, 'completion');
  assert.equal(finalized.receipt.runStatus, 'succeeded');
  assert.equal(finalized.receipt.finalRunVersion, 5);
  assert.deepEqual(
    await repository.findFinalizationByRequestId(execution.plan.requestId),
    finalized.receipt,
  );
  const replay = await repository.finalize(execution.plan.requestId);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.receipt, finalized.receipt);
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT status, version, event_sequence, finished_at_ms,
                  error_code, error_summary
           FROM "Runs"`,
        )
        .get(),
    },
    {
      status: 'succeeded',
      version: 5,
      event_sequence: 5,
      finished_at_ms: 3_000,
      error_code: null,
      error_summary: null,
    },
  );
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "RunEvents"`).get().count,
    5,
  );
  const durable = JSON.stringify(
    client
      .prepare(`SELECT receipt_json FROM "ModelInvocationPromptFinalizations"`)
      .get(),
  );
  assert.equal(durable.includes('private model output'), false);
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});

test('Prompt executor executes once and exact replay never calls the provider again', async () => {
  const { active, client, repository } = await fixture();
  const modelRepository = new LocalModelInvocationRepository(client);
  let providerCalls = 0;
  const modelCoordinator = new DurableModelInvocationCoordinator(
    modelRepository,
  );
  const durableOutput = new PluginPackagePromptOutputCompletionCoordinator({
    coordinator: modelCoordinator,
    keys: {
      async active() {
        return { keyId: 'prompt-output-key-1', key: Buffer.alloc(32, 7) };
      },
      async resolve(keyId) {
        return keyId === 'prompt-output-key-1'
          ? { keyId, key: Buffer.alloc(32, 7) }
          : null;
      },
    },
    now: () => 3_001,
    nonceFactory: () => Buffer.alloc(12, 9),
  });
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'vendor/model-a' }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: 'openai-compatible',
            model: 'vendor/model-a',
            text: 'one live response',
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
          revision: 'policy-1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['vendor/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 512,
          maxTotalTokens: 1024,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    audit: modelCoordinator,
    successfulCompletion: durableOutput,
    maxConcurrent: 1,
    now: () => 3_000,
  });
  const unsupportedExecutor = new PluginPackagePromptExecutor({
    admissions: repository,
    invocations: modelRepository,
    gateway,
  });
  await assert.rejects(
    unsupportedExecutor.execute(
      executionInput(active, {
        output: {
          mode: 'durable_artifact',
          retentionPolicy: {
            revision: 'edge-output-v1',
            retentionMs: 86_400_000,
          },
        },
      }),
    ),
    { code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_UNAVAILABLE' },
  );
  assert.equal(providerCalls, 0);
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "ModelInvocationPromptAdmissions"`,
      )
      .get().count,
    0,
  );
  const executor = new PluginPackagePromptExecutor({
    admissions: repository,
    invocations: modelRepository,
    gateway,
    durableOutput,
  });
  const first = await executor.execute(executionInput(active));
  assert.equal(first.status, 'executed');
  assert.equal(first.result.text, 'one live response');
  assert.equal(first.finalization.runStatus, 'succeeded');
  const replay = await executor.execute(executionInput(active));
  assert.equal(replay.status, 'existing');
  assert.equal(replay.result, null);
  assert.deepEqual(replay.admission, first.admission);
  assert.deepEqual(replay.finalization, first.finalization);
  assert.equal(providerCalls, 1);
  assert.equal(
    JSON.stringify(
      client
        .prepare(
          `SELECT plan_json, receipt_json FROM "ModelInvocationPromptAdmissions"`,
        )
        .get(),
    ).includes('one live response'),
    false,
  );

  const durablePrepared = prepared(active, {
    requestId: 'prompt-request-durable-a',
    traceId: 'trace-durable-a',
    output: {
      mode: 'durable_artifact',
      retentionPolicy: {
        revision: 'edge-output-v1',
        retentionMs: 86_400_000,
      },
    },
  });
  const durableExecution = await executor.execute(
    executionInput(active, {
      requestId: 'prompt-request-durable-a',
      traceId: 'trace-durable-a',
      output: {
        mode: 'durable_artifact',
        retentionPolicy: {
          revision: 'edge-output-v1',
          retentionMs: 86_400_000,
        },
      },
    }),
  );
  assert.equal(durableExecution.status, 'executed');
  assert.equal(durableExecution.result.text, 'one live response');
  assert.equal(
    durableExecution.outputArtifact.artifactId.startsWith('pao:'),
    true,
  );
  assert.equal(providerCalls, 2);
  const operationAuthority = {
    client,
    async enqueue(work) {
      return work();
    },
  };
  const artifacts = new LocalPluginPackagePromptOutputArtifactRepository(
    operationAuthority,
  );
  const artifact = await artifacts.find(
    durableExecution.outputArtifact.artifactId,
  );
  assert.ok(artifact);
  assert.equal(
    artifact.artifactDigest,
    durableExecution.outputArtifact.artifactDigest,
  );
  assert.deepEqual(
    openPluginPackagePromptOutputArtifact(artifact, Buffer.alloc(32, 7)),
    durableExecution.result,
  );
  assert.equal(
    client
      .prepare(`SELECT output_ref AS outputRef FROM "StepRuns" WHERE id = ?`)
      .get(durablePrepared.plan.stepRunId).outputRef,
    artifact.artifactId,
  );
  const durableReplay = await executor.execute(
    executionInput(active, {
      requestId: 'prompt-request-durable-a',
      traceId: 'trace-durable-a',
      output: {
        mode: 'durable_artifact',
        retentionPolicy: {
          revision: 'edge-output-v1',
          retentionMs: 86_400_000,
        },
      },
    }),
  );
  assert.equal(durableReplay.status, 'existing');
  assert.equal(durableReplay.result, null);
  assert.deepEqual(
    durableReplay.outputArtifact,
    durableExecution.outputArtifact,
  );
  assert.equal(providerCalls, 2);
  assert.equal(
    JSON.stringify(
      client
        .prepare(
          `SELECT artifact_json FROM "ModelInvocationPromptOutputArtifacts"`,
        )
        .get(),
    ).includes('one live response'),
    false,
  );
  const livePlan = prepared(active).plan;
  const liveArtifact = createPluginPackagePromptOutputArtifact(
    {
      projectId: livePlan.target.projectId,
      runId: livePlan.runId,
      stepRunId: livePlan.stepRunId,
      invocationId: livePlan.invocationId,
      requestedBy: livePlan.requestedBySubject,
      result: first.result,
      retentionPolicy: {
        revision: 'edge-output-v1',
        retentionMs: 86_400_000,
      },
      keyId: 'prompt-output-key-1',
      key: Buffer.alloc(32, 7),
      sealedAtMs: 3_001,
    },
    () => Buffer.alloc(12, 9),
  );
  await assert.rejects(artifacts.put(liveArtifact), {
    code: 'PLUGIN_PACKAGE_PROMPT_OUTPUT_ARTIFACT_CONFLICT',
  });
  const retention = new LocalPluginPackagePromptOutputRetentionRepository(
    operationAuthority,
  );
  assert.deepEqual(
    await retention.inspect({
      reference: durableExecution.outputArtifact,
      observedAtMs: artifact.retentionEligibleAtMs,
    }),
    { state: 'retained' },
  );
  const garbageCollector = new LocalPluginPackagePromptOutputGarbageCollector({
    authority: operationAuthority,
    policies: {
      async resolve({ revision }) {
        return revision === artifact.retentionPolicy.revision
          ? artifact.retentionPolicy
          : null;
      },
    },
    now: () => artifact.retentionEligibleAtMs,
    limit: 4,
  });
  assert.deepEqual(await garbageCollector.collect(), {
    scanned: 1,
    tombstoned: 1,
    skipped: 0,
    hasMore: false,
  });
  assert.equal(
    await artifacts.find(durableExecution.outputArtifact.artifactId),
    null,
  );
  const tombstoneState = await retention.inspect({
    reference: durableExecution.outputArtifact,
    observedAtMs: artifact.retentionEligibleAtMs,
  });
  assert.equal(tombstoneState.state, 'tombstoned');
  assert.equal(tombstoneState.tombstonedAtMs, artifact.retentionEligibleAtMs);
  assert.equal(
    JSON.stringify(
      client
        .prepare(
          `SELECT tombstone_json FROM "ModelInvocationPromptOutputArtifactTombstones"`,
        )
        .get(),
    ).includes('one live response'),
    false,
  );
  const replayAfterGc = await executor.execute(
    executionInput(active, {
      requestId: 'prompt-request-durable-a',
      traceId: 'trace-durable-a',
      output: {
        mode: 'durable_artifact',
        retentionPolicy: {
          revision: 'edge-output-v1',
          retentionMs: 86_400_000,
        },
      },
    }),
  );
  assert.equal(replayAfterGc.status, 'existing');
  assert.equal(replayAfterGc.result, null);
  assert.deepEqual(
    replayAfterGc.outputArtifact,
    durableExecution.outputArtifact,
  );
  assert.equal(providerCalls, 2);
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});

test('SQLite rolls Artifact and terminal facts back at the post-completion settlement crash window', async () => {
  const { active, client, repository } = await fixture();
  const modelRepository = new LocalModelInvocationRepository(client);
  const modelCoordinator = new DurableModelInvocationCoordinator(
    modelRepository,
  );
  const durableOutput = new PluginPackagePromptOutputCompletionCoordinator({
    coordinator: modelCoordinator,
    keys: {
      async active() {
        return { keyId: 'prompt-output-key-1', key: Buffer.alloc(32, 7) };
      },
      async resolve() {
        return null;
      },
    },
    now: () => 3_001,
    nonceFactory: () => Buffer.alloc(12, 9),
  });
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'openai-compatible',
        async listModels() {
          return [{ id: 'vendor/model-a' }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: 'openai-compatible',
            model: 'vendor/model-a',
            text: 'must roll back as ciphertext too',
            finishReason: 'stop',
            usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
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
          revision: 'policy-1',
          allowedProviders: ['openai-compatible'],
          allowedModels: ['vendor/model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 512,
          maxTotalTokens: 1024,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    audit: modelCoordinator,
    successfulCompletion: durableOutput,
    maxConcurrent: 1,
    now: () => 3_000,
  });
  const executor = new PluginPackagePromptExecutor({
    admissions: repository,
    invocations: modelRepository,
    gateway,
    durableOutput,
  });
  const input = executionInput(active, {
    requestId: 'prompt-request-crash-a',
    traceId: 'trace-crash-a',
    output: {
      mode: 'durable_artifact',
      retentionPolicy: {
        revision: 'edge-output-v1',
        retentionMs: 86_400_000,
      },
    },
  });
  const crashPlan = prepared(active, {
    requestId: 'prompt-request-crash-a',
    traceId: 'trace-crash-a',
    output: input.output,
  }).plan;
  client.exec(`
    CREATE TRIGGER "PromptOutputSettlementCrash"
    BEFORE INSERT ON "ModelInvocationUsageLedger"
    BEGIN
      SELECT RAISE(ABORT, 'prompt output settlement crash');
    END;
  `);
  await assert.rejects(executor.execute(input), {
    code: 'MODEL_AUDIT_UNAVAILABLE',
  });
  assert.equal(providerCalls, 1);
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
           FROM "ModelInvocationPromptOutputArtifacts"
          WHERE invocation_id = ?`,
      )
      .get(crashPlan.invocationId).count,
    0,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "ModelInvocationCompletions"
          WHERE invocation_id = ?`,
      )
      .get(crashPlan.invocationId).count,
    0,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT status, output_ref AS outputRef FROM "StepRuns" WHERE id = ?`,
        )
        .get(crashPlan.stepRunId),
    },
    { status: 'running', outputRef: null },
  );
  client.exec(`DROP TRIGGER "PromptOutputSettlementCrash"`);
  await assert.rejects(executor.execute(input), {
    code: 'PLUGIN_PACKAGE_PROMPT_EXECUTION_IN_PROGRESS',
  });
  assert.equal(providerCalls, 1);
  const recovery = await new DurableModelInvocationRecovery(
    modelRepository,
  ).recover(4);
  assert.equal(recovery.recovered, 1);
  assert.equal(
    (await modelRepository.findCompletion(crashPlan.invocationId)).outcome,
    'outcome_unknown',
  );
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});
