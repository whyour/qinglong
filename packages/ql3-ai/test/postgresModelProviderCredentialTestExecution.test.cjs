const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');

const {
  createModelProviderCredentialTestAllowlist,
  createModelProviderCredentialTestPlan,
  createModelProviderCredentialTestResult,
} = require('../dist/model-provider-credential/modelProviderCredentialTestConnection.js');
const {
  POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
  postgresModelInvocationMigrationDefinition,
} = require('@qinglong/ai/model-invocation-migration');
const {
  ModelProviderCredentialTestExecutionRejectedError,
  ModelProviderCredentialTestExecutionUnavailableError,
  PostgresModelProviderCredentialTestExecutionRepository,
  PostgresModelProviderCredentialTesterNotReadyError,
  assertPostgresModelProviderCredentialTesterReady,
} = require('../dist/model-provider-credential/postgresModelProviderCredentialTestConnection.js');

function contractFixture({ observedAtMs = 200 } = {}) {
  const allowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v1',
    providers: [
      {
        provider: 'openai-compatible',
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.example.test/v1/',
        revision: 'endpoint-v1',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels: 64,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  const plan = createModelProviderCredentialTestPlan({
    testId: randomUUID(),
    requestId: `request-${randomUUID()}`,
    projectId: 'project-a',
    provider: 'openai-compatible',
    endpoint: allowlist.providers[0],
    requestedBy: { type: 'user', id: 'owner-a' },
    fence: { projectVersion: 1, bindingVersion: 1 },
    plannedAtMs: 100,
    expiresAtMs: 60_100,
  });
  const state = {
    executions: new Map(),
    results: new Map(),
    executionInserts: 0,
    resultInserts: 0,
  };
  let snapshot;
  let loseCommit = false;
  const client = {
    async query(text, values = []) {
      if (text.startsWith('BEGIN')) {
        snapshot = structuredClone(state);
        return { rows: [] };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (
        text.startsWith('WITH database_clock AS (') &&
        text.includes('model_provider_credential_test_plans')
      ) {
        return values[0] === plan.testId
          ? { rows: [{ planJson: plan, observedAtMs }] }
          : { rows: [] };
      }
      if (
        text.startsWith('SELECT execution.execution_json') &&
        text.includes('model_provider_credential_test_executions')
      ) {
        const execution = state.executions.get(values[0]);
        if (!execution) return { rows: [] };
        return {
          rows: [
            {
              executionJson: execution,
              resultJson: state.results.get(execution.executionId) ?? null,
            },
          ],
        };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3_ai"."model_provider_credential_test_executions"',
        )
      ) {
        const execution = JSON.parse(values[5]);
        state.executions.set(execution.testId, execution);
        state.executionInserts += 1;
        return { rows: [] };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3_ai"."model_provider_credential_test_results"',
        )
      ) {
        const result = JSON.parse(values[8]);
        state.results.set(result.executionId, result);
        state.resultInserts += 1;
        return { rows: [] };
      }
      if (text === 'COMMIT') {
        snapshot = undefined;
        if (loseCommit) {
          loseCommit = false;
          const error = new Error('lost commit response');
          error.code = 'ECONNRESET';
          throw error;
        }
        return { rows: [] };
      }
      if (text === 'ROLLBACK') {
        if (snapshot) {
          state.executions = snapshot.executions;
          state.results = snapshot.results;
          state.executionInserts = snapshot.executionInserts;
          state.resultInserts = snapshot.resultInserts;
        }
        snapshot = undefined;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  return {
    allowlist,
    plan,
    repository: new PostgresModelProviderCredentialTestExecutionRepository({
      async connect() {
        return client;
      },
    }),
    state: () => state,
    loseNextCommitResponse() {
      loseCommit = true;
    },
  };
}

test('commits an immutable execution intent before provider I/O is allowed', async () => {
  const value = contractFixture();
  const input = {
    executionId: randomUUID(),
    testId: value.plan.testId,
    allowlist: value.allowlist,
  };
  const created = await value.repository.beginExecution(input);
  assert.equal(created.status, 'created');
  assert.equal(created.result, null);
  assert.equal(value.state().executionInserts, 1);

  const replay = await value.repository.beginExecution(input);
  assert.equal(replay.status, 'existing');
  assert.equal(replay.result, null);
  assert.equal(value.state().executionInserts, 1);
});

test('returns existing after a begin COMMIT response loss so callers cannot reexecute', async () => {
  const value = contractFixture();
  const input = {
    executionId: randomUUID(),
    testId: value.plan.testId,
    allowlist: value.allowlist,
  };
  value.loseNextCommitResponse();
  await assert.rejects(
    value.repository.beginExecution(input),
    ModelProviderCredentialTestExecutionUnavailableError,
  );
  const recovery = await value.repository.beginExecution(input);
  assert.equal(recovery.status, 'existing');
  assert.equal(recovery.result, null);
  assert.equal(value.state().executionInserts, 1);
});

test('rejects expired plans and exact allowlist drift before inserting intent', async () => {
  const expired = contractFixture({ observedAtMs: 60_100 });
  await assert.rejects(
    expired.repository.beginExecution({
      executionId: randomUUID(),
      testId: expired.plan.testId,
      allowlist: expired.allowlist,
    }),
    ModelProviderCredentialTestExecutionRejectedError,
  );
  assert.equal(expired.state().executionInserts, 0);

  const drifted = contractFixture();
  const changedAllowlist = createModelProviderCredentialTestAllowlist({
    revision: 'catalog-v2',
    providers: [
      {
        provider: 'openai-compatible',
        adapter: 'openai-compatible',
        baseUrl: 'https://provider.example.test/v2/',
        revision: 'endpoint-v2',
        deadlineMs: 5_000,
        maxResponseBytes: 64 * 1_024,
        maxModels: 64,
        maxCostMicrousd: 0,
        retryLimit: 0,
      },
    ],
  });
  await assert.rejects(
    drifted.repository.beginExecution({
      executionId: randomUUID(),
      testId: drifted.plan.testId,
      allowlist: changedAllowlist,
    }),
    ModelProviderCredentialTestExecutionRejectedError,
  );
  assert.equal(drifted.state().executionInserts, 0);
});

test('recovers a result COMMIT response loss by exact durable replay', async () => {
  const value = contractFixture();
  const executionId = randomUUID();
  const started = await value.repository.beginExecution({
    executionId,
    testId: value.plan.testId,
    allowlist: value.allowlist,
  });
  const result = createModelProviderCredentialTestResult({
    executionId,
    testId: value.plan.testId,
    planDigest: started.plan.planDigest,
    outcome: 'reachable',
    modelCount: 3,
    durationMs: 40,
    completedAtMs: 240,
  });
  value.loseNextCommitResponse();
  await assert.rejects(
    value.repository.complete(result),
    ModelProviderCredentialTestExecutionUnavailableError,
  );
  const recovery = await value.repository.complete(result);
  assert.equal(recovery.status, 'existing');
  assert.deepEqual(recovery.result, result);
  assert.equal(value.state().resultInserts, 1);
});

test('tester readiness freezes migration history and least privilege', async () => {
  const history = postgresModelInvocationMigrationDefinition.migrations.map(
    ({ id, checksum }) => ({
      migrationId: id,
      streamId: POSTGRES_MODEL_INVOCATION_MIGRATION_STREAM_ID,
      dialect: 'postgresql',
      checksum,
    }),
  );
  const ready = await assertPostgresModelProviderCredentialTesterReady({
    async query(text) {
      if (text.includes('FROM "ql3_ai"."ai_schema_migrations"')) {
        return { rows: history };
      }
      return {
        rows: [
          {
            currentUser: 'ql3_ai_credential_tester',
            writablePrimary: true,
            testerAuthority: true,
            leastPrivilege: true,
          },
        ],
      };
    },
  });
  assert.equal(ready.ready, true);
  assert.equal(
    ready.migrationIds.at(-1),
    'pg-9021-ai-copilot-failure-diagnosis-pre-model-terminalizations',
  );

  await assert.rejects(
    assertPostgresModelProviderCredentialTesterReady({
      async query(text) {
        if (text.includes('FROM "ql3_ai"."ai_schema_migrations"')) {
          return { rows: history };
        }
        return {
          rows: [
            {
              currentUser: 'ql3_ai_credential_tester',
              writablePrimary: true,
              testerAuthority: true,
              leastPrivilege: false,
            },
          ],
        };
      },
    }),
    PostgresModelProviderCredentialTesterNotReadyError,
  );
});
