const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  TaskDefinitionConflictError,
  TaskDefinitionUnavailableError,
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');
const {
  TriggerConflictError,
  TriggerUnavailableError,
  createBuiltInTriggerSpecSemanticRegistry,
  createTriggerRecord,
} = require('@qinglong/runtime-core/trigger');
const {
  compileClusterCommandTaskDefinition,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  TaskDefinitionAdministrationAuthorizationFenceConflictError,
  TaskDefinitionAdministrationMutationConflictError,
  TaskDefinitionAdministrationReadConflictError,
} = require('@qinglong/runtime-core/task-definition-administration');
const {
  TriggerAdministrationAuthorizationFenceConflictError,
  TriggerAdministrationReadConflictError,
} = require('@qinglong/runtime-core/trigger-administration');
const {
  PostgresTaskDefinitionRepository,
  PostgresTaskDefinitionSource,
  PostgresTaskExecutionRevisionSource,
} = require('../dist/automation/taskDefinitionRepository');
const {
  PostgresTriggerRepository,
  PostgresTriggerSource,
} = require('../dist/scheduling/triggerRepository');
const {
  PostgresTaskDefinitionAdministrationRepository,
  PostgresTriggerAdministrationRepository,
} = require('../dist/automation/automationAdministrationRepository');

const TASK_COMMAND = Object.freeze({
  projectId: 'default',
  taskId: 'task-00001',
  expectedRevision: null,
  mutationId: '123e4567-e89b-42d3-a456-426614174001',
  name: 'Task 1',
  kind: 'command',
  spec: Object.freeze({
    schema: 'qinglong/command@v1',
    config: Object.freeze({
      command: Object.freeze({
        kind: 'argv',
        file: '/bin/echo',
        args: Object.freeze(['1']),
      }),
    }),
  }),
  labels: Object.freeze({ source: 'postgres-test' }),
  enabled: true,
  occurredAtMs: 101,
});

const NORMALIZED_TASK_COMMAND = Object.freeze({
  ...TASK_COMMAND,
  spec: createBuiltInTaskSpecSemanticRegistry().normalize({
    projectId: TASK_COMMAND.projectId,
    taskId: TASK_COMMAND.taskId,
    kind: TASK_COMMAND.kind,
    spec: TASK_COMMAND.spec,
  }),
});
const TASK = createTaskDefinitionRecord(
  NORMALIZED_TASK_COMMAND,
  TASK_COMMAND.occurredAtMs,
);
const DRIFT_TASK = createTaskDefinitionRecord(
  Object.freeze({ ...NORMALIZED_TASK_COMMAND, name: 'drift' }),
  TASK_COMMAND.occurredAtMs,
);
const TASK_EXECUTION = compileClusterCommandTaskDefinition(
  TASK,
  createBuiltInTaskSpecSemanticRegistry(),
);

