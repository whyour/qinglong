const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const { createTriggerRecord } = require('@qinglong/runtime-core/trigger');
const {
  ClusterAutomationManagementAuthorizationError,
  ClusterAutomationManagementConflictError,
  createClusterAutomationManagementService,
} = require('@qinglong/cluster-admin/automation-management');
const {
  TaskDefinitionAdministrationMutationConflictError,
} = require('@qinglong/runtime-core/task-definition-administration');

const principal = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'operator-a' }),
  authenticationId: 'session-operator-a',
  authenticatedAtMs: 900,
  expiresAtMs: 10_000,
  assurance: 'multi_factor',
});

function taskCommand(expectedRevision = null) {
  return {
    projectId: 'project-a',
    taskId: 'task-a',
    expectedRevision,
    mutationId:
      expectedRevision === null
        ? '123e4567-e89b-42d3-a456-426614174000'
        : '123e4567-e89b-42d3-a456-426614174001',
    name: 'Sensitive command name',
    kind: 'script',
    spec: {
      schema: 'qinglong/script@v1',
      config: { source: 'sensitive source text' },
    },
    labels: { environment: 'test' },
    enabled: true,
    occurredAtMs: 1_000,
  };
}

function triggerCommand(expectedRevision = null) {
  return {
    projectId: 'project-a',
    triggerId: 'trigger-a',
    expectedRevision,
    mutationId:
      expectedRevision === null
        ? '123e4567-e89b-42d3-a456-426614174002'
        : '123e4567-e89b-42d3-a456-426614174003',
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
  };
}

function fixture(effect = 'allow') {
  const calls = [];
  const service = createClusterAutomationManagementService({
    policy: {
      async authorize(candidate, projectId, permission) {
        calls.push(['authorize', candidate, projectId, permission]);
        return {
          effect,
          reasons: [effect === 'allow' ? 'role_grant' : 'permission_missing'],
          fence: { projectVersion: 3, bindingVersion: 5 },
        };
      },
    },
    taskDefinitions: {
      async appendAuthorizedTaskDefinitionRevision(mutation) {
        calls.push(['task', mutation]);
        return {
          status:
            mutation.command.expectedRevision === null ? 'created' : 'updated',
          definition: createTaskDefinitionRecord(mutation.command, 900),
        };
      },
      async findAuthorizedCurrentTaskDefinition(read) {
        calls.push(['task-inspect', read]);
        return createTaskDefinitionRecord(taskCommand(), 900);
      },
      async listAuthorizedTaskDefinitions(read) {
        calls.push(['task-list', read]);
        return {
          definitions: [createTaskDefinitionRecord(taskCommand(), 900)],
          truncated: true,
          next: { taskId: 'task-a' },
        };
      },
    },
    triggers: {
      async appendAuthorizedTriggerRevision(mutation) {
        calls.push(['trigger', mutation]);
        return {
          status:
            mutation.command.expectedRevision === null ? 'created' : 'updated',
          trigger: createTriggerRecord(mutation.command, 900),
        };
      },
      async findAuthorizedCurrentTrigger(read) {
        calls.push(['trigger-inspect', read]);
        return createTriggerRecord(triggerCommand(), 900);
      },
      async listAuthorizedTriggers(read) {
        calls.push(['trigger-list', read]);
        return {
          triggers: [createTriggerRecord(triggerCommand(), 900)],
          truncated: false,
        };
      },
    },
    now: () => 1_100,
  });
  return { service, calls };
}

test('authorizes Task and Trigger create/update and binds allowed audit to the repository fence', async () => {
  const { service, calls } = fixture();
  await service.publishTask({
    requestId: 'request-task-create',
    command: taskCommand(),
    principal,
  });
  await service.publishTask({
    requestId: 'request-task-update',
    command: taskCommand(1),
    principal,
  });
  await service.publishTrigger({
    requestId: 'request-trigger-create',
    command: triggerCommand(),
    principal,
  });
  await service.publishTrigger({
    requestId: 'request-trigger-update',
    command: triggerCommand(1),
    principal,
  });
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'authorize').map((call) => call[3]),
    ['task.create', 'task.update', 'trigger.create', 'trigger.update'],
  );
  for (const [kind, mutation] of calls.filter(([kind]) =>
    ['task', 'trigger'].includes(kind),
  )) {
    assert.deepEqual(mutation.actor, principal.subject);
    assert.deepEqual(mutation.fence, {
      projectVersion: 3,
      bindingVersion: 5,
    });
    assert.equal(mutation.audit.outcome, 'allowed');
    assert.equal(mutation.audit.authenticationId, principal.authenticationId);
    assert.equal(mutation.audit.eventId, mutation.command.mutationId);
    assert.equal(
      mutation.audit.operationId,
      `${kind}.${mutation.command.expectedRevision === null ? 'create' : 'update'}`,
    );
  }
});

