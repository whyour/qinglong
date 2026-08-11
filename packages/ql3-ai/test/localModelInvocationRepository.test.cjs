const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  createStepRunRecord,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  ModelInvocationConflictError,
  ModelInvocationRepositoryUnavailableError,
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
} = require('../dist/model-invocation/modelInvocation.js');
const {
  DurableModelInvocationCoordinator,
  DurableModelInvocationRecovery,
} = require('../dist/model-invocation/durableModelInvocationCoordinator.js');
const {
  DurableModelInvocationResolutionCoordinator,
} = require('../dist/model-invocation/modelInvocationResolution.js');
const {
  BoundedModelGateway,
  ModelInvocationReplayBlockedError,
} = require('../dist/model-gateway/gateway.js');
const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');
const {
  LocalModelInvocationRepository,
} = require('../dist/model-invocation/localModelInvocationRepository.js');
const {
  ModelInvocationProjectQuotaExceededError,
  createModelInvocationQuotaAdmission,
} = require('../dist/usage/usageQuota.js');
const {
  StaticModelPriceCatalog,
  createModelPriceCatalogEntry,
  createModelInvocationPriceQuote,
} = require('../dist/pricing/pricing.js');

const NOW = 1_000_000;

function createMainSqliteContract(client) {
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
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      event_sequence INTEGER NOT NULL
    );
    CREATE TABLE "RunEvents" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
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
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      output_ref TEXT,
      approval_request_id TEXT,
      ready_at_ms INTEGER,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      result_code TEXT,
      error_summary TEXT,
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
  `);
}

function audit(phase, overrides = {}) {
  return {
    phase,
    projectId: 'project-a',
    runId: 'run-a',
    stepRunId: 'step-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    provider: 'remote',
    model: 'model-a',
    policyRevision: 'policy-1',
    requestDigest: `sha256:${'b'.repeat(64)}`,
    deadlineAtMs: NOW + 10_000,
    inputBytes: 128,
    maxOutputTokens: 64,
    outputBytes: 0,
    usage: null,
    errorCode: null,
    occurredAtMs: NOW,
    ...overrides,
  };
}

async function fixture() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);
  await migrateLocalModelInvocationFeature(client);
  new LocalModelInvocationFeatureActivationRepository(client).transition(
    createLocalModelInvocationFeatureTransitionCommand({
      featureId: 'model-invocation',
      expectedGeneration: 0,
      expectedState: null,
      state: 'active',
      mutationId: 'model-invocation-test-feature-activation',
      requestId: 'model-invocation-test-feature-request',
      expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
      safety: {
        mode: 'fresh_database',
        backupEvidenceDigest: null,
      },
      principal: {
        subject: { type: 'user', id: 'test-owner' },
        authenticationId: 'local_ai_feature:test-proof',
        authenticatedAtMs: 1,
        expiresAtMs: 301_000,
        assurance: 'local_console',
      },
    }),
  );
  const ready = createStepRunRecord({
    id: 'step-a',
    runId: 'run-a',
    stepKey: 'summarize',
    kind: 'model',
    definitionRef: 'prompt:summary@1',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:input-a',
    mutationId: 'create-step-a',
    createdAtMs: NOW - 1,
  });
  client
    .prepare(
      `INSERT INTO "Runs"
       (id, project_id, status, version, event_sequence)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run('run-a', 'project-a', 'running', 1, 1);
  client
    .prepare(
      `INSERT INTO "StepRuns" (
         id, run_id, kind, status, version, attempt_count, output_ref,
         approval_request_id, ready_at_ms, started_at_ms, finished_at_ms,
         result_code, error_summary, updated_at_ms, last_mutation_id,
         step_run_digest, step_run_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ready.id,
      ready.runId,
      ready.kind,
      ready.status,
      ready.version,
      ready.attemptCount,
      ready.outputRef,
      ready.approvalRequestId,
      ready.readyAtMs,
      ready.startedAtMs,
      ready.finishedAtMs,
      ready.resultCode,
      ready.errorSummary,
      ready.updatedAtMs,
      ready.lastMutationId,
      ready.stepRunDigest,
      JSON.stringify(ready),
    );
  return {
    client,
    ready,
    repository: new LocalModelInvocationRepository(client),
  };
}

function startCommand(ready) {
  const identity = createModelInvocationMutationIdentity('request-a', 'start');
  return createModelInvocationStartCommand(
    audit('admitted'),
    transitionStepRunMutation(
      ready,
      {
        expectedVersion: ready.version,
        expectedDigest: ready.stepRunDigest,
        mutationId: identity.mutationId,
        to: 'running',
        atMs: NOW,
      },
      {
        expectedRunVersion: 1,
        expectedRunEventSequence: 1,
        eventId: identity.eventId,
        dedupeKey: identity.dedupeKey,
        actor: { type: 'executor', id: 'model-gateway' },
      },
    ),
  );
}

function completionCommand(start) {
  const identity = createModelInvocationMutationIdentity(
    'request-a',
    'completion',
  );
  return createModelInvocationCompletionCommand(
    start.start,
    audit('completed', {
      occurredAtMs: NOW + 25,
      outputBytes: 12,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }),
    transitionStepRunMutation(
      start.stepRunMutation.stepRun,
      {
        expectedVersion: start.start.startedStepRunVersion,
        expectedDigest: start.start.startedStepRunDigest,
        mutationId: identity.mutationId,
        to: 'succeeded',
        atMs: NOW + 25,
        outputRef: 'model-invocation:request-a',
      },
      {
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventId: identity.eventId,
        dedupeKey: identity.dedupeKey,
        actor: { type: 'executor', id: 'model-gateway' },
      },
    ),
  );
}

test('SQLite admission is transaction-fenced by the active local AI feature', async () => {
  const { client, ready, repository } = await fixture();
  new LocalModelInvocationFeatureActivationRepository(client).transition(
    createLocalModelInvocationFeatureTransitionCommand({
      featureId: 'model-invocation',
      expectedGeneration: 1,
      expectedState: 'active',
      state: 'inactive',
      mutationId: 'model-invocation-test-feature-deactivation',
      requestId: 'model-invocation-test-feature-deactivation-request',
      expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
      safety: {
        mode: 'preserve_existing',
        backupEvidenceDigest: null,
      },
      principal: {
        subject: { type: 'user', id: 'test-owner' },
        authenticationId: 'local_ai_feature:test-proof',
        authenticatedAtMs: 1,
        expiresAtMs: 301_000,
        assurance: 'local_console',
      },
    }),
  );

  await assert.rejects(
    repository.admit(startCommand(ready)),
    ModelInvocationRepositoryUnavailableError,
  );
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "ModelInvocationStarts"`)
      .get().count,
    0,
  );
  assert.equal(
    client.prepare(`SELECT count(*) AS count FROM "StepRunMutations"`).get()
      .count,
    0,
  );
  client.close();
});

