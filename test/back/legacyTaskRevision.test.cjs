require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLegacyLogArtifactId,
  createLegacyTaskRevision,
} = require('../../back/runtime/compatibility/legacyTaskRevision');

test('creates a deterministic opaque revision from execution-affecting fields', () => {
  const input = {
    command: 'node script.js --token secret-value',
    schedule: '0 * * * *',
    extraSchedules: ['30 * * * *'],
    taskBefore: 'prepare',
    taskAfter: 'cleanup',
    workDirectory: '/ql/scripts',
    logName: 'script',
    environmentRevision: 'env-v1',
    sourceRevision: 'git:abc123',
  };
  const first = createLegacyTaskRevision(input);
  const second = createLegacyTaskRevision(structuredClone(input));

  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.includes('secret-value'), false);
  assert.notEqual(
    first,
    createLegacyTaskRevision({ ...input, schedule: '1 * * * *' }),
  );
  assert.notEqual(
    first,
    createLegacyTaskRevision({ ...input, command: 'node other.js' }),
  );
});

test('preserves extra schedule order as part of the task snapshot', () => {
  const left = createLegacyTaskRevision({
    command: 'task',
    extraSchedules: ['a', 'b'],
  });
  const right = createLegacyTaskRevision({
    command: 'task',
    extraSchedules: ['b', 'a'],
  });

  assert.notEqual(left, right);
});

test('creates a bounded opaque artifact id for arbitrary legacy log paths', () => {
  const longPath = `custom/${'nested/'.repeat(100)}secret-task.log`;
  const artifactId = createLegacyLogArtifactId(longPath);

  assert.match(artifactId, /^legacy-log:[a-f0-9]{25}$/);
  assert.equal(artifactId.length <= 36, true);
  assert.equal(artifactId.includes('secret-task'), false);
  assert.equal(createLegacyLogArtifactId(longPath), artifactId);
  assert.notEqual(createLegacyLogArtifactId(`${longPath}.1`), artifactId);
});
