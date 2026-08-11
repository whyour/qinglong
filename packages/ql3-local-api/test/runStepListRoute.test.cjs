const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createLocalApiRunStepListRoute,
} = require('../dist/run/runStepListRoute.js');
const {
  createStepRunRecord,
} = require('../../ql3-runtime-core/dist/run/stepRun.js');

function run(projectId = 'prj_default') {
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

test('returns the shared bounded low-sensitive Run Step projection', async () => {
  const calls = [];
  const first = step('step-1', 'build');
  const second = step('step-2', 'deploy');
  const route = createLocalApiRunStepListRoute(
    {
      async findRunById(runId) {
        calls.push(['run', runId]);
        return run();
      },
    },
    {
      async listByRun(query) {
        calls.push(['steps', query]);
        return {
          stepRuns: [first, second],
          truncated: true,
          next: { stepKey: second.stepKey, id: second.id },
        };
      },
    },
  );
  const response = await route.handle({
    projectId: 'prj_default',
    runId: 'run-1',
    input: {
      after: { stepKey: 'admit', stepRunId: 'step-0' },
      limit: 2,
    },
  });
  assert.deepEqual(calls, [
    ['run', 'run-1'],
    [
      'steps',
      {
        runId: 'run-1',
        limit: 2,
        after: { stepKey: 'admit', id: 'step-0' },
      },
    ],
  ]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.steps.length, 2);
  assert.deepEqual(response.body.next, {
    stepKey: 'deploy',
    stepRunId: 'step-2',
  });
  assert.equal(response.body.hasMore, true);
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes('private.internal'), false);
  assert.equal(serialized.includes('private-input'), false);
  assert.equal(serialized.includes('stepRunDigest'), false);
});

test('masks absent and cross-Project Runs and fails closed on corrupt storage', async () => {
  for (const value of [null, run('prj_other')]) {
    const route = createLocalApiRunStepListRoute(
      {
        async findRunById() {
          return value;
        },
      },
      {
        async listByRun() {
          throw new Error('must not read');
        },
      },
    );
    assert.deepEqual(
      await route.handle({
        projectId: 'prj_default',
        runId: 'run-1',
        input: {},
      }),
      { statusCode: 404, body: { code: 'run_not_found' } },
    );
  }
  const route = createLocalApiRunStepListRoute(
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
  );
  assert.deepEqual(
    await route.handle({ projectId: 'prj_default', runId: 'run-1', input: {} }),
    { statusCode: 503, body: { code: 'run_step_list_unavailable' } },
  );
});
