const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_RUN_EVENT_LIST_DEFAULT_LIMIT,
  BUILTIN_RUN_EVENT_LIST_MAX_LIMIT,
  BUILTIN_RUN_EVENT_LIST_TOOL,
  BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION,
  BuiltInRunEventListToolUnavailableError,
  InvalidBuiltInRunEventListToolError,
  executeBuiltInRunEventListTool,
} = require('../dist/tool-projection/runEventList.js');

function run(projectId = 'default') {
  return Object.freeze({ id: 'run-1', projectId });
}

function event(sequence, overrides = {}) {
  return Object.freeze({
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type: `run.event.${sequence}`,
    dedupeKey: `private-dedupe-${sequence}`,
    actorType: 'system',
    actorId: 'private-actor',
    attemptId: 'private-attempt',
    stepRunId: 'private-step',
    payload: Object.freeze({ secret: 'must-not-leak' }),
    createdAtMs: 1_000 + sequence,
    ...overrides,
  });
}

test('defines one bounded low-risk Run event list Tool', () => {
  assert.deepEqual(BUILTIN_RUN_EVENT_LIST_TOOL, {
    name: 'qinglong.run.events.list',
    version: '1.0.0',
  });
  assert.equal(BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(
    BUILTIN_RUN_EVENT_LIST_TOOL_DEFINITION.requiredPermissions,
    ['run.read'],
  );
  assert.equal(BUILTIN_RUN_EVENT_LIST_DEFAULT_LIMIT, 32);
  assert.equal(BUILTIN_RUN_EVENT_LIST_MAX_LIMIT, 64);
});

test('returns an ordered payload-free page and a stable cursor', async () => {
  const calls = [];
  const result = await executeBuiltInRunEventListTool(
    {
      async findRunById(runId) {
        calls.push(['run', runId]);
        return run();
      },
      async listEvents(runId, options) {
        calls.push(['events', runId, options]);
        return [event(3), event(4), event(5)];
      },
    },
    'default',
    { runId: 'run-1', afterSequence: 2, limit: 2 },
  );
  assert.deepEqual(result, {
    found: true,
    events: [
      {
        sequence: 3,
        type: 'run.event.3',
        actorType: 'system',
        createdAtMs: 1_003,
      },
      {
        sequence: 4,
        type: 'run.event.4',
        actorType: 'system',
        createdAtMs: 1_004,
      },
    ],
    hasMore: true,
    nextAfterSequence: 4,
  });
  assert.deepEqual(calls, [
    ['run', 'run-1'],
    ['events', 'run-1', { afterSequence: 2, limit: 3 }],
  ]);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('masks absent and cross-Project Runs without reading events', async () => {
  for (const value of [null, run('other')]) {
    let eventReads = 0;
    const result = await executeBuiltInRunEventListTool(
      {
        async findRunById() {
          return value;
        },
        async listEvents() {
          eventReads += 1;
          return [];
        },
      },
      'default',
      { runId: 'run-1', afterSequence: 7 },
    );
    assert.deepEqual(result, {
      found: false,
      events: [],
      hasMore: false,
      nextAfterSequence: 7,
    });
    assert.equal(eventReads, 0);
  }
});

test('rejects malformed input and fails closed on storage or event corruption', async () => {
  const runs = {
    async findRunById() {
      return run();
    },
    async listEvents() {
      return [];
    },
  };
  for (const input of [
    null,
    {},
    { runId: '' },
    { runId: 'run-1', limit: 65 },
    { runId: 'run-1', afterSequence: -1 },
    { runId: 'run-1', unexpected: true },
  ]) {
    await assert.rejects(
      executeBuiltInRunEventListTool(runs, 'default', input),
      InvalidBuiltInRunEventListToolError,
    );
  }
  await assert.rejects(
    executeBuiltInRunEventListTool(
      {
        async findRunById() {
          throw new Error('hidden');
        },
        async listEvents() {
          return [];
        },
      },
      'default',
      { runId: 'run-1' },
    ),
    BuiltInRunEventListToolUnavailableError,
  );
  await assert.rejects(
    executeBuiltInRunEventListTool(
      {
        async findRunById() {
          return run();
        },
        async listEvents() {
          return [event(2), event(1)];
        },
      },
      'default',
      { runId: 'run-1' },
    ),
    BuiltInRunEventListToolUnavailableError,
  );
});
