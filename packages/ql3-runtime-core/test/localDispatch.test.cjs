const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLocalExecutionContextRecipe,
  createLocalTaskExecutionRevision,
  localTaskExecutionRevisionDigest,
  normalizeLocalDispatchCandidate,
  normalizeLocalTaskExecutionRevision,
} = require('../dist/local-runtime/localDispatch');

test('context recipes are content-addressed and canonical', () => {
  const recipe = createLocalExecutionContextRecipe({
    environment: [
      { name: 'Z_VALUE', kind: 'public', value: 'z' },
      { name: 'A_VALUE', kind: 'secret', secretRef: 'secret-a' },
    ],
    createdAtMs: 1,
  });
  assert.match(recipe.contextRef, /^localctx:sha256:[a-f0-9]{64}$/);
  assert.equal(recipe.contextRef, `localctx:sha256:${recipe.contentDigest}`);
  assert.deepEqual(
    recipe.environment.map(({ name }) => name),
    ['A_VALUE', 'Z_VALUE'],
  );
  assert.throws(
    () =>
      createLocalExecutionContextRecipe({
        environment: [
          { name: 'QL3_RECEIPT_TOKEN', kind: 'public', value: 'forged' },
        ],
        createdAtMs: 1,
      }),
    /invalid or duplicated/,
  );
});

test('local revisions use bounded absolute commands and immutable context refs', () => {
  const recipe = createLocalExecutionContextRecipe({
    environment: [],
    createdAtMs: 1,
  });
  const revision = createLocalTaskExecutionRevision({
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    executorType: 'local_process',
    command: { kind: 'argv', file: '/bin/echo', args: ['hello'] },
    contextRef: recipe.contextRef,
    createdAtMs: 1,
  });
  assert.equal(Object.isFrozen(revision), true);
  assert.equal(Object.isFrozen(revision.command), true);
  assert.match(revision.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    revision.contentDigest,
    localTaskExecutionRevisionDigest(revision),
  );
  assert.equal(
    createLocalTaskExecutionRevision({ ...revision, createdAtMs: 2 })
      .contentDigest,
    revision.contentDigest,
  );
  assert.throws(
    () =>
      normalizeLocalTaskExecutionRevision({
        ...revision,
        contentDigest: '0'.repeat(64),
      }),
    /digest does not match/,
  );
  assert.throws(
    () =>
      normalizeLocalTaskExecutionRevision({
        ...revision,
        command: { kind: 'argv', file: 'echo', args: [] },
      }),
    /absolute/,
  );
});

test('dispatch candidates reject non-local executors and invalid ordering facts', () => {
  const candidate = {
    runId: 'run-1',
    attemptId: 'attempt-1',
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'revision-1',
    attemptNumber: 1,
    executorType: 'local_process',
    priority: 1,
    queuedAtMs: 1,
    attemptCreatedAtMs: 1,
  };
  assert.deepEqual(normalizeLocalDispatchCandidate(candidate), candidate);
  assert.throws(
    () =>
      normalizeLocalDispatchCandidate({
        ...candidate,
        executorType: 'remote_worker',
      }),
    /executor type/,
  );
});
