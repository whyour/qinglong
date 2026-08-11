import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidTaskStartError,
  TaskStartFenceRejectedError,
  TaskStartNotFoundError,
  TaskStartUnavailableError,
  normalizeTaskStartCommand,
  normalizeTaskStartResult,
  type TaskStartAllowedRole,
  type TaskStartCommand,
  type TaskStartRepository,
  type TaskStartResult,
} from '@qinglong/runtime-core/task-start';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import { createTaskDefinitionRevisionRef } from '@qinglong/runtime-core/task-definition-execution-compiler';

import { findExecutionRevision } from '../automation/taskDefinitionRepository';
import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredBoolean,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const ALLOWED_ROLES = new Set<TaskStartAllowedRole>([
  'owner',
  'admin',
  'operator',
]);

function unavailable(options?: ErrorOptions): TaskStartUnavailableError {
  return new TaskStartUnavailableError(options);
}

function text(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function integer(row: Row, key: string): number {
  return postgresRequiredInteger(row[key], unavailable);
}

function taskDefinition(row: Row): TaskDefinitionRecord {
  const description = row.description;
  if (description !== null && typeof description !== 'string') {
    throw unavailable();
  }
  return normalizeTaskDefinitionRecord({
    projectId: text(row, 'projectId'),
    taskId: text(row, 'taskId'),
    revision: integer(row, 'taskRevision'),
    mutationId: text(row, 'definitionMutationId'),
    name: text(row, 'taskName'),
    ...(description === null ? {} : { description }),
    kind: text(row, 'taskKind') as TaskDefinitionRecord['kind'],
    spec: postgresRequiredJsonObject(
      row.specJson,
      unavailable,
    ) as unknown as TaskDefinitionRecord['spec'],
    labels: postgresRequiredJsonObject(
      row.labelsJson,
      unavailable,
    ) as TaskDefinitionRecord['labels'],
    enabled: postgresRequiredBoolean(row.enabled, unavailable),
    contentDigest: text(row, 'taskContentDigest'),
    createdAtMs: integer(row, 'taskCreatedAtMs'),
    updatedAtMs: integer(row, 'taskUpdatedAtMs'),
  });
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
      AS "nowMs"
  `);
  if (result.rows.length !== 1) throw unavailable();
  return integer(result.rows[0]!, 'nowMs');
}

async function replayResult(
  client: PostgresClient,
  command: Readonly<TaskStartCommand>,
  run: Row,
): Promise<Readonly<TaskStartResult>> {
  const attempt = await client.query<Row>(`
    SELECT id AS "attemptId", executor_type AS "executorType"
    FROM "ql3"."run_attempts"
    WHERE run_id = $1 AND attempt = 1
    LIMIT 2
  `, [text(run, 'runId')]);
  const events = await client.query<Row>(`
    SELECT sequence, type, actor_type AS "actorType", actor_id AS "actorId",
           payload, created_at_ms AS "createdAtMs"
    FROM "ql3"."run_events"
    WHERE run_id = $1 AND sequence IN (1, 2)
    ORDER BY sequence
  `, [text(run, 'runId')]);
  if (attempt.rows.length !== 1 || events.rows.length !== 2) {
    throw new TaskStartFenceRejectedError('mutation_conflict');
  }
  const first = events.rows[0]!;
  const second = events.rows[1]!;
  const created = postgresRequiredJsonObject(first.payload, unavailable);
  const queued = postgresRequiredJsonObject(second.payload, unavailable);
  const fence = postgresRequiredJsonObject(created.policy_fence, unavailable);
  if (
    text(run, 'projectId') !== command.projectId ||
    text(run, 'taskId') !== command.taskId ||
    text(run, 'taskRevisionRef') !==
      createTaskDefinitionRevisionRef({
        revision: command.expectedRevision,
        contentDigest: command.expectedContentDigest,
      }) ||
    text(run, 'triggerType') !== 'task_start' ||
    text(run, 'executionOrigin') !== 'manual' ||
    text(run, 'executionOwner') !== 'runtime' ||
    text(run, 'triggeredBy') !== command.subject.id ||
    text(run, 'requestId') !== command.mutationId ||
    integer(run, 'priority') !== 0 ||
    text(attempt.rows[0]!, 'executorType') !== 'remote_worker' ||
    integer(first, 'sequence') !== 1 ||
    text(first, 'type') !== 'run.created' ||
    text(first, 'actorType') !== command.subject.type ||
    text(first, 'actorId') !== command.subject.id ||
    integer(second, 'sequence') !== 2 ||
    text(second, 'type') !== 'run.queued' ||
    text(second, 'actorType') !== command.subject.type ||
    text(second, 'actorId') !== command.subject.id ||
    created.mutation_id !== command.mutationId ||
    created.task_revision !== command.expectedRevision ||
    created.task_content_digest !== command.expectedContentDigest ||
    created.executor_type !== 'remote_worker' ||
    typeof created.execution_revision_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(created.execution_revision_digest) ||
    fence.project_version !== command.policyFence.projectVersion ||
    fence.binding_version !== command.policyFence.bindingVersion ||
    queued.from_status !== 'created' ||
    queued.to_status !== 'queued' ||
    queued.version !== 2
  ) {
    throw new TaskStartFenceRejectedError('mutation_conflict');
  }
  return normalizeTaskStartResult({
    status: 'existing',
    projectId: command.projectId,
    taskId: command.taskId,
    taskRevision: command.expectedRevision,
    taskContentDigest: command.expectedContentDigest,
    runId: text(run, 'runId'),
    attemptId: text(attempt.rows[0]!, 'attemptId'),
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'remote_worker',
    executionRevisionDigest: created.execution_revision_digest,
    createdAtMs: integer(first, 'createdAtMs'),
  });
}

export class PostgresTaskStartRepository implements TaskStartRepository {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Task start pool is invalid');
    }
  }

  async startTask(
    value: Readonly<TaskStartCommand>,
  ): Promise<Readonly<TaskStartResult>> {
    const command = normalizeTaskStartCommand(value);
    for (
      let attempt = 0;
      attempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      attempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch (error) {
        throw unavailable({ cause: error });
      }
      let began = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const project = await client.query<Row>(`
          SELECT status AS "projectStatus", version AS "projectVersion"
          FROM "ql3"."projects" WHERE id = $1 FOR UPDATE
        `, [command.projectId]);
        if (project.rows.length === 0) throw new TaskStartNotFoundError();
        if (project.rows.length !== 1) throw unavailable();
        const binding = await client.query<Row>(`
          SELECT version AS "bindingVersion", state AS "bindingState",
                 role AS "bindingRole"
          FROM "ql3"."project_role_bindings"
          WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
          ORDER BY version DESC LIMIT 1
          FOR SHARE
        `, [command.projectId, command.subject.type, command.subject.id]);
        const currentProject = project.rows[0]!;
        const currentBinding = binding.rows[0];
        if (
          text(currentProject, 'projectStatus') !== 'active' ||
          integer(currentProject, 'projectVersion') !==
            command.policyFence.projectVersion ||
          !currentBinding ||
          integer(currentBinding, 'bindingVersion') !==
            command.policyFence.bindingVersion ||
          text(currentBinding, 'bindingState') !== 'active' ||
          !ALLOWED_ROLES.has(
            text(currentBinding, 'bindingRole') as TaskStartAllowedRole,
          )
        ) {
          throw new TaskStartFenceRejectedError('authorization_changed');
        }

        const idempotencyKey = `ql3:task-start:v1:${command.mutationId}`;
        const replay = await client.query<Row>(`
          SELECT id AS "runId", project_id AS "projectId",
                 task_id AS "taskId", task_revision AS "taskRevisionRef",
                 trigger_type AS "triggerType",
                 execution_origin AS "executionOrigin",
                 execution_owner AS "executionOwner",
                 triggered_by AS "triggeredBy", request_id AS "requestId",
                 priority, created_at_ms AS "createdAtMs"
          FROM "ql3"."runs"
          WHERE project_id = $1 AND idempotency_key = $2
          FOR UPDATE
        `, [command.projectId, idempotencyKey]);
        if (replay.rows.length > 1) throw unavailable();
        if (replay.rows.length === 1) {
          const result = await replayResult(client, command, replay.rows[0]!);
          await client.query('COMMIT');
          began = false;
          return result;
        }

        const task = await client.query<Row>(`
          SELECT head.project_id AS "projectId", head.task_id AS "taskId",
                 revision.revision AS "taskRevision",
                 revision.mutation_id AS "definitionMutationId",
                 revision.name AS "taskName", revision.description,
                 revision.kind AS "taskKind", revision.spec_json AS "specJson",
                 revision.labels_json AS "labelsJson", revision.enabled,
                 revision.content_digest AS "taskContentDigest",
                 head.created_at_ms AS "taskCreatedAtMs",
                 revision.created_at_ms AS "taskUpdatedAtMs"
          FROM "ql3"."task_definitions" AS head
          JOIN "ql3"."task_definition_revisions" AS revision
            ON revision.project_id = head.project_id
           AND revision.task_id = head.task_id
           AND revision.revision = head.current_revision
          WHERE head.project_id = $1 AND head.task_id = $2
          FOR UPDATE OF head
        `, [command.projectId, command.taskId]);
        if (task.rows.length === 0) throw new TaskStartNotFoundError();
        if (task.rows.length !== 1) throw unavailable();
        const definition = taskDefinition(task.rows[0]!);
        if (
          definition.revision !== command.expectedRevision ||
          definition.contentDigest !== command.expectedContentDigest
        ) {
          throw new TaskStartFenceRejectedError('definition_changed');
        }
        if (!definition.enabled) {
          throw new TaskStartFenceRejectedError('task_disabled');
        }
        if (
          definition.kind !== 'command' ||
          definition.spec.schema !== 'qinglong/command@v1'
        ) {
          throw new TaskStartFenceRejectedError('task_not_executable');
        }
        const execution = await findExecutionRevision(
          client,
          command.projectId,
          command.taskId,
          definition.revision,
        );
        if (
          !execution ||
          execution.executorType !== 'remote_worker' ||
          execution.sourceContentDigest !== definition.contentDigest ||
          execution.taskRevision !==
            createTaskDefinitionRevisionRef({
              revision: definition.revision,
              contentDigest: definition.contentDigest,
            })
        ) {
          throw unavailable();
        }

        const createdAtMs = await databaseNow(client);
        await client.query(`
          INSERT INTO "ql3"."runs" (
            id, project_id, task_id, task_revision, task_name,
            task_snapshot_ref, trigger_type, execution_origin,
            execution_owner, triggered_by, request_id, status, version,
            event_sequence, priority, idempotency_key, created_at_ms,
            queued_at_ms
          ) VALUES (
            $1, $2, $3, $4, $5, $4, 'task_start', 'manual', 'runtime', $6,
            $7, 'queued', 2, 2, 0, $8, $9, $9
          )
        `, [
          command.runId,
          command.projectId,
          command.taskId,
          execution.taskRevision,
          definition.name,
          command.subject.id,
          command.mutationId,
          idempotencyKey,
          createdAtMs,
        ]);
        await client.query(`
          INSERT INTO "ql3"."run_attempts" (
            id, run_id, attempt, status, executor_type,
            callback_sequence, created_at_ms
          ) VALUES ($1, $2, 1, 'claimed', 'remote_worker', 0, $3)
        `, [command.attemptId, command.runId, createdAtMs]);
        await client.query(`
          INSERT INTO "ql3"."run_events" (
            id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
            attempt_id, payload, created_at_ms
          ) VALUES ($1, $2, 1, 'run.created', $3, $4, $5, $6, $7::jsonb, $8)
        `, [
          command.createdEventId,
          command.runId,
          `task-start-created:${command.mutationId}`,
          command.subject.type,
          command.subject.id,
          command.attemptId,
          JSON.stringify({
            status: 'created',
            version: 1,
            execution_owner: 'runtime',
            executor_type: 'remote_worker',
            execution_revision_digest: execution.contentDigest,
            task_revision: definition.revision,
            task_content_digest: definition.contentDigest,
            mutation_id: command.mutationId,
            policy_fence: {
              project_version: command.policyFence.projectVersion,
              binding_version: command.policyFence.bindingVersion,
            },
          }),
          createdAtMs,
        ]);
        await client.query(`
          INSERT INTO "ql3"."run_events" (
            id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
            attempt_id, payload, created_at_ms
          ) VALUES ($1, $2, 2, 'run.queued', $3, $4, $5, $6, $7::jsonb, $8)
        `, [
          command.queuedEventId,
          command.runId,
          `task-start-queued:${command.mutationId}`,
          command.subject.type,
          command.subject.id,
          command.attemptId,
          JSON.stringify({
            from_status: 'created',
            to_status: 'queued',
            version: 2,
          }),
          createdAtMs,
        ]);
        const result = normalizeTaskStartResult({
          status: 'accepted',
          projectId: command.projectId,
          taskId: command.taskId,
          taskRevision: definition.revision,
          taskContentDigest: definition.contentDigest,
          runId: command.runId,
          attemptId: command.attemptId,
          runStatus: 'queued',
          runVersion: 2,
          eventSequence: 2,
          executorType: 'remote_worker',
          executionRevisionDigest: execution.contentDigest,
          createdAtMs,
        });
        await client.query('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began) await rollbackPostgresDefinitionTransaction(client);
        const state = postgresSqlState(error);
        if (
          (state === '23505' ||
            POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state ?? '')) &&
          attempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        if (
          error instanceof InvalidTaskStartError ||
          error instanceof TaskStartNotFoundError ||
          error instanceof TaskStartFenceRejectedError ||
          error instanceof TaskStartUnavailableError
        ) {
          throw error;
        }
        throw unavailable({ cause: error });
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
