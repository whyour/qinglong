const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_RUN_LIST_DEFAULT_LIMIT,
  BUILTIN_RUN_LIST_MAX_LIMIT,
  BUILTIN_RUN_LIST_TOOL,
  BUILTIN_RUN_LIST_TOOL_DEFINITION,
  BuiltInRunListToolUnavailableError,
  InvalidBuiltInRunListToolError,
  executeBuiltInRunListTool,
} = require('../dist/tool-projection/runList.js');

function run(id, createdAtMs, overrides = {}) {
  return Object.freeze({
    id,
    projectId: 'default',
    taskId: `task-${id}`,
    taskRevision: 'revision-1',
    taskName: 'private-name',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: 'private-actor',
    requestId: 'private-request',
    status: 'succeeded',
    version: 2,
    eventSequence: 3,
    priority: 0,
    inputRef: 'private-input',
    outputRef: 'private-output',
    createdAtMs,
    finishedAtMs: createdAtMs + 1,
    ...overrides,
  });
}

test('defines one bounded low-risk Project Run discovery Tool', () => {
  assert.deepEqual(BUILTIN_RUN_LIST_TOOL, {
    name: 'qinglong.run.list',
    version: '1.0.0',
  });
  assert.equal(BUILTIN_RUN_LIST_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_RUN_LIST_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_RUN_LIST_TOOL_DEFINITION.requiredPermissions, [
    'run.read',
  ]);
  assert.equal(BUILTIN_RUN_LIST_DEFAULT_LIMIT, 32);
  assert.equal(BUILTIN_RUN_LIST_MAX_LIMIT, 64);
});

test('returns a descending low-sensitive page and stable continuation', async () => {
  const calls = [];
  const result = await executeBuiltInRunListTool(
    {
      async listRunsByProject(query) {
        calls.push(query);
        return [run('run-c', 30), run('run-b', 20), run('run-a', 10)];
      },
    },
    'default',
    { limit: 2 },
  );
  assert.deepEqual(calls, [{ projectId: 'default', limit: 3 }]);
  assert.deepEqual(result, {
    runs: [
      {
        id: 'run-c',
        taskId: 'task-run-c',
        taskRevision: 'revision-1',
        status: 'succeeded',
        version: 2,
        eventSequence: 3,
        priority: 0,
        executionOrigin: 'manual',
        executionOwner: 'runtime',
        createdAtMs: 30,
        finishedAtMs: 31,
      },
      {
        id: 'run-b',
        taskId: 'task-run-b',
        taskRevision: 'revision-1',
        status: 'succeeded',
        version: 2,
        eventSequence: 3,
        priority: 0,
        executionOrigin: 'manual',
        executionOwner: 'runtime',
        createdAtMs: 20,
        finishedAtMs: 21,
      },
    ],
    hasMore: true,
    next: { createdAtMs: 20, runId: 'run-b' },
  });
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('passes an exact cursor and fails closed on malformed or corrupt pages', async () => {
  const seen = [];
  const reader = {
    async listRunsByProject(query) {
      seen.push(query);
      return [];
    },
  };
  assert.deepEqual(
    await executeBuiltInRunListTool(reader, 'default', {
      after: { createdAtMs: 20, runId: 'run-b' },
    }),
    { runs: [], hasMore: false },
  );
  assert.deepEqual(seen, [
    {
      projectId: 'default',
      limit: BUILTIN_RUN_LIST_DEFAULT_LIMIT + 1,
      after: { createdAtMs: 20, runId: 'run-b' },
    },
  ]);

  for (const input of [
    null,
    { limit: 65 },
    { unexpected: true },
    { after: null },
    { after: { createdAtMs: -1, runId: 'run-b' } },
    { after: { createdAtMs: 20, runId: 'run-b', extra: true } },
  ]) {
    await assert.rejects(
      executeBuiltInRunListTool(reader, 'default', input),
      InvalidBuiltInRunListToolError,
    );
  }

  for (const rows of [
    [run('run-a', 10, { projectId: 'other' })],
    [run('run-a', 10), run('run-b', 20)],
    Array.from({ length: 34 }, (_, index) => run(`run-${index}`, 100 - index)),
  ]) {
    await assert.rejects(
      executeBuiltInRunListTool(
        {
          async listRunsByProject() {
            return rows;
          },
        },
        'default',
        {},
      ),
      BuiltInRunListToolUnavailableError,
    );
  }
});
