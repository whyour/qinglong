import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  InvalidRunManualRetryError,
  MAX_RUN_MANUAL_RETRY_AUTHENTICATION_AGE_MS,
  RUN_MANUAL_RETRY_SOURCE_STATUSES,
  RunManualRetryFenceRejectedError,
  RunManualRetryNotFoundError,
  RunManualRetryRateLimitedError,
  RunManualRetryUnavailableError,
  normalizeRunManualRetryCommand,
  normalizeRunManualRetryResult,
  type RunManualRetryAllowedRole,
  type RunManualRetryCommand,
  type RunManualRetryRepository,
  type RunManualRetryResult,
  type RunManualRetrySourceStatus,
} from '@qinglong/runtime-core/run-manual-retry';

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

export const CLUSTER_RUN_MANUAL_RETRY_RATE_WINDOW_MS = 60_000;
export const CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT = 64;

const ALLOWED_ROLES = new Set<RunManualRetryAllowedRole>([
  'owner',
  'admin',
  'operator',
]);
const CLUSTER_STRONG_ASSURANCES = new Set(['multi_factor', 'hardware']);
const TASK_REVISION_PATTERN = /^qltd:v1:([1-9]\d*):([0-9a-f]{64})$/;

interface SourceRun {
  readonly taskId: string;
  readonly taskRevision: string;
  readonly taskName?: string;
  readonly taskSnapshotRef: string;
  readonly inputRef?: string;
  readonly priority: number;
}

interface ExecutionRevision {
  readonly contentDigest: string;
  readonly sourceContentDigest: string;
}

function unavailable(options?: ErrorOptions): RunManualRetryUnavailableError {
  return new RunManualRetryUnavailableError(options);
}

function text(row: Row, key: string): string {
  return postgresRequiredString(row[key], unavailable);
}

function integer(row: Row, key: string): number {
  return postgresRequiredInteger(row[key], unavailable);
}

function optionalText(row: Row, key: string): string | undefined {
  if (row[key] === null) return undefined;
  return text(row, key);
}

function json(row: Row, key: string): Record<string, unknown> {
  return postgresRequiredJsonObject(row[key], unavailable);
}

function sourceStatus(value: string): RunManualRetrySourceStatus {
  if (
    !RUN_MANUAL_RETRY_SOURCE_STATUSES.includes(
      value as RunManualRetrySourceStatus,
    )
  ) {
    throw new RunManualRetryFenceRejectedError('source_not_terminal');
  }
  return value as RunManualRetrySourceStatus;
}

