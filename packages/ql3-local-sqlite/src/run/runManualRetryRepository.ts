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
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type { SecuritySubject } from '@qinglong/runtime-core/security';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import { LocalSqliteDispatchDefinitionStore } from '../task-definition/dispatchDefinitionStore';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from '../security/securityPersistence';
import {
  optionalString,
  requiredInteger,
  requiredString,
  type QueryRow,
} from './runPersistence';

export const RUN_MANUAL_RETRY_RATE_WINDOW_MS = 60_000;
export const EDGE_RUN_MANUAL_RETRY_RATE_LIMIT = 4;
export const STANDALONE_RUN_MANUAL_RETRY_RATE_LIMIT = 16;

const ALLOWED_ROLES = new Set<RunManualRetryAllowedRole>([
  'owner',
  'admin',
  'operator',
]);

export interface LocalSqliteRunManualRetryRepositoryOptions {
  readonly rateLimit: number;
  readonly beforeMutation?: (actor: Readonly<SecuritySubject>) => void;
}

interface SourceRun {
  readonly taskId: string;
  readonly taskRevision: string;
  readonly taskName?: string;
  readonly taskSnapshotRef: string;
  readonly inputRef?: string;
  readonly priority: number;
  readonly status: string;
  readonly version: number;
  readonly attemptExecutorType: string;
}

