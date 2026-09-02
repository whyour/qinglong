const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createPanelCronListRoute,
} = require('../dist/panel-compatibility/panelCronListRoute.js');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createTriggerRecord,
  createBuiltInTriggerSpecSemanticRegistry,
} = require('@qinglong/runtime-core/trigger');

function task(taskId, revision = 2, enabled = true) {
  return createTaskDefinitionRecord(
    {
      projectId: 'default',
      taskId,
      expectedRevision: revision - 1,
      mutationId: `019f7300-0000-4000-8000-${String(revision).padStart(
        12,
        '0',
      )}`,
      name: `Task ${taskId}`,
      kind: 'command',
      spec: {
        schema: 'qinglong/command@v1',
        config: { command: ['/bin/private'] },
      },
      labels: { private: 'redacted' },
      enabled,
      occurredAtMs: 200,
    },
    100,
  );
}

function trigger(taskRecord, triggerId, enabled = true) {
  const semantics = createBuiltInTriggerSpecSemanticRegistry();
  const spec = semantics.normalize({
    projectId: 'default',
    triggerId,
    taskId: taskRecord.taskId,
    taskRevision: taskRecord.revision,
    spec: {
      schema: 'qinglong/cron@v1',
      config: {
        expression: '0 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      },
    },
  });
  return createTriggerRecord(
    {
      projectId: 'default',
      triggerId,
      expectedRevision: null,
      mutationId: `019f7300-0000-4000-8001-${
        triggerId.endsWith('b') ? '000000000002' : '000000000001'
      }`,
      taskId: taskRecord.taskId,
      taskRevision: taskRecord.revision,
      taskContentDigest: taskRecord.contentDigest,
      spec,
      enabled,
      occurredAtMs: 400,
    },
    300,
  );
}

test('projects one bounded page of pinned QL3 cron triggers into the legacy panel envelope', async () => {
  const taskA = task('task-a');
  const taskB = task('task-b', 3, false);
  const triggers = [
    trigger(taskA, 'cron:task-a'),
    trigger(taskB, 'cron:task-b'),
  ];
  const calls = [];
  const route = createPanelCronListRoute({
    tasks: {
      async findTaskDefinitionRevision(projectId, taskId, revision) {
        calls.push(['task', projectId, taskId, revision]);
        return [taskA, taskB].find(
          (entry) => entry.taskId === taskId && entry.revision === revision,
        );
      },
    },
    triggers: {
      async listTriggers(input) {
        calls.push(['trigger', input]);
        return {
          triggers: triggers.slice(0, input.limit),
          truncated: triggers.length > input.limit,
          ...(triggers.length > input.limit
            ? { next: { triggerId: triggers[input.limit - 1].triggerId } }
            : {}),
        };
      },
    },
  });

  const first = await route.handle({
    projectId: 'default',
    page: 1,
    size: 1,
    maximumRows: 64,
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.code, 200);
  assert.equal(first.body.data.total, 2);
  assert.deepEqual(first.body.data.data, [
    {
      id: 'cron:task-a',
      name: 'Task task-a',
      command: 'ql3:command:task-a@2',
      schedule: '0 * * * *',
      extra_schedules: [],
      status: 1,
      isDisabled: 0,
      isPinned: 0,
      createdAt: new Date(300).toISOString(),
      updatedAt: new Date(400).toISOString(),
      ql3: {
        projectId: 'default',
        taskId: 'task-a',
        taskRevision: 2,
        triggerId: 'cron:task-a',
        triggerRevision: 1,
        timezone: 'UTC',
        misfirePolicy: 'skip',
        readOnly: true,
      },
    },
  ]);

  const second = await route.handle({
    projectId: 'default',
    page: 2,
    size: 1,
    maximumRows: 64,
  });
  assert.equal(second.body.data.total, 2);
  assert.equal(second.body.data.data[0].id, 'cron:task-b');
  assert.equal(second.body.data.data[0].status, 2);
  assert.equal(second.body.data.data[0].isDisabled, 1);
  assert.deepEqual(calls[0], ['trigger', { projectId: 'default', limit: 1 }]);
  assert.deepEqual(calls[2], ['trigger', { projectId: 'default', limit: 2 }]);

  const afterEnd = await route.handle({
    projectId: 'default',
    page: 3,
    size: 1,
    maximumRows: 64,
  });
  assert.deepEqual(afterEnd.body.data, { data: [], total: 2 });
});

test('fails closed for detached pins, unsupported triggers, invalid budgets and unavailable storage', async () => {
  const pinned = task('task-a');
  const cron = trigger(pinned, 'cron:task-a');
  for (const sources of [
    {
      tasks: {
        async findTaskDefinitionRevision() {
          return null;
        },
      },
      triggers: {
        async listTriggers() {
          return { triggers: [cron], truncated: false };
        },
      },
    },
    {
      tasks: {
        async findTaskDefinitionRevision() {
          return pinned;
        },
      },
      triggers: {
        async listTriggers() {
          return {
            triggers: [
              { ...cron, spec: { schema: 'vendor/event@v1', config: {} } },
            ],
            truncated: false,
          };
        },
      },
    },
    {
      tasks: {
        async findTaskDefinitionRevision() {
          return pinned;
        },
      },
      triggers: {
        async listTriggers() {
          throw new Error('offline');
        },
      },
    },
  ]) {
    const route = createPanelCronListRoute(sources);
    assert.deepEqual(
      await route.handle({
        projectId: 'default',
        page: 1,
        size: 1,
        maximumRows: 64,
      }),
      {
        statusCode: 503,
        body: { code: 503, message: 'QL3 面板兼容视图暂不可用' },
      },
    );
  }
  const route = createPanelCronListRoute({
    tasks: {
      async findTaskDefinitionRevision() {
        return pinned;
      },
    },
    triggers: {
      async listTriggers() {
        return { triggers: [], truncated: false };
      },
    },
  });
  assert.deepEqual(
    await route.handle({
      projectId: 'default',
      page: 4,
      size: 20,
      maximumRows: 64,
    }),
    {
      statusCode: 200,
      body: { code: 200, data: { data: [], total: 0 } },
    },
  );
  assert.equal(
    (
      await route.handle({
        projectId: 'default',
        page: 5,
        size: 20,
        maximumRows: 64,
      })
    ).statusCode,
    400,
  );
  assert.throws(() => createPanelCronListRoute({}), TypeError);
});
