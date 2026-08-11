const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const {
  createStepRunRecord,
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  ModelInvocationConflictError,
  createModelInvocationCompletionCommand,
  createModelInvocationMutationIdentity,
  createModelInvocationStartCommand,
} = require('../dist/model-invocation/modelInvocation.js');
const {
  migratePostgresModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  PostgresModelInvocationRepository,
} = require('../dist/model-invocation/postgresModelInvocationRepository.js');
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
  ModelInvocationProjectQuotaExceededError,
  createModelInvocationQuotaAdmission,
} = require('../dist/usage/usageQuota.js');
const {
  StaticModelPriceCatalog,
  createModelPriceCatalogEntry,
} = require('../dist/pricing/pricing.js');

const migrationConnectionString =
  process.env.QL3_TEST_POSTGRES_MIGRATION_URL ??
  process.env.QL3_TEST_POSTGRES_URL;
const runtimeConnectionString =
  process.env.QL3_TEST_POSTGRES_RUNTIME_URL ?? migrationConnectionString;

if (!migrationConnectionString) {
  test(
    'PostgreSQL ModelInvocation integration requires QL3_TEST_POSTGRES_URL',
    {
      skip: true,
    },
  );
} else {
  const clusterRequire = createRequire(
    path.resolve(__dirname, '../../ql3-cluster-postgres/package.json'),
  );
  const { Pool } = clusterRequire('pg');
  const {
    runPostgresMigrations,
  } = require('../../ql3-cluster-postgres/dist/migration/migration.js');
  const {
    assertPostgresSchemaReady,
  } = require('../../ql3-cluster-postgres/dist/schema/schemaReadiness.js');

  const NOW = 2_000_000;
  const RUN_ID = '51000000-0000-4000-8000-000000000001';
  const CONFLICT_RUN_ID = '51000000-0000-4000-8000-000000000002';
  const FAULT_RUN_ID = '51000000-0000-4000-8000-000000000003';
  const QUOTA_RUN_A_ID = '51000000-0000-4000-8000-000000000004';
  const QUOTA_RUN_B_ID = '51000000-0000-4000-8000-000000000005';
  const PRICING_RUN_ID = '51000000-0000-4000-8000-000000000006';

  function pool(connectionString, applicationName) {
    return new Pool({
      connectionString,
      ssl: false,
      max: 4,
      application_name: applicationName,
    });
  }

  function commitResponseLossPool(basePool) {
    let injected = false;
    return {
      query(text, values) {
        return basePool.query(text, values);
      },
      async connect() {
        const client = await basePool.connect();
        return {
          async query(text, values) {
            const result = await client.query(text, values);
            if (!injected && /^\s*COMMIT\s*$/i.test(text)) {
              injected = true;
              const error = new Error('injected response loss after COMMIT');
              error.code = 'ECONNRESET';
              throw error;
            }
            return result;
          },
          release() {
            client.release();
          },
        };
      },
      wasInjected() {
        return injected;
      },
    };
  }

  function audit(phase, overrides = {}) {
    return {
      phase,
      projectId: 'project-ai',
      runId: RUN_ID,
      stepRunId: 'model-step-ai',
      traceId: 'trace-ai',
      requestId: 'request-ai',
      provider: 'remote',
      model: 'model-ai',
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

  function readyStep(runId, stepRunId, mutationId) {
    return createStepRunRecord({
      id: stepRunId,
      runId,
      stepKey: 'summarize',
      kind: 'model',
      definitionRef: 'prompt:summary@1',
      definitionDigest: 'a'.repeat(64),
      required: true,
      initialStatus: 'ready',
      inputRef: `artifact:${stepRunId}:input`,
      mutationId,
      createdAtMs: NOW - 1,
    });
  }

  function startCommand(ready, auditRecord = audit('admitted')) {
    const identity = createModelInvocationMutationIdentity(
      auditRecord.requestId,
      'start',
    );
    return createModelInvocationStartCommand(
      auditRecord,
      transitionStepRunMutation(
        ready,
        {
          expectedVersion: ready.version,
          expectedDigest: ready.stepRunDigest,
          mutationId: identity.mutationId,
          to: 'running',
          atMs: auditRecord.occurredAtMs,
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
      start.start.invocationId,
      'completion',
    );
    const completedAudit = audit('completed', {
      runId: start.start.runId,
      stepRunId: start.start.stepRunId,
      traceId: start.start.traceId,
      requestId: start.start.invocationId,
      occurredAtMs: NOW + 25,
      outputBytes: 12,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    return createModelInvocationCompletionCommand(
      start.start,
      completedAudit,
      transitionStepRunMutation(
        start.stepRunMutation.stepRun,
        {
          expectedVersion: start.start.startedStepRunVersion,
          expectedDigest: start.start.startedStepRunDigest,
          mutationId: identity.mutationId,
          to: 'succeeded',
          atMs: completedAudit.occurredAtMs,
          outputRef: `model-invocation:${start.start.invocationId}`,
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

  async function deleteFixture(client, runId) {
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_price_settlements"
       WHERE invocation_id IN (
         SELECT invocation_id
         FROM "ql3_ai"."model_invocation_starts"
         WHERE run_id = $1
       )`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_quota_settlements"
       WHERE invocation_id IN (
         SELECT invocation_id
         FROM "ql3_ai"."model_invocation_starts"
         WHERE run_id = $1
       )`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_quota_reservations"
       WHERE invocation_id IN (
         SELECT invocation_id
         FROM "ql3_ai"."model_invocation_starts"
         WHERE run_id = $1
       )`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_price_quotes"
       WHERE invocation_id IN (
         SELECT invocation_id
         FROM "ql3_ai"."model_invocation_starts"
         WHERE run_id = $1
       )`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_resolutions"
       WHERE run_id = $1`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_usage_ledger"
       WHERE run_id = $1`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_completions"
       WHERE run_id = $1`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3_ai"."model_invocation_starts" WHERE run_id = $1`,
      [runId],
    );
    await client.query(
      `DELETE FROM "ql3"."step_run_mutations" WHERE run_id = $1`,
      [runId],
    );
    await client.query(`DELETE FROM "ql3"."run_events" WHERE run_id = $1`, [
      runId,
    ]);
    await client.query(`DELETE FROM "ql3"."step_runs" WHERE run_id = $1`, [
      runId,
    ]);
    await client.query(`DELETE FROM "ql3"."runs" WHERE id = $1`, [runId]);
  }

  async function insertFixture(
    client,
    ready,
    runVersion = 1,
    projectId = 'project-ai',
  ) {
    await client.query(
      `INSERT INTO "ql3"."runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version,
         event_sequence, priority, created_at_ms
       ) VALUES (
         $1, $4, 'task-ai', 'task-revision-ai', 'manual',
         'manual', 'runtime', 'running', $2, 1, 0, $3
       )`,
      [ready.runId, runVersion, NOW - 1, projectId],
    );
    await client.query(
      `INSERT INTO "ql3"."step_runs" (
         id, run_id, parent_step_run_id, step_key, kind, definition_ref,
         definition_digest, required, status, version, attempt_count,
         input_ref, output_ref, approval_request_id, ready_at_ms,
         started_at_ms, finished_at_ms, result_code, error_summary,
         created_at_ms, updated_at_ms, last_mutation_id, step_run_digest,
         step_run_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb
       )`,
      [
        ready.id,
        ready.runId,
        ready.parentStepRunId,
        ready.stepKey,
        ready.kind,
        ready.definitionRef,
        ready.definitionDigest,
        ready.required,
        ready.status,
        ready.version,
        ready.attemptCount,
        ready.inputRef,
        ready.outputRef,
        ready.approvalRequestId,
        ready.readyAtMs,
        ready.startedAtMs,
        ready.finishedAtMs,
        ready.resultCode,
        ready.errorSummary,
        ready.createdAtMs,
        ready.updatedAtMs,
        ready.lastMutationId,
        ready.stepRunDigest,
        JSON.stringify(ready),
      ],
    );
  }

  test('PostgreSQL migration and repository preserve atomic model invocation facts', async () => {
    const migrationPool = pool(
      migrationConnectionString,
      'ql3-ai-model-invocation-migration-test',
    );
    const runtimePool = pool(
      runtimeConnectionString,
      'ql3-ai-model-invocation-runtime-test',
    );
    try {
      await runPostgresMigrations({ pool: migrationPool });
      await migratePostgresModelInvocationFeature(migrationPool);
      await runPostgresMigrations({ pool: migrationPool });
      await migratePostgresModelInvocationFeature(migrationPool);
      assert.equal((await assertPostgresSchemaReady(runtimePool)).ready, true);

      const privileges = await runtimePool.query(
        `SELECT
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_starts', 'SELECT'
           ) AS start_select,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_starts', 'INSERT'
           ) AS start_insert,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_starts', 'UPDATE'
           ) AS start_update,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_starts', 'DELETE'
           ) AS start_delete,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_completions', 'SELECT'
           ) AS completion_select,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_completions', 'INSERT'
           ) AS completion_insert,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_resolutions', 'SELECT'
           ) AS resolution_select,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_resolutions', 'INSERT'
           ) AS resolution_insert,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_resolutions', 'UPDATE'
           ) AS resolution_update,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_resolutions', 'DELETE'
           ) AS resolution_delete,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_usage_ledger', 'SELECT'
           ) AS usage_select,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_usage_ledger', 'INSERT'
           ) AS usage_insert,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_usage_ledger', 'UPDATE'
           ) AS usage_update,
           has_table_privilege(
             current_user, 'ql3_ai.model_invocation_usage_ledger', 'DELETE'
           ) AS usage_delete,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_reservations', 'SELECT'
           ) AS quota_reservation_select,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_reservations', 'INSERT'
           ) AS quota_reservation_insert,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_reservations', 'UPDATE'
           ) AS quota_reservation_update,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_reservations', 'DELETE'
           ) AS quota_reservation_delete,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_settlements', 'SELECT'
           ) AS quota_settlement_select,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_settlements', 'INSERT'
           ) AS quota_settlement_insert,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_settlements', 'UPDATE'
           ) AS quota_settlement_update,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_quota_settlements', 'DELETE'
           ) AS quota_settlement_delete,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_quotes', 'SELECT'
           ) AS price_quote_select,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_quotes', 'INSERT'
           ) AS price_quote_insert,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_quotes', 'UPDATE'
           ) AS price_quote_update,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_quotes', 'DELETE'
           ) AS price_quote_delete,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_settlements', 'SELECT'
           ) AS price_settlement_select,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_settlements', 'INSERT'
           ) AS price_settlement_insert,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_settlements', 'UPDATE'
           ) AS price_settlement_update,
           has_table_privilege(
             current_user,
             'ql3_ai.model_invocation_price_settlements', 'DELETE'
           ) AS price_settlement_delete`,
      );
      assert.deepEqual(privileges.rows[0], {
        start_select: true,
        start_insert: true,
        start_update: false,
        start_delete: false,
        completion_select: true,
        completion_insert: true,
        resolution_select: true,
        resolution_insert: true,
        resolution_update: false,
        resolution_delete: false,
        usage_select: true,
        usage_insert: true,
        usage_update: false,
        usage_delete: false,
        quota_reservation_select: true,
        quota_reservation_insert: true,
        quota_reservation_update: false,
        quota_reservation_delete: false,
        quota_settlement_select: true,
        quota_settlement_insert: true,
        quota_settlement_update: false,
        quota_settlement_delete: false,
        price_quote_select: true,
        price_quote_insert: true,
        price_quote_update: false,
        price_quote_delete: false,
        price_settlement_select: true,
        price_settlement_insert: true,
        price_settlement_update: false,
        price_settlement_delete: false,
      });

      await deleteFixture(migrationPool, RUN_ID);
      await deleteFixture(migrationPool, CONFLICT_RUN_ID);
      await deleteFixture(migrationPool, FAULT_RUN_ID);
      await deleteFixture(migrationPool, QUOTA_RUN_A_ID);
      await deleteFixture(migrationPool, QUOTA_RUN_B_ID);
      await deleteFixture(migrationPool, PRICING_RUN_ID);
      const ready = readyStep(RUN_ID, 'model-step-ai', 'create-model-step-ai');
      await insertFixture(migrationPool, ready);
      const start = startCommand(ready);
      const completion = completionCommand(start);
      const repository = new PostgresModelInvocationRepository(runtimePool);

      const authority = await repository.readAuthority({
        projectId: 'project-ai',
        runId: RUN_ID,
        stepRunId: 'model-step-ai',
      });
      assert.equal(authority.stepRun.status, 'ready');
      assert.equal(authority.runVersion, 1);
      assert.equal((await repository.admit(start)).status, 'created');
      assert.equal((await repository.admit(start)).status, 'existing');
      assert.deepEqual(await repository.findStart('request-ai'), start.start);
      const incomplete = await repository.listIncomplete(1);
      assert.deepEqual(
        incomplete.candidates.map((candidate) => candidate.invocationId),
        ['request-ai'],
      );
      assert.equal(incomplete.hasMore, false);
      assert.equal((await repository.complete(completion)).status, 'created');
      assert.equal((await repository.complete(completion)).status, 'existing');
      assert.deepEqual(
        await repository.findCompletion('request-ai'),
        completion.completion,
      );
      const usage = await repository.findUsage('request-ai');
      assert.equal(
        usage.completionDigest,
        completion.completion.completionDigest,
      );
      assert.equal(usage.totalTokens, 7);
      assert.deepEqual(
        await repository.summarizeProjectUsage({
          projectId: 'project-ai',
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

      const facts = await migrationPool.query(
        `SELECT
           (SELECT status FROM "ql3"."step_runs"
            WHERE id = 'model-step-ai') AS step_status,
           (SELECT version FROM "ql3"."step_runs"
            WHERE id = 'model-step-ai') AS step_version,
           (SELECT version FROM "ql3"."runs" WHERE id = $1) AS run_version,
           (SELECT event_sequence FROM "ql3"."runs" WHERE id = $1)
             AS event_sequence,
           (SELECT count(*) FROM "ql3"."run_events" WHERE run_id = $1)
             AS events,
           (SELECT count(*) FROM "ql3"."step_run_mutations"
            WHERE run_id = $1) AS mutations,
           (SELECT count(*) FROM "ql3_ai"."model_invocation_starts"
            WHERE run_id = $1) AS starts,
           (SELECT count(*) FROM "ql3_ai"."model_invocation_completions"
            WHERE run_id = $1) AS completions,
           (SELECT count(*) FROM "ql3_ai"."model_invocation_usage_ledger"
            WHERE run_id = $1) AS usage`,
        [RUN_ID],
      );
      assert.deepEqual(facts.rows[0], {
        step_status: 'succeeded',
        step_version: 3,
        run_version: 3,
        event_sequence: 3,
        events: '2',
        mutations: '2',
        starts: '1',
        completions: '1',
        usage: '1',
      });

      const quotaReadyA = readyStep(
        QUOTA_RUN_A_ID,
        'model-step-quota-a',
        'create-model-step-quota-a',
      );
      const quotaReadyB = readyStep(
        QUOTA_RUN_B_ID,
        'model-step-quota-b',
        'create-model-step-quota-b',
      );
      await insertFixture(migrationPool, quotaReadyA);
      await insertFixture(migrationPool, quotaReadyB);
      const quotaStartA = startCommand(
        quotaReadyA,
        audit('admitted', {
          runId: QUOTA_RUN_A_ID,
          stepRunId: 'model-step-quota-a',
          traceId: 'trace-quota-a',
          requestId: 'request-quota-a',
        }),
      );
      const quotaStartB = startCommand(
        quotaReadyB,
        audit('admitted', {
          runId: QUOTA_RUN_B_ID,
          stepRunId: 'model-step-quota-b',
          traceId: 'trace-quota-b',
          requestId: 'request-quota-b',
        }),
      );
      const quotaPolicy = {
        revision: 'quota-concurrency-1',
        windowMs: 3_600_000,
        maxInvocations: 1,
        maxTokens: 512,
        maxCostMicros: null,
      };
      const quotaAdmissions = [quotaStartA, quotaStartB].map((command) =>
        createModelInvocationQuotaAdmission({
          invocationId: command.start.invocationId,
          projectId: command.start.projectId,
          modelPolicyRevision: command.start.policyRevision,
          reservedTokens: 256,
          reservedCostMicros: null,
          quota: quotaPolicy,
        }),
      );
      const quotaResults = await Promise.allSettled([
        repository.admitWithQuota(quotaStartA, quotaAdmissions[0]),
        repository.admitWithQuota(quotaStartB, quotaAdmissions[1]),
      ]);
      assert.equal(
        quotaResults.filter((result) => result.status === 'fulfilled').length,
        1,
        JSON.stringify(
          quotaResults.map((result) =>
            result.status === 'fulfilled'
              ? { status: result.status }
              : {
                  status: result.status,
                  name: result.reason?.name,
                  code: result.reason?.code,
                  message: result.reason?.message,
                  cause: result.reason?.cause?.message,
                },
          ),
        ),
      );
      const quotaRejection = quotaResults.find(
        (result) => result.status === 'rejected',
      );
      assert.ok(
        quotaRejection.reason instanceof
          ModelInvocationProjectQuotaExceededError,
      );
      const winnerIndex = quotaResults.findIndex(
        (result) => result.status === 'fulfilled',
      );
      const winningStart = [quotaStartA, quotaStartB][winnerIndex];
      const losingStart = [quotaStartA, quotaStartB][1 - winnerIndex];
      assert.equal(
        await repository.findStart(losingStart.start.invocationId),
        null,
      );
      const winningReservation = await repository.findQuotaReservation(
        winningStart.start.invocationId,
      );
      assert.equal(winningReservation.reservedTokens, 256);
      assert.equal(
        (await repository.completeWithQuota(completionCommand(winningStart)))
          .status,
        'created',
      );
      const winningSettlement = await repository.findQuotaSettlement(
        winningStart.start.invocationId,
      );
      assert.equal(winningSettlement.effectiveTokens, 7);
      assert.equal(winningSettlement.retainedTokenReservation, false);
      assert.deepEqual(
        await repository.readQuotaWindowUsage(
          'project-ai',
          winningReservation.reservedAtMs,
        ),
        {
          projectId: 'project-ai',
          windowStartMs: winningReservation.windowStartMs,
          windowEndMs: winningReservation.windowEndMs,
          invocationCount: 1,
          effectiveTokens: 7,
          effectiveCostMicros: 0,
          unknownCostInvocations: 1,
        },
      );

      const pricingReady = readyStep(
        PRICING_RUN_ID,
        'model-step-pricing',
        'create-model-step-pricing',
      );
      await insertFixture(migrationPool, pricingReady, 1, 'project-pricing');
      const pricing = new StaticModelPriceCatalog([
        createModelPriceCatalogEntry({
          provider: 'remote',
          model: 'model-ai',
          priceRevision: 'price-1',
          currency: 'USD',
          inputMicrosPerMillionTokens: 150_000,
          outputMicrosPerMillionTokens: 600_000,
          publishedAtMs: NOW - 1,
        }),
      ]);
      const pricedGateway = new BoundedModelGateway({
        providers: [
          {
            type: 'remote',
            async listModels() {
              return [{ id: 'model-ai' }];
            },
            async generate() {
              return {
                provider: 'remote',
                model: 'model-ai',
                text: 'priced summary',
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
              revision: 'policy-priced-1',
              allowedProviders: ['remote'],
              allowedModels: ['model-ai'],
              maxInputBytes: 4096,
              maxOutputBytes: 4096,
              maxOutputTokens: 64,
              maxTotalTokens: 256,
              maxCostMicros: 100,
              priceRevision: 'price-1',
              projectQuota: {
                revision: 'quota-priced-1',
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
      const pricedResult = await pricedGateway.generate(
        {
          provider: 'remote',
          model: 'model-ai',
          messages: [{ role: 'user', content: 'priced prompt' }],
          maxOutputTokens: 64,
        },
        {
          projectId: 'project-pricing',
          runId: PRICING_RUN_ID,
          stepRunId: 'model-step-pricing',
          traceId: 'trace-pricing',
          requestId: 'request-pricing',
          deadlineAtMs: NOW + 10_000,
        },
      );
      const priceQuote = await repository.findPriceQuote('request-pricing');
      const priceSettlement = await repository.findPriceSettlement(
        'request-pricing',
      );
      const pricedReservation = await repository.findQuotaReservation(
        'request-pricing',
      );
      const pricedQuotaSettlement = await repository.findQuotaSettlement(
        'request-pricing',
      );
      assert.equal(pricedResult.usage.costMicros, 3);
      assert.equal(priceQuote.reservedCostMicros, 68);
      assert.equal(priceSettlement.costMicros, 3);
      assert.equal(
        (await repository.findUsage('request-pricing')).costMicros,
        3,
      );
      assert.equal(pricedReservation.reservedCostMicros, 68);
      assert.equal(pricedQuotaSettlement.effectiveCostMicros, 3);

      const conflictReady = readyStep(
        CONFLICT_RUN_ID,
        'model-step-conflict',
        'create-model-step-conflict',
      );
      await insertFixture(migrationPool, conflictReady, 2);
      const conflictStart = startCommand(
        conflictReady,
        audit('admitted', {
          runId: CONFLICT_RUN_ID,
          stepRunId: 'model-step-conflict',
          traceId: 'trace-conflict',
          requestId: 'request-conflict',
        }),
      );
      await assert.rejects(
        repository.admit(conflictStart),
        ModelInvocationConflictError,
      );
      const rolledBack = await migrationPool.query(
        `SELECT
           (SELECT count(*) FROM "ql3_ai"."model_invocation_starts"
            WHERE run_id = $1) AS starts,
           (SELECT count(*) FROM "ql3"."run_events"
            WHERE run_id = $1) AS events,
           (SELECT count(*) FROM "ql3"."step_run_mutations"
            WHERE run_id = $1) AS mutations`,
        [CONFLICT_RUN_ID],
      );
      assert.deepEqual(rolledBack.rows[0], {
        starts: '0',
        events: '0',
        mutations: '0',
      });

      const faultReady = readyStep(
        FAULT_RUN_ID,
        'model-step-fault',
        'create-model-step-fault',
      );
      await insertFixture(migrationPool, faultReady);
      const faultPool = commitResponseLossPool(runtimePool);
      const faultRepository = new PostgresModelInvocationRepository(faultPool);
      const faultCoordinator = new DurableModelInvocationCoordinator(
        faultRepository,
      );
      let providerCalls = 0;
      const gateway = new BoundedModelGateway({
        providers: [
          {
            type: 'remote',
            async listModels() {
              return [{ id: 'model-ai' }];
            },
            async generate() {
              providerCalls += 1;
              throw new Error('provider must not run after ambiguous commit');
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
              allowedModels: ['model-ai'],
              maxInputBytes: 4096,
              maxOutputBytes: 4096,
              maxOutputTokens: 64,
              maxTotalTokens: 256,
              maxCostMicros: null,
              priceRevision: null,
            };
          },
        },
        audit: faultCoordinator,
        maxConcurrent: 1,
        now: () => NOW,
      });
      await assert.rejects(
        gateway.generate(
          {
            provider: 'remote',
            model: 'model-ai',
            messages: [{ role: 'user', content: 'must not persist' }],
            maxOutputTokens: 64,
          },
          {
            projectId: 'project-ai',
            runId: FAULT_RUN_ID,
            stepRunId: 'model-step-fault',
            traceId: 'trace-fault',
            requestId: 'request-fault',
            deadlineAtMs: NOW + 10_000,
          },
        ),
        ModelInvocationReplayBlockedError,
      );
      assert.equal(faultPool.wasInjected(), true);
      assert.equal(providerCalls, 0);
      const committedStart = await repository.findStart('request-fault');
      assert.equal(committedStart.invocationId, 'request-fault');
      assert.equal(
        JSON.stringify(committedStart).includes('must not persist'),
        false,
      );

      const recovery = await new DurableModelInvocationRecovery(
        repository,
      ).recover(8);
      assert.deepEqual(
        {
          recovered: recovery.recovered,
          failed: recovery.failed,
          hasMore: recovery.hasMore,
        },
        { recovered: 1, failed: 0, hasMore: false },
      );
      const recoveredCompletion = await repository.findCompletion(
        'request-fault',
      );
      assert.equal(recoveredCompletion.outcome, 'outcome_unknown');
      assert.equal(await repository.findUsage('request-fault'), null);
      const recoveredStep = await migrationPool.query(
        `SELECT status FROM "ql3"."step_runs" WHERE id = 'model-step-fault'`,
      );
      assert.equal(recoveredStep.rows[0].status, 'lost');

      const resolution = await new DurableModelInvocationResolutionCoordinator(
        repository,
      ).resolve({
        invocationId: 'request-fault',
        decision: 'retry',
        resolvedByUserId: 'user-ai',
        resolvedAtMs: recoveredCompletion.completedAtMs + 1,
      });
      assert.equal(resolution.status, 'created');
      const retryAtMs = recoveredCompletion.completedAtMs + 2;
      assert.deepEqual(
        await new DurableModelInvocationCoordinator(repository).record(
          audit('admitted', {
            runId: FAULT_RUN_ID,
            stepRunId: 'model-step-fault',
            traceId: 'trace-fault-retry',
            requestId: 'request-fault-retry',
            occurredAtMs: retryAtMs,
            deadlineAtMs: retryAtMs + 10_000,
          }),
        ),
        { status: 'created' },
      );
      const retried = await migrationPool.query(
        `SELECT
           (SELECT status FROM "ql3"."step_runs"
            WHERE id = 'model-step-fault') AS step_status,
           (SELECT attempt_count FROM "ql3"."step_runs"
            WHERE id = 'model-step-fault') AS attempt_count,
           (SELECT count(*) FROM "ql3_ai"."model_invocation_starts"
            WHERE run_id = $1) AS starts,
           (SELECT count(*) FROM "ql3_ai"."model_invocation_completions"
            WHERE run_id = $1) AS completions,
           (SELECT count(*) FROM "ql3_ai"."model_invocation_resolutions"
            WHERE run_id = $1) AS resolutions`,
        [FAULT_RUN_ID],
      );
      assert.deepEqual(retried.rows[0], {
        step_status: 'running',
        attempt_count: 2,
        starts: '2',
        completions: '1',
        resolutions: '1',
      });
    } finally {
      await runtimePool.end();
      await migrationPool.end();
    }
  });
}
