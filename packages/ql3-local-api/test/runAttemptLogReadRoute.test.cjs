const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  RunAttemptLogReadUnavailableError,
} = require('@qinglong/runtime-core/run-attempt-log-read');
const {
  createLocalApiRunAttemptLogReadRoute,
} = require('../dist/run/runAttemptLogReadRoute.js');

function request(overrides = {}) {
  return {
    projectId: 'prj_default',
    runId: 'run_123',
    attemptId: 'attempt_123',
    offset: 2,
    length: 16,
    ...overrides,
  };
}

test('projects an available byte range as bounded base64 JSON', async () => {
  const route = createLocalApiRunAttemptLogReadRoute({
    async read(value) {
      assert.deepEqual(value.range, { offset: 2, length: 16 });
      return {
        status: 'available',
        projectId: value.projectId,
        runId: value.runId,
        attemptId: value.attemptId,
        logArtifactId: `local-${'a'.repeat(30)}`,
        content: Buffer.from('hello'),
        start: 2,
        endExclusive: 7,
        totalBytes: 9,
        nextOffset: 7,
        truncation: { truncated: 'unknown' },
      };
    },
  });
  assert.deepEqual(await route.handle(request()), {
    statusCode: 200,
    body: {
      schema: 'qinglong/run-attempt-log-read-result@v1',
      status: 'available',
      projectId: 'prj_default',
      runId: 'run_123',
      attemptId: 'attempt_123',
      range: { start: 2, endExclusive: 7, totalBytes: 9, nextOffset: 7 },
      encoding: 'base64',
      content: Buffer.from('hello').toString('base64'),
      truncation: { truncated: 'unknown' },
    },
  });
});

test('maps pending, masked absence, missing storage and unavailable evidence', async () => {
  const cases = [
    [
      {
        status: 'pending',
        projectId: 'prj_default',
        runId: 'run_123',
        attemptId: 'attempt_123',
      },
      {
        statusCode: 202,
        body: {
          schema: 'qinglong/run-attempt-log-read-result@v1',
          status: 'pending',
          projectId: 'prj_default',
          runId: 'run_123',
          attemptId: 'attempt_123',
        },
      },
    ],
    [
      { status: 'not_found' },
      { statusCode: 404, body: { code: 'artifact_not_found' } },
    ],
    [
      {
        status: 'missing',
        projectId: 'prj_default',
        runId: 'run_123',
        attemptId: 'attempt_123',
        logArtifactId: `local-${'a'.repeat(30)}`,
      },
      { statusCode: 503, body: { code: 'artifact_unavailable' } },
    ],
    [
      {
        status: 'retired',
        projectId: 'prj_default',
        runId: 'run_123',
        attemptId: 'attempt_123',
        logArtifactId: `local-${'a'.repeat(30)}`,
        retiredAtMs: 30,
        byteLength: 42,
        truncation: { truncated: 'unknown' },
      },
      {
        statusCode: 410,
        body: {
          schema: 'qinglong/run-attempt-log-read-result@v1',
          status: 'retired',
          projectId: 'prj_default',
          runId: 'run_123',
          attemptId: 'attempt_123',
          retiredAtMs: 30,
          byteLength: 42,
          truncation: { truncated: 'unknown' },
        },
      },
    ],
  ];
  for (const [result, expected] of cases) {
    const route = createLocalApiRunAttemptLogReadRoute({
      async read() {
        return result;
      },
    });
    assert.deepEqual(await route.handle(request()), expected);
  }
  const unavailable = createLocalApiRunAttemptLogReadRoute({
    async read() {
      throw new RunAttemptLogReadUnavailableError();
    },
  });
  assert.deepEqual(await unavailable.handle(request()), {
    statusCode: 503,
    body: { code: 'artifact_unavailable' },
  });
});