test('SQLite atomically admits and completes one model StepRun', async () => {
  const { client, ready, repository } = await fixture();
  const start = startCommand(ready);
  const completion = completionCommand(start);

  assert.equal((await repository.admit(start)).status, 'created');
  assert.equal((await repository.admit(start)).status, 'existing');
  assert.deepEqual(await repository.findStart('request-a'), start.start);
  assert.equal((await repository.complete(completion)).status, 'created');
  assert.equal((await repository.complete(completion)).status, 'existing');
  assert.deepEqual(
    await repository.findCompletion('request-a'),
    completion.completion,
  );
  const usage = await repository.findUsage('request-a');
  assert.deepEqual(
    {
      invocationId: usage.invocationId,
      projectId: usage.projectId,
      completionDigest: usage.completionDigest,
      outcome: usage.outcome,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costMicros: usage.costMicros,
    },
    {
      invocationId: 'request-a',
      projectId: 'project-a',
      completionDigest: completion.completion.completionDigest,
      outcome: 'succeeded',
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      costMicros: null,
    },
  );
  assert.deepEqual(
    await repository.listProjectUsage({
      projectId: 'project-a',
      fromMsInclusive: NOW,
      toMsExclusive: NOW + 100,
      limit: 1,
    }),
    { records: [usage], hasMore: false },
  );
  assert.deepEqual(
    await repository.summarizeProjectUsage({
      projectId: 'project-a',
      fromMsInclusive: NOW,
      toMsExclusive: NOW + 100,
    }),
    {
      invocationCount: 1,
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      knownCostMicros: 0,
      unknownCostInvocations: 1,
    },
  );
  const storedStep = client
    .prepare(
      `SELECT status, version, output_ref FROM "StepRuns"
       WHERE id = 'step-a'`,
    )
    .get();
  assert.equal(storedStep.status, 'succeeded');
  assert.equal(storedStep.version, 3);
  assert.equal(storedStep.output_ref, 'model-invocation:request-a');
  const storedRun = client
    .prepare(`SELECT version, event_sequence FROM "Runs" WHERE id = 'run-a'`)
    .get();
  assert.equal(storedRun.version, 3);
  assert.equal(storedRun.event_sequence, 3);
  assert.equal(
    client.prepare('SELECT count(*) AS count FROM "RunEvents"').get().count,
    2,
  );
  assert.equal(
    client.prepare('SELECT count(*) AS count FROM "StepRunMutations"').get()
      .count,
    2,
  );
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationUsageLedger"')
      .get().count,
    1,
  );
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});

