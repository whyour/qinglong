require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RecipeLocalExecutionContextMaterializer,
} = require('../../back/runtime/application/recipeLocalExecutionContextMaterializer');
const {
  normalizeLocalExecutionContextRecipe,
} = require('../../back/runtime/domain/localExecutionContextRecipe');

function candidate() {
  return {
    runId: 'run-context',
    attemptId: 'attempt-context',
    projectId: 'default',
    taskId: 'task-context',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    priority: 0,
    queuedAtMs: 1_760_000_000_000,
    attemptCreatedAtMs: 1_760_000_000_000,
  };
}

function recipe(environment = []) {
  return {
    contextRef: 'context://default/task-context/revision-1',
    environment,
  };
}

test('materializes public and ephemeral Secret values into one bounded context', async () => {
  const secretRequests = [];
  const artifactRequests = [];
  let disposed = 0;
  const output = { async write() {} };
  const materializer = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve(contextRef) {
        assert.equal(contextRef, recipe().contextRef);
        return recipe([
          { name: 'MODE', kind: 'public', value: 'edge' },
          { name: 'TOKEN', kind: 'secret', secretRef: 'secret://token' },
          { name: 'TOKEN_COPY', kind: 'secret', secretRef: 'secret://token' },
        ]);
      },
    },
    {
      async prepare(request) {
        artifactRequests.push(request);
        return {
          logArtifactId: `local-${'a'.repeat(30)}`,
          output,
          async dispose() {
            disposed += 1;
          },
        };
      },
    },
    {
      async resolve(request) {
        secretRequests.push(request);
        assert.ok(Object.isFrozen(request));
        assert.ok(Object.isFrozen(request.candidate));
        assert.ok(Object.isFrozen(request.secretRefs));
        return ['in-memory-secret'];
      },
    },
  );

  const materialized = await materializer.prepare({
    candidate: candidate(),
    contextRef: recipe().contextRef,
  });
  assert.deepEqual(secretRequests[0].secretRefs, ['secret://token']);
  assert.equal(artifactRequests.length, 1);
  assert.equal(materialized.logArtifactId, `local-${'a'.repeat(30)}`);
  assert.equal(materialized.context.output, output);
  assert.equal(Object.getPrototypeOf(materialized.context.environment), null);
  assert.deepEqual(
    { ...materialized.context.environment },
    {
      MODE: 'edge',
      TOKEN: 'in-memory-secret',
      TOKEN_COPY: 'in-memory-secret',
    },
  );
  assert.ok(Object.isFrozen(materialized.context.environment));
  await materialized.dispose();
  assert.equal(disposed, 1);
});

test('returns unavailable before allocating output when recipe or Secrets are missing', async () => {
  let artifactCalls = 0;
  const artifacts = {
    async prepare() {
      artifactCalls += 1;
    },
  };
  const missingRecipe = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve() {
        return null;
      },
    },
    artifacts,
  );
  assert.equal(
    await missingRecipe.prepare({
      candidate: candidate(),
      contextRef: recipe().contextRef,
    }),
    null,
  );

  const missingSecret = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve() {
        return recipe([
          { name: 'TOKEN', kind: 'secret', secretRef: 'secret://missing' },
        ]);
      },
    },
    artifacts,
    {
      async resolve() {
        return null;
      },
    },
  );
  assert.equal(
    await missingSecret.prepare({
      candidate: candidate(),
      contextRef: recipe().contextRef,
    }),
    null,
  );
  assert.equal(artifactCalls, 0);
});

test('fails closed on recipe drift, duplicate names, and invalid Secret results', async () => {
  const artifacts = {
    async prepare() {
      throw new Error('artifact allocation must not run');
    },
  };
  const drift = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve() {
        return { ...recipe(), contextRef: 'context://other' };
      },
    },
    artifacts,
  );
  await assert.rejects(
    drift.prepare({ candidate: candidate(), contextRef: recipe().contextRef }),
    /does not match/,
  );

  assert.throws(
    () =>
      normalizeLocalExecutionContextRecipe(
        recipe([
          { name: 'DUPLICATE', kind: 'public', value: 'a' },
          { name: 'DUPLICATE', kind: 'public', value: 'b' },
        ]),
      ),
    /duplicated/,
  );

  const invalidSecret = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve() {
        return recipe([
          { name: 'TOKEN', kind: 'secret', secretRef: 'secret://token' },
        ]);
      },
    },
    artifacts,
    {
      async resolve() {
        return [];
      },
    },
  );
  await assert.rejects(
    invalidSecret.prepare({
      candidate: candidate(),
      contextRef: recipe().contextRef,
    }),
    /invalid result/,
  );
});

test('disposes an allocated Artifact when its capability is invalid', async () => {
  let disposed = 0;
  const materializer = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve() {
        return recipe();
      },
    },
    {
      async prepare() {
        return {
          logArtifactId: '../escape',
          output: { async write() {} },
          async dispose() {
            await new Promise((resolve) => setImmediate(resolve));
            disposed += 1;
          },
        };
      },
    },
  );
  await assert.rejects(
    materializer.prepare({
      candidate: candidate(),
      contextRef: recipe().contextRef,
    }),
    /artifact id is invalid/,
  );
  assert.equal(disposed, 1);
});

test('rejects an invalid request before consulting recipes or Secret providers', async () => {
  let recipeCalls = 0;
  const materializer = new RecipeLocalExecutionContextMaterializer(
    {
      async resolve() {
        recipeCalls += 1;
        return recipe();
      },
    },
    { async prepare() {} },
  );
  await assert.rejects(
    materializer.prepare({
      candidate: { ...candidate(), attemptId: '../invalid\0' },
      contextRef: recipe().contextRef,
    }),
  );
  await assert.rejects(
    materializer.prepare({
      candidate: candidate(),
      contextRef: '../invalid\0',
    }),
  );
  assert.equal(recipeCalls, 0);
});
