require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  taskExecutionRevisionMigration,
} = require('../../back/migrations/0012-task-execution-revisions');
const {
  LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
  localExecutionContextRecipeMigration,
} = require('../../back/migrations/0013-local-execution-context-recipes');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeLocalExecutionContextRecipeRepository,
  LocalExecutionContextRecipeCorruptError,
} = require('../../back/runtime/adapters/legacy-sequelize/localExecutionContextRecipeRepository');
const {
  LegacySequelizeTaskExecutionRevisionRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/taskExecutionRevisionRepository');
const {
  LocalTaskExecutionRevisionPublisher,
} = require('../../back/runtime/application/localTaskExecutionRevisionPublisher');
const {
  RecipeLocalExecutionContextMaterializer,
} = require('../../back/runtime/application/recipeLocalExecutionContextMaterializer');
const {
  createLocalExecutionContextRecipe,
  localExecutionContextRecipeDigest,
} = require('../../back/runtime/domain/localExecutionContextRecipe');

function contextRecipe() {
  return createLocalExecutionContextRecipe([
    { name: 'MODE', kind: 'public', value: 'edge' },
    { name: 'TOKEN', kind: 'secret', secretRef: 'secret://token' },
  ]);
}

function revision(recipe = contextRecipe()) {
  return {
    projectId: 'default',
    taskId: 'task-recipe',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    execution: {
      command: { kind: 'argv', file: '/bin/true', args: [] },
      environmentPolicy: 'isolated',
      terminationGraceMs: 100,
    },
    contextRef: recipe.contextRef,
  };
}

function candidate() {
  return {
    runId: 'run-recipe',
    attemptId: 'attempt-recipe',
    projectId: 'default',
    taskId: 'task-recipe',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1_760_000_000_000,
    attemptCreatedAtMs: 1_760_000_000_000,
  };
}

async function createRepositories(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      taskExecutionRevisionMigration,
      localExecutionContextRecipeMigration,
    ],
    logger: { info() {} },
  });
  return {
    database,
    recipes: new LegacySequelizeLocalExecutionContextRecipeRepository(database),
    revisions: new LegacySequelizeTaskExecutionRevisionRepository(database),
  };
}

test('uses stable content-address and digest vectors without persisting Secret values', () => {
  const recipe = contextRecipe();
  assert.equal(
    recipe.contextRef,
    'localctx:sha256:d70176732d42e2701d95adce0371b765226a3d5085e17d14816615c933fc5c7f',
  );
  assert.equal(
    localExecutionContextRecipeDigest(recipe),
    'a1acbef2b7b882a0e6f204bd79f303a10fa6043753251ebb222adb31d42b2597',
  );
  assert.equal(
    createLocalExecutionContextRecipe([...recipe.environment].reverse())
      .contextRef,
    recipe.contextRef,
  );
  assert.equal(JSON.stringify(recipe).includes('in-memory-secret'), false);
});

test('concurrent immutable recipe publication converges and resolves exactly', async (t) => {
  const { recipes } = await createRepositories(t);
  const recipe = contextRecipe();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      recipes.insert(recipe, 100 + index),
    ),
  );
  assert.equal(results.filter((result) => result === 'inserted').length, 1);
  assert.equal(results.filter((result) => result === 'idempotent').length, 11);

  const stored = await recipes.resolve(recipe.contextRef);
  assert.deepEqual(stored.environment, recipe.environment);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.environment));
  assert.equal(await recipes.resolve(`${recipe.contextRef}-missing`), null);
  await assert.rejects(
    recipes.insert({ ...recipe, contextRef: 'localctx:sha256:wrong' }, 200),
    /not content-addressed/,
  );
});

test('fails closed on persisted recipe corruption and cluster dialect use', async (t) => {
  const { database, recipes } = await createRepositories(t);
  const recipe = contextRecipe();
  await recipes.insert(recipe, 100);
  await database
    .getQueryInterface()
    .bulkUpdate(
      LOCAL_EXECUTION_CONTEXT_RECIPE_TABLE,
      { content_digest: '0'.repeat(64) },
      { context_ref: recipe.contextRef },
    );
  await assert.rejects(
    recipes.resolve(recipe.contextRef),
    LocalExecutionContextRecipeCorruptError,
  );
  assert.throws(
    () =>
      new LegacySequelizeLocalExecutionContextRecipeRepository({
        getDialect: () => 'postgres',
      }),
    /PostgreSQL adapter/,
  );
});

test('publishes recipe before revision and materializes it with ephemeral Secrets', async (t) => {
  const { recipes, revisions } = await createRepositories(t);
  const recipe = contextRecipe();
  const publisher = new LocalTaskExecutionRevisionPublisher(recipes, revisions);
  assert.deepEqual(
    await publisher.publish({
      revision: revision(recipe),
      contextRecipe: recipe,
      createdAtMs: 100,
    }),
    { contextRecipe: 'inserted', revision: 'inserted' },
  );
  assert.deepEqual(
    await publisher.publish({
      revision: revision(recipe),
      contextRecipe: recipe,
      createdAtMs: 101,
    }),
    { contextRecipe: 'idempotent', revision: 'idempotent' },
  );
  assert.equal(
    (await revisions.resolve(revision(recipe))).contextRef,
    recipe.contextRef,
  );

  const materializer = new RecipeLocalExecutionContextMaterializer(
    recipes,
    {
      async prepare() {
        return {
          logArtifactId: `local-${'c'.repeat(30)}`,
          output: { async write() {} },
          dispose() {},
        };
      },
    },
    {
      async resolve() {
        return ['in-memory-secret'];
      },
    },
  );
  const context = await materializer.prepare({
    candidate: candidate(),
    contextRef: recipe.contextRef,
  });
  assert.deepEqual(
    { ...context.context.environment },
    {
      MODE: 'edge',
      TOKEN: 'in-memory-secret',
    },
  );
});

test('a missing or failed recipe publication can never create a dangling revision', async () => {
  const calls = [];
  const publisher = new LocalTaskExecutionRevisionPublisher(
    {
      async resolve() {
        return null;
      },
      async insert() {
        calls.push('recipe');
        throw new Error('recipe write failed');
      },
    },
    {
      async resolve() {
        return null;
      },
      async insert() {
        calls.push('revision');
        return 'inserted';
      },
    },
  );
  const recipe = contextRecipe();
  await assert.rejects(
    publisher.publish({
      revision: revision(recipe),
      contextRecipe: recipe,
      createdAtMs: 100,
    }),
    /recipe write failed/,
  );
  assert.deepEqual(calls, ['recipe']);
  await assert.rejects(
    publisher.publish({
      revision: { ...revision(recipe), contextRef: 'localctx:sha256:other' },
      contextRecipe: recipe,
      createdAtMs: 100,
    }),
    /does not match/,
  );
  assert.deepEqual(calls, ['recipe']);
});