test('SQLite completion and usage ledger roll back together', async () => {
  const { client, ready, repository } = await fixture();
  const start = startCommand(ready);
  const completion = completionCommand(start);
  await repository.admit(start);
  client
    .prepare(`UPDATE "StepRuns" SET status = 'cancelled' WHERE id = 'step-a'`)
    .run();

  await assert.rejects(
    repository.complete(completion),
    ModelInvocationConflictError,
  );
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationCompletions"')
      .get().count,
    0,
  );
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationUsageLedger"')
      .get().count,
    0,
  );
  client.close();
});

test('SQLite completion replay fails closed when its usage ledger is missing', async () => {
  const { client, ready, repository } = await fixture();
  const start = startCommand(ready);
  const completion = completionCommand(start);
  await repository.admit(start);
  await repository.complete(completion);
  client
    .prepare(`DELETE FROM "ModelInvocationUsageLedger" WHERE invocation_id = ?`)
    .run('request-a');

  await assert.rejects(
    repository.complete(completion),
    ModelInvocationConflictError,
  );
  client.close();
});

test('SQLite state conflict rolls back every invocation fact', async () => {
  const { client, ready, repository } = await fixture();
  const start = startCommand(ready);
  client
    .prepare(`UPDATE "StepRuns" SET status = 'cancelled' WHERE id = 'step-a'`)
    .run();

  await assert.rejects(repository.admit(start), ModelInvocationConflictError);
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationStarts"')
      .get().count,
    0,
  );
  assert.equal(
    client.prepare('SELECT count(*) AS count FROM "RunEvents"').get().count,
    0,
  );
  assert.equal(
    client.prepare('SELECT count(*) AS count FROM "StepRunMutations"').get()
      .count,
    0,
  );
  client.close();
});

test('SQLite corrupted durable JSON fails closed', async () => {
  const { client, ready, repository } = await fixture();
  const start = startCommand(ready);
  await repository.admit(start);
  client.exec('PRAGMA ignore_check_constraints = ON');
  client
    .prepare(
      `UPDATE "ModelInvocationStarts"
       SET record_json = json_set(record_json, '$.traceId', 'trace-drift')`,
    )
    .run();

  await assert.rejects(
    repository.findStart('request-a'),
    ModelInvocationRepositoryUnavailableError,
  );
  client.close();
});

test('durable SQLite gateway executes once and blocks provider replay', async () => {
  const { client, repository } = await fixture();
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'remote',
        async listModels() {
          return [{ id: 'model-a' }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: 'remote',
            model: 'model-a',
            text: 'safe summary',
            finishReason: 'stop',
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          };
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    policies: {
      async resolve() {
        return {
          revision: 'policy-1',
          allowedProviders: ['remote'],
          allowedModels: ['model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 64,
          maxTotalTokens: 256,
          maxCostMicros: null,
          priceRevision: null,
        };
      },
    },
    audit: new DurableModelInvocationCoordinator(repository),
    maxConcurrent: 1,
    now: () => NOW,
  });
  const request = {
    provider: 'remote',
    model: 'model-a',
    messages: [{ role: 'user', content: 'sensitive prompt' }],
    maxOutputTokens: 64,
  };
  const context = {
    projectId: 'project-a',
    runId: 'run-a',
    stepRunId: 'step-a',
    traceId: 'trace-a',
    requestId: 'request-a',
    deadlineAtMs: NOW + 10_000,
  };

  assert.equal((await gateway.generate(request, context)).text, 'safe summary');
  await assert.rejects(
    gateway.generate(request, context),
    ModelInvocationReplayBlockedError,
  );
  assert.equal(providerCalls, 1);
  assert.equal(
    JSON.stringify(await repository.findStart('request-a')).includes(
      'sensitive prompt',
    ),
    false,
  );
  client.close();
});