const TRIGGER_COMMAND = Object.freeze({
  projectId: 'default',
  triggerId: 'trigger-00001',
  expectedRevision: null,
  mutationId: '123e4567-e89b-42d3-a456-426614174002',
  taskId: TASK.taskId,
  taskRevision: TASK.revision,
  taskContentDigest: TASK.contentDigest,
  spec: Object.freeze({
    schema: 'qinglong/cron@v1',
    config: Object.freeze({
      expression: '*/5 * * * *',
      timezone: 'Etc/UTC',
      misfirePolicy: 'skip',
    }),
  }),
  enabled: true,
  occurredAtMs: 201,
});
const NORMALIZED_TRIGGER_COMMAND = Object.freeze({
  ...TRIGGER_COMMAND,
  spec: createBuiltInTriggerSpecSemanticRegistry().normalize({
    projectId: TRIGGER_COMMAND.projectId,
    triggerId: TRIGGER_COMMAND.triggerId,
    taskId: TRIGGER_COMMAND.taskId,
    taskRevision: TRIGGER_COMMAND.taskRevision,
    spec: TRIGGER_COMMAND.spec,
  }),
});
const TRIGGER = createTriggerRecord(
  NORMALIZED_TRIGGER_COMMAND,
  TRIGGER_COMMAND.occurredAtMs,
);
const DRIFT_TRIGGER = createTriggerRecord(
  Object.freeze({ ...NORMALIZED_TRIGGER_COMMAND, enabled: false }),
  TRIGGER_COMMAND.occurredAtMs,
);
const ACTOR = Object.freeze({ type: 'user', id: 'usr_cluster_admin' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });
const TASK_AUDIT = Object.freeze({
  eventId: TASK_COMMAND.mutationId,
  requestId: 'request-task-create-00001',
  operationId: 'task.create',
  projectId: TASK_COMMAND.projectId,
  subject: ACTOR,
  authenticationId: 'oidc:session-task-00001',
  outcome: 'allowed',
  reasons: Object.freeze(['role_grant']),
  fence: FENCE,
  occurredAtMs: 102,
});
const TRIGGER_AUDIT = Object.freeze({
  ...TASK_AUDIT,
  eventId: TRIGGER_COMMAND.mutationId,
  requestId: 'request-trigger-create-00001',
  operationId: 'trigger.create',
  occurredAtMs: 202,
});
const TASK_READ_AUDIT = Object.freeze({
  ...TASK_AUDIT,
  eventId: '123e4567-e89b-42d3-a456-426614174010',
  requestId: 'request-task-read-00001',
  operationId: 'task.read',
  occurredAtMs: 302,
});
const TRIGGER_READ_AUDIT = Object.freeze({
  ...TASK_AUDIT,
  eventId: '123e4567-e89b-42d3-a456-426614174011',
  requestId: 'request-trigger-read-00001',
  operationId: 'trigger.read',
  occurredAtMs: 303,
});

function administrationAuditRow(audit) {
  return {
    auditEventId: audit.eventId,
    auditRequestId: audit.requestId,
    auditOperationId: audit.operationId,
    auditProjectId: audit.projectId,
    auditSubjectType: audit.subject.type,
    auditSubjectId: audit.subject.id,
    auditAuthenticationId: audit.authenticationId,
    auditOutcome: audit.outcome,
    auditReasons: [...audit.reasons],
    auditProjectVersion: audit.fence.projectVersion,
    auditBindingVersion: audit.fence.bindingVersion,
    auditOccurredAtMs: String(audit.occurredAtMs),
  };
}

function taskRow(overrides = {}) {
  return {
    projectId: TASK.projectId,
    taskId: TASK.taskId,
    revision: TASK.revision,
    mutationId: TASK.mutationId,
    name: TASK.name,
    description: null,
    kind: TASK.kind,
    specJson: TASK.spec,
    labelsJson: TASK.labels,
    enabled: TASK.enabled,
    contentDigest: TASK.contentDigest,
    createdAtMs: String(TASK.createdAtMs),
    updatedAtMs: String(TASK.updatedAtMs),
    ...overrides,
  };
}

function triggerRow(overrides = {}) {
  return {
    projectId: TRIGGER.projectId,
    triggerId: TRIGGER.triggerId,
    revision: TRIGGER.revision,
    mutationId: TRIGGER.mutationId,
    taskId: TRIGGER.taskId,
    taskRevision: TRIGGER.taskRevision,
    taskContentDigest: TRIGGER.taskContentDigest,
    specJson: TRIGGER.spec,
    enabled: TRIGGER.enabled,
    contentDigest: TRIGGER.contentDigest,
    createdAtMs: String(TRIGGER.createdAtMs),
    updatedAtMs: String(TRIGGER.updatedAtMs),
    ...overrides,
  };
}

