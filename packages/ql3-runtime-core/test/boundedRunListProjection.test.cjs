const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const {
  BoundedRunListProjectionUnavailableError,
  DEFAULT_BOUNDED_RUN_LIST_LIMIT,
  InvalidBoundedRunListProjectionError,
  MAX_BOUNDED_RUN_LIST_LIMIT,
  executeBoundedRunListProjection,
} = require('../dist/run/projection/boundedRunListProjection.js');

function run(id, createdAtMs, overrides = {}) {
  return Object.freeze({
    id,
    projectId: 'prj_default',
    taskId: `task-${id}`,
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'succeeded',
    version: 2,
    eventSequence: 3,
    priority: 0,
    createdAtMs,
    finishedAtMs: createdAtMs + 1,
    privateRef: 'must-not-cross-projection',
    ...overrides,
  });
}

test('projects one descending bounded page and a stable keyset cursor', async () => {
  const calls = [];
  const result = await executeBoundedRunListProjection(
    {
      async listRunsByProject(query) {
        calls.push(query);
        return [
          run('run-c', 30, { triggerId: 'cron:task-run-c' }),
          run('run-b', 20),
          run('run-a', 10),
        ];
      },
    },
    'prj_default',
    { limit: 2 },
  );
  assert.deepEqual(calls, [{ projectId: 'prj_default', limit: 3 }]);
  assert.deepEqual(result, {
    runs: [
      {
        id: 'run-c',
        taskId: 'task-run-c',
        taskRevision: 'revision-1',
        triggerId: 'cron:task-run-c',
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
  assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
});

test('uses default and maximum bounds and passes an exact cursor', async () => {
  const seen = [];
  const reader = {
    async listRunsByProject(query) {
      seen.push(query);
      return [];
    },
  };
  assert.deepEqual(
    await executeBoundedRunListProjection(reader, 'prj_default', {}),
    { runs: [], hasMore: false },
  );
  assert.deepEqual(
    await executeBoundedRunListProjection(reader, 'prj_default', {
      limit: MAX_BOUNDED_RUN_LIST_LIMIT,
      after: { createdAtMs: 20, runId: 'run-b' },
    }),
    { runs: [], hasMore: false },
  );
  assert.deepEqual(seen, [
    { projectId: 'prj_default', limit: DEFAULT_BOUNDED_RUN_LIST_LIMIT + 1 },
    {
      projectId: 'prj_default',
      limit: MAX_BOUNDED_RUN_LIST_LIMIT + 1,
      after: { createdAtMs: 20, runId: 'run-b' },
    },
  ]);
});

test('fails closed on malformed inputs, rows, ordering and repository failures', async () => {
  const reader = {
    async listRunsByProject() {
      return [];
    },
  };
  for (const input of [
    null,
    { limit: 0 },
    { limit: 65 },
    { extra: true },
    { after: null },
    { after: { createdAtMs: -1, runId: 'run-a' } },
  ]) {
    await assert.rejects(
      executeBoundedRunListProjection(reader, 'prj_default', input),
      InvalidBoundedRunListProjectionError,
    );
  }
  for (const rows of [
    [run('run-a', 10, { projectId: 'prj_other' })],
    [run('run-a', 10), run('run-b', 20)],
    [run('run-a', 10), run('run-a', 10)],
    [run('run-a', 10, { status: 'invented' })],
  ]) {
    await assert.rejects(
      executeBoundedRunListProjection(
        {
          async listRunsByProject() {
            return rows;
          },
        },
        'prj_default',
        {},
      ),
      BoundedRunListProjectionUnavailableError,
    );
  }
  await assert.rejects(
    executeBoundedRunListProjection(
      {
        async listRunsByProject() {
          throw new Error('offline');
        },
      },
      'prj_default',
      {},
    ),
    BoundedRunListProjectionUnavailableError,
  );
});

test('leaf import does not load Tool Registry or SemVer', () => {
  const entry = path.resolve(
    __dirname,
    '../dist/run/projection/boundedRunListProjection.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(entry)});
       const loaded = Object.keys(require.cache);
       if (loaded.some((value) => /node_modules[\\\\/]semver(?:[\\\\/]|$)/.test(value))) process.exit(2);
       if (loaded.some((value) => /tool-execution[\\\\/]tool-registry/.test(value))) process.exit(3);
       process.stdout.write(String(loaded.length));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(result.stdout) <= 4);
});