test('SQLite quota admission and settlement stay atomic with the model StepRun', async () => {
  const { client, repository } = await fixture();
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'remote',
        async listModels() {
          return [{ id: 'model-a' }];
        },
        async generate() {
          providerCalls += 1;
          return {
            provider: 'remote',
            model: 'model-a',
            text: 'safe summary',
            finishReason: 'stop',
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 7,
              costMicros: 700,
            },
          };
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    policies: {
      async resolve() {
        return {
          revision: 'policy-1',
          allowedProviders: ['remote'],
          allowedModels: ['model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 64,
          maxTotalTokens: 256,
          maxCostMicros: null,
          priceRevision: null,
          projectQuota: {
            revision: 'quota-1',
            windowMs: 3_600_000,
            maxInvocations: 1,
            maxTokens: 256,
            maxCostMicros: null,
          },
        };
      },
    },
    audit: new DurableModelInvocationCoordinator(repository),
    maxConcurrent: 1,
    now: () => NOW,
  });

  await gateway.generate(
    {
      provider: 'remote',
      model: 'model-a',
      messages: [{ role: 'user', content: 'sensitive prompt' }],
      maxOutputTokens: 64,
    },
    {
      projectId: 'project-a',
      runId: 'run-a',
      stepRunId: 'step-a',
      traceId: 'trace-a',
      requestId: 'request-a',
      deadlineAtMs: NOW + 10_000,
    },
  );

  const reservation = await repository.findQuotaReservation('request-a');
  const settlement = await repository.findQuotaSettlement('request-a');
  assert.equal(providerCalls, 1);
  assert.equal(reservation.reservedTokens, 256);
  assert.equal(settlement.effectiveTokens, 7);
  assert.equal(settlement.effectiveCostMicros, null);
  assert.equal(settlement.retainedTokenReservation, false);
  assert.equal(settlement.retainedCostReservation, false);
  assert.equal((await repository.findUsage('request-a')).costMicros, 700);
  assert.deepEqual(
    await repository.readQuotaWindowUsage(
      'project-a',
      reservation.reservedAtMs,
    ),
    {
      projectId: 'project-a',
      windowStartMs: reservation.windowStartMs,
      windowEndMs: reservation.windowEndMs,
      invocationCount: 1,
      effectiveTokens: 7,
      effectiveCostMicros: 0,
      unknownCostInvocations: 1,
    },
  );
  client.close();
});

