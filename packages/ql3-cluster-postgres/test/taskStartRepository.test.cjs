'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  TaskStartFenceRejectedError,
  TaskStartNotFoundError,
} = require('@qinglong/runtime-core/task-start');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');
const {
  compileClusterCommandTaskDefinition,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  PostgresTaskStartRepository,
} = require('@qinglong/cluster-postgres/task-start');

const IDS = [
  '019f7300-0000-7000-8000-000000000801',
  '019f7300-0000-7000-8000-000000000802',
  '019f7300-0000-7000-8000-000000000803',
  '019f7300-0000-7000-8000-000000000804',
];
const MUTATION_ID = '019f7300-0000-7000-8000-000000000800';
const TASK_SEMANTICS = createBuiltInTaskSpecSemanticRegistry();
const TASK_COMMAND = {
  projectId: 'project-1',
  taskId: 'task-1',
  expectedRevision: null,
  mutationId: '019f7300-0000-7000-8000-000000000899',
  name: 'Task 1',
  kind: 'command',
  spec: {
    schema: 'qinglong/command@v1',
    config: {
      command: { kind: 'argv', file: '/bin/echo', args: ['cluster'] },
    },
  },
  labels: {},
  enabled: true,
  occurredAtMs: 20,
};
const DEFINITION = createTaskDefinitionRecord({
  ...TASK_COMMAND,
  spec: TASK_SEMANTICS.normalize({
    projectId: TASK_COMMAND.projectId,
    taskId: TASK_COMMAND.taskId,
    kind: TASK_COMMAND.kind,
    spec: TASK_COMMAND.spec,
  }),
}, 10);
const DISABLED_DEFINITION = createTaskDefinitionRecord({
  ...TASK_COMMAND,
  enabled: false,
  spec: TASK_SEMANTICS.normalize({
    projectId: TASK_COMMAND.projectId,
    taskId: TASK_COMMAND.taskId,
    kind: TASK_COMMAND.kind,
    spec: TASK_COMMAND.spec,
  }),
}, 10);
const EXECUTION = compileClusterCommandTaskDefinition(
  DEFINITION,
  TASK_SEMANTICS,
);

function command(overrides = {}) {
  return {
    projectId: 'project-1',
    taskId: 'task-1',
    mutationId: MUTATION_ID,
    expectedRevision: DEFINITION.revision,
    expectedContentDigest: DEFINITION.contentDigest,
    runId: IDS[0],
    attemptId: IDS[1],
    createdEventId: IDS[2],
    queuedEventId: IDS[3],
    subject: { type: 'user', id: 'user-1' },
    policyFence: { projectVersion: 2, bindingVersion: 3 },
    ...overrides,
  };
}

function taskRow(overrides = {}) {
  return {
    projectId: DEFINITION.projectId,
    taskId: DEFINITION.taskId,
    taskRevision: DEFINITION.revision,
    definitionMutationId: DEFINITION.mutationId,
    taskName: DEFINITION.name,
    description: null,
    taskKind: DEFINITION.kind,
    specJson: DEFINITION.spec,
    labelsJson: DEFINITION.labels,
    enabled: DEFINITION.enabled,
    taskContentDigest: DEFINITION.contentDigest,
    taskCreatedAtMs: DEFINITION.createdAtMs,
    taskUpdatedAtMs: DEFINITION.updatedAtMs,
    ...overrides,
  };
}

function executionRow() {
  return {
    projectId: EXECUTION.projectId,
    taskId: EXECUTION.taskId,
    sourceRevision: EXECUTION.sourceRevision,
    taskRevision: EXECUTION.taskRevision,
    sourceContentDigest: EXECUTION.sourceContentDigest,
    executorType: EXECUTION.executorType,
    planSchema: EXECUTION.planSchema,
    planJson: {
      command: EXECUTION.command,
      environment: EXECUTION.environment,
      placement: EXECUTION.placement,
    },
    contentDigest: EXECUTION.contentDigest,
    createdAtMs: EXECUTION.createdAtMs,
  };
}

