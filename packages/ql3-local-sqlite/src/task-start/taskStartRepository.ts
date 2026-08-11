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

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteDispatchDefinitionStore } from '../task-definition/dispatchDefinitionStore';
import {
  optionalString,
  requiredInteger,
  requiredString,
  type QueryRow,
} from '../run/runPersistence';

const ALLOWED_ROLES = new Set<TaskStartAllowedRole>([
  'owner',
  'admin',
  'operator',
]);

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Local SQLite Task start clock is invalid');
  }
  return value;
}

function json(row: QueryRow, key: string): unknown {
  try {
    return JSON.parse(requiredString(row, key)) as unknown;
  } catch {
    throw new TypeError(`Local SQLite Task start ${key} is invalid`);
  }
}

function taskDefinition(row: QueryRow): TaskDefinitionRecord {
  const enabled = requiredInteger(row, 'enabled');
  if (enabled !== 0 && enabled !== 1) {
    throw new TypeError('Local SQLite Task start enabled is invalid');
  }
  const description = optionalString(row, 'description');
  return normalizeTaskDefinitionRecord({
    projectId: requiredString(row, 'projectId'),
    taskId: requiredString(row, 'taskId'),
    revision: requiredInteger(row, 'taskRevision'),
    mutationId: requiredString(row, 'definitionMutationId'),
    name: requiredString(row, 'taskName'),
    ...(description === undefined ? {} : { description }),
    kind: requiredString(row, 'taskKind') as TaskDefinitionRecord['kind'],
    spec: json(row, 'specJson') as TaskDefinitionRecord['spec'],
    labels: json(row, 'labelsJson') as TaskDefinitionRecord['labels'],
    enabled: enabled === 1,
    contentDigest: requiredString(row, 'taskContentDigest'),
    createdAtMs: requiredInteger(row, 'taskCreatedAtMs'),
    updatedAtMs: requiredInteger(row, 'taskUpdatedAtMs'),
  });
}

function rollback(authority: LocalSqliteOperationAuthority): void {
  if (!authority.client.isTransaction) return;
  try {
    authority.client.exec('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure.
  }
}

function replayResult(
  command: Readonly<TaskStartCommand>,
  row: QueryRow,
): Readonly<TaskStartResult> {
  const payload = json(row, 'createdPayload');
  const queuedPayload = json(row, 'queuedPayload');
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !queuedPayload ||
    typeof queuedPayload !== 'object' ||
    Array.isArray(queuedPayload)
  ) {
    throw new TaskStartFenceRejectedError('mutation_conflict');
  }
  const created = payload as Record<string, unknown>;
  const queued = queuedPayload as Record<string, unknown>;
  const fence = created.policy_fence;
  if (
    requiredString(row, 'projectId') !== command.projectId ||
    requiredString(row, 'taskId') !== command.taskId ||
    requiredString(row, 'taskRevisionRef') !==
      createTaskDefinitionRevisionRef({
        revision: command.expectedRevision,
        contentDigest: command.expectedContentDigest,
      }) ||
    requiredString(row, 'triggerType') !== 'task_start' ||
    requiredString(row, 'executionOrigin') !== 'manual' ||
    requiredString(row, 'executionOwner') !== 'runtime' ||
    requiredString(row, 'triggeredBy') !== command.subject.id ||
    requiredString(row, 'requestId') !== command.mutationId ||
    requiredInteger(row, 'priority') !== 0 ||
    requiredString(row, 'attemptExecutorType') !== 'local_process' ||
    requiredString(row, 'createdActorType') !== command.subject.type ||
    requiredString(row, 'createdActorId') !== command.subject.id ||
    requiredString(row, 'queuedActorType') !== command.subject.type ||
    requiredString(row, 'queuedActorId') !== command.subject.id ||
    created.mutation_id !== command.mutationId ||
    created.task_revision !== command.expectedRevision ||
    created.task_content_digest !== command.expectedContentDigest ||
    created.executor_type !== 'local_process' ||
    typeof created.execution_revision_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(created.execution_revision_digest) ||
    !fence ||
    typeof fence !== 'object' ||
    Array.isArray(fence) ||
    (fence as Record<string, unknown>).project_version !==
      command.policyFence.projectVersion ||
    (fence as Record<string, unknown>).binding_version !==
      command.policyFence.bindingVersion ||
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
    runId: requiredString(row, 'runId'),
    attemptId: requiredString(row, 'attemptId'),
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'local_process',
    executionRevisionDigest: created.execution_revision_digest,
    createdAtMs: requiredInteger(row, 'createdAtMs'),
  });
}

