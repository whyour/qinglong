const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_TRIGGER_LIST_DEFAULT_LIMIT,
  BUILTIN_TRIGGER_LIST_MAX_LIMIT,
  BUILTIN_TRIGGER_LIST_TOOL,
  BUILTIN_TRIGGER_LIST_TOOL_DEFINITION,
  BuiltInTriggerListToolUnavailableError,
  InvalidBuiltInTriggerListToolError,
  executeBuiltInTriggerListTool,
} = require('../dist/tool-projection/triggerList.js');

function trigger(triggerId, overrides = {}) {
  return Object.freeze({
    projectId: 'default',
    triggerId,
    revision: 2,
    mutationId: 'private-mutation',
    taskId: 'task-1',
    taskRevision: 3,
    taskContentDigest: 'private-task-digest',
    spec: Object.freeze({
      schema: 'qinglong/cron@v1',
      config: Object.freeze({
        expression: 'private cron expression',
        timezone: 'private timezone',
        misfire: 'private misfire policy',
      }),
    }),
    enabled: true,
    contentDigest: 'private-trigger-digest',
    createdAtMs: 10,
    updatedAtMs: 20,
    ...overrides,
  });
}

test('defines one bounded low-risk trigger.read Tool', () => {
  assert.deepEqual(BUILTIN_TRIGGER_LIST_TOOL, {
    name: 'qinglong.trigger.list',
    version: '1.0.0',
  });
  assert.equal(BUILTIN_TRIGGER_LIST_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_TRIGGER_LIST_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_TRIGGER_LIST_TOOL_DEFINITION.requiredPermissions, [
    'trigger.read',
  ]);
  assert.equal(BUILTIN_TRIGGER_LIST_DEFAULT_LIMIT, 32);
  assert.equal(BUILTIN_TRIGGER_LIST_MAX_LIMIT, 64);
});

test('projects bounded current Triggers without schedule configuration', async () => {
  let captured;
  const output = await executeBuiltInTriggerListTool(
    {
      async listTriggers(query) {
        captured = query;
        return Object.freeze({
          triggers: Object.freeze([trigger('trigger-b')]),
          truncated: true,
          next: Object.freeze({ triggerId: 'trigger-b' }),
        });
      },
    },
    'default',
    { after: { triggerId: 'trigger-a' }, limit: 1 },
  );
  assert.deepEqual(captured, {
    projectId: 'default',
    limit: 1,
    after: { triggerId: 'trigger-a' },
  });
  assert.deepEqual(output, {
    triggers: [
      {
        triggerId: 'trigger-b',
        revision: 2,
        taskId: 'task-1',
        taskRevision: 3,
        specSchema: 'qinglong/cron@v1',
        enabled: true,
        updatedAtMs: 20,
      },
    ],
    hasMore: true,
    next: { triggerId: 'trigger-b' },
  });
  const serialized = JSON.stringify(output);
  for (const hidden of [
    'private',
    'expression',
    'timezone',
    'misfire',
    'contentDigest',
    'projectId',
  ]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test('defaults to 32 and returns no cursor for a complete page', async () => {
  let captured;
  const output = await executeBuiltInTriggerListTool(
    {
      async listTriggers(query) {
        captured = query;
        return { triggers: [], truncated: false };
      },
    },
    'default',
    {},
  );
  assert.deepEqual(captured, { projectId: 'default', limit: 32 });
  assert.deepEqual(output, { triggers: [], hasMore: false });
});

test('rejects invalid input before reading', async () => {
  let reads = 0;
  const source = {
    async listTriggers() {
      reads += 1;
      return { triggers: [], truncated: false };
    },
  };
  for (const input of [
    null,
    { limit: 65 },
    { after: { triggerId: '' } },
    { after: { triggerId: 'trigger-a', extra: true } },
    { unexpected: true },
  ]) {
    await assert.rejects(
      executeBuiltInTriggerListTool(source, 'default', input),
      InvalidBuiltInTriggerListToolError,
    );
  }
  assert.equal(reads, 0);
});

test('fails closed on cross-Project, unordered, oversized or inconsistent pages', async () => {
  for (const { page, input = {} } of [
    {
      page: {
        triggers: [trigger('trigger-a', { projectId: 'other' })],
        truncated: false,
      },
    },
    {
      page: {
        triggers: [trigger('trigger-b'), trigger('trigger-a')],
        truncated: false,
      },
    },
    {
      page: {
        triggers: [trigger('trigger-a'), trigger('trigger-b')],
        truncated: false,
      },
      input: { limit: 1 },
    },
    {
      page: { triggers: [trigger('trigger-a')], truncated: true },
    },
    {
      page: {
        triggers: [trigger('trigger-a')],
        truncated: true,
        next: { triggerId: 'trigger-b' },
      },
    },
    {
      page: {
        triggers: [
          trigger('trigger-a', { spec: { schema: 'invalid', config: {} } }),
        ],
        truncated: false,
      },
    },
  ]) {
    await assert.rejects(
      executeBuiltInTriggerListTool(
        {
          async listTriggers() {
            return page;
          },
        },
        'default',
        input,
      ),
      BuiltInTriggerListToolUnavailableError,
    );
  }
});