function taskExecutionRow(overrides = {}) {
  return {
    projectId: TASK_EXECUTION.projectId,
    taskId: TASK_EXECUTION.taskId,
    sourceRevision: TASK_EXECUTION.sourceRevision,
    taskRevision: TASK_EXECUTION.taskRevision,
    sourceContentDigest: TASK_EXECUTION.sourceContentDigest,
    executorType: TASK_EXECUTION.executorType,
    planSchema: TASK_EXECUTION.planSchema,
    planJson: {
      command: TASK_EXECUTION.command,
      environment: TASK_EXECUTION.environment,
      ...(TASK_EXECUTION.workingDirectory === undefined
        ? {}
        : { workingDirectory: TASK_EXECUTION.workingDirectory }),
      ...(TASK_EXECUTION.timeoutMs === undefined
        ? {}
        : { timeoutMs: TASK_EXECUTION.timeoutMs }),
      ...(TASK_EXECUTION.placement === undefined
        ? {}
        : { placement: TASK_EXECUTION.placement }),
    },
    contentDigest: TASK_EXECUTION.contentDigest,
    createdAtMs: String(TASK_EXECUTION.createdAtMs),
    ...overrides,
  };
}

function sourcePool(rows) {
  const queries = [];
  return {
    queries,
    pool: {
      async query(text, values) {
        queries.push({ text, values });
        return { rows };
      },
      async connect() {
        throw new Error('not used');
      },
    },
  };
}

function appendPool(kind, options = {}) {
  const events = [];
  const queries = [];
  let connection = 0;
  return {
    events,
    queries,
    pool: {
      async query() {
        throw new Error('not used');
      },
      async connect() {
        connection += 1;
        return {
          async query(text, values) {
            events.push(text.trim().split('\n', 1)[0]);
            queries.push({ text, values });
            if (text.includes('WHERE revision.mutation_id = $1')) {
              return {
                rows: options.replay
                  ? [kind === 'task' ? taskRow(options.replay) : triggerRow(options.replay)]
                  : [],
              };
            }
            if (text.includes('FROM "ql3"."task_execution_revisions"')) {
              return {
                rows: options.missingExecution ? [] : [taskExecutionRow()],
              };
            }
            if (text.includes('FROM "ql3"."trigger_schedules"')) {
              return {
                rows: options.missingSchedule
                  ? []
                  : [{ triggerRevision: TRIGGER.revision }],
              };
            }
            if (text.includes('FROM "ql3"."projects"')) {
              return {
                rows: [{
                  status: options.projectStatus ?? 'active',
                  version: options.projectVersion ?? 1,
                }],
              };
            }
            if (text.includes('FROM "ql3"."project_role_bindings"')) {
              return {
                rows: options.missingBinding
                  ? []
                  : [{
                      version: options.bindingVersion ?? 1,
                      state: options.bindingState ?? 'active',
                    }],
              };
            }
            if (text.includes('FROM "ql3"."security_audit_events"')) {
              return {
                rows: options.audit ? [administrationAuditRow(options.audit)] : [],
              };
            }
            if (text.includes('INSERT INTO "ql3"."task_definitions"')) {
              return { rows: [{ taskId: TASK.taskId }], rowCount: 1 };
            }
            if (text.includes('FROM "ql3"."task_definitions"') &&
                text.includes('FOR UPDATE')) {
              return {
                rows: [{
                  currentRevision: 1,
                  createdAtMs: '101',
                  updatedAtMs: '101',
                }],
              };
            }
            if (text.includes('INSERT INTO "ql3"."task_definition_revisions"')) {
              if (options.retryOnce && connection === 1) {
                throw Object.assign(new Error('serialization'), { code: '40001' });
              }
              return { rows: [], rowCount: 1 };
            }
            if (text.includes('INSERT INTO "ql3"."triggers"')) {
              return { rows: [{ triggerId: TRIGGER.triggerId }], rowCount: 1 };
            }
            if (text.includes('FROM "ql3"."triggers"') &&
                text.includes('FOR UPDATE')) {
              return {
                rows: [{
                  taskId: TASK.taskId,
                  currentRevision: 1,
                  createdAtMs: '201',
                  updatedAtMs: '201',
                }],
              };
            }
            if (text.includes('FROM "ql3"."task_definitions"') &&
                text.includes('revision.revision = $3')) {
              return { rows: options.missingTask ? [] : [taskRow(options.task)] };
            }
            if (text.includes('FROM "ql3"."task_definitions"') &&
                text.includes('JOIN "ql3"."task_definition_revisions"')) {
              return { rows: options.readAbsent ? [] : [taskRow(options.task)] };
            }
            if (text.includes('FROM "ql3"."triggers"') &&
                text.includes('JOIN "ql3"."trigger_revisions"')) {
              return {
                rows: options.readAbsent ? [] : [triggerRow(options.trigger)],
              };
            }
            if (text.includes('INSERT INTO "ql3"."trigger_revisions"')) {
              return { rows: [], rowCount: 1 };
            }
            return { rows: [], rowCount: 1 };
          },
          release() {
            events.push(`release:${connection}`);
          },
        };
      },
    },
  };
}

