const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const {
  BoundedRunStepListProjectionUnavailableError,
  DEFAULT_BOUNDED_RUN_STEP_LIST_LIMIT,
  InvalidBoundedRunStepListProjectionError,
  MAX_BOUNDED_RUN_STEP_LIST_LIMIT,
  executeBoundedRunStepListProjection,
} = require('../dist/run/projection/boundedRunStepListProjection.js');
const { createStepRunRecord } = require('../dist/run/stepRun.js');

function run(projectId = 'prj_default') {
  return Object.freeze({ id: 'run-1', projectId });
}

function step(id, stepKey, overrides = {}) {
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
    ...overrides,
  });
}

test('projects one bounded low-sensitive Step page and stable cursor', async () => {
  const calls = [];
  const first = step('step-1', 'build');
  const second = step('step-2', 'deploy');
  const result = await executeBoundedRunStepListProjection(
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
    'prj_default',
    'run-1',
    { after: { stepKey: 'admit', stepRunId: 'step-0' }, limit: 2 },
  );
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
  assert.deepEqual(result, {
    found: true,
    steps: [
      {
        id: 'step-1',
        parentStepRunId: 'step-parent',
        stepKey: 'build',
        kind: 'tool',
        required: true,
        status: 'ready',
        version: 1,
        attemptCount: 0,
        readyAtMs: 1_000,
        startedAtMs: null,
        finishedAtMs: null,
        resultCode: null,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
      {
        id: 'step-2',
        parentStepRunId: 'step-parent',
        stepKey: 'deploy',
        kind: 'tool',
        required: true,
        status: 'ready',
        version: 1,
        attemptCount: 0,
        readyAtMs: 1_000,
        startedAtMs: null,
        finishedAtMs: null,
        resultCode: null,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      },
    ],
    hasMore: true,
    next: { stepKey: 'deploy', stepRunId: 'step-2' },
  });
  const serialized = JSON.stringify(result);
  for (const hidden of [
    'definition',
    'private-input',
    'approvalRequestId',
    'errorSummary',
    'stepRunDigest',
  ]) {
    assert.equal(serialized.includes(hidden), false);
  }
});

test('uses default and maximum bounds and preserves an empty page', async () => {
  const calls = [];
  const stepRuns = {
    async listByRun(query) {
      calls.push(query);
      return { stepRuns: [], truncated: false };
    },
  };
  const runs = {
    async findRunById() {
      return run();
    },
  };
  assert.deepEqual(
    await executeBoundedRunStepListProjection(
      runs,
      stepRuns,
      'prj_default',
      'run-1',
      {},
    ),
    { found: true, steps: [], hasMore: false, next: null },
  );
  await executeBoundedRunStepListProjection(
    runs,
    stepRuns,
    'prj_default',
    'run-1',
    { limit: MAX_BOUNDED_RUN_STEP_LIST_LIMIT },
  );
  assert.deepEqual(calls, [
    { runId: 'run-1', limit: DEFAULT_BOUNDED_RUN_STEP_LIST_LIMIT },
    { runId: 'run-1', limit: MAX_BOUNDED_RUN_STEP_LIST_LIMIT },
  ]);
});

test('masks absence and Project mismatch without reading StepRuns', async () => {
  for (const value of [null, run('prj_other')]) {
    let reads = 0;
    const result = await executeBoundedRunStepListProjection(
      {
        async findRunById() {
          return value;
        },
      },
      {
        async listByRun() {
          reads += 1;
          return { stepRuns: [], truncated: false };
        },
      },
      'prj_default',
      'run-1',
      {},
    );
    assert.deepEqual(result, {
      found: false,
      steps: [],
      hasMore: false,
      next: null,
    });
    assert.equal(reads, 0);
  }
});

test('fails closed on invalid input, repository failure and corrupt pages', async () => {
  const runs = {
    async findRunById() {
      return run();
    },
  };
  const empty = {
    async listByRun() {
      return { stepRuns: [], truncated: false };
    },
  };
  for (const input of [
    null,
    { limit: 0 },
    { limit: 65 },
    { after: { stepKey: 'build' } },
    { after: { stepKey: 'build', stepRunId: 'step-1', extra: true } },
    { extra: true },
  ]) {
    await assert.rejects(
      executeBoundedRunStepListProjection(
        runs,
        empty,
        'prj_default',
        'run-1',
        input,
      ),
      InvalidBoundedRunStepListProjectionError,
    );
  }
  const duplicateStepKey = [step('step-1', 'build'), step('step-2', 'build')];
  for (const page of [
    { stepRuns: duplicateStepKey, truncated: false },
    {
      stepRuns: [step('step-1', 'build')],
      truncated: true,
      next: { stepKey: 'other', id: 'step-1' },
    },
    {
      stepRuns: [{ ...step('step-1', 'build'), status: 'succeeded' }],
      truncated: false,
    },
  ]) {
    await assert.rejects(
      executeBoundedRunStepListProjection(
        runs,
        {
          async listByRun() {
            return page;
          },
        },
        'prj_default',
        'run-1',
        { limit: 2 },
      ),
      BoundedRunStepListProjectionUnavailableError,
    );
  }
  await assert.rejects(
    executeBoundedRunStepListProjection(
      {
        async findRunById() {
          throw new Error('offline');
        },
      },
      empty,
      'prj_default',
      'run-1',
      {},
    ),
    BoundedRunStepListProjectionUnavailableError,
  );
});

test('leaf import does not load Tool Registry or SemVer', () => {
  const entry = path.resolve(
    __dirname,
    '../dist/run/projection/boundedRunStepListProjection.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(entry)});
       const loaded = Object.keys(require.cache);
       if (loaded.some((value) => /node_modules[\\/]semver(?:[\\/]|$)/.test(value))) process.exit(2);
       if (loaded.some((value) => /tool-execution[\\/]tool-registry/.test(value))) process.exit(3);
       process.stdout.write(String(loaded.length));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(result.stdout) <= 5);
});
