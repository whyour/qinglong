const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const { createTriggerRecord } = require('@qinglong/runtime-core/trigger');
const {
  ClusterAutomationManagementTransportAuthenticationError,
  ClusterAutomationManagementTransportRequestError,
  createClusterAutomationManagementTransport,
} = require('@qinglong/cluster-admin/automation-management-transport');

const principal = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'operator-a' }),
  authenticationId: 'session-operator-a',
  authenticatedAtMs: 900,
  expiresAtMs: 10_000,
  assurance: 'hardware',
});
const taskCommand = Object.freeze({
  projectId: 'project-a',
  taskId: 'task-a',
  expectedRevision: null,
  mutationId: '123e4567-e89b-42d3-a456-426614174000',
  name: 'Sensitive task name',
  kind: 'script',
  spec: {
    schema: 'qinglong/script@v1',
    config: { source: 'sensitive script body' },
  },
  labels: {},
  enabled: true,
  occurredAtMs: 1_000,
});
const triggerCommand = Object.freeze({
  projectId: 'project-a',
  triggerId: 'trigger-a',
  expectedRevision: null,
  mutationId: '123e4567-e89b-42d3-a456-426614174002',
  taskId: 'task-a',
  taskRevision: 1,
  taskContentDigest: 'a'.repeat(64),
  spec: {
    schema: 'qinglong/cron@v1',
    config: {
      expression: '*/5 * * * *',
      timezone: 'UTC',
      misfirePolicy: 'fire_once',
    },
  },
  enabled: true,
  occurredAtMs: 1_000,
});

test('routes strong User Task/Trigger publications and returns only low-sensitive summaries', async () => {
  const calls = [];
  const transport = createClusterAutomationManagementTransport({
    service: {
      async publishTask(request) {
        calls.push(['task', request]);
        return {
          status: 'created',
          definition: createTaskDefinitionRecord(request.command, 900),
        };
      },
      async publishTrigger(request) {
        calls.push(['trigger', request]);
        return {
          status: 'created',
          trigger: createTriggerRecord(request.command, 900),
        };
      },
      async inspectTask(request) {
        calls.push(['task-inspect', request]);
        return createTaskDefinitionRecord(taskCommand, 900);
      },
      async listTasks(request) {
        calls.push(['task-list', request]);
        return {
          definitions: [createTaskDefinitionRecord(taskCommand, 900)],
          truncated: true,
          next: { taskId: 'task-a' },
        };
      },
      async inspectTrigger(request) {
        calls.push(['trigger-inspect', request]);
        return null;
      },
      async listTriggers(request) {
        calls.push(['trigger-list', request]);
        return {
          triggers: [createTriggerRecord(triggerCommand, 900)],
          truncated: false,
        };
      },
    },
    now: () => 1_100,
  });
  const authentication = { async authenticate() { return principal; } };
  const task = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'task.publish',
      request: { requestId: 'request-task', command: taskCommand },
    },
    authentication,
  );
  const trigger = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'trigger.publish',
      request: { requestId: 'request-trigger', command: triggerCommand },
    },
    authentication,
  );
  const taskInspection = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'task.inspect',
      request: {
        requestId: 'request-task-inspect',
        auditEventId: '123e4567-e89b-42d3-a456-426614174010',
        projectId: 'project-a',
        taskId: 'task-a',
      },
    },
    authentication,
  );
  const taskList = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'task.list',
      request: {
        requestId: 'request-task-list',
        auditEventId: '123e4567-e89b-42d3-a456-426614174011',
        projectId: 'project-a',
        limit: 1,
      },
    },
    authentication,
  );
  const triggerInspection = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'trigger.inspect',
      request: {
        requestId: 'request-trigger-inspect',
        auditEventId: '123e4567-e89b-42d3-a456-426614174012',
        projectId: 'project-a',
        triggerId: 'trigger-a',
      },
    },
    authentication,
  );
  const triggerList = await transport.execute(
    {
      schemaVersion: 1,
      operation: 'trigger.list',
      request: {
        requestId: 'request-trigger-list',
        auditEventId: '123e4567-e89b-42d3-a456-426614174013',
        projectId: 'project-a',
        limit: 1,
      },
    },
    authentication,
  );
  assert.deepEqual(calls.map(([kind]) => kind), [
    'task',
    'trigger',
    'task-inspect',
    'task-list',
    'trigger-inspect',
    'trigger-list',
  ]);
  assert.deepEqual(calls.map(([, request]) => request.principal), [
    principal,
    principal,
    principal,
    principal,
    principal,
    principal,
  ]);
  assert.equal(task.task.contentDigest.length, 64);
  assert.equal(trigger.trigger.taskContentDigest, 'a'.repeat(64));
  assert.equal(taskInspection.status, 'found');
  assert.equal(taskList.next.taskId, 'task-a');
  assert.equal(triggerInspection.status, 'absent');
  assert.equal(triggerList.next, null);
  const serialized = JSON.stringify([
    task,
    trigger,
    taskInspection,
    taskList,
    triggerInspection,
    triggerList,
  ]);
  assert.doesNotMatch(serialized, /Sensitive|script body|expression|authenticationId|mutationId/);
});

test('rejects malformed envelopes and weak identities before service authority', async () => {
  let calls = 0;
  const transport = createClusterAutomationManagementTransport({
    service: {
      async publishTask() { calls += 1; },
      async publishTrigger() { calls += 1; },
      async inspectTask() { calls += 1; },
      async listTasks() { calls += 1; },
      async inspectTrigger() { calls += 1; },
      async listTriggers() { calls += 1; },
    },
    now: () => 1_100,
  });
  await assert.rejects(
    transport.execute(
      { schemaVersion: 1, operation: 'task.publish', request: {}, extra: true },
      { async authenticate() { return principal; } },
    ),
    ClusterAutomationManagementTransportRequestError,
  );
  await assert.rejects(
    transport.execute(
      {
        schemaVersion: 1,
        operation: 'task.publish',
        request: { requestId: 'request-task', command: taskCommand },
      },
      { async authenticate() { return { ...principal, assurance: 'single_factor' }; } },
    ),
    ClusterAutomationManagementTransportAuthenticationError,
  );
  assert.equal(calls, 0);
});