test('runtime sources read normalized immutable facts without write authority', async () => {
  const taskFixture = sourcePool([taskRow()]);
  const taskSource = new PostgresTaskDefinitionSource(taskFixture.pool);
  assert.deepEqual(
    await taskSource.findCurrentTaskDefinition(TASK.projectId, TASK.taskId),
    TASK,
  );
  assert.equal('appendTaskDefinitionRevision' in taskSource, false);
  assert.deepEqual(taskFixture.queries[0].values, [TASK.projectId, TASK.taskId]);
  const listed = sourcePool([taskRow()]);
  assert.equal(
    (await new PostgresTaskDefinitionSource(listed.pool).listTaskDefinitions({
      projectId: TASK.projectId,
      limit: 1,
    })).definitions.length,
    1,
  );
  assert.equal(
    (listed.queries[0].text.match(/ORDER BY/g) ?? []).length,
    1,
  );

  const executionSource = new PostgresTaskExecutionRevisionSource(
    sourcePool([taskExecutionRow()]).pool,
  );
  assert.deepEqual(
    await executionSource.resolveClusterTaskExecutionRevision({
      projectId: TASK.projectId,
      taskId: TASK.taskId,
      sourceRevision: TASK.revision,
    }),
    TASK_EXECUTION,
  );

  const triggerFixture = sourcePool([triggerRow()]);
  const triggerSource = new PostgresTriggerSource(triggerFixture.pool);
  assert.deepEqual(
    await triggerSource.findCurrentTrigger(TRIGGER.projectId, TRIGGER.triggerId),
    TRIGGER,
  );
  assert.equal('appendTriggerRevision' in triggerSource, false);
});

test('publishes TaskDefinition atomically and replays the exact mutation', async () => {
  const fixture = appendPool('task');
  const created = await new PostgresTaskDefinitionRepository(
    fixture.pool,
  ).appendTaskDefinitionRevision(TASK_COMMAND);
  assert.deepEqual(created, { status: 'created', definition: TASK });
  assert.ok(fixture.events.includes('BEGIN ISOLATION LEVEL SERIALIZABLE'));
  assert.ok(fixture.events.includes('COMMIT'));
  assert.equal(
    fixture.events.some((event) =>
      event.includes('INSERT INTO "ql3"."task_execution_revisions"'),
    ),
    true,
  );
  assert.equal(fixture.events.at(-1), 'release:1');

  const replayFixture = appendPool('task', { replay: {} });
  assert.deepEqual(
    await new PostgresTaskDefinitionRepository(
      replayFixture.pool,
    ).appendTaskDefinitionRevision(TASK_COMMAND),
    { status: 'existing', definition: TASK },
  );
  assert.equal(
    replayFixture.events.some((event) => event.includes('INSERT INTO')),
    false,
  );
});