function sameFencePayload(
  value: unknown,
  command: Readonly<RunManualRetryCommand>,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  return (
    fence.project_version === command.policyFence.projectVersion &&
    fence.binding_version === command.policyFence.bindingVersion
  );
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
      AS "nowMs"
  `);
  if (result.rows.length !== 1) throw unavailable();
  return integer(result.rows[0]!, 'nowMs');
}

function confirmStrongAuthentication(
  command: Readonly<RunManualRetryCommand>,
  observedAtMs: number,
): void {
  if (
    command.principal.subject.type !== 'user' ||
    !CLUSTER_STRONG_ASSURANCES.has(command.principal.assurance) ||
    command.principal.authenticatedAtMs > observedAtMs ||
    command.principal.expiresAtMs <= observedAtMs ||
    observedAtMs - command.principal.authenticatedAtMs >
      MAX_RUN_MANUAL_RETRY_AUTHENTICATION_AGE_MS
  ) {
    throw new RunManualRetryFenceRejectedError('authentication_changed');
  }
}

async function confirmAuthorization(
  client: PostgresClient,
  command: Readonly<RunManualRetryCommand>,
): Promise<void> {
  const project = await client.query<Row>(
    `
    SELECT status AS "projectStatus", version AS "projectVersion"
    FROM "ql3"."projects" WHERE id = $1 FOR UPDATE
  `,
    [command.projectId],
  );
  if (project.rows.length === 0) throw new RunManualRetryNotFoundError();
  if (project.rows.length !== 1) throw unavailable();
  // Authorized management mutations take the same Project lock. Keeping this
  // append-only RoleBinding read lock-free avoids granting UPDATE authority to
  // the runtime role merely to use PostgreSQL row-lock syntax.
  const binding = await client.query<Row>(
    `
    SELECT version AS "bindingVersion", state AS "bindingState",
           role AS "bindingRole"
    FROM "ql3"."project_role_bindings"
    WHERE project_id = $1 AND subject_type = $2 AND subject_id = $3
    ORDER BY version DESC LIMIT 1
  `,
    [
      command.projectId,
      command.principal.subject.type,
      command.principal.subject.id,
    ],
  );
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
      text(currentBinding, 'bindingRole') as RunManualRetryAllowedRole,
    )
  ) {
    throw new RunManualRetryFenceRejectedError('authorization_changed');
  }
}

async function findReplay(
  client: PostgresClient,
  command: Readonly<RunManualRetryCommand>,
): Promise<Row | undefined> {
  const result = await client.query<Row>(
    `
    SELECT run.id AS "runId", run.project_id AS "projectId",
           run.retry_of_run_id AS "retryOfRunId",
           run.task_id AS "taskId", run.task_revision AS "taskRevision",
           run.trigger_type AS "triggerType",
           run.execution_origin AS "executionOrigin",
           run.execution_owner AS "executionOwner",
           run.triggered_by AS "triggeredBy", run.request_id AS "requestId",
           run.status AS "runStatus", run.version AS "runVersion",
           run.event_sequence AS "eventSequence",
           run.created_at_ms AS "createdAtMs",
           attempt.id AS "attemptId", attempt.executor_type AS "executorType",
           created.actor_type AS "createdActorType",
           created.actor_id AS "createdActorId",
           created.payload AS "createdPayload",
           queued.actor_type AS "queuedActorType",
           queued.actor_id AS "queuedActorId",
           queued.payload AS "queuedPayload"
    FROM "ql3"."runs" AS run
    JOIN "ql3"."run_attempts" AS attempt
      ON attempt.run_id = run.id AND attempt.attempt = 1
    JOIN "ql3"."run_events" AS created
      ON created.run_id = run.id AND created.sequence = 1
     AND created.type = 'run.created'
    JOIN "ql3"."run_events" AS queued
      ON queued.run_id = run.id AND queued.sequence = 2
     AND queued.type = 'run.queued'
    WHERE run.project_id = $1 AND run.idempotency_key = $2
    FOR UPDATE OF run
  `,
    [command.projectId, `ql3:run-manual-retry:v1:${command.mutationId}`],
  );
  if (result.rows.length > 1) throw unavailable();
  return result.rows[0];
}

function replayResult(
  command: Readonly<RunManualRetryCommand>,
  row: Row,
): Readonly<RunManualRetryResult> {
  const created = json(row, 'createdPayload');
  const queued = json(row, 'queuedPayload');
  if (
    text(row, 'projectId') !== command.projectId ||
    text(row, 'retryOfRunId') !== command.sourceRunId ||
    text(row, 'triggerType') !== 'run_manual_retry' ||
    text(row, 'executionOrigin') !== 'manual' ||
    text(row, 'executionOwner') !== 'runtime' ||
    text(row, 'triggeredBy') !== command.principal.subject.id ||
    text(row, 'requestId') !== command.mutationId ||
    text(row, 'runStatus') !== 'queued' ||
    integer(row, 'runVersion') !== 2 ||
    integer(row, 'eventSequence') !== 2 ||
    text(row, 'executorType') !== 'remote_worker' ||
    text(row, 'createdActorType') !== command.principal.subject.type ||
    text(row, 'createdActorId') !== command.principal.subject.id ||
    text(row, 'queuedActorType') !== command.principal.subject.type ||
    text(row, 'queuedActorId') !== command.principal.subject.id ||
    created.mutation_id !== command.mutationId ||
    created.retry_of_run_id !== command.sourceRunId ||
    created.source_run_status !== command.expectedRunStatus ||
    created.source_run_version !== command.expectedRunVersion ||
    created.inherit_retry_policy !== false ||
    created.authentication_id !== command.principal.authenticationId ||
    created.audit_event_id !== command.auditEventId ||
    typeof created.execution_revision_digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(created.execution_revision_digest) ||
    !sameFencePayload(created.policy_fence, command) ||
    queued.from_status !== 'created' ||
    queued.to_status !== 'queued' ||
    queued.version !== 2
  ) {
    throw new RunManualRetryFenceRejectedError('mutation_conflict');
  }
  return normalizeRunManualRetryResult({
    status: 'existing',
    projectId: command.projectId,
    sourceRunId: command.sourceRunId,
    sourceRunStatus: command.expectedRunStatus,
    sourceRunVersion: command.expectedRunVersion,
    runId: text(row, 'runId'),
    retryOfRunId: text(row, 'retryOfRunId'),
    taskId: text(row, 'taskId'),
    taskRevision: text(row, 'taskRevision'),
    attemptId: text(row, 'attemptId'),
    runStatus: 'queued',
    runVersion: 2,
    eventSequence: 2,
    executorType: 'remote_worker',
    executionRevisionDigest: created.execution_revision_digest,
    createdAtMs: integer(row, 'createdAtMs'),
  });
}

async function findSource(
  client: PostgresClient,
  command: Readonly<RunManualRetryCommand>,
): Promise<SourceRun> {
  const result = await client.query<Row>(
    `
    SELECT run.project_id AS "projectId", run.task_id AS "taskId",
           run.task_revision AS "taskRevision", run.task_name AS "taskName",
           run.task_snapshot_ref AS "taskSnapshotRef",
           run.parent_run_id AS "parentRunId",
           run.trigger_type AS "triggerType",
           run.execution_owner AS "executionOwner",
           run.input_ref AS "inputRef", run.priority,
           run.status AS "runStatus", run.version AS "runVersion",
           attempt.executor_type AS "attemptExecutorType"
    FROM "ql3"."runs" AS run
    LEFT JOIN LATERAL (
      SELECT executor_type
      FROM "ql3"."run_attempts"
      WHERE run_id = run.id
      ORDER BY attempt DESC
      LIMIT 1
    ) AS attempt ON true
    WHERE run.id = $1
    FOR UPDATE OF run
  `,
    [command.sourceRunId],
  );
  if (
    result.rows.length === 0 ||
    result.rows[0]?.projectId !== command.projectId
  ) {
    throw new RunManualRetryNotFoundError();
  }
  if (result.rows.length !== 1) throw unavailable();
  const row = result.rows[0]!;
  const status = sourceStatus(text(row, 'runStatus'));
  if (
    status !== command.expectedRunStatus ||
    integer(row, 'runVersion') !== command.expectedRunVersion
  ) {
    throw new RunManualRetryFenceRejectedError('source_changed');
  }
  const taskRevision = text(row, 'taskRevision');
  const taskSnapshotRef = optionalText(row, 'taskSnapshotRef');
  if (
    text(row, 'executionOwner') !== 'runtime' ||
    optionalText(row, 'parentRunId') !== undefined ||
    text(row, 'triggerType') === 'plugin_package_workflow' ||
    taskSnapshotRef === undefined ||
    taskSnapshotRef !== taskRevision ||
    optionalText(row, 'attemptExecutorType') !== 'remote_worker' ||
    !TASK_REVISION_PATTERN.test(taskRevision)
  ) {
    throw new RunManualRetryFenceRejectedError('source_not_retryable');
  }
  const taskName = optionalText(row, 'taskName');
  const inputRef = optionalText(row, 'inputRef');
  return Object.freeze({
    taskId: text(row, 'taskId'),
    taskRevision,
    ...(taskName === undefined ? {} : { taskName }),
    taskSnapshotRef,
    ...(inputRef === undefined ? {} : { inputRef }),
    priority: integer(row, 'priority'),
  });
}

async function confirmTaskAndExecution(
  client: PostgresClient,
  projectId: string,
  source: Readonly<SourceRun>,
): Promise<ExecutionRevision> {
  const task = await client.query<Row>(
    `
    SELECT revision.enabled
    FROM "ql3"."task_definitions" AS head
    JOIN "ql3"."task_definition_revisions" AS revision
      ON revision.project_id = head.project_id
     AND revision.task_id = head.task_id
     AND revision.revision = head.current_revision
    WHERE head.project_id = $1 AND head.task_id = $2
  `,
    [projectId, source.taskId],
  );
  if (
    task.rows.length !== 1 ||
    !postgresRequiredBoolean(task.rows[0]!.enabled, unavailable)
  ) {
    throw new RunManualRetryFenceRejectedError('task_disabled');
  }
  const execution = await client.query<Row>(
    `
    SELECT source_content_digest AS "sourceContentDigest",
           content_digest AS "contentDigest"
    FROM "ql3"."task_execution_revisions"
    WHERE project_id = $1 AND task_id = $2 AND task_revision = $3
      AND executor_type = 'remote_worker'
    LIMIT 2
  `,
    [projectId, source.taskId, source.taskRevision],
  );
  if (execution.rows.length !== 1) {
    throw new RunManualRetryFenceRejectedError('source_not_retryable');
  }
  const match = TASK_REVISION_PATTERN.exec(source.taskRevision);
  const row = execution.rows[0]!;
  const sourceContentDigest = text(row, 'sourceContentDigest');
  const contentDigest = text(row, 'contentDigest');
  if (
    !match ||
    match[2] !== sourceContentDigest ||
    !/^[0-9a-f]{64}$/.test(contentDigest)
  ) {
    throw new RunManualRetryFenceRejectedError('source_not_retryable');
  }
  return Object.freeze({ contentDigest, sourceContentDigest });
}

async function consumeRateLimit(
  client: PostgresClient,
  command: Readonly<RunManualRetryCommand>,
  observedAtMs: number,
): Promise<void> {
  const threshold = Math.max(
    0,
    observedAtMs - CLUSTER_RUN_MANUAL_RETRY_RATE_WINDOW_MS,
  );
  const result = await client.query<Row>(
    `
    SELECT created_at_ms AS "createdAtMs"
    FROM "ql3"."runs"
    WHERE project_id = $1 AND trigger_type = 'run_manual_retry'
      AND execution_origin = 'manual' AND triggered_by = $2
      AND created_at_ms > $3
    ORDER BY created_at_ms DESC, id DESC
    LIMIT $4
  `,
    [
      command.projectId,
      command.principal.subject.id,
      threshold,
      CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT,
    ],
  );
  if (result.rows.length < CLUSTER_RUN_MANUAL_RETRY_RATE_LIMIT) return;
  const earliestAtMs = integer(
    result.rows[result.rows.length - 1]!,
    'createdAtMs',
  );
  throw new RunManualRetryRateLimitedError(
    Math.max(
      1,
      earliestAtMs + CLUSTER_RUN_MANUAL_RETRY_RATE_WINDOW_MS - observedAtMs,
    ),
  );
}

async function insertRetry(
  client: PostgresClient,
  command: Readonly<RunManualRetryCommand>,
  source: Readonly<SourceRun>,
  execution: Readonly<ExecutionRevision>,
  observedAtMs: number,
): Promise<void> {
  await client.query(
    `
    INSERT INTO "ql3"."runs" (
      id, project_id, task_id, task_revision, task_name,
      task_snapshot_ref, retry_of_run_id, trigger_type, execution_origin,
      execution_owner, triggered_by, request_id, status, version,
      event_sequence, priority, idempotency_key, input_ref,
      created_at_ms, queued_at_ms
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, 'run_manual_retry', 'manual',
      'runtime', $8, $9, 'queued', 2, 2, $10, $11, $12, $13, $13
    )
  `,
    [
      command.runId,
      command.projectId,
      source.taskId,
      source.taskRevision,
      source.taskName ?? null,
      source.taskSnapshotRef,
      command.sourceRunId,
      command.principal.subject.id,
      command.mutationId,
      source.priority,
      `ql3:run-manual-retry:v1:${command.mutationId}`,
      source.inputRef ?? null,
      observedAtMs,
    ],
  );
  await client.query(
    `
    INSERT INTO "ql3"."run_attempts" (
      id, run_id, attempt, status, executor_type,
      callback_sequence, created_at_ms
    ) VALUES ($1, $2, 1, 'claimed', 'remote_worker', 0, $3)
  `,
    [command.attemptId, command.runId, observedAtMs],
  );
  await client.query(
    `
    INSERT INTO "ql3"."run_events" (
      id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
      attempt_id, payload, created_at_ms
    ) VALUES ($1, $2, 1, 'run.created', $3, $4, $5, $6, $7::jsonb, $8)
  `,
    [
      command.createdEventId,
      command.runId,
      `run-manual-retry-created:${command.mutationId}`,
      command.principal.subject.type,
      command.principal.subject.id,
      command.attemptId,
      JSON.stringify({
        status: 'created',
        version: 1,
        execution_owner: 'runtime',
        executor_type: 'remote_worker',
        execution_revision_digest: execution.contentDigest,
        source_content_digest: execution.sourceContentDigest,
        retry_of_run_id: command.sourceRunId,
        source_run_status: command.expectedRunStatus,
        source_run_version: command.expectedRunVersion,
        inherit_retry_policy: false,
        mutation_id: command.mutationId,
        authentication_id: command.principal.authenticationId,
        audit_event_id: command.auditEventId,
        policy_fence: {
          project_version: command.policyFence.projectVersion,
          binding_version: command.policyFence.bindingVersion,
        },
      }),
      observedAtMs,
    ],
  );
  await client.query(
    `
    INSERT INTO "ql3"."run_events" (
      id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
      attempt_id, payload, created_at_ms
    ) VALUES ($1, $2, 2, 'run.queued', $3, $4, $5, $6, $7::jsonb, $8)
  `,
    [
      command.queuedEventId,
      command.runId,
      `run-manual-retry-queued:${command.mutationId}`,
      command.principal.subject.type,
      command.principal.subject.id,
      command.attemptId,
      JSON.stringify({
        from_status: 'created',
        to_status: 'queued',
        version: 2,
      }),
      observedAtMs,
    ],
  );
  await client.query(
    `
    INSERT INTO "ql3"."security_audit_events" (
      event_id, request_id, operation_id, project_id,
      subject_type, subject_id, authentication_id, outcome, reasons,
      project_version, binding_version, occurred_at_ms
    ) VALUES (
      $1, $2, 'run.retry', $3, $4, $5, $6, 'allowed', $7::jsonb,
      $8, $9, $10
    )
  `,
    [
      command.auditEventId,
      command.requestId,
      command.projectId,
      command.principal.subject.type,
      command.principal.subject.id,
      command.principal.authenticationId,
      JSON.stringify(['role_grant', 'strong_authentication']),
      command.policyFence.projectVersion,
      command.policyFence.bindingVersion,
      observedAtMs,
    ],
  );
}

/**
 * PostgreSQL authority for one strongly authenticated manual retry. The
 * Project row lock serializes the existing Run-ledger quota across replicas.
 */
export class PostgresRunManualRetryRepository
  implements RunManualRetryRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Run manual retry pool is invalid');
    }
  }

  async retryRun(
    value: Readonly<RunManualRetryCommand>,
  ): Promise<Readonly<RunManualRetryResult>> {
    const command = normalizeRunManualRetryCommand(value);
    for (
      let transactionAttempt = 0;
      transactionAttempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      transactionAttempt += 1
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
        const observedAtMs = await databaseNow(client);
        confirmStrongAuthentication(command, observedAtMs);
        await confirmAuthorization(client, command);

        const replay = await findReplay(client, command);
        if (replay) {
          const result = replayResult(command, replay);
          await client.query('COMMIT');
          began = false;
          return result;
        }

        const source = await findSource(client, command);
        const execution = await confirmTaskAndExecution(
          client,
          command.projectId,
          source,
        );
        await consumeRateLimit(client, command, observedAtMs);
        await insertRetry(client, command, source, execution, observedAtMs);
        const result = normalizeRunManualRetryResult({
          status: 'accepted',
          projectId: command.projectId,
          sourceRunId: command.sourceRunId,
          sourceRunStatus: command.expectedRunStatus,
          sourceRunVersion: command.expectedRunVersion,
          runId: command.runId,
          retryOfRunId: command.sourceRunId,
          taskId: source.taskId,
          taskRevision: source.taskRevision,
          attemptId: command.attemptId,
          runStatus: 'queued',
          runVersion: 2,
          eventSequence: 2,
          executorType: 'remote_worker',
          executionRevisionDigest: execution.contentDigest,
          createdAtMs: observedAtMs,
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
          transactionAttempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        if (
          error instanceof InvalidRunManualRetryError ||
          error instanceof RunManualRetryNotFoundError ||
          error instanceof RunManualRetryFenceRejectedError ||
          error instanceof RunManualRetryRateLimitedError ||
          error instanceof RunManualRetryUnavailableError
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
