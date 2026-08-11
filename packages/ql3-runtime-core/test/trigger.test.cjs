const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidTriggerError,
  InvalidTriggerSpecSemanticError,
  UnsupportedTriggerSpecError,
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
  createTriggerSpecSemanticRegistry,
  normalizeTriggerRecord,
} = require('@qinglong/runtime-core/trigger');

function command(overrides = {}) {
  return {
    projectId: 'default',
    triggerId: 'trigger-1',
    expectedRevision: null,
    mutationId: '019f7300-0000-7000-8000-000000000001',
    taskId: 'task-1',
    taskRevision: 3,
    taskContentDigest: 'a'.repeat(64),
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '  0   2 * * *  ',
        timezone: 'Etc/UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
    occurredAtMs: 200,
    ...overrides,
  };
}

test('normalizes built-in cron semantics and creates a digest-bound record', () => {
  const registry = createBuiltInTriggerSpecSemanticRegistry();
  const input = command();
  const spec = registry.normalize({
    projectId: input.projectId,
    triggerId: input.triggerId,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    spec: input.spec,
  });
  assert.deepEqual({ ...spec.config }, {
    expression: '0 2 * * *',
    timezone: 'UTC',
    misfirePolicy: 'skip',
  });
  const record = createTriggerRecord({ ...input, spec }, 100);
  assert.match(record.contentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(normalizeTriggerRecord(record), record);
  assert.throws(
    () => normalizeTriggerRecord({ ...record, enabled: false }),
    InvalidTriggerError,
  );
});

test('rejects cron macros, implicit timezones and unknown misfire behavior', () => {
  const registry = createBuiltInTriggerSpecSemanticRegistry();
  const normalize = (config) =>
    registry.normalize({
      projectId: 'default',
      triggerId: 'trigger-1',
      taskId: 'task-1',
      taskRevision: 1,
      spec: { schema: 'qinglong/cron@v1', config },
    });
  assert.throws(
    () =>
      normalize({
        expression: '@daily',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      }),
    InvalidTriggerSpecSemanticError,
  );
  assert.throws(
    () => normalize({ expression: '0 2 * * *', misfirePolicy: 'skip' }),
    InvalidTriggerSpecSemanticError,
  );
  assert.throws(
    () =>
      normalize({
        expression: '0 2 * * *',
        timezone: 'UTC',
        misfirePolicy: 'replay_all',
      }),
    InvalidTriggerSpecSemanticError,
  );
});

test('keeps extension schemas explicit and the qinglong namespace reserved', () => {
  assert.throws(
    () =>
      createTriggerSpecSemanticRegistry([
        {
          schema: 'qinglong/event@v1',
          normalizeConfig: (config) => config,
        },
      ]),
    InvalidTriggerSpecSemanticError,
  );
  const registry = createTriggerSpecSemanticRegistry([
    {
      schema: 'example/event@v1',
      normalizeConfig(config) {
        return Object.freeze({ topic: String(config.topic).toLowerCase() });
      },
    },
  ]);
  assert.deepEqual(
    {
      ...registry.normalize({
      projectId: 'default',
      triggerId: 'trigger-1',
      taskId: 'task-1',
      taskRevision: 1,
      spec: { schema: 'example/event@v1', config: { topic: 'BUILD' } },
      }).config,
    },
    { topic: 'build' },
  );
  assert.throws(
    () =>
      createBuiltInTriggerSpecSemanticRegistry().normalize({
        projectId: 'default',
        triggerId: 'trigger-1',
        taskId: 'task-1',
        taskRevision: 1,
        spec: { schema: 'example/event@v1', config: { topic: 'build' } },
      }),
    UnsupportedTriggerSpecError,
  );
});

test('rejects extensible records, invalid identity and over-budget specs', () => {
  const base = command();
  assert.throws(
    () => createTriggerRecord({ ...base, unexpected: true }, 100),
    InvalidTriggerError,
  );
  assert.throws(
    () => createTriggerRecord({ ...base, taskContentDigest: 'A'.repeat(64) }, 100),
    InvalidTriggerError,
  );
  assert.throws(
    () =>
      createTriggerRecord(
        {
          ...base,
          spec: {
            schema: 'example/event@v1',
            config: { value: 'x'.repeat(16 * 1024) },
          },
        },
        100,
      ),
    InvalidTriggerError,
  );
});
