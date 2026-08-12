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
import {
  normalizeSecurityPrincipal,
  type SecurityPolicyFence,
  type SecurityPrincipal,
  type SecuritySubject,
} from '@qinglong/runtime-core/security';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  insertLocalSecurityAudit,
  localSecurityAuditFromRow,
  sameSecurityAuditSemantic,
} from '../security/securityPersistence';
import {
  optionalInteger,
  optionalString,
  requiredInteger,
  requiredString,
  type QueryRow,
} from './runPersistence';

const MAX_AUTHENTICATION_AGE_MS = 5 * 60 * 1_000;
const STRONG_ASSURANCES = new Set([
  'multi_factor',
  'hardware',
  'local_console',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

export interface LocalSqliteRunManagementCancellationCommand {
  readonly projectId: string;
  readonly runId: string;
  readonly mutationId: string;
  readonly eventId: string;
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence>;
}

export interface LocalSqliteRunCancellationRepositoryOptions {
  readonly beforeMutation?: (actor: Readonly<SecuritySubject>) => void;
}

interface CancellationAudit {
  readonly requestId: string;
  readonly auditEventId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRunCancellationError('management command is invalid');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new InvalidRunCancellationError(
      'management command shape is invalid',
    );
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidRunCancellationError(`${label} is invalid`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new InvalidRunCancellationError(`${label} is invalid`);
  }
  return value;
}

function normalizeManagementCommand(
  value: Readonly<LocalSqliteRunManagementCancellationCommand>,
): Readonly<{
  command: Readonly<RunCancellationCommand>;
  audit: Readonly<CancellationAudit>;
}> {
  const input = exact(value, [
    'projectId',
    'runId',
    'mutationId',
    'eventId',
    'requestId',
    'auditEventId',
    'principal',
    'policyFence',
  ]);
  const principal = exact(input.principal, [
    'subject',
    'authenticationId',
    'authenticatedAtMs',
    'expiresAtMs',
    'assurance',
  ]) as unknown as SecurityPrincipal;
  const projectId = identifier(input.projectId, 'projectId');
  const runId = identifier(input.runId, 'runId');
  const mutationId = uuid(input.mutationId, 'mutationId');
  const eventId = uuid(input.eventId, 'eventId');
  const requestId = identifier(input.requestId, 'requestId');
  const auditEventId = uuid(input.auditEventId, 'auditEventId');
  if (eventId === auditEventId) {
    throw new InvalidRunCancellationError('event identities must differ');
  }
  return Object.freeze({
    command: normalizeRunCancellationCommand({
      projectId,
      runId,
      mutationId,
      eventId,
      subject: principal.subject,
      policyFence: input.policyFence as SecurityPolicyFence,
    }),
    audit: Object.freeze({ requestId, auditEventId, principal }),
  });
}

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
  private readonly beforeMutation: (actor: Readonly<SecuritySubject>) => void;

  constructor(
    private readonly authority: LocalSqliteOperationAuthority,
    private readonly now: () => number = Date.now,
    options: LocalSqliteRunCancellationRepositoryOptions = {},
  ) {
    if (
      !(authority instanceof LocalSqliteOperationAuthority) ||
      typeof now !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'beforeMutation') ||
      (options.beforeMutation !== undefined &&
        typeof options.beforeMutation !== 'function')
    ) {
      throw new TypeError(
        'Local SQLite Run cancellation dependencies are invalid',
      );
    }
    this.beforeMutation = options.beforeMutation ?? (() => undefined);
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
    return this.requestCancellation(command);
  }

  requestUserCancellationAudited(
    value: Readonly<LocalSqliteRunManagementCancellationCommand>,
  ): Promise<Readonly<RunCancellationResult>> {
    let normalized: ReturnType<typeof normalizeManagementCommand>;
    try {
      normalized = normalizeManagementCommand(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.requestCancellation(normalized.command, normalized.audit);
  }

  private requestCancellation(
    command: Readonly<RunCancellationCommand>,
    audit?: Readonly<CancellationAudit>,
  ): Promise<Readonly<RunCancellationResult>> {
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        try {
          client.exec('BEGIN IMMEDIATE');
          const observedAtMs = audit ? this.databaseTime() : undefined;
          const confirmedAudit = audit
            ? Object.freeze({
                ...audit,
                principal: this.confirmStrongAuthentication(
                  audit.principal,
                  observedAtMs!,
                ),
              })
            : undefined;
          if (
            confirmedAudit &&
            (confirmedAudit.principal.subject.type !== command.subject.type ||
              confirmedAudit.principal.subject.id !== command.subject.id)
          ) {
            throw new RunCancellationFenceRejectedError(
              'authorization_changed',
            );
          }
          if (confirmedAudit) {
            try {
              this.beforeMutation(confirmedAudit.principal.subject);
            } catch {
              throw new RunCancellationFenceRejectedError(
                'authorization_changed',
              );
            }
          }
          this.confirmAuthorization(command);

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
          if (!run || requiredString(run, 'projectId') !== command.projectId) {
            throw new RunCancellationNotFoundError();
          }
          const runStatus = status(run);
          let outcome: Readonly<RunCancellationResult>;
          if (TERMINAL.has(runStatus)) {
            outcome = result('already_terminal', command, run);
          } else if (
            optionalInteger(run, 'cancelRequestedAtMs') !== undefined
          ) {
            outcome = result('already_requested', command, run);
          } else if (optionalString(run, 'cancelReason') !== undefined) {
            throw new RunCancellationFenceRejectedError('state_mismatch');
          } else {
            const runVersion = requiredInteger(run, 'runVersion');
            const eventSequence = requiredInteger(run, 'eventSequence');
            if (runVersion >= 2_147_483_647 || eventSequence >= 2_147_483_647) {
              throw new RunCancellationFenceRejectedError('state_mismatch');
            }
            const mutationObservedAtMs = observedAtMs ?? timestamp(this.now());
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
                mutationObservedAtMs,
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
                mutationObservedAtMs,
              );
            outcome = result('accepted', command, updated);
          }
          if (confirmedAudit) {
            this.commitAudit(
              this.allowedAudit(command, confirmedAudit, observedAtMs!),
            );
          }
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

  private databaseTime(): number {
    const row = this.authority.client
      .prepare(
        `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "observedAtMs"`,
      )
      .get() as QueryRow | undefined;
    return timestamp(row?.observedAtMs as number);
  }

  private confirmStrongAuthentication(
    value: Readonly<SecurityPrincipal>,
    observedAtMs: number,
  ): Readonly<SecurityPrincipal> {
    let principal: Readonly<SecurityPrincipal>;
    try {
      principal = normalizeSecurityPrincipal(value, observedAtMs);
    } catch {
      throw new RunCancellationFenceRejectedError('authorization_changed');
    }
    if (
      principal.subject.type !== 'user' ||
      !STRONG_ASSURANCES.has(principal.assurance) ||
      principal.authenticatedAtMs > observedAtMs ||
      principal.expiresAtMs <= observedAtMs ||
      observedAtMs - principal.authenticatedAtMs > MAX_AUTHENTICATION_AGE_MS
    ) {
      throw new RunCancellationFenceRejectedError('authorization_changed');
    }
    return principal;
  }

  private confirmAuthorization(
    command: Readonly<RunCancellationCommand>,
  ): void {
    const client = this.authority.client;
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
      .get(command.projectId, command.subject.type, command.subject.id) as
      | QueryRow
      | undefined;
    if (
      requiredString(project, 'projectStatus') !== 'active' ||
      requiredInteger(project, 'projectVersion') !==
        command.policyFence.projectVersion ||
      !binding ||
      requiredInteger(binding, 'bindingVersion') !==
        command.policyFence.bindingVersion ||
      requiredString(binding, 'bindingState') !== 'active' ||
      !ALLOWED_ROLES.has(
        requiredString(binding, 'bindingRole') as RunCancellationAllowedRole,
      )
    ) {
      throw new RunCancellationFenceRejectedError('authorization_changed');
    }
  }

  private allowedAudit(
    command: Readonly<RunCancellationCommand>,
    audit: Readonly<CancellationAudit>,
    observedAtMs: number,
  ): Readonly<SecurityAuditRecord> {
    return normalizeSecurityAuditRecord({
      eventId: audit.auditEventId,
      requestId: audit.requestId,
      operationId: 'run.stop',
      projectId: command.projectId,
      subject: audit.principal.subject,
      authenticationId: audit.principal.authenticationId,
      outcome: 'allowed',
      reasons: ['role_grant', 'strong_authentication'],
      fence: command.policyFence,
      occurredAtMs: observedAtMs,
    });
  }

  private commitAudit(audit: Readonly<SecurityAuditRecord>): void {
    const row = this.authority.client
      .prepare(
        `SELECT ${AUDIT_SELECT}
         FROM "QingLong3SecurityAuditEvents" WHERE "event_id" = ?`,
      )
      .get(audit.eventId) as QueryRow | undefined;
    if (row) {
      const stored = localSecurityAuditFromRow(row);
      const storedWithoutTime = Object.freeze({
        ...stored,
        occurredAtMs: audit.occurredAtMs,
      });
      if (!sameSecurityAuditSemantic(storedWithoutTime, audit)) {
        throw new RunCancellationFenceRejectedError('state_mismatch');
      }
      return;
    }
    insertLocalSecurityAudit(this.authority.client, audit);
  }
}
