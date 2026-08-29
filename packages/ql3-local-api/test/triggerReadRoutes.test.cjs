const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createLocalApiTriggerListRoute,
  createLocalApiTriggerReadRoute,
} = require('../dist/trigger/triggerReadRoutes.js');
const {
  TriggerUnavailableError,
  triggerContentDigest,
} = require('@qinglong/runtime-core/trigger');

function trigger(triggerId = 'cron:task-a') {
  const fields = {
    projectId: 'default',
    triggerId,
    revision: 2,
    taskId: 'task-a',
    taskRevision: 3,
    taskContentDigest: 'a'.repeat(64),
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '0 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      },
    },
    enabled: true,
  };
  return Object.freeze({
    ...fields,
    mutationId: '019f7300-0000-4000-8000-000000000001',
    contentDigest: triggerContentDigest(fields),
    createdAtMs: 100,
    updatedAtMs: 200,
  });
}

test('projects bounded Trigger summaries and one complete cron detail', async () => {
  const record = trigger();
  const source = {
    async listTriggers(input) {
      assert.deepEqual(input, { projectId: 'default', limit: 16 });
      return { triggers: [record], truncated: false };
    },
    async findCurrentTrigger(projectId, triggerId) {
      assert.equal(projectId, 'default');
      return triggerId === record.triggerId ? record : null;
    },
  };
  const list = createLocalApiTriggerListRoute(source);
  const read = createLocalApiTriggerReadRoute(source);
  const listed = await list.handle({ projectId: 'default', limit: 16 });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.triggers[0].triggerId, record.triggerId);
  assert.equal(listed.body.triggers[0].spec, undefined);
  assert.equal(listed.body.triggers[0].taskContentDigest, undefined);

  const found = await read.handle({
    projectId: 'default',
    triggerId: record.triggerId,
  });
  assert.deepEqual(found, {
    statusCode: 200,
    body: {
      trigger: {
        triggerId: record.triggerId,
        revision: 2,
        taskId: 'task-a',
        taskRevision: 3,
        specSchema: 'qinglong/cron@v1',
        enabled: true,
        contentDigest: record.contentDigest,
        createdAtMs: 100,
        updatedAtMs: 200,
        projectId: 'default',
        taskContentDigest: 'a'.repeat(64),
        spec: record.spec,
      },
    },
  });
  assert.deepEqual(
    await read.handle({ projectId: 'default', triggerId: 'missing' }),
    { statusCode: 404, body: { code: 'trigger_not_found' } },
  );
});

test('fails closed when Trigger storage is unavailable', async () => {
  const source = {
    async listTriggers() {
      throw new TriggerUnavailableError();
    },
    async findCurrentTrigger() {
      throw new TriggerUnavailableError();
    },
  };
  assert.deepEqual(
    await createLocalApiTriggerListRoute(source).handle({
      projectId: 'default',
      limit: 16,
    }),
    { statusCode: 503, body: { code: 'trigger_query_unavailable' } },
  );
  assert.deepEqual(
    await createLocalApiTriggerReadRoute(source).handle({
      projectId: 'default',
      triggerId: 'cron:task-a',
    }),
    { statusCode: 503, body: { code: 'trigger_query_unavailable' } },
  );
});
