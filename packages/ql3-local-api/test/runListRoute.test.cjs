const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createLocalApiRunListRoute } = require('../dist/run/runListRoute.js');

function run(id, createdAtMs, overrides = {}) {
  return {
    id,
    projectId: 'prj_default',
    taskId: `task-${id}`,
    taskRevision: 'revision-1',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'running',
    version: 0,
    eventSequence: 1,
    priority: 0,
    createdAtMs,
    privateValue: 'secret-adjacent',
    ...overrides,
  };
}

test('returns the shared bounded Project Run list projection', async () => {
  const calls = [];
  const route = createLocalApiRunListRoute({
    async listRunsByProject(query) {
      calls.push(query);
      return [run('run-b', 20, { triggerId: 'cron:task-b' }), run('run-a', 10)];
    },
  });
  const response = await route.handle({
    projectId: 'prj_default',
    input: { limit: 1 },
  });
  assert.deepEqual(calls, [{ projectId: 'prj_default', limit: 2 }]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.runs[0].id, 'run-b');
  assert.equal(response.body.runs[0].triggerId, 'cron:task-b');
  assert.equal(response.body.hasMore, true);
  assert.deepEqual(response.body.next, { createdAtMs: 20, runId: 'run-b' });
  assert.equal(JSON.stringify(response).includes('secret-adjacent'), false);
});

test('fails closed on cross-Project, malformed and unavailable pages', async () => {
  for (const rows of [
    [run('run-a', 10, { projectId: 'prj_other' })],
    [run('run-a', 10, { status: 'invented' })],
  ]) {
    const route = createLocalApiRunListRoute({
      async listRunsByProject() {
        return rows;
      },
    });
    assert.deepEqual(
      await route.handle({ projectId: 'prj_default', input: {} }),
      { statusCode: 503, body: { code: 'run_list_unavailable' } },
    );
  }
  const unavailable = createLocalApiRunListRoute({
    async listRunsByProject() {
      throw new Error('offline');
    },
  });
  assert.deepEqual(
    await unavailable.handle({ projectId: 'prj_default', input: {} }),
    { statusCode: 503, body: { code: 'run_list_unavailable' } },
  );
});
