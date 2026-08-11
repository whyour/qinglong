const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
  migrateLocalModelInvocationFeature,
} = require('@qinglong/ai/model-invocation-migration');
const {
  LocalModelInvocationFeatureActivationRepository,
  LocalModelInvocationFeatureTransitionConflictError,
  LocalModelInvocationFeatureTransitionUnavailableError,
  assertLocalModelInvocationFeatureActive,
  createLocalModelInvocationFeatureTransitionCommand,
} = require('@qinglong/ai/local-feature-activation');

function createMainSqliteContract(client) {
  client.exec(`
    CREATE TABLE "QingLong3SchemaMigrations" (
      migration_id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      dialect TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE "Runs" (id TEXT PRIMARY KEY);
    CREATE TABLE "RunEvents" (id TEXT PRIMARY KEY);
    CREATE TABLE "StepRuns" (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      UNIQUE (run_id, id)
    );
    CREATE TABLE "StepRunMutations" (mutation_id TEXT PRIMARY KEY);
  `);
}

function principal(authenticationId = 'local_ai_feature:proof-1') {
  return {
    subject: { type: 'user', id: 'owner-user' },
    authenticationId,
    authenticatedAtMs: 1_000,
    expiresAtMs: 301_000,
    assurance: 'local_console',
  };
}

function transition(overrides = {}) {
  return createLocalModelInvocationFeatureTransitionCommand({
    featureId: 'model-invocation',
    expectedGeneration: 0,
    expectedState: null,
    state: 'active',
    mutationId: 'feature-activation-1',
    requestId: 'feature-request-1',
    expectedMigrationDigest: LOCAL_MODEL_INVOCATION_MIGRATION_PLAN_DIGEST,
    safety: {
      mode: 'fresh_database',
      backupEvidenceDigest: null,
    },
    principal: principal(),
    ...overrides,
  });
}

async function fixture() {
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  createMainSqliteContract(client);
  await migrateLocalModelInvocationFeature(client);
  return client;
}

test('local AI feature activation is append-only, replay-safe and non-destructive', async () => {
  const client = await fixture();
  const repository = new LocalModelInvocationFeatureActivationRepository(
    client,
  );

  assert.equal(repository.findCurrent(), null);
  assert.throws(
    () => assertLocalModelInvocationFeatureActive(client),
    LocalModelInvocationFeatureTransitionUnavailableError,
  );

  const activated = repository.transition(transition());
  assert.equal(activated.status, 'created');
  assert.equal(activated.transition.generation, 1);
  assert.equal(activated.transition.state, 'active');
  assert.equal(
    assertLocalModelInvocationFeatureActive(client).transitionDigest,
    activated.transition.transitionDigest,
  );

  const replayed = repository.transition(transition());
  assert.equal(replayed.status, 'existing');
  assert.deepEqual(replayed.transition, activated.transition);

  const deactivated = repository.transition(
    transition({
      expectedGeneration: 1,
      expectedState: 'active',
      state: 'inactive',
      mutationId: 'feature-deactivation-1',
      requestId: 'feature-request-2',
      safety: {
        mode: 'preserve_existing',
        backupEvidenceDigest: null,
      },
    }),
  );
  assert.equal(deactivated.status, 'created');
  assert.equal(deactivated.transition.generation, 2);
  assert.equal(deactivated.transition.state, 'inactive');
  assert.throws(
    () => assertLocalModelInvocationFeatureActive(client),
    LocalModelInvocationFeatureTransitionUnavailableError,
  );

  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
             (SELECT count(*) FROM "ModelInvocationFeatureTransitions") AS transitions,
             (SELECT count(*) FROM "ModelInvocationFeatureHead") AS heads,
             (SELECT count(*) FROM "ModelInvocationStarts") AS starts,
             (SELECT count(*) FROM "ModelPriceCatalogPublications") AS publications`,
        )
        .get(),
    },
    { transitions: 2, heads: 1, starts: 0, publications: 0 },
  );
  client.close();
});

test('local AI feature activation rejects CAS, plan and identity drift', async () => {
  const client = await fixture();
  const repository = new LocalModelInvocationFeatureActivationRepository(
    client,
  );
  repository.transition(transition());

  assert.throws(
    () =>
      repository.transition(
        transition({
          mutationId: 'feature-activation-conflict',
          requestId: 'feature-request-conflict',
        }),
      ),
    LocalModelInvocationFeatureTransitionConflictError,
  );
  assert.throws(
    () =>
      repository.transition(
        transition({
          expectedGeneration: 1,
          expectedState: 'active',
          state: 'inactive',
          mutationId: 'feature-deactivation-plan-drift',
          requestId: 'feature-request-plan-drift',
          expectedMigrationDigest: 'f'.repeat(64),
          safety: {
            mode: 'preserve_existing',
            backupEvidenceDigest: null,
          },
        }),
      ),
    LocalModelInvocationFeatureTransitionConflictError,
  );
  assert.throws(
    () =>
      repository.transition(
        transition({
          principal: principal('local_ai_feature:different-proof'),
        }),
      ),
    LocalModelInvocationFeatureTransitionConflictError,
  );
  client.close();
});

test('local AI feature transaction fence runs before replay and rolls back', async () => {
  const client = await fixture();
  let fences = 0;
  const first = new LocalModelInvocationFeatureActivationRepository(client, {
    beforeMutation() {
      fences += 1;
    },
  });
  first.transition(transition());
  first.transition(transition());
  assert.equal(fences, 2);

  const rejected = new LocalModelInvocationFeatureActivationRepository(client, {
    beforeMutation() {
      throw new Error('fence rejected');
    },
  });
  assert.throws(
    () =>
      rejected.transition(
        transition({
          expectedGeneration: 1,
          expectedState: 'active',
          state: 'inactive',
          mutationId: 'feature-deactivation-rejected',
          requestId: 'feature-request-rejected',
          safety: {
            mode: 'preserve_existing',
            backupEvidenceDigest: null,
          },
        }),
      ),
    LocalModelInvocationFeatureTransitionUnavailableError,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
           FROM "ModelInvocationFeatureTransitions"`,
      )
      .get().count,
    1,
  );
  client.close();
});