test('persists only the pinned environment bundle reference in an execution plan', async () => {
  const environmentBundleRef = createSecretRef({
    projectId: TASK_COMMAND.projectId,
    name: 'legacy-env-bundle',
    version: 7,
  });
  const command = {
    ...TASK_COMMAND,
    taskId: 'task-bundle-00001',
    mutationId: '123e4567-e89b-42d3-a456-426614174021',
    spec: {
      ...TASK_COMMAND.spec,
      config: { ...TASK_COMMAND.spec.config, environmentBundleRef },
    },
  };
  const fixture = appendPool('task');
  await new PostgresTaskDefinitionRepository(
    fixture.pool,
  ).appendTaskDefinitionRevision(command);
  const insert = fixture.queries.find(({ text }) =>
    text.includes('INSERT INTO "ql3"."task_execution_revisions"'),
  );
  const plan = JSON.parse(insert.values[7]);
  assert.equal(plan.environmentBundleRef, environmentBundleRef);
  assert.deepEqual(plan.environment, []);
  assert.equal(JSON.stringify(plan).includes('LEGACY_ENV_NAME'), false);
});

test('runs TaskDefinition transaction hooks for create and replay before COMMIT', async () => {
  const createdFixture = appendPool('task');
  const createdHook = [];
  await new PostgresTaskDefinitionRepository(
    createdFixture.pool,
  ).appendTaskDefinitionRevision(TASK_COMMAND, async (client, context) => {
    createdHook.push(context);
    await client.query('SELECT 1 AS task_hook');
  });
  assert.equal(createdHook.length, 1);
  assert.equal(createdHook[0].replay, null);
  assert.deepEqual(createdHook[0].record, TASK);
  assert.ok(
    createdFixture.events.indexOf('SELECT 1 AS task_hook') <
      createdFixture.events.indexOf('COMMIT'),
  );

  const replayFixture = appendPool('task', { replay: {} });
  const replayHook = [];
  await new PostgresTaskDefinitionRepository(
    replayFixture.pool,
  ).appendTaskDefinitionRevision(TASK_COMMAND, async (_client, context) => {
    replayHook.push(context);
  });
  assert.deepEqual(replayHook[0].replay, TASK);
  assert.deepEqual(replayHook[0].record, TASK);

  const deniedFixture = appendPool('task');
  const denial = new Error('task authorization fence changed');
  await assert.rejects(
    new PostgresTaskDefinitionRepository(
      deniedFixture.pool,
    ).appendTaskDefinitionRevision(TASK_COMMAND, async () => {
      throw denial;
    }),
    (error) => error === denial,
  );
  assert.equal(deniedFixture.events.includes('ROLLBACK'), true);
  assert.equal(deniedFixture.events.includes('COMMIT'), false);
});

test('retries serialization and fails closed on TaskDefinition drift or corruption', async () => {
  const retry = appendPool('task', { retryOnce: true });
  assert.equal(
    (
      await new PostgresTaskDefinitionRepository(
        retry.pool,
      ).appendTaskDefinitionRevision(TASK_COMMAND)
    ).status,
    'created',
  );
  assert.equal(retry.events.filter((event) => event.startsWith('release:')).length, 2);

  await assert.rejects(
    new PostgresTaskDefinitionRepository(
      appendPool('task', {
        replay: {
          name: DRIFT_TASK.name,
          contentDigest: DRIFT_TASK.contentDigest,
        },
      }).pool,
    ).appendTaskDefinitionRevision(TASK_COMMAND),
    TaskDefinitionConflictError,
  );
  await assert.rejects(
    new PostgresTaskDefinitionRepository(
      appendPool('task', { replay: {}, missingExecution: true }).pool,
    ).appendTaskDefinitionRevision(TASK_COMMAND),
    TaskDefinitionUnavailableError,
  );
  await assert.rejects(
    new PostgresTaskDefinitionSource(sourcePool([
      taskRow({ contentDigest: 'b'.repeat(64) }),
    ]).pool).findCurrentTaskDefinition(TASK.projectId, TASK.taskId),
    TaskDefinitionUnavailableError,
  );
});

