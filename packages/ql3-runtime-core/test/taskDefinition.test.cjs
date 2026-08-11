const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidTaskDefinitionError,
  assertTaskDefinitionPageSize,
  createTaskDefinitionRecord,
  normalizeAppendTaskDefinitionRevisionCommand,
  normalizeTaskDefinitionCursor,
  normalizeTaskDefinitionRecord,
} = require('../dist/task-definition/taskDefinition');

function command(overrides = {}) {
  return {
    projectId: 'default',
    taskId: 'task-1',
    expectedRevision: null,
    mutationId: '019f7200-0000-7000-8000-000000000001',
    name: 'Example task',
    description: 'one immutable revision',
    kind: 'script',
    spec: {
      schema: 'qinglong/script@v1',
      config: {
        command: ['/usr/local/bin/node', 'script.js'],
        retry: { maximumAttempts: 1 },
      },
    },
    labels: { environment: 'test', 'qinglong.io/source': 'manual' },
    enabled: true,
    occurredAtMs: 100,
    ...overrides,
  };
}

test('normalizes one bounded canonical TaskDefinition revision', () => {
  const value = normalizeAppendTaskDefinitionRevisionCommand(command());
  assert.deepEqual(Object.keys(value.spec.config), ['command', 'retry']);
  assert.deepEqual(Object.keys(value.labels), [
    'environment',
    'qinglong.io/source',
  ]);
  assert.equal(Object.isFrozen(value.spec.config), true);

  const record = createTaskDefinitionRecord(value, 90);
  assert.equal(record.revision, 1);
  assert.equal(record.contentDigest.length, 64);
  assert.deepEqual(normalizeTaskDefinitionRecord(record), record);
});

test('rejects extensible commands and unbounded or non-JSON specs', () => {
  assert.throws(
    () => normalizeAppendTaskDefinitionRevisionCommand(command({ extra: 1 })),
    InvalidTaskDefinitionError,
  );
  assert.throws(
    () =>
      normalizeAppendTaskDefinitionRevisionCommand(
        command({ spec: { schema: 'unknown', config: {} } }),
      ),
    /spec schema is invalid/,
  );
  assert.throws(
    () =>
      normalizeAppendTaskDefinitionRevisionCommand(
        command({
          spec: { schema: 'qinglong/script@v1', config: { fn() {} } },
        }),
      ),
    /non-JSON value/,
  );
  assert.throws(
    () =>
      normalizeAppendTaskDefinitionRevisionCommand(
        command({
          labels: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`key-${index}`, 'x']),
          ),
        }),
      ),
    /count budget/,
  );
});

test('binds content digest to revision semantics and validates pagination', () => {
  const first = createTaskDefinitionRecord(command(), 90);
  const second = createTaskDefinitionRecord(
    command({
      expectedRevision: 1,
      mutationId: '019f7200-0000-7000-8000-000000000002',
      name: 'Changed task',
      occurredAtMs: 110,
    }),
    90,
  );
  assert.equal(second.revision, 2);
  assert.notEqual(second.contentDigest, first.contentDigest);
  assert.throws(
    () => normalizeTaskDefinitionRecord({ ...first, enabled: false }),
    /content digest did not match/,
  );
  assert.doesNotThrow(() => assertTaskDefinitionPageSize(256));
  assert.throws(() => assertTaskDefinitionPageSize(257), RangeError);
  assert.deepEqual(normalizeTaskDefinitionCursor({ taskId: 'task-1' }), {
    taskId: 'task-1',
  });
});