test('fails closed before mutation on weak identity or denied policy', async () => {
  const denied = fixture('deny');
  await assert.rejects(
    denied.service.publishTask({
      requestId: 'request-denied',
      command: taskCommand(),
      principal,
    }),
    ClusterAutomationManagementAuthorizationError,
  );
  assert.equal(denied.calls.some(([kind]) => kind === 'task'), false);

  const allowed = fixture();
  await assert.rejects(
    allowed.service.publishTrigger({
      requestId: 'request-weak',
      command: triggerCommand(),
      principal: { ...principal, assurance: 'single_factor' },
    }),
    ClusterAutomationManagementAuthorizationError,
  );
  assert.equal(allowed.calls.length, 0);
});

test('authorizes bounded Task and Trigger reads and binds each durable audit fence', async () => {
  const { service, calls } = fixture();
  const task = await service.inspectTask({
    requestId: 'request-task-inspect',
    auditEventId: '123e4567-e89b-42d3-a456-426614174010',
    projectId: 'project-a',
    taskId: 'task-a',
    principal,
  });
  const tasks = await service.listTasks({
    requestId: 'request-task-list',
    auditEventId: '123e4567-e89b-42d3-a456-426614174011',
    projectId: 'project-a',
    limit: 1,
    principal,
  });
  const trigger = await service.inspectTrigger({
    requestId: 'request-trigger-inspect',
    auditEventId: '123e4567-e89b-42d3-a456-426614174012',
    projectId: 'project-a',
    triggerId: 'trigger-a',
    principal,
  });
  const triggers = await service.listTriggers({
    requestId: 'request-trigger-list',
    auditEventId: '123e4567-e89b-42d3-a456-426614174013',
    projectId: 'project-a',
    limit: 1,
    after: { triggerId: 'trigger-0' },
    principal,
  });
  assert.equal(task.taskId, 'task-a');
  assert.equal(tasks.truncated, true);
  assert.equal(trigger.triggerId, 'trigger-a');
  assert.equal(triggers.truncated, false);
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'authorize').map((call) => call[3]),
    ['task.read', 'task.read', 'trigger.read', 'trigger.read'],
  );
  for (const [kind, read] of calls.filter(([kind]) => kind.includes('-'))) {
    assert.equal(read.audit.operationId, kind.startsWith('task') ? 'task.read' : 'trigger.read');
    assert.equal(read.audit.outcome, 'allowed');
    assert.deepEqual(read.actor, principal.subject);
    assert.deepEqual(read.fence, { projectVersion: 3, bindingVersion: 5 });
  }
});

test('maps durable mutation conflicts without leaking repository details', async () => {
  const conflicting = createClusterAutomationManagementService({
    policy: {
      async authorize() {
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 1, bindingVersion: 1 },
        };
      },
    },
    taskDefinitions: {
      async appendAuthorizedTaskDefinitionRevision() {
        throw new TaskDefinitionAdministrationMutationConflictError();
      },
      async findAuthorizedCurrentTaskDefinition() { return null; },
      async listAuthorizedTaskDefinitions() {
        return { definitions: [], truncated: false };
      },
    },
    triggers: {
      async appendAuthorizedTriggerRevision() {
        throw new Error('unused');
      },
      async findAuthorizedCurrentTrigger() { return null; },
      async listAuthorizedTriggers() {
        return { triggers: [], truncated: false };
      },
    },
    now: () => 1_100,
  });
  await assert.rejects(
    conflicting.publishTask({
      requestId: 'request-conflict',
      command: taskCommand(),
      principal,
    }),
    ClusterAutomationManagementConflictError,
  );
});
