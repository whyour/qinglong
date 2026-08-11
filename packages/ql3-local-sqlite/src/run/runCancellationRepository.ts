// Run owns the Project-fenced durable cancellation intent mutation.
import {
  InvalidRunCancellationError,
  RunCancellationFenceRejectedError,
  RunCancellationNotFoundError,
  RunCancellationUnavailableError,
  normalizeRunCancellationCommand,
  normalizeRunCancellationResult,
  type RunCancellationAllowedRole,
  type RunCancellationCommand,
  type RunCancellationRepository,
  type RunCancellationResult,
} from '@qinglong/runtime-core/run-cancellation';
import { RUN_STATUSES, type RunStatus } from '@qinglong/runtime-core/run';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  optionalInteger,
  optionalString,
  requiredInteger,
  requiredString,
  type QueryRow,
} from './runPersistence';

const ALLOWED_ROLES = new Set<RunCancellationAllowedRole>([
  'owner',
  'admin',
  'operator',
]);
const TERMINAL = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Local SQLite Run cancellation clock is invalid');
  }
  return value;
}

function status(row: QueryRow): RunStatus {
  const value = requiredString(row, 'runStatus') as RunStatus;
  if (!RUN_STATUSES.includes(value)) {
    throw new TypeError('Local SQLite Run cancellation status is invalid');
  }
  return value;
}

function result(
  disposition: RunCancellationResult['status'],
  command: Readonly<RunCancellationCommand>,
  row: QueryRow,
): Readonly<RunCancellationResult> {
  const cancelRequestedAtMs = optionalInteger(row, 'cancelRequestedAtMs');
  const cancelReason = optionalString(row, 'cancelReason');
  if (
    (cancelRequestedAtMs === undefined) !== (cancelReason === undefined) ||
    (cancelReason !== undefined && !CANCEL_REASONS.has(cancelReason))
  ) {
    throw new TypeError('Local SQLite Run cancellation intent is invalid');
  }
  return normalizeRunCancellationResult({
    status: disposition,
    projectId: command.projectId,
    runId: command.runId,
    runStatus: status(row),
    runVersion: requiredInteger(row, 'runVersion'),
    eventSequence: requiredInteger(row, 'eventSequence'),
    ...(cancelRequestedAtMs === undefined
      ? {}
      : {
          cancelRequestedAtMs,
          cancelReason: cancelReason as NonNullable<
            RunCancellationResult['cancelReason']
          >,
        }),
  });
}

function rollback(authority: LocalSqliteOperationAuthority): void {
  if (!authority.client.isTransaction) return;
  try {
    authority.client.exec('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure; close owns broken handles.
  }
}

export class LocalSqliteRunCancellationRepository
  implements RunCancellationRepository
{
  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof now !== 'function'
    ) {
      throw new TypeError(
        'Local SQLite Run cancellation dependencies are invalid',
      );
    }
  }

  requestUserCancellation(
    value: Readonly<RunCancellationCommand>,
  ): Promise<Readonly<RunCancellationResult>> {
    let command: Readonly<RunCancellationCommand>;
    try {
      command = normalizeRunCancellationCommand(value);
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
          if (!project) throw new RunCancellationNotFoundError();
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
              requiredString(
                binding,
                'bindingRole',
              ) as RunCancellationAllowedRole,
            )
          ) {
            throw new RunCancellationFenceRejectedError(
              'authorization_changed',
            );
          }

          const run = client
            .prepare(
              `SELECT "project_id" AS "projectId", "status" AS "runStatus",
                      "version" AS "runVersion",
                      "event_sequence" AS "eventSequence",
                      "cancel_requested_at_ms" AS "cancelRequestedAtMs",
                      "cancel_reason" AS "cancelReason"
               FROM "Runs" WHERE "id" = ?`,
            )
            .get(command.runId) as QueryRow | undefined;
          if (
            !run ||
            requiredString(run, 'projectId') !== command.projectId
          ) {
            throw new RunCancellationNotFoundError();
          }
          const runStatus = status(run);
          if (TERMINAL.has(runStatus)) {
            const outcome = result('already_terminal', command, run);
            client.exec('COMMIT');
            return outcome;
          }
          if (optionalInteger(run, 'cancelRequestedAtMs') !== undefined) {
            const outcome = result('already_requested', command, run);
            client.exec('COMMIT');
            return outcome;
          }
          if (optionalString(run, 'cancelReason') !== undefined) {
            throw new RunCancellationFenceRejectedError('state_mismatch');
          }

          const runVersion = requiredInteger(run, 'runVersion');
          const eventSequence = requiredInteger(run, 'eventSequence');
          if (runVersion >= 2_147_483_647 || eventSequence >= 2_147_483_647) {
            throw new RunCancellationFenceRejectedError('state_mismatch');
          }
          const observedAtMs = timestamp(this.now());
          const updated = client
            .prepare(
              `UPDATE "Runs"
               SET "cancel_requested_at_ms" = ?, "cancel_reason" = 'user',
                   "version" = ?, "event_sequence" = ?
               WHERE "id" = ? AND "project_id" = ? AND "version" = ?
                 AND "cancel_requested_at_ms" IS NULL
               RETURNING "project_id" AS "projectId",
                         "status" AS "runStatus", "version" AS "runVersion",
                         "event_sequence" AS "eventSequence",
                         "cancel_requested_at_ms" AS "cancelRequestedAtMs",
                         "cancel_reason" AS "cancelReason"`,
            )
            .get(
              observedAtMs,
              runVersion + 1,
              eventSequence + 1,
              command.runId,
              command.projectId,
              runVersion,
            ) as QueryRow | undefined;
          if (!updated) {
            throw new RunCancellationFenceRejectedError('state_mismatch');
          }
          client
            .prepare(
              `INSERT INTO "RunEvents" (
                 "id", "run_id", "sequence", "type", "dedupe_key",
                 "actor_type", "actor_id", "attempt_id", "step_run_id",
                 "payload", "created_at_ms"
               ) VALUES (?, ?, ?, 'run.cancel_requested', ?, ?, ?,
                         NULL, NULL, ?, ?)`,
            )
            .run(
              command.eventId,
              command.runId,
              eventSequence + 1,
              `user-cancel:${command.mutationId}`,
              command.subject.type,
              command.subject.id,
              JSON.stringify({
                reason: 'user',
                mutation_id: command.mutationId,
                policy_fence: {
                  project_version: command.policyFence.projectVersion,
                  binding_version: command.policyFence.bindingVersion,
                },
              }),
              observedAtMs,
            );
          const outcome = result('accepted', command, updated);
          client.exec('COMMIT');
          return outcome;
        } catch (error) {
          rollback(this.authority);
          if (
            error instanceof InvalidRunCancellationError ||
            error instanceof RunCancellationNotFoundError ||
            error instanceof RunCancellationFenceRejectedError
          ) {
            throw error;
          }
          throw new RunCancellationUnavailableError({ cause: error });
        }
      },
      () => new RunCancellationUnavailableError(),
    );
  }
}
