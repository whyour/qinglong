const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const {
  BoundedTaskListProjectionUnavailableError,
  DEFAULT_BOUNDED_TASK_LIST_LIMIT,
  InvalidBoundedTaskListProjectionError,
  MAX_BOUNDED_TASK_LIST_LIMIT,
  executeBoundedTaskListProjection,
} = require('../dist/task-definition/projection/boundedTaskListProjection.js');

function task(taskId, overrides = {}) {
  return Object.freeze({
    projectId: 'prj_default',
    taskId,
    revision: 2,
    name: `Task ${taskId}`,
    description: 'must-not-cross-projection',
    kind: 'command',
    spec: Object.freeze({
      schema: 'qinglong/command@v1',
      config: Object.freeze({ command: ['private'] }),
    }),
    labels: Object.freeze({ private: 'value' }),
    enabled: true,
    mutationId: 'mutation-private',
    contentDigest: 'digest-private',
    createdAtMs: 10,
    updatedAtMs: 20,
    ...overrides,
  });
}

test('projects one bounded ascending current-head page and stable cursor', async () => {
  const calls = [];
  const result = await executeBoundedTaskListProjection(
    {
      async listTaskDefinitions(query) {
        calls.push(query);
        return {
          definitions: [
            task('task-a'),
            task('task-b', { enabled: false }),
          ],
          truncated: true,
          next: { taskId: 'task-b' },
        };
      },
    },
    'prj_default',
    { limit: 2 },
  );
  assert.deepEqual(calls, [{ projectId: 'prj_default', limit: 2 }]);
  assert.deepEqual(result, {
    tasks: [
      {
        taskId: 'task-a',
        revision: 2,
        name: 'Task task-a',
        kind: 'command',
        specSchema: 'qinglong/command@v1',
        enabled: true,
        updatedAtMs: 20,
      },
      {
        taskId: 'task-b',
        revision: 2,
        name: 'Task task-b',
        kind: 'command',
        specSchema: 'qinglong/command@v1',
        enabled: false,
        updatedAtMs: 20,
      },
    ],
    hasMore: true,
    next: { taskId: 'task-b' },
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('uses default and maximum bounds and passes an exact cursor', async () => {
  const seen = [];
  const source = {
    async listTaskDefinitions(query) {
      seen.push(query);
      return { definitions: [], truncated: false };
    },
  };
  assert.deepEqual(
    await executeBoundedTaskListProjection(source, 'prj_default', {}),
    { tasks: [], hasMore: false },
  );
  assert.deepEqual(
    await executeBoundedTaskListProjection(source, 'prj_default', {
      limit: MAX_BOUNDED_TASK_LIST_LIMIT,
      after: { taskId: 'task-a' },
    }),
    { tasks: [], hasMore: false },
  );
  assert.deepEqual(seen, [
    { projectId: 'prj_default', limit: DEFAULT_BOUNDED_TASK_LIST_LIMIT },
    {
      projectId: 'prj_default',
      limit: MAX_BOUNDED_TASK_LIST_LIMIT,
      after: { taskId: 'task-a' },
    },
  ]);
});

test('fails closed on malformed input before storage', async () => {
  let calls = 0;
  const source = {
    async listTaskDefinitions() {
      calls += 1;
      return { definitions: [], truncated: false };
    },
  };
  for (const input of [
    null,
    { limit: 0 },
    { limit: 65 },
    { extra: true },
    { after: null },
    { after: { taskId: '' } },
    { after: { taskId: 'task-a', extra: true } },
  ]) {
    await assert.rejects(
      executeBoundedTaskListProjection(source, 'prj_default', input),
      InvalidBoundedTaskListProjectionError,
    );
  }
  assert.equal(calls, 0);
});

test('fails closed on cross-Project, ordering, shape and continuation drift', async () => {
  for (const page of [
    { definitions: [task('task-a', { projectId: 'prj_other' })], truncated: false },
    { definitions: [task('task-b'), task('task-a')], truncated: false },
    { definitions: [task('task-a'), task('task-a')], truncated: false },
    { definitions: [task('task-a', { kind: 'invented' })], truncated: false },
    { definitions: [task('task-a')], truncated: true },
    {
      definitions: [task('task-a')],
      truncated: true,
      next: { taskId: 'task-b' },
    },
    { definitions: [], truncated: true, next: { taskId: 'task-a' } },
    { definitions: [task('task-a'), task('task-b')], truncated: false },
  ]) {
    await assert.rejects(
      executeBoundedTaskListProjection(
        { async listTaskDefinitions() { return page; } },
        'prj_default',
        page.definitions.length > 1 ? { limit: 1 } : {},
      ),
      BoundedTaskListProjectionUnavailableError,
    );
  }
  await assert.rejects(
    executeBoundedTaskListProjection(
      { async listTaskDefinitions() { throw new Error('offline'); } },
      'prj_default',
      {},
    ),
    BoundedTaskListProjectionUnavailableError,
  );
});

test('leaf import does not load Tool Registry or SemVer', () => {
  const entry = path.resolve(
    __dirname,
    '../dist/task-definition/projection/boundedTaskListProjection.js',
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
  assert.ok(Number(result.stdout) <= 4);
});
