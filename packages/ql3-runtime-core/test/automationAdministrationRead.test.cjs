const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  InvalidTaskDefinitionAdministrationReadError,
  normalizeAuthorizedTaskDefinitionInspection,
  normalizeAuthorizedTaskDefinitionList,
} = require('@qinglong/runtime-core/task-definition-administration');
const {
  InvalidTriggerAdministrationReadError,
  normalizeAuthorizedTriggerInspection,
  normalizeAuthorizedTriggerList,
} = require('@qinglong/runtime-core/trigger-administration');

const actor = Object.freeze({ type: 'user', id: 'operator-a' });
const fence = Object.freeze({ projectVersion: 3, bindingVersion: 5 });

function audit(operationId, eventId) {
  return Object.freeze({
    eventId,
    requestId: `request-${operationId}`,
    operationId,
    projectId: 'project-a',
    subject: actor,
    authenticationId: 'oidc:automation-session',
    outcome: 'allowed',
    reasons: Object.freeze(['role_grant']),
    fence,
    occurredAtMs: 1_000,
  });
}

test('normalizes exact Task inspection and bounded keyset list authority', () => {
  assert.deepEqual(
    normalizeAuthorizedTaskDefinitionInspection({
      projectId: 'project-a',
      taskId: 'task-a',
      actor,
      fence,
      audit: audit('task.read', '123e4567-e89b-42d3-a456-426614174010'),
    }),
    {
      projectId: 'project-a',
      taskId: 'task-a',
      actor,
      fence,
      audit: audit('task.read', '123e4567-e89b-42d3-a456-426614174010'),
    },
  );
  const list = normalizeAuthorizedTaskDefinitionList({
    projectId: 'project-a',
    limit: 2,
    after: { taskId: 'task-0' },
    actor,
    fence,
    audit: audit('task.read', '123e4567-e89b-42d3-a456-426614174011'),
  });
  assert.deepEqual(list.after, { taskId: 'task-0' });
  assert.equal(Object.isFrozen(list), true);
  assert.throws(
    () =>
      normalizeAuthorizedTaskDefinitionList({
        projectId: 'project-a',
        limit: 257,
        actor,
        fence,
        audit: audit('task.read', '123e4567-e89b-42d3-a456-426614174012'),
      }),
    InvalidTaskDefinitionAdministrationReadError,
  );
});

test('rejects Task read audit or actor drift before storage', () => {
  assert.throws(
    () =>
      normalizeAuthorizedTaskDefinitionInspection({
        projectId: 'project-a',
        taskId: 'task-a',
        actor,
        fence,
        audit: {
          ...audit('trigger.read', '123e4567-e89b-42d3-a456-426614174013'),
          subject: { type: 'user', id: 'operator-b' },
        },
      }),
    InvalidTaskDefinitionAdministrationReadError,
  );
});

test('normalizes exact Trigger inspection and bounded keyset list authority', () => {
  const inspection = normalizeAuthorizedTriggerInspection({
    projectId: 'project-a',
    triggerId: 'trigger-a',
    actor,
    fence,
    audit: audit('trigger.read', '123e4567-e89b-42d3-a456-426614174014'),
  });
  assert.equal(inspection.triggerId, 'trigger-a');
  const list = normalizeAuthorizedTriggerList({
    projectId: 'project-a',
    limit: 1,
    after: { triggerId: 'trigger-0' },
    actor,
    fence,
    audit: audit('trigger.read', '123e4567-e89b-42d3-a456-426614174015'),
  });
  assert.deepEqual(list.after, { triggerId: 'trigger-0' });
  assert.throws(
    () =>
      normalizeAuthorizedTriggerList({
        ...list,
        extra: true,
      }),
    InvalidTriggerAdministrationReadError,
  );
});

test('rejects Trigger read fence drift before storage', () => {
  assert.throws(
    () =>
      normalizeAuthorizedTriggerInspection({
        projectId: 'project-a',
        triggerId: 'trigger-a',
        actor,
        fence,
        audit: {
          ...audit('trigger.read', '123e4567-e89b-42d3-a456-426614174016'),
          fence: { projectVersion: 4, bindingVersion: 5 },
        },
      }),
    InvalidTriggerAdministrationReadError,
  );
});
