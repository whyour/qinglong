import type { PostgresPool } from '@qinglong/runtime-core';
import {
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';
import {
  normalizeApprovedActionExecutionRecord,
  normalizeApprovedActionExecutionSnapshot,
  type ApprovedActionExecutionRecord,
  type ApprovedActionExecutionSnapshot,
} from '@qinglong/runtime-core/approved-action-execution';
import {
  ApprovedActionManualRecoveryFenceConflictError,
  ApprovedActionManualRecoveryTargetUnavailableError,
  ApprovedActionManualRecoveryUnavailableError,
  normalizeApprovedActionManualRecoveryResolution,
  normalizeApprovedActionManualRecoverySnapshot,
  type ApprovedActionManualRecoveryRepository,
  type ApprovedActionManualRecoveryResolutionRecord,
  type ApprovedActionManualRecoverySnapshot,
  type ResolveApprovedActionManualRecoveryCommand,
  type ResolveApprovedActionManualRecoveryResult,
} from '@qinglong/runtime-core/approved-action-manual-recovery';
import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';

import {
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
} from '../repository/definitionRepositorySupport';

type Row = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function unavailable(options?: ErrorOptions): ApprovedActionManualRecoveryUnavailableError {
  return new ApprovedActionManualRecoveryUnavailableError(options);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseDispatch(row: Row): Readonly<ApprovedActionDispatchRecord> {
  try {
    return normalizeApprovedActionDispatchRecord(
      postgresRequiredJsonObject(
        row.dispatchJson,
        unavailable,
      ) as unknown as ApprovedActionDispatchRecord,
    );
  } catch (error) {
    if (error instanceof ApprovedActionManualRecoveryUnavailableError) throw error;
    throw unavailable();
  }
}
function parseExecution(row: Row): Readonly<ApprovedActionExecutionRecord> {
  try {
    const execution = normalizeApprovedActionExecutionRecord(
      postgresRequiredJsonObject(
        row.executionJson,
        unavailable,
      ) as unknown as ApprovedActionExecutionRecord,
    );
    if (
      execution.executionDigest !==
      postgresRequiredString(row.executionDigest, unavailable)
    ) {
      throw unavailable();
    }
    return execution;
  } catch (error) {
    if (error instanceof ApprovedActionManualRecoveryUnavailableError) throw error;
    throw unavailable();
  }
}

function parseResolution(
  value: unknown,
): Readonly<ApprovedActionManualRecoveryResolutionRecord> | null {
  if (value === null || value === undefined) return null;
  try {
    return normalizeApprovedActionManualRecoveryResolution(
      postgresRequiredJsonObject(
        value,
        unavailable,
      ) as unknown as ApprovedActionManualRecoveryResolutionRecord,
    );
  } catch (error) {
    if (error instanceof ApprovedActionManualRecoveryUnavailableError) throw error;
    throw unavailable();
  }
}

function parseSnapshot(row: Row): Readonly<ApprovedActionManualRecoverySnapshot> {
  try {
    return normalizeApprovedActionManualRecoverySnapshot({
      execution: normalizeApprovedActionExecutionSnapshot({
        dispatch: parseDispatch(row),
        execution: parseExecution(row),
      }),
      resolution: parseResolution(row.resolutionJson),
    });
  } catch (error) {
    if (error instanceof ApprovedActionManualRecoveryUnavailableError) throw error;
    throw unavailable();
  }
}

function mapped(error: unknown): Error {
  if (
    error instanceof ApprovedActionManualRecoveryFenceConflictError ||
    error instanceof ApprovedActionManualRecoveryTargetUnavailableError ||
    error instanceof ApprovedActionManualRecoveryUnavailableError ||
    (error instanceof Error && error.name.startsWith('InvalidApprovedAction'))
  ) {
    return error;
  }
  const state = postgresSqlState(error);
  if (
    state === '23503' ||
    state === '23505' ||
    state === '23514' ||
    state === '40001' ||
    state === '40P01'
  ) {
    return new ApprovedActionManualRecoveryFenceConflictError();
  }
  return unavailable({ cause: error instanceof Error ? error : undefined });
}

function auditMatchesResolution(
  audit: Readonly<SecurityAuditRecord>,
  resolution: Readonly<ApprovedActionManualRecoveryResolutionRecord>,
): boolean {
  return (
    audit.eventId === resolution.auditEventId &&
    audit.operationId === 'approval.recover.resolve' &&
    audit.projectId === resolution.projectId &&
    audit.subject?.type === resolution.resolvedBy.type &&
    audit.subject.id === resolution.resolvedBy.id &&
    audit.authenticationId === resolution.authenticationId &&
    audit.outcome === 'allowed' &&
    same(audit.reasons, [
      'role_grant',
      'strong_authentication',
      'manual_recovery',
    ]) &&
    same(audit.fence, resolution.authorizationFence) &&
    audit.occurredAtMs === resolution.resolvedAtMs
  );
}

function normalizeCommand(
  value: Readonly<ResolveApprovedActionManualRecoveryCommand>,
): Readonly<ResolveApprovedActionManualRecoveryCommand> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['previous', 'nextExecution', 'resolution', 'audit'].sort().join('\0')
  ) {
    throw new TypeError('Approved Action manual recovery command is invalid');
  }
  const previous = normalizeApprovedActionExecutionSnapshot(value.previous);
  const nextExecution = normalizeApprovedActionExecutionRecord(value.nextExecution);
  const resolution = normalizeApprovedActionManualRecoveryResolution(
    value.resolution,
  );
  const audit = normalizeSecurityAuditRecord(value.audit);
  if (
    previous.dispatch.id !== resolution.dispatchId ||
    previous.dispatch.projectId !== resolution.projectId ||
    previous.dispatch.action.actionType !== resolution.actionType ||
    previous.dispatch.action.actionDigest !== resolution.actionDigest ||
    previous.execution.version !== resolution.executionVersion ||
    previous.execution.executionDigest !== resolution.executionDigest ||
    nextExecution.dispatchId !== previous.dispatch.id ||
    nextExecution.version !== previous.execution.version + 1 ||
    nextExecution.resultMutationId !== resolution.mutationId ||
    nextExecution.completedAtMs !== resolution.resolvedAtMs ||
    !auditMatchesResolution(audit, resolution)
  ) {
    throw new ApprovedActionManualRecoveryFenceConflictError();
  }
  return Object.freeze({ previous, nextExecution, resolution, audit });
}

