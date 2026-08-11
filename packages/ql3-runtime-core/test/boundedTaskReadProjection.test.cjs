const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const {
  createTaskDefinitionRecord,
} = require('../dist/task-definition/taskDefinition.js');
const {
  BoundedTaskReadProjectionUnavailableError,
  InvalidBoundedTaskReadProjectionError,
  executeBoundedTaskReadProjection,
} = require('../dist/task-definition/projection/boundedTaskReadProjection.js');

function task(overrides = {}) {
  return createTaskDefinitionRecord(
    {
      projectId: 'prj_default',
      taskId: 'task-a',
      expectedRevision: null,
      mutationId: '123e4567-e89b-42d3-a456-426614174001',
      name: 'Task A',
      description: 'must-not-cross-projection',
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: { command: { kind: 'shell', command: 'private' } },
      },
      labels: { private: 'value' },
      enabled: true,
      occurredAtMs: 20,
      ...overrides,
    },
    10,
  );
}

test('projects one exact current Task with an immutable start fence', async () => {
  const calls = [];
  const definition = task({ enabled: false });
  const result = await executeBoundedTaskReadProjection(
    {
      async findCurrentTaskDefinition(projectId, taskId) {
        calls.push([projectId, taskId]);
        return definition;
      },
    },
    'prj_default',
    'task-a',
  );
  assert.deepEqual(calls, [['prj_default', 'task-a']]);
  assert.deepEqual(result, {
    found: true,
    taskId: 'task-a',
    revision: 1,
    name: 'Task A',
    kind: 'command',
    specSchema: 'qinglong/command@v1',
    enabled: false,
    contentDigest: definition.contentDigest,
    createdAtMs: 10,
    updatedAtMs: 20,
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('must-not-cross'), false);
  assert.equal(serialized.includes('mutationId'), false);
});

test('masks absent and cross-Project current Tasks', async () => {
  assert.deepEqual(
    await executeBoundedTaskReadProjection(
      { async findCurrentTaskDefinition() { return null; } },
      'prj_default',
      'task-a',
    ),
    { found: false },
  );
  assert.deepEqual(
    await executeBoundedTaskReadProjection(
      {
        async findCurrentTaskDefinition() {
          return task({ projectId: 'prj_other' });
        },
      },
      'prj_default',
      'task-a',
    ),
    { found: false },
  );
});

test('rejects invalid input before storage', async () => {
  let calls = 0;
  const source = {
    async findCurrentTaskDefinition() {
      calls += 1;
      return null;
    },
  };
  for (const [projectId, taskId] of [
    ['', 'task-a'],
    ['prj_default', ''],
    ['prj_default', 'x'.repeat(129)],
    ['prj_default', 'task\nother'],
  ]) {
    await assert.rejects(
      executeBoundedTaskReadProjection(source, projectId, taskId),
      InvalidBoundedTaskReadProjectionError,
    );
  }
  assert.equal(calls, 0);
});

test('fails closed on corrupt identity, digest, time and repository errors', async () => {
  const definition = task();
  for (const value of [
    { ...definition, taskId: 'task-b' },
    { ...definition, contentDigest: '0'.repeat(64) },
    { ...definition, updatedAtMs: 9 },
  ]) {
    await assert.rejects(
      executeBoundedTaskReadProjection(
        { async findCurrentTaskDefinition() { return value; } },
        'prj_default',
        'task-a',
      ),
      BoundedTaskReadProjectionUnavailableError,
    );
  }
  await assert.rejects(
    executeBoundedTaskReadProjection(
      { async findCurrentTaskDefinition() { throw new Error('offline'); } },
      'prj_default',
      'task-a',
    ),
    BoundedTaskReadProjectionUnavailableError,
  );
});

test('leaf import does not load Tool Registry or SemVer', () => {
  const entry = path.resolve(
    __dirname,
    '../dist/task-definition/projection/boundedTaskReadProjection.js',
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