const AUDIT_SELECT = `
  "event_id" AS "eventId",
  "request_id" AS "requestId",
  "operation_id" AS "operationId",
  "project_id" AS "auditProjectId",
  "subject_type" AS "subjectType",
  "subject_id" AS "subjectId",
  "authentication_id" AS "authenticationId",
  "outcome" AS "outcome",
  "reasons_json" AS "reasonsJson",
  "fence_project_version" AS "fenceProjectVersion",
  "fence_binding_version" AS "fenceBindingVersion",
  "occurred_at_ms" AS "occurredAtMs"`;

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Local SQLite Run manual retry ${label} is invalid`);
  }
  return value;
}

function exactJson(row: QueryRow, key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(requiredString(row, key)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new RunManualRetryFenceRejectedError('mutation_conflict');
  }
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

function rollback(authority: LocalSqliteOperationAuthority): void {
  if (!authority.client.isTransaction) return;
  try {
    authority.client.exec('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure.
  }
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

export class LocalSqliteRunManualRetryRepository
  implements RunManualRetryRepository
{
  private readonly beforeMutation: (actor: Readonly<SecuritySubject>) => void;
  private readonly dispatchDefinitions: LocalSqliteDispatchDefinitionStore;

  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly options: LocalSqliteRunManualRetryRepositoryOptions,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some(
        (key) => key !== 'rateLimit' && key !== 'beforeMutation',
      ) ||
      !Number.isSafeInteger(options.rateLimit) ||
      options.rateLimit < 1 ||
      options.rateLimit > 64 ||
      (options.beforeMutation !== undefined &&
        typeof options.beforeMutation !== 'function')
    ) {
      throw new TypeError(
        'Local SQLite Run manual retry dependencies are invalid',
      );
    }
    this.beforeMutation = options.beforeMutation ?? (() => undefined);
    this.dispatchDefinitions = new LocalSqliteDispatchDefinitionStore(
      authority.client,
    );
  }

  retryRun(
    value: Readonly<RunManualRetryCommand>,
  ): Promise<Readonly<RunManualRetryResult>> {
    let command: Readonly<RunManualRetryCommand>;
    try {
      command = normalizeRunManualRetryCommand(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        try {
          client.exec('BEGIN IMMEDIATE');
          const observedAtMs = this.databaseTime();
          this.confirmStrongAuthentication(command, observedAtMs);
          try {
            this.beforeMutation(command.principal.subject);
          } catch {
            throw new RunManualRetryFenceRejectedError(
              'authentication_changed',
            );
          }
          this.confirmAuthorization(command);

          const replay = this.findReplay(command);
          if (replay) {
            const result = this.replayResult(command, replay);
            this.commitAudit(this.audit(command, observedAtMs), true);
            client.exec('COMMIT');
            return result;
          }

          const source = this.findSource(command);
          const execution = this.dispatchDefinitions.resolveRevision({
            projectId: command.projectId,
            taskId: source.taskId,
            taskRevision: source.taskRevision,
          });
          if (
            !execution ||
            execution.executorType !== 'local_process' ||
            source.attemptExecutorType !== execution.executorType
          ) {
            throw new RunManualRetryFenceRejectedError('source_not_retryable');
          }
          this.confirmTaskEnabled(command.projectId, source.taskId);
          this.consumeRateLimit(command, observedAtMs);
          this.insertRetry(
            command,
            source,
            execution.contentDigest,
            observedAtMs,
          );
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
            executorType: 'local_process',
            executionRevisionDigest: execution.contentDigest,
            createdAtMs: observedAtMs,
          });
          this.commitAudit(this.audit(command, observedAtMs), false);
          client.exec('COMMIT');
          return result;
        } catch (error) {
          rollback(this.authority);
          if (
            error instanceof InvalidRunManualRetryError ||
            error instanceof RunManualRetryNotFoundError ||
            error instanceof RunManualRetryFenceRejectedError ||
            error instanceof RunManualRetryRateLimitedError
          ) {
            throw error;
          }
          throw new RunManualRetryUnavailableError({ cause: error });
        }
      },
      () => new RunManualRetryUnavailableError(),
    );
  }

  private databaseTime(): number {
    const row = this.authority.client
      .prepare(
        `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "observedAtMs"`,
      )
      .get() as QueryRow | undefined;
    return timestamp(row?.observedAtMs, 'database clock');
  }

  private confirmStrongAuthentication(
    command: Readonly<RunManualRetryCommand>,
    observedAtMs: number,
  ): void {
    if (
      command.principal.subject.type !== 'user' ||
      !['multi_factor', 'hardware', 'local_console'].includes(
        command.principal.assurance,
      ) ||
      command.principal.authenticatedAtMs > observedAtMs ||
      command.principal.expiresAtMs <= observedAtMs ||
      observedAtMs - command.principal.authenticatedAtMs >
        MAX_RUN_MANUAL_RETRY_AUTHENTICATION_AGE_MS
    ) {
      throw new RunManualRetryFenceRejectedError('authentication_changed');
    }
  }

  private confirmAuthorization(command: Readonly<RunManualRetryCommand>): void {
    const row = this.authority.client
      .prepare(
        `SELECT project."status" AS "projectStatus",
                project."version" AS "projectVersion",
                binding."state" AS "bindingState",
                binding."version" AS "bindingVersion",
                binding."role" AS "bindingRole"
           FROM "QingLong3Projects" AS project
           JOIN "QingLong3ProjectRoleBindings" AS binding
             ON binding."project_id" = project."id"
            AND binding."subject_type" = ?
            AND binding."subject_id" = ?
          WHERE project."id" = ?
            AND binding."version" = (
              SELECT MAX(latest."version")
                FROM "QingLong3ProjectRoleBindings" AS latest
               WHERE latest."project_id" = binding."project_id"
                 AND latest."subject_type" = binding."subject_type"
                 AND latest."subject_id" = binding."subject_id"
            )`,
      )
      .get(
        command.principal.subject.type,
        command.principal.subject.id,
        command.projectId,
      ) as QueryRow | undefined;
    if (
      !row ||
      requiredString(row, 'projectStatus') !== 'active' ||
      requiredInteger(row, 'projectVersion') !==
        command.policyFence.projectVersion ||
      requiredString(row, 'bindingState') !== 'active' ||
      requiredInteger(row, 'bindingVersion') !==
        command.policyFence.bindingVersion ||
      !ALLOWED_ROLES.has(
        requiredString(row, 'bindingRole') as RunManualRetryAllowedRole,
      )
    ) {
      throw new RunManualRetryFenceRejectedError('authorization_changed');
    }
  }

  private findReplay(
    command: Readonly<RunManualRetryCommand>,
  ): QueryRow | undefined {
    return this.authority.client
      .prepare(
        `SELECT run."id" AS "runId", run."project_id" AS "projectId",
                run."retry_of_run_id" AS "retryOfRunId",
                run."task_id" AS "taskId",
                run."task_revision" AS "taskRevision",
                run."trigger_type" AS "triggerType",
                run."execution_origin" AS "executionOrigin",
                run."execution_owner" AS "executionOwner",
                run."triggered_by" AS "triggeredBy",
                run."request_id" AS "requestId",
                run."status" AS "runStatus", run."version" AS "runVersion",
                run."event_sequence" AS "eventSequence",
                run."created_at_ms" AS "createdAtMs",
                attempt."id" AS "attemptId",
                attempt."executor_type" AS "executorType",
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
      .get(
        command.projectId,
        `ql3:run-manual-retry:v1:${command.mutationId}`,
      ) as QueryRow | undefined;
  }

  private replayResult(
    command: Readonly<RunManualRetryCommand>,
    row: QueryRow,
  ): Readonly<RunManualRetryResult> {
    const created = exactJson(row, 'createdPayload');
    const queued = exactJson(row, 'queuedPayload');
    if (
      requiredString(row, 'projectId') !== command.projectId ||
      requiredString(row, 'retryOfRunId') !== command.sourceRunId ||
      requiredString(row, 'triggerType') !== 'run_manual_retry' ||
      requiredString(row, 'executionOrigin') !== 'manual' ||
      requiredString(row, 'executionOwner') !== 'runtime' ||
      requiredString(row, 'triggeredBy') !== command.principal.subject.id ||
      requiredString(row, 'requestId') !== command.mutationId ||
      requiredString(row, 'runStatus') !== 'queued' ||
      requiredInteger(row, 'runVersion') !== 2 ||
      requiredInteger(row, 'eventSequence') !== 2 ||
      requiredString(row, 'executorType') !== 'local_process' ||
      requiredString(row, 'createdActorType') !==
        command.principal.subject.type ||
      requiredString(row, 'createdActorId') !== command.principal.subject.id ||
      requiredString(row, 'queuedActorType') !==
        command.principal.subject.type ||
      requiredString(row, 'queuedActorId') !== command.principal.subject.id ||
      created.mutation_id !== command.mutationId ||
      created.retry_of_run_id !== command.sourceRunId ||
      created.source_run_status !== command.expectedRunStatus ||
      created.source_run_version !== command.expectedRunVersion ||
      created.inherit_retry_policy !== false ||
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
      runId: requiredString(row, 'runId'),
      retryOfRunId: requiredString(row, 'retryOfRunId'),
      taskId: requiredString(row, 'taskId'),
      taskRevision: requiredString(row, 'taskRevision'),
      attemptId: requiredString(row, 'attemptId'),
      runStatus: 'queued',
      runVersion: 2,
      eventSequence: 2,
      executorType: 'local_process',
      executionRevisionDigest: created.execution_revision_digest,
      createdAtMs: requiredInteger(row, 'createdAtMs'),
    });
  }

  private findSource(command: Readonly<RunManualRetryCommand>): SourceRun {
    const row = this.authority.client
      .prepare(
        `SELECT run."project_id" AS "projectId",
                run."task_id" AS "taskId",
                run."task_revision" AS "taskRevision",
                run."task_name" AS "taskName",
                run."task_snapshot_ref" AS "taskSnapshotRef",
                run."parent_run_id" AS "parentRunId",
                run."trigger_type" AS "triggerType",
                run."execution_owner" AS "executionOwner",
                run."input_ref" AS "inputRef",
                run."priority" AS "priority",
                run."status" AS "runStatus",
                run."version" AS "runVersion",
                attempt."executor_type" AS "attemptExecutorType"
           FROM "Runs" AS run
           LEFT JOIN "RunAttempts" AS attempt
             ON attempt."run_id" = run."id"
            AND attempt."attempt" = (
              SELECT MAX(latest."attempt") FROM "RunAttempts" AS latest
               WHERE latest."run_id" = run."id"
            )
          WHERE run."id" = ?`,
      )
      .get(command.sourceRunId) as QueryRow | undefined;
    if (!row || requiredString(row, 'projectId') !== command.projectId) {
      throw new RunManualRetryNotFoundError();
    }
    const status = requiredString(row, 'runStatus');
    if (!RUN_MANUAL_RETRY_SOURCE_STATUSES.includes(status as never)) {
      throw new RunManualRetryFenceRejectedError('source_not_terminal');
    }
    if (
      status !== command.expectedRunStatus ||
      requiredInteger(row, 'runVersion') !== command.expectedRunVersion
    ) {
      throw new RunManualRetryFenceRejectedError('source_changed');
    }
    const taskRevision = requiredString(row, 'taskRevision');
    const taskSnapshotRef = optionalString(row, 'taskSnapshotRef');
    if (
      requiredString(row, 'executionOwner') !== 'runtime' ||
      optionalString(row, 'parentRunId') !== undefined ||
      requiredString(row, 'triggerType') === 'plugin_package_workflow' ||
      taskSnapshotRef === undefined ||
      taskSnapshotRef !== taskRevision ||
      optionalString(row, 'attemptExecutorType') === undefined
    ) {
      throw new RunManualRetryFenceRejectedError('source_not_retryable');
    }
    const taskName = optionalString(row, 'taskName');
    const inputRef = optionalString(row, 'inputRef');
    return Object.freeze({
      taskId: requiredString(row, 'taskId'),
      taskRevision,
      ...(taskName === undefined ? {} : { taskName }),
      taskSnapshotRef,
      ...(inputRef === undefined ? {} : { inputRef }),
      priority: requiredInteger(row, 'priority'),
      status,
      version: requiredInteger(row, 'runVersion'),
      attemptExecutorType: requiredString(row, 'attemptExecutorType'),
    });
  }

  private confirmTaskEnabled(projectId: string, taskId: string): void {
    const row = this.authority.client
      .prepare(
        `SELECT revision."enabled" AS "enabled"
           FROM "QingLong3TaskDefinitions" AS head
           JOIN "QingLong3TaskDefinitionRevisions" AS revision
             ON revision."project_id" = head."project_id"
            AND revision."task_id" = head."task_id"
            AND revision."revision" = head."current_revision"
          WHERE head."project_id" = ? AND head."task_id" = ?`,
      )
      .get(projectId, taskId) as QueryRow | undefined;
    if (!row || requiredInteger(row, 'enabled') !== 1) {
      throw new RunManualRetryFenceRejectedError('task_disabled');
    }
  }

  private consumeRateLimit(
    command: Readonly<RunManualRetryCommand>,
    observedAtMs: number,
  ): void {
    const threshold = Math.max(
      0,
      observedAtMs - RUN_MANUAL_RETRY_RATE_WINDOW_MS,
    );
    const rows = this.authority.client
      .prepare(
        `SELECT "created_at_ms" AS "createdAtMs"
           FROM "Runs"
          WHERE "project_id" = ? AND "trigger_type" = 'run_manual_retry'
            AND "execution_origin" = 'manual' AND "triggered_by" = ?
            AND "created_at_ms" > ?
          ORDER BY "created_at_ms" DESC, "id" DESC LIMIT ?`,
      )
      .all(
        command.projectId,
        command.principal.subject.id,
        threshold,
        this.options.rateLimit,
      ) as QueryRow[];
    if (rows.length < this.options.rateLimit) return;
    const earliestAtMs = requiredInteger(rows[rows.length - 1]!, 'createdAtMs');
    throw new RunManualRetryRateLimitedError(
      Math.max(
        1,
        earliestAtMs + RUN_MANUAL_RETRY_RATE_WINDOW_MS - observedAtMs,
      ),
    );
  }

  private insertRetry(
    command: Readonly<RunManualRetryCommand>,
    source: Readonly<SourceRun>,
    executionRevisionDigest: string,
    observedAtMs: number,
  ): void {
    const client = this.authority.client;
    client
      .prepare(
        `INSERT INTO "Runs" (
           "id", "project_id", "task_id", "task_revision", "task_name",
           "task_snapshot_ref", "retry_of_run_id", "trigger_type",
           "execution_origin", "execution_owner", "triggered_by",
           "request_id", "status", "version", "event_sequence", "priority",
           "idempotency_key", "input_ref", "created_at_ms", "queued_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'run_manual_retry', 'manual',
                   'runtime', ?, ?, 'queued', 2, 2, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        observedAtMs,
      );
    client
      .prepare(
        `INSERT INTO "RunAttempts" (
           "id", "run_id", "attempt", "status", "executor_type",
           "callback_sequence", "created_at_ms"
         ) VALUES (?, ?, 1, 'claimed', 'local_process', 0, ?)`,
      )
      .run(command.attemptId, command.runId, observedAtMs);
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
        `run-manual-retry-created:${command.mutationId}`,
        command.principal.subject.type,
        command.principal.subject.id,
        command.attemptId,
        JSON.stringify({
          status: 'created',
          version: 1,
          execution_owner: 'runtime',
          executor_type: 'local_process',
          execution_revision_digest: executionRevisionDigest,
          retry_of_run_id: command.sourceRunId,
          source_run_status: command.expectedRunStatus,
          source_run_version: command.expectedRunVersion,
          inherit_retry_policy: false,
          mutation_id: command.mutationId,
          policy_fence: {
            project_version: command.policyFence.projectVersion,
            binding_version: command.policyFence.bindingVersion,
          },
        }),
        observedAtMs,
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
      );
  }

  private audit(
    command: Readonly<RunManualRetryCommand>,
    observedAtMs: number,
  ) {
    return normalizeSecurityAuditRecord({
      eventId: command.auditEventId,
      requestId: command.requestId,
      operationId: 'run.retry',
      projectId: command.projectId,
      subject: command.principal.subject,
      authenticationId: command.principal.authenticationId,
      outcome: 'allowed',
      reasons: ['role_grant', 'strong_authentication'],
      fence: command.policyFence,
      occurredAtMs: observedAtMs,
    });
  }

  private commitAudit(
    audit: Readonly<SecurityAuditRecord>,
    replay: boolean,
  ): void {
    const row = this.authority.client
      .prepare(
        `SELECT ${AUDIT_SELECT}
           FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
      )
      .get(audit.eventId) as QueryRow | undefined;
    if (replay) {
      const stored = row ? localSecurityAuditFromRow(row) : null;
      const storedWithoutTime = stored
        ? Object.freeze({ ...stored, occurredAtMs: audit.occurredAtMs })
        : null;
      if (
        !storedWithoutTime ||
        !sameSecurityAuditSemantic(storedWithoutTime, audit)
      ) {
        throw new RunManualRetryFenceRejectedError('mutation_conflict');
      }
      return;
    }
    if (row) {
      throw new RunManualRetryFenceRejectedError('mutation_conflict');
    }
    insertLocalSecurityAudit(this.authority.client, audit);
  }
}
