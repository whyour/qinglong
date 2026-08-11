const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  BUILTIN_RUN_STEP_LIST_DEFAULT_LIMIT,
  BUILTIN_RUN_STEP_LIST_MAX_LIMIT,
  BUILTIN_RUN_STEP_LIST_TOOL,
  BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION,
  BuiltInRunStepListToolUnavailableError,
  InvalidBuiltInRunStepListToolError,
  executeBuiltInRunStepListTool,
} = require('../dist/tool-projection/runStepList.js');
const {
  createStepRunRecord,
} = require('../../ql3-runtime-core/dist/run/stepRun.js');

function run(projectId = 'default') {
  return { id: 'run-1', projectId };
}

function step(id, stepKey) {
  return createStepRunRecord({
    id,
    runId: 'run-1',
    parentStepRunId: 'step-parent',
    stepKey,
    kind: 'tool',
    definitionRef: 'tool:private.internal@1.0.0',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    inputRef: 'artifact:private-input',
    mutationId: `create-${id}`,
    createdAtMs: 1_000,
  });
}

test('defines one bounded low-risk Run Step list Tool', () => {
  assert.deepEqual(BUILTIN_RUN_STEP_LIST_TOOL, {
    name: 'qinglong.run.steps.list',
    version: '1.0.0',
  });
  assert.equal(BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION.effect, 'read');
  assert.equal(BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION.risk, 'low');
  assert.deepEqual(BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION.requiredPermissions, [
    'run.read',
  ]);
  assert.equal(BUILTIN_RUN_STEP_LIST_DEFAULT_LIMIT, 32);
  assert.equal(BUILTIN_RUN_STEP_LIST_MAX_LIMIT, 64);
});

test('returns a low-sensitive page and omits nullable fields', async () => {
  const calls = [];
  const first = step('step-1', 'build');
  const second = step('step-2', 'deploy');
  const result = await executeBuiltInRunStepListTool(
    {
      async findRunById() {
        return run();
      },
    },
    {
      async listByRun(query) {
        calls.push(query);
        return {
          stepRuns: [first, second],
          truncated: true,
          next: { stepKey: second.stepKey, id: second.id },
        };
      },
    },
    'default',
    {
      runId: 'run-1',
      afterStepKey: 'admit',
      afterStepRunId: 'step-0',
      limit: 2,
    },
  );
  assert.deepEqual(calls, [
    {
      runId: 'run-1',
      limit: 2,
      after: { stepKey: 'admit', id: 'step-0' },
    },
  ]);
  assert.equal(result.found, true);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].parentStepRunId, 'step-parent');
  assert.equal(Object.hasOwn(result.steps[0], 'startedAtMs'), false);
  assert.deepEqual(result.next, {
    stepKey: 'deploy',
    stepRunId: 'step-2',
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private.internal'), false);
  assert.equal(serialized.includes('private-input'), false);
});

test('masks Project mismatch and rejects malformed or corrupt input', async () => {
  let reads = 0;
  assert.deepEqual(
    await executeBuiltInRunStepListTool(
      {
        async findRunById() {
          return run('other');
        },
      },
      {
        async listByRun() {
          reads += 1;
          return { stepRuns: [], truncated: false };
        },
      },
      'default',
      { runId: 'run-1' },
    ),
    { found: false, steps: [], hasMore: false },
  );
  assert.equal(reads, 0);
  for (const input of [
    {},
    { runId: 'run-1', afterStepKey: 'build' },
    { runId: 'run-1', afterStepRunId: 'step-1' },
    { runId: 'run-1', limit: 65 },
    { runId: 'run-1', unexpected: true },
  ]) {
    await assert.rejects(
      executeBuiltInRunStepListTool(
        {
          async findRunById() {
            return run();
          },
        },
        {
          async listByRun() {
            return { stepRuns: [], truncated: false };
          },
        },
        'default',
        input,
      ),
      InvalidBuiltInRunStepListToolError,
    );
  }
  await assert.rejects(
    executeBuiltInRunStepListTool(
      {
        async findRunById() {
          return run();
        },
      },
      {
        async listByRun() {
          return {
            stepRuns: [step('step-2', 'deploy'), step('step-1', 'build')],
            truncated: false,
          };
        },
      },
      'default',
      { runId: 'run-1' },
    ),
    BuiltInRunStepListToolUnavailableError,
  );
});