test('publishes Trigger only when its immutable task pin is valid', async () => {
  const fixture = appendPool('trigger');
  const created = await new PostgresTriggerRepository(
    fixture.pool,
  ).appendTriggerRevision(TRIGGER_COMMAND);
  assert.deepEqual(created, { status: 'created', trigger: TRIGGER });
  assert.ok(
    fixture.events.findIndex((event) => event.includes('task_definitions')) <
      fixture.events.findIndex((event) => event.includes('trigger_revisions')),
  );
  assert.equal(
    fixture.events.some((event) =>
      event.includes('INSERT INTO "ql3"."trigger_schedules"'),
    ),
    true,
  );
  const createdPin = fixture.queries.find(({ text }) =>
    text.includes('$4::boolean = false'),
  );
  assert.equal(createdPin.values[3], true);

  const replayFixture = appendPool('trigger', { replay: {} });
  assert.deepEqual(
    await new PostgresTriggerRepository(
      replayFixture.pool,
    ).appendTriggerRevision(TRIGGER_COMMAND),
    { status: 'existing', trigger: TRIGGER },
  );
  const replayPin = replayFixture.queries.find(({ text }) =>
    text.includes('$4::boolean = false'),
  );
  assert.equal(replayPin.values[3], false);

  await assert.rejects(
    new PostgresTriggerRepository(
      appendPool('trigger', { missingTask: true }).pool,
    ).appendTriggerRevision(TRIGGER_COMMAND),
    TriggerConflictError,
  );
  await assert.rejects(
    new PostgresTriggerRepository(
      appendPool('trigger', { task: { contentDigest: 'b'.repeat(64) } }).pool,
    ).appendTriggerRevision(TRIGGER_COMMAND),
    TriggerUnavailableError,
  );
});

test('runs Trigger transaction hooks atomically and preserves hook failures', async () => {
  const createdFixture = appendPool('trigger');
  const contexts = [];
  await new PostgresTriggerRepository(
    createdFixture.pool,
  ).appendTriggerRevision(TRIGGER_COMMAND, async (client, context) => {
    contexts.push(context);
    await client.query('SELECT 1 AS trigger_hook');
  });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].replay, null);
  assert.deepEqual(contexts[0].record, TRIGGER);
  assert.ok(
    createdFixture.events.indexOf('SELECT 1 AS trigger_hook') <
      createdFixture.events.indexOf('COMMIT'),
  );

  const replayFixture = appendPool('trigger', { replay: {} });
  await new PostgresTriggerRepository(
    replayFixture.pool,
  ).appendTriggerRevision(TRIGGER_COMMAND, async (_client, context) => {
    contexts.push(context);
  });
  assert.deepEqual(contexts[1].replay, TRIGGER);

  const deniedFixture = appendPool('trigger');
  const denial = new Error('trigger authorization fence changed');
  await assert.rejects(
    new PostgresTriggerRepository(
      deniedFixture.pool,
    ).appendTriggerRevision(TRIGGER_COMMAND, async () => {
      throw denial;
    }),
    (error) => error === denial,
  );
  assert.equal(deniedFixture.events.includes('ROLLBACK'), true);
  assert.equal(deniedFixture.events.includes('COMMIT'), false);
});

test('Trigger replay rejects mutation drift and corrupt durable records', async () => {
  await assert.rejects(
    new PostgresTriggerRepository(
      appendPool('trigger', {
        replay: {
          enabled: DRIFT_TRIGGER.enabled,
          contentDigest: DRIFT_TRIGGER.contentDigest,
        },
      }).pool,
    ).appendTriggerRevision(TRIGGER_COMMAND),
    TriggerConflictError,
  );
  await assert.rejects(
    new PostgresTriggerRepository(
      appendPool('trigger', {
        replay: {},
        missingSchedule: true,
      }).pool,
    ).appendTriggerRevision(TRIGGER_COMMAND),
    TriggerUnavailableError,
  );
  await assert.rejects(
    new PostgresTriggerSource(sourcePool([
      triggerRow({ contentDigest: 'b'.repeat(64) }),
    ]).pool).findCurrentTrigger(TRIGGER.projectId, TRIGGER.triggerId),
    TriggerUnavailableError,
  );
});

