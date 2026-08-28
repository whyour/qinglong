const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createLocalApiRunReadRoute,
} = require('../dist/run/runReadRoute.js');

function run(overrides = {}) {
  return {
    id: 'run_123',
    projectId: 'prj_default',
    taskId: 'task_1',
    taskRevision: 'revision_7',
    taskName: 'must not cross the wire',
    taskSnapshotRef: 'secret-adjacent-ref',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: 'private-user-id',
    requestId: 'private-request-id',
    status: 'running',
    version: 4,
    eventSequence: 6,
    priority: 10,
    inputRef: 'private-input-ref',
    outputRef: 'private-output-ref',
    createdAtMs: 1_000,
    queuedAtMs: 2_000,
    startedAtMs: 3_000,
    errorCode: 'private-error-code',
    errorSummary: 'private error detail',
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: 'attempt_123',
    runId: 'run_123',
    attempt: 2,
    status: 'running',
    executorType: 'local_process',
    executorHandle: 'private-executor-handle',
    logArtifactId: 'private-log-artifact-id',
    callbackSequence: 0,
    createdAtMs: 2_100,
    startedAtMs: 2_200,
    ...overrides,
  };
}

test('returns the shared bounded Run projection without secret-adjacent fields', async () => {
  const route = createLocalApiRunReadRoute({
    async findRunById(runId) {
      assert.equal(runId, 'run_123');
      return run({ version: 0 });
    },
    async findLatestAttemptByRunId(runId) {
      assert.equal(runId, 'run_123');
      return attempt();
    },
  });

  const response = await route.handle({
    projectId: 'prj_default',
    runId: 'run_123',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.run.projectId, 'prj_default');
  assert.equal(response.body.run.version, 0);
  assert.deepEqual(response.body.run.latestAttempt, {
    id: 'attempt_123',
    attempt: 2,
    status: 'running',
    logAvailable: true,
    createdAtMs: 2_100,
    startedAtMs: 2_200,
  });
  assert.equal(JSON.stringify(response).includes('private'), false);
});

test('collapses absent and cross-project Runs and fails closed on repository errors', async () => {
  for (const value of [null, run({ projectId: 'another_project' })]) {
    const route = createLocalApiRunReadRoute({
      async findRunById() {
        return value;
      },
      async findLatestAttemptByRunId() {
        throw new Error('must not inspect Attempt for an absent Run');
      },
    });
    assert.deepEqual(
      await route.handle({ projectId: 'prj_default', runId: 'run_123' }),
      { statusCode: 404, body: { code: 'run_not_found' } },
    );
  }
  const unavailable = createLocalApiRunReadRoute({
    async findRunById() {
      throw new Error('database unavailable');
    },
    async findLatestAttemptByRunId() {
      throw new Error('database unavailable');
    },
  });
  assert.deepEqual(
    await unavailable.handle({ projectId: 'prj_default', runId: 'run_123' }),
    { statusCode: 503, body: { code: 'run_query_unavailable' } },
  );
});

test('returns null without an Attempt and fails closed on invalid Attempt projections', async () => {
  const withoutAttempt = createLocalApiRunReadRoute({
    async findRunById() {
      return run();
    },
    async findLatestAttemptByRunId() {
      return null;
    },
  });
  const response = await withoutAttempt.handle({
    projectId: 'prj_default',
    runId: 'run_123',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.run.latestAttempt, null);

  const invalidAttempt = createLocalApiRunReadRoute({
    async findRunById() {
      return run();
    },
    async findLatestAttemptByRunId() {
      return attempt({ runId: 'another_run' });
    },
  });
  assert.deepEqual(
    await invalidAttempt.handle({
      projectId: 'prj_default',
      runId: 'run_123',
    }),
    { statusCode: 503, body: { code: 'run_query_unavailable' } },
  );
});
