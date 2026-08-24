const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  ClusterLegacyEnvMigrationPlanConflictError,
  ClusterLegacyEnvMigrationPlanUnavailableError,
} = require('@qinglong/runtime-core/cluster-legacy-env-migration-plan');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PostgresClusterLegacyEnvMigrationPlanRepository,
} = require('@qinglong/cluster-postgres/cluster-legacy-env-migration-plan');

function intent(overrides = {}) {
  const projectId = overrides.projectId ?? 'project-a';
  return {
    planId: 'legacy-env-plan-a',
    mutationId: 'legacy-env-mutation-a',
    projectId,
    source: {
      reconciliationBundleDigest: '1'.repeat(64),
      decisionDigest: '2'.repeat(64),
      candidateSetDigest: '3'.repeat(64),
      sourceRowCount: 3,
      activeRowCount: 2,
      disabledRowCount: 1,
      effectiveBindingCount: 2,
    },
    target: {
      secretRef: createSecretRef({
        projectId,
        name: 'legacy-env-bundle',
        version: 7,
      }),
      taskRevisionSetDigest: '4'.repeat(64),
      triggerRevisionSetDigest: '5'.repeat(64),
      taskCount: 2,
      triggerCount: 3,
      totalEffectiveBytes: 1024,
    },
    ...overrides,
  };
}

function fixture(options = {}) {
  const plansById = new Map();
  const plansByMutation = new Map();
  const queries = [];
  let serializationFailures = options.serializationFailures ?? 0;
  let connections = 0;

  const pool = {
    async query(text, values) {
      queries.push({ scope: 'pool', text, values });
      if (text.includes('WHERE plan_id')) {
        const plan = plansById.get(values[0]);
        return {
          rows: plan ? [{ planJson: plan }] : [],
          rowCount: plan ? 1 : 0,
        };
      }
      throw new Error('unexpected pool query');
    },
    async connect() {
      connections += 1;
      return {
        async query(text, values) {
          queries.push({ scope: 'client', text, values });
          if (
            text === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
            text === 'COMMIT' ||
            text === 'ROLLBACK' ||
            text.includes("set_config('")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('WHERE mutation_id')) {
            if (serializationFailures > 0) {
              serializationFailures -= 1;
              throw Object.assign(new Error('serialization retry'), {
                code: '40001',
              });
            }
            const plan = plansByMutation.get(values[0]);
            return {
              rows: plan ? [{ planJson: plan }] : [],
              rowCount: plan ? 1 : 0,
            };
          }
          if (text.includes('FROM "ql3"."projects"')) {
            return options.projectStatus === 'archived'
              ? { rows: [{ status: 'archived' }], rowCount: 1 }
              : { rows: [{ status: 'active' }], rowCount: 1 };
          }
          if (text.includes('WHERE plan_id')) {
            const plan = plansById.get(values[0]);
            return {
              rows: plan ? [{ planJson: plan }] : [],
              rowCount: plan ? 1 : 0,
            };
          }
          if (text.includes('transaction_timestamp')) {
            return { rows: [{ plannedAtMs: '12345' }], rowCount: 1 };
          }
          if (text.includes('INSERT INTO')) {
            const plan = JSON.parse(values[18]);
            plansById.set(plan.planId, plan);
            plansByMutation.set(plan.mutationId, plan);
            return { rows: [], rowCount: 1 };
          }
          if (text === 'SELECT hook_boundary') {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`unexpected client query: ${text}`);
        },
        release() {
          queries.push({ scope: 'client', text: 'RELEASE' });
        },
      };
    },
  };
  return {
    repository: new PostgresClusterLegacyEnvMigrationPlanRepository(pool),
    plansById,
    plansByMutation,
    queries,
    connectionCount: () => connections,
  };
}

test('publishes and exactly replays one content-free plan in serializable transactions', async () => {
  const state = fixture();
  const hookContexts = [];
  const hook = async (client, context) => {
    hookContexts.push(context);
    await client.query('SELECT hook_boundary');
  };
  const created = await state.repository.publish(intent(), hook);
  const replay = await state.repository.publish(intent(), hook);

  assert.equal(created.status, 'created');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.plan, created.plan);
  assert.equal(state.plansById.size, 1);
  assert.equal(hookContexts[0].replay, null);
  assert.deepEqual(hookContexts[1].replay, created.plan);
  assert.equal(
    state.queries.filter(
      ({ text }) => text === 'BEGIN ISOLATION LEVEL SERIALIZABLE',
    ).length,
    2,
  );
  assert.equal(state.queries.filter(({ text }) => text === 'COMMIT').length, 2);

  const insert = state.queries.find(({ text }) => text.includes('INSERT INTO'));
  const encodedPlan = insert.values[18];
  assert.doesNotMatch(encodedPlan, /TOKEN|secretValue|ciphertext|keyId/i);
  assert.equal(
    JSON.parse(encodedPlan).target.secretRef,
    intent().target.secretRef,
  );
});