test('atomically fences and audits authorized PostgreSQL Task mutations', async () => {
  const createdFixture = appendPool('task');
  assert.deepEqual(
    await new PostgresTaskDefinitionAdministrationRepository(
      createdFixture.pool,
    ).appendAuthorizedTaskDefinitionRevision({
      command: TASK_COMMAND,
      actor: ACTOR,
      fence: FENCE,
      audit: TASK_AUDIT,
    }),
    { status: 'created', definition: TASK },
  );
  const createdSql = createdFixture.queries.map(({ text }) => text);
  assert.ok(
    createdSql.findIndex((text) => text.includes('project_role_bindings')) <
      createdSql.findIndex((text) => text.includes('security_audit_events')),
  );
  assert.ok(
    createdSql.findIndex((text) => text.includes('security_audit_events')) <
      createdSql.indexOf('COMMIT'),
  );

  const replayFixture = appendPool('task', {
    replay: {},
    audit: TASK_AUDIT,
  });
  assert.equal(
    (
      await new PostgresTaskDefinitionAdministrationRepository(
        replayFixture.pool,
      ).appendAuthorizedTaskDefinitionRevision({
        command: TASK_COMMAND,
        actor: ACTOR,
        fence: FENCE,
        audit: { ...TASK_AUDIT, occurredAtMs: 999 },
      })
    ).status,
    'existing',
  );
  assert.equal(
    replayFixture.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    false,
  );

  const fencedFixture = appendPool('task', { bindingVersion: 2 });
  await assert.rejects(
    new PostgresTaskDefinitionAdministrationRepository(
      fencedFixture.pool,
    ).appendAuthorizedTaskDefinitionRevision({
      command: TASK_COMMAND,
      actor: ACTOR,
      fence: FENCE,
      audit: TASK_AUDIT,
    }),
    TaskDefinitionAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(fencedFixture.events.includes('ROLLBACK'), true);

  await assert.rejects(
    new PostgresTaskDefinitionAdministrationRepository(
      appendPool('task', { audit: TASK_AUDIT }).pool,
    ).appendAuthorizedTaskDefinitionRevision({
      command: TASK_COMMAND,
      actor: ACTOR,
      fence: FENCE,
      audit: TASK_AUDIT,
    }),
    TaskDefinitionAdministrationMutationConflictError,
  );
});

test('atomically fences and audits authorized PostgreSQL Trigger mutations', async () => {
  const createdFixture = appendPool('trigger');
  assert.equal(
    (
      await new PostgresTriggerAdministrationRepository(
        createdFixture.pool,
      ).appendAuthorizedTriggerRevision({
        command: TRIGGER_COMMAND,
        actor: ACTOR,
        fence: FENCE,
        audit: TRIGGER_AUDIT,
      })
    ).status,
    'created',
  );
  assert.equal(
    createdFixture.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    true,
  );

  const fencedFixture = appendPool('trigger', { projectVersion: 2 });
  await assert.rejects(
    new PostgresTriggerAdministrationRepository(
      fencedFixture.pool,
    ).appendAuthorizedTriggerRevision({
      command: TRIGGER_COMMAND,
      actor: ACTOR,
      fence: FENCE,
      audit: TRIGGER_AUDIT,
    }),
    TriggerAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(fencedFixture.events.includes('ROLLBACK'), true);
});

test('atomically fences, reads and audits current PostgreSQL automation facts', async () => {
  const taskFixture = appendPool('task');
  const taskRepository = new PostgresTaskDefinitionAdministrationRepository(
    taskFixture.pool,
  );
  assert.deepEqual(
    await taskRepository.findAuthorizedCurrentTaskDefinition({
      projectId: TASK.projectId,
      taskId: TASK.taskId,
      actor: ACTOR,
      fence: FENCE,
      audit: TASK_READ_AUDIT,
    }),
    TASK,
  );
  const taskSql = taskFixture.queries.map(({ text }) => text);
  assert.ok(
    taskSql.findIndex((text) => text.includes('FROM "ql3"."projects"')) <
      taskSql.findIndex((text) =>
        text.includes('JOIN "ql3"."task_definition_revisions"'),
      ),
  );
  assert.ok(
    taskSql.findIndex((text) =>
      text.includes('JOIN "ql3"."task_definition_revisions"'),
    ) <
      taskSql.findIndex((text) =>
        text.includes('INSERT INTO "ql3"."security_audit_events"'),
      ),
  );
  assert.ok(
    taskSql.findIndex((text) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ) < taskSql.indexOf('COMMIT'),
  );

  const triggerFixture = appendPool('trigger');
  assert.deepEqual(
    await new PostgresTriggerAdministrationRepository(
      triggerFixture.pool,
    ).findAuthorizedCurrentTrigger({
      projectId: TRIGGER.projectId,
      triggerId: TRIGGER.triggerId,
      actor: ACTOR,
      fence: FENCE,
      audit: TRIGGER_READ_AUDIT,
    }),
    TRIGGER,
  );
  assert.equal(
    triggerFixture.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."security_audit_events"'),
    ),
    true,
  );
});

test('reads bounded automation pages and fails closed on fence or audit replay', async () => {
  const taskFixture = appendPool('task');
  const tasks = await new PostgresTaskDefinitionAdministrationRepository(
    taskFixture.pool,
  ).listAuthorizedTaskDefinitions({
    projectId: TASK.projectId,
    limit: 1,
    actor: ACTOR,
    fence: FENCE,
    audit: TASK_READ_AUDIT,
  });
  assert.deepEqual(tasks, { definitions: [TASK], truncated: false });

  const triggerFixture = appendPool('trigger');
  const triggers = await new PostgresTriggerAdministrationRepository(
    triggerFixture.pool,
  ).listAuthorizedTriggers({
    projectId: TRIGGER.projectId,
    limit: 1,
    actor: ACTOR,
    fence: FENCE,
    audit: TRIGGER_READ_AUDIT,
  });
  assert.deepEqual(triggers, { triggers: [TRIGGER], truncated: false });

  const fenced = appendPool('task', { bindingVersion: 2 });
  await assert.rejects(
    new PostgresTaskDefinitionAdministrationRepository(
      fenced.pool,
    ).findAuthorizedCurrentTaskDefinition({
      projectId: TASK.projectId,
      taskId: TASK.taskId,
      actor: ACTOR,
      fence: FENCE,
      audit: TASK_READ_AUDIT,
    }),
    TaskDefinitionAdministrationAuthorizationFenceConflictError,
  );
  assert.equal(
    fenced.queries.some(({ text }) =>
      text.includes('JOIN "ql3"."task_definition_revisions"'),
    ),
    false,
  );

  await assert.rejects(
    new PostgresTaskDefinitionAdministrationRepository(
      appendPool('task', { audit: TASK_READ_AUDIT }).pool,
    ).findAuthorizedCurrentTaskDefinition({
      projectId: TASK.projectId,
      taskId: TASK.taskId,
      actor: ACTOR,
      fence: FENCE,
      audit: TASK_READ_AUDIT,
    }),
    TaskDefinitionAdministrationReadConflictError,
  );
  await assert.rejects(
    new PostgresTriggerAdministrationRepository(
      appendPool('trigger', { audit: TRIGGER_READ_AUDIT }).pool,
    ).findAuthorizedCurrentTrigger({
      projectId: TRIGGER.projectId,
      triggerId: TRIGGER.triggerId,
      actor: ACTOR,
      fence: FENCE,
      audit: TRIGGER_READ_AUDIT,
    }),
    TriggerAdministrationReadConflictError,
  );
});