function fixture(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (
        normalized.startsWith('BEGIN') ||
        normalized === 'COMMIT' ||
        normalized === 'ROLLBACK' ||
        normalized.startsWith('SELECT set_config') ||
        normalized.startsWith('INSERT INTO')
      ) return { rows: [], rowCount: normalized.startsWith('INSERT') ? 1 : 0 };
      if (normalized.includes('lock_run_management_policy_fence')) {
        const rows = options.authorizationRows ?? [{ matches: true }];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('SELECT EXISTS')) {
        const rows = options.projectExistenceRows ?? [{ exists: true }];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('FROM "ql3"."runs"')) {
        const rows = options.runRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('FROM "ql3"."task_definitions"')) {
        const rows = options.taskRows ?? [taskRow()];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('FROM "ql3"."task_execution_revisions"')) {
        const rows = options.executionRows ?? [executionRow()];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('statement_timestamp()')) {
        return { rows: [{ nowMs: 1_000 }], rowCount: 1 };
      }
      if (normalized.includes('FROM "ql3"."run_attempts"')) {
        const rows = options.attemptRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (normalized.includes('FROM "ql3"."run_events"')) {
        const rows = options.eventRows ?? [];
        return { rows, rowCount: rows.length };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    repository: new PostgresTaskStartRepository({
      async connect() { return client; },
    }),
    calls,
  };
}

test('revalidates Policy and Task/execution digests before one atomic Run aggregate', async () => {
  const { repository, calls } = fixture();
  assert.deepEqual(await repository.startTask(command()), {
    status: 'accepted',
    projectId: 'project-1',
    taskId: 'task-1',
    taskRevision: 1,
    taskContentDigest: DEFINITION.contentDigest,
    runId: IDS[0],
    attemptId: IDS[1],
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'remote_worker',
    executionRevisionDigest: EXECUTION.contentDigest,
    createdAtMs: 1_000,
  });
  const authorization = calls.findIndex(({ sql }) =>
    sql.includes('lock_run_management_policy_fence'));
  const task = calls.findIndex(({ sql }) => sql.includes('task_definitions'));
  const execution = calls.findIndex(({ sql }) => sql.includes('task_execution_revisions'));
  assert.ok(authorization < task && task < execution);
  assert.equal(calls.filter(({ sql }) => sql.startsWith('INSERT INTO')).length, 4);
  assert.equal(calls.some(({ sql }) => sql === 'COMMIT'), true);
});

test('returns the original durable identities for an exact replay', async () => {
  const createdPayload = {
    status: 'created',
    version: 1,
    execution_owner: 'runtime',
    executor_type: 'remote_worker',
    execution_revision_digest: EXECUTION.contentDigest,
    task_revision: 1,
    task_content_digest: DEFINITION.contentDigest,
    mutation_id: MUTATION_ID,
    policy_fence: { project_version: 2, binding_version: 3 },
  };
  const { repository, calls } = fixture({
    runRows: [{
      runId: IDS[0],
      projectId: 'project-1',
      taskId: 'task-1',
      taskRevisionRef: EXECUTION.taskRevision,
      triggerType: 'task_start',
      executionOrigin: 'manual',
      executionOwner: 'runtime',
      triggeredBy: 'user-1',
      requestId: MUTATION_ID,
      priority: 0,
      createdAtMs: 1_000,
    }],
    attemptRows: [{ attemptId: IDS[1], executorType: 'remote_worker' }],
    eventRows: [
      {
        sequence: 1,
        type: 'run.created',
        actorType: 'user',
        actorId: 'user-1',
        payload: createdPayload,
        createdAtMs: 1_000,
      },
      {
        sequence: 2,
        type: 'run.queued',
        actorType: 'user',
        actorId: 'user-1',
        payload: { from_status: 'created', to_status: 'queued', version: 2 },
        createdAtMs: 1_000,
      },
    ],
  });
  const replay = await repository.startTask(command({
    runId: '019f7300-0000-7000-8000-000000000901',
    attemptId: '019f7300-0000-7000-8000-000000000902',
    createdEventId: '019f7300-0000-7000-8000-000000000903',
    queuedEventId: '019f7300-0000-7000-8000-000000000904',
  }));
  assert.equal(replay.status, 'existing');
  assert.equal(replay.runId, IDS[0]);
  assert.equal(replay.attemptId, IDS[1]);
  assert.equal(calls.some(({ sql }) => sql.includes('task_definitions')), false);
  assert.equal(calls.some(({ sql }) => sql.startsWith('INSERT INTO')), false);
});

test('rejects missing, authorization, definition and disabled fences', async () => {
  await assert.rejects(
    fixture({
      authorizationRows: [{ matches: null }],
      projectExistenceRows: [{ exists: false }],
    }).repository.startTask(command()),
    TaskStartNotFoundError,
  );
  await assert.rejects(
    fixture({
      authorizationRows: [{ matches: false }],
      projectExistenceRows: [{ exists: true }],
    }).repository.startTask(command()),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'authorization_changed',
  );
  await assert.rejects(
    fixture().repository.startTask(command({ expectedRevision: 2 })),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'definition_changed',
  );
  await assert.rejects(
    fixture({
      taskRows: [taskRow({
        enabled: false,
        taskContentDigest: DISABLED_DEFINITION.contentDigest,
      })],
    }).repository.startTask(command({
      expectedContentDigest: DISABLED_DEFINITION.contentDigest,
    })),
    (error) =>
      error instanceof TaskStartFenceRejectedError &&
      error.reason === 'task_disabled',
  );
});