test('rejects mutation replay drift and inactive Projects without writing', async () => {
  const replayState = fixture();
  await replayState.repository.publish(intent());
  await assert.rejects(
    replayState.repository.publish(
      intent({
        target: { ...intent().target, taskCount: 3 },
      }),
    ),
    ClusterLegacyEnvMigrationPlanConflictError,
  );
  assert.equal(
    replayState.queries.filter(({ text }) => text.includes('INSERT INTO'))
      .length,
    1,
  );
  assert.equal(
    replayState.queries.some(({ text }) => text === 'ROLLBACK'),
    true,
  );

  const archivedState = fixture({ projectStatus: 'archived' });
  await assert.rejects(
    archivedState.repository.publish(intent()),
    ClusterLegacyEnvMigrationPlanConflictError,
  );
  assert.equal(
    archivedState.queries.some(({ text }) => text.includes('INSERT INTO')),
    false,
  );
});

test('retries bounded serializable failures and preserves the transaction hook error', async () => {
  const state = fixture({ serializationFailures: 1 });
  const created = await state.repository.publish(intent());
  assert.equal(created.status, 'created');
  assert.equal(state.connectionCount(), 2);
  assert.equal(
    state.queries.filter(({ text }) => text === 'ROLLBACK').length,
    1,
  );

  const hookError = new Error('caller hook failed');
  await assert.rejects(
    fixture().repository.publish(intent(), async () => {
      throw hookError;
    }),
    (error) => error === hookError,
  );
});

test('fails closed on malformed durable JSON and hides raw storage errors', async () => {
  const malformedPool = {
    async query() {
      return { rows: [{ planJson: { schema: 'wrong' } }], rowCount: 1 };
    },
    async connect() {
      throw new Error('unused');
    },
  };
  await assert.rejects(
    new PostgresClusterLegacyEnvMigrationPlanRepository(
      malformedPool,
    ).findByPlanId('legacy-env-plan-a'),
    ClusterLegacyEnvMigrationPlanUnavailableError,
  );

  const identityDrift = fixture();
  const created = await identityDrift.repository.publish(intent());
  identityDrift.plansById.set('legacy-env-plan-b', created.plan);
  await assert.rejects(
    identityDrift.repository.findByPlanId('legacy-env-plan-b'),
    ClusterLegacyEnvMigrationPlanUnavailableError,
  );
  identityDrift.plansByMutation.set('legacy-env-mutation-b', created.plan);
  await assert.rejects(
    identityDrift.repository.publish(
      intent({
        planId: 'legacy-env-plan-b',
        mutationId: 'legacy-env-mutation-b',
      }),
    ),
    ClusterLegacyEnvMigrationPlanUnavailableError,
  );

  const failedPool = {
    async query() {
      throw new Error('password=do-not-leak');
    },
    async connect() {
      throw new Error('unused');
    },
  };
  await assert.rejects(
    new PostgresClusterLegacyEnvMigrationPlanRepository(
      failedPool,
    ).findByPlanId('legacy-env-plan-a'),
    (error) => {
      assert.ok(error instanceof ClusterLegacyEnvMigrationPlanUnavailableError);
      assert.doesNotMatch(error.message, /password|do-not-leak/i);
      return true;
    },
  );
});

test('keeps the append authority behind its explicit package subpath', () => {
  const root = require('@qinglong/cluster-postgres');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  const admin = require('@qinglong/cluster-postgres/admin');
  const authority = require('@qinglong/cluster-postgres/cluster-legacy-env-migration-plan');
  assert.equal(root.PostgresClusterLegacyEnvMigrationPlanRepository, undefined);
  assert.equal(
    runtime.PostgresClusterLegacyEnvMigrationPlanRepository,
    undefined,
  );
  assert.equal(
    admin.PostgresClusterLegacyEnvMigrationPlanRepository,
    undefined,
  );
  assert.equal(
    typeof authority.PostgresClusterLegacyEnvMigrationPlanRepository,
    'function',
  );
});
