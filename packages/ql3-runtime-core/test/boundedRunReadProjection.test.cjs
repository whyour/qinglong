const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const {
  BoundedRunReadProjectionUnavailableError,
  executeBoundedRunReadProjection,
} = require('../dist/run/projection/boundedRunReadProjection.js');

function run(overrides = {}) {
  return {
    id: 'run_123',
    projectId: 'prj_default',
    taskId: 'task_1',
    taskRevision: 'revision_7',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 0,
    eventSequence: 2,
    priority: 10,
    createdAtMs: 1_000,
    ...overrides,
  };
}

test('projects only bounded low-sensitive Run facts', async () => {
  const projection = await executeBoundedRunReadProjection(
    { async findRunById() { return run({ privateValue: 'secret' }); } },
    'prj_default',
    'run_123',
  );
  assert.equal(projection.found, true);
  assert.equal(projection.version, 0);
  assert.equal(JSON.stringify(projection).includes('secret'), false);
});

test('collapses absence and project mismatch and rejects malformed repository facts', async () => {
  for (const value of [null, run({ projectId: 'prj_other' })]) {
    assert.deepEqual(
      await executeBoundedRunReadProjection(
        { async findRunById() { return value; } },
        'prj_default',
        'run_123',
      ),
      { found: false },
    );
  }
  await assert.rejects(
    executeBoundedRunReadProjection(
      { async findRunById() { return run({ status: 'invented' }); } },
      'prj_default',
      'run_123',
    ),
    BoundedRunReadProjectionUnavailableError,
  );
});

test('leaf import does not load Tool Registry or SemVer', () => {
  const entry = path.resolve(
    __dirname,
    '../dist/run/projection/boundedRunReadProjection.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(entry)});
       const loaded = Object.keys(require.cache);
       if (loaded.some((value) => /node_modules[\\\\/]semver(?:[\\\\/]|$)/.test(value))) process.exit(2);
       process.stdout.write(String(loaded.length));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(result.stdout) <= 4);
});