export class LocalSqliteTaskStartRepository implements TaskStartRepository {
  private readonly dispatchDefinitions: LocalSqliteDispatchDefinitionStore;

  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof now !== 'function'
    ) {
      throw new TypeError('Local SQLite Task start dependencies are invalid');
    }
    this.dispatchDefinitions = new LocalSqliteDispatchDefinitionStore(
      authority.client,
    );
  }

  startTask(
    value: Readonly<TaskStartCommand>,
  ): Promise<Readonly<TaskStartResult>> {
    let command: Readonly<TaskStartCommand>;
    try {
      command = normalizeTaskStartCommand(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        try {
          client.exec('BEGIN IMMEDIATE');
          const project = client
            .prepare(
              `SELECT "status" AS "projectStatus", "version" AS "projectVersion"
               FROM "QingLong3Projects" WHERE "id" = ?`,
            )
            .get(command.projectId) as QueryRow | undefined;
          if (!project) throw new TaskStartNotFoundError();
          const binding = client
            .prepare(
              `SELECT "version" AS "bindingVersion", "state" AS "bindingState",
                      "role" AS "bindingRole"
               FROM "QingLong3ProjectRoleBindings"
               WHERE "project_id" = ? AND "subject_type" = ?
                 AND "subject_id" = ?
               ORDER BY "version" DESC LIMIT 1`,
            )
            .get(
              command.projectId,
              command.subject.type,
              command.subject.id,
            ) as QueryRow | undefined;
          if (
            requiredString(project, 'projectStatus') !== 'active' ||
            requiredInteger(project, 'projectVersion') !==
              command.policyFence.projectVersion ||
            !binding ||
            requiredInteger(binding, 'bindingVersion') !==
              command.policyFence.bindingVersion ||
            requiredString(binding, 'bindingState') !== 'active' ||
            !ALLOWED_ROLES.has(
              requiredString(binding, 'bindingRole') as TaskStartAllowedRole,
            )
          ) {
            throw new TaskStartFenceRejectedError('authorization_changed');
          }

          const idempotencyKey = `ql3:task-start:v1:${command.mutationId}`;
          const replay = client
            .prepare(
              `SELECT run."id" AS "runId", run."project_id" AS "projectId",
                      run."task_id" AS "taskId",
                      run."task_revision" AS "taskRevisionRef",
                      run."trigger_type" AS "triggerType",
                      run."execution_origin" AS "executionOrigin",
                      run."execution_owner" AS "executionOwner",
                      run."triggered_by" AS "triggeredBy",
                      run."request_id" AS "requestId",
                      run."priority" AS "priority",
                      run."created_at_ms" AS "createdAtMs",
                      attempt."id" AS "attemptId",
                      attempt."executor_type" AS "attemptExecutorType",
                      created."actor_type" AS "createdActorType",
                      created."actor_id" AS "createdActorId",
                      created."payload" AS "createdPayload",
                      queued."actor_type" AS "queuedActorType",
                      queued."actor_id" AS "queuedActorId",
                      queued."payload" AS "queuedPayload"
               FROM "Runs" AS run
               JOIN "RunAttempts" AS attempt
                 ON attempt."run_id" = run."id" AND attempt."attempt" = 1
               JOIN "RunEvents" AS created
                 ON created."run_id" = run."id" AND created."sequence" = 1
                    AND created."type" = 'run.created'
               JOIN "RunEvents" AS queued
                 ON queued."run_id" = run."id" AND queued."sequence" = 2
                    AND queued."type" = 'run.queued'
               WHERE run."project_id" = ? AND run."idempotency_key" = ?`,
            )
            .get(command.projectId, idempotencyKey) as QueryRow | undefined;
          if (replay) {
            const result = replayResult(command, replay);
            client.exec('COMMIT');
            return result;
          }

          const row = client
            .prepare(
              `SELECT head."project_id" AS "projectId",
                      head."task_id" AS "taskId",
                      revision."revision" AS "taskRevision",
                      revision."mutation_id" AS "definitionMutationId",
                      revision."name" AS "taskName",
                      revision."description" AS "description",
                      revision."kind" AS "taskKind",
                      revision."spec_json" AS "specJson",
                      revision."labels_json" AS "labelsJson",
                      revision."enabled" AS "enabled",
                      revision."content_digest" AS "taskContentDigest",
                      head."created_at_ms" AS "taskCreatedAtMs",
                      revision."created_at_ms" AS "taskUpdatedAtMs"
               FROM "QingLong3TaskDefinitions" AS head
               JOIN "QingLong3TaskDefinitionRevisions" AS revision
                 ON revision."project_id" = head."project_id"
                AND revision."task_id" = head."task_id"
                AND revision."revision" = head."current_revision"
               WHERE head."project_id" = ? AND head."task_id" = ?`,
            )
            .get(command.projectId, command.taskId) as QueryRow | undefined;
          if (!row) throw new TaskStartNotFoundError();
          const definition = taskDefinition(row);
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
          const taskRevisionRef = createTaskDefinitionRevisionRef({
            revision: definition.revision,
            contentDigest: definition.contentDigest,
          });
          const execution = this.dispatchDefinitions.resolveRevision({
            projectId: command.projectId,
            taskId: command.taskId,
            taskRevision: taskRevisionRef,
          });
          if (!execution || execution.executorType !== 'local_process') {
            throw new TaskStartUnavailableError();
          }

          const createdAtMs = timestamp(this.now());
          client
            .prepare(
              `INSERT INTO "Runs" (
                 "id", "project_id", "task_id", "task_revision", "task_name",
                 "task_snapshot_ref", "trigger_type", "execution_origin",
                 "execution_owner", "triggered_by", "request_id", "status",
                 "version", "event_sequence", "priority", "idempotency_key",
                 "created_at_ms", "queued_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, 'task_start', 'manual', 'runtime',
                         ?, ?, 'queued', 2, 2, 0, ?, ?, ?)`,
            )
            .run(
              command.runId,
              command.projectId,
              command.taskId,
              taskRevisionRef,
              definition.name,
              taskRevisionRef,
              command.subject.id,
              command.mutationId,
              idempotencyKey,
              createdAtMs,
              createdAtMs,
            );
          client
            .prepare(
              `INSERT INTO "RunAttempts" (
                 "id", "run_id", "attempt", "status", "executor_type",
                 "callback_sequence", "created_at_ms"
               ) VALUES (?, ?, 1, 'claimed', 'local_process', 0, ?)`,
            )
            .run(command.attemptId, command.runId, createdAtMs);
          client
            .prepare(
              `INSERT INTO "RunEvents" (
                 "id", "run_id", "sequence", "type", "dedupe_key",
                 "actor_type", "actor_id", "attempt_id", "payload",
                 "created_at_ms"
               ) VALUES (?, ?, 1, 'run.created', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
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
                executor_type: 'local_process',
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
            );
          client
            .prepare(
              `INSERT INTO "RunEvents" (
                 "id", "run_id", "sequence", "type", "dedupe_key",
                 "actor_type", "actor_id", "attempt_id", "payload",
                 "created_at_ms"
               ) VALUES (?, ?, 2, 'run.queued', ?, ?, ?, ?, ?, ?)`,
            )
            .run(
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
            );
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
            executorType: 'local_process',
            executionRevisionDigest: execution.contentDigest,
            createdAtMs,
          });
          client.exec('COMMIT');
          return result;
        } catch (error) {
          rollback(this.authority);
          if (
            error instanceof InvalidTaskStartError ||
            error instanceof TaskStartNotFoundError ||
            error instanceof TaskStartFenceRejectedError ||
            error instanceof TaskStartUnavailableError
          ) {
            throw error;
          }
          throw new TaskStartUnavailableError({ cause: error });
        }
      },
      () => new TaskStartUnavailableError(),
    );
  }
}