test('SQLite price quote, billing, quota and completion commit atomically', async () => {
  const { client, repository } = await fixture();
  const pricing = new StaticModelPriceCatalog([
    createModelPriceCatalogEntry({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
      currency: 'USD',
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
      publishedAtMs: NOW - 1,
    }),
  ]);
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'remote',
        async listModels() {
          return [{ id: 'model-a' }];
        },
        async generate() {
          return {
            provider: 'remote',
            model: 'model-a',
            text: 'safe summary',
            finishReason: 'stop',
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              totalTokens: 7,
              costMicros: 99_999,
            },
          };
        },
        async *stream() {
          throw new Error('not used');
        },
      },
    ],
    pricing,
    policies: {
      async resolve() {
        return {
          revision: 'policy-1',
          allowedProviders: ['remote'],
          allowedModels: ['model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 64,
          maxTotalTokens: 256,
          maxCostMicros: 100,
          priceRevision: 'price-1',
          projectQuota: {
            revision: 'quota-1',
            windowMs: 3_600_000,
            maxInvocations: 10,
            maxTokens: 10_000,
            maxCostMicros: 1_000,
          },
        };
      },
    },
    audit: new DurableModelInvocationCoordinator(repository),
    maxConcurrent: 1,
    now: () => NOW,
  });

  const result = await gateway.generate(
    {
      provider: 'remote',
      model: 'model-a',
      messages: [{ role: 'user', content: 'sensitive prompt' }],
      maxOutputTokens: 64,
    },
    {
      projectId: 'project-a',
      runId: 'run-a',
      stepRunId: 'step-a',
      traceId: 'trace-a',
      requestId: 'request-a',
      deadlineAtMs: NOW + 10_000,
    },
  );

  const quote = await repository.findPriceQuote('request-a');
  const priceSettlement = await repository.findPriceSettlement('request-a');
  const quotaReservation = await repository.findQuotaReservation('request-a');
  const quotaSettlement = await repository.findQuotaSettlement('request-a');
  const usage = await repository.findUsage('request-a');
  assert.equal(result.usage.costMicros, 3);
  assert.equal(quote.priceRevision, 'price-1');
  assert.equal(quote.reservedCostMicros, 68);
  assert.equal(priceSettlement.costMicros, 3);
  assert.equal(usage.costMicros, 3);
  assert.equal(quotaReservation.reservedCostMicros, 68);
  assert.equal(quotaSettlement.effectiveCostMicros, 3);
  assert.equal(quotaSettlement.retainedCostReservation, false);
  const storedStart = await repository.findStart('request-a');
  assert.deepEqual(
    await new DurableModelInvocationCoordinator(repository).recordWithPricing(
      audit('admitted', {
        requestDigest: storedStart.requestDigest,
        inputBytes: storedStart.inputBytes,
        maxOutputTokens: storedStart.maxOutputTokens,
        deadlineAtMs: storedStart.deadlineAtMs,
        occurredAtMs: storedStart.admittedAtMs,
      }),
      quote,
      createModelInvocationQuotaAdmission({
        invocationId: 'request-a',
        projectId: 'project-a',
        modelPolicyRevision: 'policy-1',
        reservedTokens: 256,
        reservedCostMicros: 68,
        quota: {
          revision: 'quota-1',
          windowMs: 3_600_000,
          maxInvocations: 10,
          maxTokens: 10_000,
          maxCostMicros: 1_000,
        },
      }),
    ),
    { status: 'existing' },
  );
  assert.equal(
    client
      .prepare(`SELECT count(*) AS count FROM "ModelInvocationPriceQuotes"`)
      .get().count,
    1,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "ModelInvocationPriceSettlements"`,
      )
      .get().count,
    1,
  );
  client.close();
});

test('SQLite quota exhaustion rolls back admission before provider I/O', async () => {
  const { client, repository } = await fixture();
  let providerCalls = 0;
  const gateway = new BoundedModelGateway({
    providers: [
      {
        type: 'remote',
        async listModels() {
          return [];
        },
        async generate() {
          providerCalls += 1;
          throw new Error('must not execute');
        },
        async *stream() {
          throw new Error('must not execute');
        },
      },
    ],
    pricing: {
      async resolve() {
        throw new Error('pricing must remain unreachable');
      },
    },
    policies: {
      async resolve() {
        return {
          revision: 'policy-1',
          allowedProviders: ['remote'],
          allowedModels: ['model-a'],
          maxInputBytes: 4096,
          maxOutputBytes: 4096,
          maxOutputTokens: 64,
          maxTotalTokens: 256,
          maxCostMicros: null,
          priceRevision: null,
          projectQuota: {
            revision: 'quota-1',
            windowMs: 3_600_000,
            maxInvocations: 10,
            maxTokens: 255,
            maxCostMicros: null,
          },
        };
      },
    },
    audit: new DurableModelInvocationCoordinator(repository),
    maxConcurrent: 1,
    now: () => NOW,
  });

  await assert.rejects(
    gateway.generate(
      {
        provider: 'remote',
        model: 'model-a',
        messages: [{ role: 'user', content: 'sensitive prompt' }],
        maxOutputTokens: 64,
      },
      {
        projectId: 'project-a',
        runId: 'run-a',
        stepRunId: 'step-a',
        traceId: 'trace-a',
        requestId: 'request-a',
        deadlineAtMs: NOW + 10_000,
      },
    ),
    ModelInvocationProjectQuotaExceededError,
  );
  assert.equal(providerCalls, 0);
  assert.equal(await repository.findStart('request-a'), null);
  assert.equal(await repository.findQuotaReservation('request-a'), null);
  assert.equal(
    client.prepare(`SELECT status FROM "StepRuns" WHERE id = 'step-a'`).get()
      .status,
    'ready',
  );
  client.close();
});

test('SQLite recovery marks expired incomplete invocation outcome unknown', async () => {
  const { client, repository } = await fixture();
  const coordinator = new DurableModelInvocationCoordinator(repository);
  assert.deepEqual(await coordinator.record(audit('admitted')), {
    status: 'created',
  });

  const page = await repository.listIncomplete(1);
  assert.equal(page.candidates.length, 1);
  assert.equal(page.hasMore, false);
  const summary = await new DurableModelInvocationRecovery(
    repository,
    coordinator,
  ).recover(1);
  assert.deepEqual(
    {
      scanned: summary.scanned,
      recovered: summary.recovered,
      alreadyCompleted: summary.alreadyCompleted,
      failed: summary.failed,
      hasMore: summary.hasMore,
    },
    {
      scanned: 1,
      recovered: 1,
      alreadyCompleted: 0,
      failed: 0,
      hasMore: false,
    },
  );
  const completion = await repository.findCompletion('request-a');
  assert.equal(completion.outcome, 'outcome_unknown');
  assert.equal(completion.errorCode, 'MODEL_INVOCATION_OUTCOME_UNKNOWN');
  assert.equal(await repository.findUsage('request-a'), null);
  assert.equal(
    client.prepare(`SELECT status FROM "StepRuns" WHERE id = 'step-a'`).get()
      .status,
    'lost',
  );
  client.close();
});

test('SQLite recovery retains a quota reservation when provider usage is unknown', async () => {
  const { client, repository } = await fixture();
  const coordinator = new DurableModelInvocationCoordinator(repository);
  const admission = createModelInvocationQuotaAdmission({
    invocationId: 'request-a',
    projectId: 'project-a',
    modelPolicyRevision: 'policy-1',
    reservedTokens: 256,
    reservedCostMicros: 5_000,
    quota: {
      revision: 'quota-1',
      windowMs: 3_600_000,
      maxInvocations: 10,
      maxTokens: 10_000,
      maxCostMicros: 50_000,
    },
  });
  assert.deepEqual(
    await coordinator.recordWithQuota(audit('admitted'), admission),
    { status: 'created' },
  );

  const summary = await new DurableModelInvocationRecovery(
    repository,
    coordinator,
  ).recover(1);
  assert.equal(summary.recovered, 1);
  const settlement = await repository.findQuotaSettlement('request-a');
  assert.equal(settlement.effectiveTokens, 256);
  assert.equal(settlement.effectiveCostMicros, 5_000);
  assert.equal(settlement.retainedTokenReservation, true);
  assert.equal(settlement.retainedCostReservation, true);
  client.close();
});

test('SQLite priced recovery preserves its quote without inventing a settlement', async () => {
  const { client, repository } = await fixture();
  const coordinator = new DurableModelInvocationCoordinator(repository);
  const quote = createModelInvocationPriceQuote(
    createModelPriceCatalogEntry({
      provider: 'remote',
      model: 'model-a',
      priceRevision: 'price-1',
      currency: 'USD',
      inputMicrosPerMillionTokens: 150_000,
      outputMicrosPerMillionTokens: 600_000,
      publishedAtMs: NOW - 1,
    }),
    {
      invocationId: 'request-a',
      projectId: 'project-a',
      modelPolicyRevision: 'policy-1',
      maxTotalTokens: 256,
      maxOutputTokens: 64,
    },
  );
  const admission = createModelInvocationQuotaAdmission({
    invocationId: 'request-a',
    projectId: 'project-a',
    modelPolicyRevision: 'policy-1',
    reservedTokens: 256,
    reservedCostMicros: quote.reservedCostMicros,
    quota: {
      revision: 'quota-1',
      windowMs: 3_600_000,
      maxInvocations: 10,
      maxTokens: 10_000,
      maxCostMicros: 50_000,
    },
  });
  assert.deepEqual(
    await coordinator.recordWithPricing(audit('admitted'), quote, admission),
    { status: 'created' },
  );

  const summary = await new DurableModelInvocationRecovery(
    repository,
    coordinator,
  ).recover(1);
  assert.equal(summary.recovered, 1);
  assert.equal(
    (await repository.findCompletion('request-a')).outcome,
    'outcome_unknown',
  );
  assert.equal(
    (await repository.findPriceQuote('request-a')).quoteDigest,
    quote.quoteDigest,
  );
  assert.equal(await repository.findPriceSettlement('request-a'), null);
  const quotaSettlement = await repository.findQuotaSettlement('request-a');
  assert.equal(quotaSettlement.effectiveCostMicros, quote.reservedCostMicros);
  assert.equal(quotaSettlement.retainedTokenReservation, true);
  assert.equal(quotaSettlement.retainedCostReservation, true);
  client.close();
});

test('SQLite manual retry preserves the unknown attempt and admits a new invocation', async () => {
  const { client, repository } = await fixture();
  const coordinator = new DurableModelInvocationCoordinator(repository);
  assert.deepEqual(await coordinator.record(audit('admitted')), {
    status: 'created',
  });
  await new DurableModelInvocationRecovery(repository, coordinator).recover(1);
  const completion = await repository.findCompletion('request-a');
  assert.equal(completion.outcome, 'outcome_unknown');

  const resolver = new DurableModelInvocationResolutionCoordinator(repository);
  const resolvedAtMs = completion.completedAtMs + 1;
  const resolution = await resolver.resolve({
    invocationId: 'request-a',
    decision: 'retry',
    resolvedByUserId: 'user-a',
    resolvedAtMs,
  });
  assert.equal(resolution.status, 'created');
  assert.equal(resolution.record.decision, 'retry');
  assert.equal(
    (
      await resolver.resolve({
        invocationId: 'request-a',
        decision: 'retry',
        resolvedByUserId: 'user-a',
        resolvedAtMs: resolvedAtMs + 100,
      })
    ).status,
    'existing',
  );
  await assert.rejects(
    resolver.resolve({
      invocationId: 'request-a',
      decision: 'fail',
      resolvedByUserId: 'user-a',
      resolvedAtMs,
    }),
    ModelInvocationConflictError,
  );

  const ready = client
    .prepare(
      `SELECT status, version, attempt_count, result_code, error_summary
       FROM "StepRuns" WHERE id = 'step-a'`,
    )
    .get();
  assert.deepEqual(
    {
      status: ready.status,
      version: ready.version,
      attemptCount: ready.attempt_count,
      resultCode: ready.result_code,
      errorSummary: ready.error_summary,
    },
    {
      status: 'ready',
      version: 4,
      attemptCount: 1,
      resultCode: null,
      errorSummary: null,
    },
  );
  const resolutionEvent = client
    .prepare(
      `SELECT actor_type, actor_id, type FROM "RunEvents"
       WHERE id = ?`,
    )
    .get(resolution.record.runEventId);
  assert.deepEqual(
    { ...resolutionEvent },
    {
      actor_type: 'user',
      actor_id: 'user-a',
      type: 'step.ready',
    },
  );

  const secondAdmissionAtMs = resolvedAtMs + 1;
  assert.deepEqual(
    await coordinator.record(
      audit('admitted', {
        requestId: 'request-b',
        traceId: 'trace-b',
        occurredAtMs: secondAdmissionAtMs,
        deadlineAtMs: secondAdmissionAtMs + 10_000,
      }),
    ),
    { status: 'created' },
  );
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationStarts"')
      .get().count,
    2,
  );
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationCompletions"')
      .get().count,
    1,
  );
  assert.equal(
    client
      .prepare('SELECT count(*) AS count FROM "ModelInvocationResolutions"')
      .get().count,
    1,
  );
  const running = client
    .prepare(
      `SELECT status, version, attempt_count FROM "StepRuns"
       WHERE id = 'step-a'`,
    )
    .get();
  assert.deepEqual(
    { ...running },
    {
      status: 'running',
      version: 5,
      attempt_count: 2,
    },
  );
  assert.deepEqual(await repository.findCompletion('request-a'), completion);
  assert.equal(
    client.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  client.close();
});

for (const [decision, expectedStatus, expectedCode] of [
  ['fail', 'failed', 'model_outcome_rejected'],
  ['cancel', 'cancelled', 'model_outcome_cancelled'],
]) {
  test(`SQLite manual ${decision} terminally resolves an unknown invocation`, async () => {
    const { client, repository } = await fixture();
    const coordinator = new DurableModelInvocationCoordinator(repository);
    await coordinator.record(audit('admitted'));
    await new DurableModelInvocationRecovery(repository, coordinator).recover(
      1,
    );
    const completion = await repository.findCompletion('request-a');
    const result = await new DurableModelInvocationResolutionCoordinator(
      repository,
    ).resolve({
      invocationId: 'request-a',
      decision,
      resolvedByUserId: 'user-a',
      resolvedAtMs: completion.completedAtMs + 1,
    });
    assert.equal(result.status, 'created');
    assert.deepEqual(
      {
        ...client
          .prepare(
            `SELECT status, result_code FROM "StepRuns" WHERE id = 'step-a'`,
          )
          .get(),
      },
      { status: expectedStatus, result_code: expectedCode },
    );
    client.close();
  });
}
