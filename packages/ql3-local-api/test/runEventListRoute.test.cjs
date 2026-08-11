const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createLocalApiRunEventListRoute,
} = require('../dist/run/runEventListRoute.js');

function run(projectId = 'prj_default') {
  return { id: 'run-1', projectId };
}

function event(sequence, overrides = {}) {
  return {
    id: `event-${sequence}`,
    runId: 'run-1',
    sequence,
    type: `run.event.${sequence}`,
    actorType: 'system',
    actorId: 'private-actor',
    dedupeKey: 'private-dedupe',
    payload: { secret: 'must-not-cross-projection' },
    createdAtMs: 1_000 + sequence,
    ...overrides,
  };
}

test('returns the shared bounded Run event projection', async () => {
  const calls = [];
  const route = createLocalApiRunEventListRoute({
    async findRunById(runId) {
      calls.push(['run', runId]);
      return run();
    },
    async listEvents(runId, input) {
      calls.push(['events', runId, input]);
      return [event(3), event(4)];
    },
  });
  const response = await route.handle({
    projectId: 'prj_default',
    runId: 'run-1',
    input: { afterSequence: 2, limit: 1 },
  });
  assert.deepEqual(calls, [
    ['run', 'run-1'],
    ['events', 'run-1', { afterSequence: 2, limit: 2 }],
  ]);
  assert.deepEqual(response, {
    statusCode: 200,
    body: {
      events: [
        {
          sequence: 3,
          type: 'run.event.3',
          actorType: 'system',
          createdAtMs: 1_003,
        },
      ],
      hasMore: true,
      nextAfterSequence: 3,
    },
  });
  assert.equal(JSON.stringify(response).includes('private'), false);
  assert.equal(JSON.stringify(response).includes('secret'), false);
});

test('masks absent and cross-Project Runs and fails closed on corrupt storage', async () => {
  for (const value of [null, run('prj_other')]) {
    const route = createLocalApiRunEventListRoute({
      async findRunById() {
        return value;
      },
      async listEvents() {
        throw new Error('must not read');
      },
    });
    assert.deepEqual(
      await route.handle({
        projectId: 'prj_default',
        runId: 'run-1',
        input: {},
      }),
      { statusCode: 404, body: { code: 'run_not_found' } },
    );
  }
  const route = createLocalApiRunEventListRoute({
    async findRunById() {
      return run();
    },
    async listEvents() {
      return [event(2), event(1)];
    },
  });
  assert.deepEqual(
    await route.handle({ projectId: 'prj_default', runId: 'run-1', input: {} }),
    { statusCode: 503, body: { code: 'run_event_list_unavailable' } },
  );
});