export class PostgresApprovedActionManualRecoveryRepository
  implements ApprovedActionManualRecoveryRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Approved Action manual recovery pool is invalid',
      );
    }
  }

  async findByDispatchId(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionManualRecoverySnapshot> | null> {
    if (typeof dispatchId !== 'string' || !IDENTIFIER_PATTERN.test(dispatchId)) {
      throw new TypeError('Approved Action recovery dispatch id is invalid');
    }
    try {
      const result = await this.pool.query<Row>(
        `SELECT dispatch.dispatch_json AS "dispatchJson",
                execution.execution_json AS "executionJson",
                execution.execution_digest AS "executionDigest",
                resolution.resolution_json AS "resolutionJson"
           FROM "ql3"."approved_action_executions" AS execution
           JOIN "ql3"."approved_action_dispatches" AS dispatch
             ON dispatch.dispatch_id = execution.dispatch_id
           LEFT JOIN "ql3"."approved_action_manual_recovery_resolutions" AS resolution
             ON resolution.dispatch_id = execution.dispatch_id
          WHERE execution.dispatch_id = $1
          LIMIT 2`,
        [dispatchId],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      return parseSnapshot(result.rows[0]!);
    } catch (error) {
      throw mapped(error);
    }
  }

  async resolve(
    commandValue: Readonly<ResolveApprovedActionManualRecoveryCommand>,
  ): Promise<Readonly<ResolveApprovedActionManualRecoveryResult>> {
    const command = normalizeCommand(commandValue);
    try {
      const result = await this.pool.query<Row>(
        `SELECT "ql3"."resolve_approved_action_manual_recovery"(
           $1::jsonb, $2::jsonb, $3::jsonb
         ) AS status`,
        [
          JSON.stringify(command.resolution),
          JSON.stringify(command.nextExecution),
          JSON.stringify(command.audit),
        ],
      );
      if (result.rows.length !== 1) throw unavailable();
      const status = postgresRequiredString(result.rows[0]!.status, unavailable);
      if (status !== 'resolved' && status !== 'existing') throw unavailable();
      const stored = await this.findByDispatchId(command.resolution.dispatchId);
      if (
        !stored ||
        !stored.resolution ||
        !same(stored.resolution, command.resolution) ||
        !same(stored.execution.execution, command.nextExecution)
      ) {
        throw new ApprovedActionManualRecoveryFenceConflictError();
      }
      return Object.freeze({ status, snapshot: stored });
    } catch (error) {
      throw mapped(error);
    }
  }
}
