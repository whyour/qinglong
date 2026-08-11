require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  assertExecutionSpec,
  cloneExecutionSpec,
} = require('../../back/runtime/domain/executionSpec');
const {
  createExecutionSpecDigest,
} = require('../../back/runtime/domain/runDispatchOffer');

function spec(overrides = {}) {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'v1',
    command: { kind: 'argv', file: '/usr/bin/node', args: ['task.js'] },
    environmentPolicy: 'isolated',
    terminationGraceMs: 5_000,
    resourcePolicy: {
      memoryBytes: { value: 1024, enforcement: 'best_effort' },
      networkIsolation: 'best_effort',
    },
    ...overrides,
  };
}

test('validates and deep-clones a portable ExecutionSpec', () => {
  const source = spec();
  const cloned = cloneExecutionSpec(source);
  source.command.args[0] = 'changed.js';
  source.resourcePolicy.memoryBytes.value = 2048;
  assert.deepEqual(cloned.command.args, ['task.js']);
  assert.equal(cloned.resourcePolicy.memoryBytes.value, 1024);
});

test('drops unknown data when cloning an ExecutionSpec for an offer', () => {
  const cloned = cloneExecutionSpec({
    ...spec(),
    internalSecret: 'do-not-forward',
    resourcePolicy: {
      ...spec().resourcePolicy,
      adapterPrivateField: 'do-not-forward',
    },
  });
  assert.equal(Object.hasOwn(cloned, 'internalSecret'), false);
  assert.equal(
    Object.hasOwn(cloned.resourcePolicy, 'adapterPrivateField'),
    false,
  );
});

test('digests only the canonical ExecutionSpec payload', () => {
  const reference = spec();
  assert.equal(
    createExecutionSpecDigest(reference),
    createExecutionSpecDigest({ ...reference, internalSecret: 'ignored' }),
  );
  assert.notEqual(
    createExecutionSpecDigest(reference),
    createExecutionSpecDigest({
      ...reference,
      command: { kind: 'argv', file: '/usr/bin/node', args: ['changed.js'] },
    }),
  );
});

test('rejects control characters, relative paths, and unsafe numeric limits', () => {
  assert.throws(
    () => assertExecutionSpec(spec({ taskId: 'task\n2' })),
    /control characters/,
  );
  assert.throws(
    () => assertExecutionSpec(spec({ workingDirectory: 'relative/path' })),
    /absolute path/,
  );
  assert.throws(
    () =>
      assertExecutionSpec(
        spec({
          resourcePolicy: {
            memoryBytes: { value: 0, enforcement: 'required' },
          },
        }),
      ),
    /positive safe integer/,
  );
});
