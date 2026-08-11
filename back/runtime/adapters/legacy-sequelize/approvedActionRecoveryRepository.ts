import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { APPROVED_ACTION_DISPATCH_TABLE } from '../../../migrations/0020-approval-requests';
import { APPROVED_ACTION_DISPATCH_EXECUTION_TABLE } from '../../../migrations/0021-approved-action-dispatch-executions';
import {
  APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
  APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
} from '../../../migrations/0022-approved-action-recovery';
import { APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE } from '../../../migrations/0024-approved-action-recovery-authorization';
import {
  PROJECT_ROLE_BINDING_TABLE,
  PROJECT_TABLE,
} from '../../../migrations/0017-project-policy';
import {
  ApprovedActionDispatchBindingConflictError,
  assertApprovedActionLeaseIdentity,
  assertApprovedActionResultCode,
  normalizeApprovedActionDispatchExecutionRecord,
  type ApprovedActionDispatchExecutionRecord,
  type ApprovedActionDispatchExecutionSnapshot,
} from '../../domain/approvedActionDispatchExecution';
import {
  ApprovedActionRecoveryBindingConflictError,
  ApprovedActionRecoveryFenceRejectedError,
  ApprovedActionRecoveryRepositoryError,
  MAX_APPROVED_ACTION_RECOVERY_FINDINGS,
  assertApprovedActionEvidenceDigest,
  assertApprovedActionRecoveryLeaseDuration,
  assertApprovedActionRecoveryPageSize,
  normalizeApprovedActionRecoveryControlRecord,
  normalizeApprovedActionRecoveryCursor,
  normalizeApprovedActionRecoveryResolutionRecord,
  type ApprovedActionRecoveryControlRecord,
  type ApprovedActionRecoveryResolutionRecord,
  type ApprovedActionRecoverySnapshot,
} from '../../domain/approvedActionRecovery';
import {
  normalizeApprovedActionRecoveryAuthorizationFact,
  type ApprovedActionRecoveryAuthorizationFact,
} from '../../domain/approvedActionRecoveryAuthorization';
import {
  InvalidApprovalValueError,
  assertApprovalMutationId,
  assertApprovalTimestamp,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '../../domain/approvalRequest';
import { normalizePolicySubject } from '../../domain/projectPolicy';
import type {
  ApprovedActionRecoveryRepository,
  ClaimApprovedActionRecoveryCommand,
  ClaimApprovedActionRecoveryResult,
  ListDueApprovedActionRecoveriesQuery,
  ListDueApprovedActionRecoveriesResult,
  RecordApprovedActionRecoveryFindingCommand,
  ResolveApprovedActionRecoveryCommand,
  ResolveApprovedActionRecoveryResult,
} from '../../ports/approvedActionRecoveryRepository';

const RETRY_ATTEMPTS = 5;

interface RecoveryRow {
  dispatch_id: string;
  approval_request_id: string;
  approval_request_version: number | string;
  dispatch_project_id: string;
  dispatch_state: string;
  permission: string;
  action_type: string;
  action_ref: string;
  action_digest: string;
  preview_digest: string;
  requested_by_type: string;
  requested_by_id: string;
  consumed_by_type: string;
  consumed_by_id: string;
  dispatch_created_at_ms: number | string;
  execution_project_id: string;
  execution_status: string;
  execution_version: number | string;
  attempt_count: number | string;
  max_attempts: number | string;
  eligible_at_ms: number | string | null;
  next_attempt_at_ms: number | string | null;
  execution_lease_owner: string | null;
  execution_lease_token: string | null;
  execution_lease_expires_at_ms: number | string | null;
  started_at_ms: number | string | null;
  execution_result_mutation_id: string | null;
  execution_last_result_code: string | null;
  completed_at_ms: number | string | null;
  execution_created_at_ms: number | string;
  execution_updated_at_ms: number | string;
  recovery_project_id: string;
  recovery_execution_version: number | string;
  recovery_status: string;
  recovery_version: number | string;
  next_scan_at_ms: number | string | null;
  recovery_lease_owner: string | null;
  recovery_lease_token: string | null;
  recovery_lease_expires_at_ms: number | string | null;
  finding_count: number | string;
  last_finding_mutation_id: string | null;
  last_finding: string | null;
  recovery_last_result_code: string | null;
  last_evidence_digest: string | null;
  recovery_resolution_mutation_id: string | null;
  recovery_created_at_ms: number | string;
  recovery_updated_at_ms: number | string;
  resolution_project_id: string | null;
  resolution_execution_version: number | string | null;
  resolution_mutation_id: string | null;
  resolution_source: string | null;
  resolution_decision: string | null;
  resolution_evidence_digest: string | null;
  resolution_reason_code: string | null;
  resolved_by_type: string | null;
  resolved_by_id: string | null;
  resolved_at_ms: number | string | null;
}

interface AuthorizationFactRow {
  dispatch_id: string;
  project_id: string;
  mutation_id: string;
  resolved_by_id: string;
  authentication_id: string;
  assurance: string;
  authenticated_at_ms: number | string;
  project_version: number | string;
  binding_version: number | string;
  authorized_at_ms: number | string;
  fact_digest: string;
}

interface PolicyFenceRow {
  project_version: number | string;
  binding_version: number | string | null;
}

const RECOVERY_SELECT = `SELECT dispatch.id AS dispatch_id,
       dispatch.approval_request_id AS approval_request_id,
       dispatch.approval_request_version AS approval_request_version,
       dispatch.project_id AS dispatch_project_id,
       dispatch.state AS dispatch_state,
       dispatch.permission AS permission,
       dispatch.action_type AS action_type,
       dispatch.action_ref AS action_ref,
       dispatch.action_digest AS action_digest,
       dispatch.preview_digest AS preview_digest,
       dispatch.requested_by_type AS requested_by_type,
       dispatch.requested_by_id AS requested_by_id,
       dispatch.consumed_by_type AS consumed_by_type,
       dispatch.consumed_by_id AS consumed_by_id,
       dispatch.created_at_ms AS dispatch_created_at_ms,
       execution.project_id AS execution_project_id,
       execution.status AS execution_status,
       execution.version AS execution_version,
       execution.attempt_count AS attempt_count,
       execution.max_attempts AS max_attempts,
       execution.eligible_at_ms AS eligible_at_ms,
       execution.next_attempt_at_ms AS next_attempt_at_ms,
       execution.lease_owner AS execution_lease_owner,
       execution.lease_token AS execution_lease_token,
       execution.lease_expires_at_ms AS execution_lease_expires_at_ms,
       execution.started_at_ms AS started_at_ms,
       execution.result_mutation_id AS execution_result_mutation_id,
       execution.last_result_code AS execution_last_result_code,
       execution.completed_at_ms AS completed_at_ms,
       execution.created_at_ms AS execution_created_at_ms,
       execution.updated_at_ms AS execution_updated_at_ms,
       recovery.project_id AS recovery_project_id,
       recovery.execution_version AS recovery_execution_version,
       recovery.status AS recovery_status,
       recovery.version AS recovery_version,
       recovery.next_scan_at_ms AS next_scan_at_ms,
       recovery.lease_owner AS recovery_lease_owner,
       recovery.lease_token AS recovery_lease_token,
       recovery.lease_expires_at_ms AS recovery_lease_expires_at_ms,
       recovery.finding_count AS finding_count,
       recovery.last_finding_mutation_id AS last_finding_mutation_id,
       recovery.last_finding AS last_finding,
       recovery.last_result_code AS recovery_last_result_code,
       recovery.last_evidence_digest AS last_evidence_digest,
       recovery.resolution_mutation_id AS recovery_resolution_mutation_id,
       recovery.created_at_ms AS recovery_created_at_ms,
       recovery.updated_at_ms AS recovery_updated_at_ms,
       resolution.project_id AS resolution_project_id,
       resolution.execution_version AS resolution_execution_version,
       resolution.mutation_id AS resolution_mutation_id,
       resolution.source AS resolution_source,
       resolution.decision AS resolution_decision,
       resolution.evidence_digest AS resolution_evidence_digest,
       resolution.reason_code AS resolution_reason_code,
       resolution.resolved_by_type AS resolved_by_type,
       resolution.resolved_by_id AS resolved_by_id,
       resolution.resolved_at_ms AS resolved_at_ms
  FROM "${APPROVED_ACTION_DISPATCH_TABLE}" AS dispatch
  JOIN "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}" AS execution
    ON execution.dispatch_id = dispatch.id
  JOIN "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}" AS recovery
    ON recovery.dispatch_id = dispatch.id
  LEFT JOIN "${APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE}" AS resolution
    ON resolution.dispatch_id = dispatch.id`;

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function rowToAuthorizationFact(
  row: AuthorizationFactRow,
): Readonly<ApprovedActionRecoveryAuthorizationFact> {
  return normalizeApprovedActionRecoveryAuthorizationFact({
    dispatchId: row.dispatch_id,
    projectId: row.project_id,
    mutationId: row.mutation_id,
    resolvedBy: { type: 'user', id: row.resolved_by_id },
    authenticationId: row.authentication_id,
    assurance:
      row.assurance as ApprovedActionRecoveryAuthorizationFact['assurance'],
    authenticatedAtMs: Number(row.authenticated_at_ms),
    projectVersion: Number(row.project_version),
    bindingVersion: Number(row.binding_version),
    authorizedAtMs: Number(row.authorized_at_ms),
    factDigest: row.fact_digest,
  });
}

function rowToRecoverySnapshot(
  row: RecoveryRow,
): Readonly<ApprovedActionRecoverySnapshot> {
  try {
    const dispatch = normalizeApprovedActionDispatchRecord({
      id: row.dispatch_id,
      approvalRequestId: row.approval_request_id,
      approvalRequestVersion: Number(row.approval_request_version),
      projectId: row.dispatch_project_id,
      state: row.dispatch_state as ApprovedActionDispatchRecord['state'],
      action: {
        permission:
          row.permission as ApprovedActionDispatchRecord['action']['permission'],
        actionType: row.action_type,
        actionRef: row.action_ref,
        actionDigest: row.action_digest,
        previewDigest: row.preview_digest,
      },
      requestedBy: {
        type: row.requested_by_type as ApprovedActionDispatchRecord['requestedBy']['type'],
        id: row.requested_by_id,
      },
      consumedBy: {
        type: row.consumed_by_type as ApprovedActionDispatchRecord['consumedBy']['type'],
        id: row.consumed_by_id,
      },
      createdAtMs: Number(row.dispatch_created_at_ms),
    });
    const execution = normalizeApprovedActionDispatchExecutionRecord({
      dispatchId: row.dispatch_id,
      projectId: row.execution_project_id,
      status:
        row.execution_status as ApprovedActionDispatchExecutionRecord['status'],
      version: Number(row.execution_version),
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      eligibleAtMs: numberOrNull(row.eligible_at_ms),
      nextAttemptAtMs: numberOrNull(row.next_attempt_at_ms),
      leaseOwner: row.execution_lease_owner,
      leaseToken: row.execution_lease_token,
      leaseExpiresAtMs: numberOrNull(row.execution_lease_expires_at_ms),
      startedAtMs: numberOrNull(row.started_at_ms),
      resultMutationId: row.execution_result_mutation_id,
      lastResultCode: row.execution_last_result_code,
      completedAtMs: numberOrNull(row.completed_at_ms),
      createdAtMs: Number(row.execution_created_at_ms),
      updatedAtMs: Number(row.execution_updated_at_ms),
    });
    const recovery = normalizeApprovedActionRecoveryControlRecord({
      dispatchId: row.dispatch_id,
      projectId: row.recovery_project_id,
      executionVersion: Number(row.recovery_execution_version),
      status:
        row.recovery_status as ApprovedActionRecoveryControlRecord['status'],
      version: Number(row.recovery_version),
      nextScanAtMs: numberOrNull(row.next_scan_at_ms),
      leaseOwner: row.recovery_lease_owner,
      leaseToken: row.recovery_lease_token,
      leaseExpiresAtMs: numberOrNull(row.recovery_lease_expires_at_ms),
      findingCount: Number(row.finding_count),
      lastFindingMutationId: row.last_finding_mutation_id,
      lastFinding:
        row.last_finding as ApprovedActionRecoveryControlRecord['lastFinding'],
      lastResultCode: row.recovery_last_result_code,
      lastEvidenceDigest: row.last_evidence_digest,
      resolutionMutationId: row.recovery_resolution_mutation_id,
      createdAtMs: Number(row.recovery_created_at_ms),
      updatedAtMs: Number(row.recovery_updated_at_ms),
    });
    const action: Readonly<ApprovedActionDispatchExecutionSnapshot> =
      Object.freeze({ dispatch, execution });
    let resolution: Readonly<ApprovedActionRecoveryResolutionRecord> | null =
      null;
    if (row.resolution_mutation_id !== null) {
      if (
        row.resolution_project_id === null ||
        row.resolution_execution_version === null ||
        row.resolution_source === null ||
        row.resolution_decision === null ||
        row.resolution_reason_code === null ||
        row.resolved_at_ms === null
      ) {
        throw new ApprovedActionRecoveryBindingConflictError();
      }
      resolution = normalizeApprovedActionRecoveryResolutionRecord({
        dispatchId: row.dispatch_id,
        projectId: row.resolution_project_id,
        executionVersion: Number(row.resolution_execution_version),
        mutationId: row.resolution_mutation_id,
        source:
          row.resolution_source as ApprovedActionRecoveryResolutionRecord['source'],
        decision:
          row.resolution_decision as ApprovedActionRecoveryResolutionRecord['decision'],
        evidenceDigest: row.resolution_evidence_digest,
        reasonCode: row.resolution_reason_code,
        resolvedBy:
          row.resolved_by_type === null || row.resolved_by_id === null
            ? null
            : {
                type: row.resolved_by_type as 'user',
                id: row.resolved_by_id,
              },
        resolvedAtMs: Number(row.resolved_at_ms),
      });
    }
    if (
      dispatch.id !== execution.dispatchId ||
      dispatch.id !== recovery.dispatchId ||
      dispatch.projectId !== execution.projectId ||
      dispatch.projectId !== recovery.projectId ||
      recovery.executionVersion !== execution.version
    ) {
      throw new ApprovedActionRecoveryBindingConflictError();
    }
    if (recovery.status === 'resolved') {
      if (
        !['succeeded', 'failed', 'blocked'].includes(execution.status) ||
        execution.resultMutationId !== recovery.resolutionMutationId
      ) {
        throw new ApprovedActionRecoveryBindingConflictError();
      }
    } else if (execution.status !== 'executing') {
      throw new ApprovedActionRecoveryBindingConflictError();
    }
    if (
      resolution &&
      (resolution.dispatchId !== dispatch.id ||
        resolution.projectId !== dispatch.projectId ||
        resolution.executionVersion + 1 !== execution.version ||
        resolution.mutationId !== recovery.resolutionMutationId ||
        resolution.mutationId !== execution.resultMutationId)
    ) {
      throw new ApprovedActionRecoveryBindingConflictError();
    }
    return Object.freeze({ action, recovery, resolution });
  } catch (error) {
    if (
      error instanceof ApprovedActionRecoveryBindingConflictError ||
      error instanceof ApprovedActionDispatchBindingConflictError
    ) {
      throw error;
    }
    throw new ApprovedActionRecoveryRepositoryError();
  }
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError('Approved action recovery command shape is invalid');
  }
}

function assertCommand(
  value: unknown,
  expected: readonly string[],
): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Approved action recovery command must be an object');
  }
  assertExactKeys(value, expected);
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2_147_483_647) {
    throw new RangeError('Approved action recovery version is invalid');
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const candidate of [
    error,
    'original' in error ? error.original : undefined,
    'parent' in error ? error.parent : undefined,
  ]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      'code' in candidate &&
      typeof candidate.code === 'string'
    ) {
      return candidate.code;
    }
  }
  return undefined;
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
}

function isKnownError(error: unknown): boolean {
  return (
    error instanceof ApprovedActionRecoveryBindingConflictError ||
    error instanceof ApprovedActionRecoveryFenceRejectedError ||
    error instanceof ApprovedActionRecoveryRepositoryError ||
    error instanceof InvalidApprovalValueError ||
    error instanceof RangeError ||
    error instanceof TypeError
  );
}

function terminalStatus(
  decision: ResolveApprovedActionRecoveryCommand['decision'],
): 'succeeded' | 'failed' | 'blocked' {
  if (decision === 'confirm_succeeded') return 'succeeded';
  if (decision === 'confirm_failed') return 'failed';
  return 'blocked';
}

export class LegacySequelizeApprovedActionRecoveryRepository
  implements ApprovedActionRecoveryRepository
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Approved action recovery repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  private async transactionWithRetry<T>(
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.database.transaction(
          { type: Transaction.TYPES.IMMEDIATE },
          operation,
        );
      } catch (error) {
        if (isKnownError(error)) throw error;
        if (
          errorCode(error) === 'SQLITE_BUSY' &&
          attempt < RETRY_ATTEMPTS - 1
        ) {
          await retryDelay(attempt);
          continue;
        }
        throw new ApprovedActionRecoveryRepositoryError();
      }
    }
    throw new ApprovedActionRecoveryRepositoryError();
  }

  private async selectSnapshot(
    dispatchId: string,
    transaction?: Transaction,
  ): Promise<Readonly<ApprovedActionRecoverySnapshot> | null> {
    const rows = await this.database.query<RecoveryRow>(
      `${RECOVERY_SELECT}
       WHERE dispatch.id = :dispatchId
       LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId },
        ...(transaction ? { transaction } : {}),
      },
    );
    if (rows.length === 0) {
      const executions = await this.database.query<{
        status: string;
      }>(
        `SELECT status
           FROM "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
          WHERE dispatch_id = :dispatchId
          LIMIT 2`,
        {
          type: QueryTypes.SELECT,
          replacements: { dispatchId },
          ...(transaction ? { transaction } : {}),
        },
      );
      if (
        executions.length !== 0 &&
        (executions.length !== 1 || executions[0].status === 'executing')
      ) {
        throw new ApprovedActionRecoveryRepositoryError();
      }
      return null;
    }
    if (rows.length !== 1) throw new ApprovedActionRecoveryRepositoryError();
    return rowToRecoverySnapshot(rows[0]);
  }

  private async updateControl(
    dispatchId: string,
    expectedExecutionVersion: number,
    expectedRecoveryVersion: number,
    expectedStatuses: readonly string[],
    values: Record<string, string | number | null>,
    transaction: Transaction,
    fence?: { owner: string; leaseToken: string },
  ): Promise<void> {
    const assignments = Object.keys(values)
      .map((field) => `"${field}" = :${field}`)
      .join(', ');
    const statusParameters = Object.fromEntries(
      expectedStatuses.map((status, index) => [
        `expectedStatus${index}`,
        status,
      ]),
    );
    const statusList = expectedStatuses
      .map((_, index) => `:expectedStatus${index}`)
      .join(', ');
    const [, affected] = await this.database.query(
      `UPDATE "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"
          SET ${assignments}
        WHERE dispatch_id = :dispatchId
          AND execution_version = :expectedExecutionVersion
          AND version = :expectedRecoveryVersion
          AND status IN (${statusList})
          ${
            fence
              ? 'AND lease_owner = :owner AND lease_token = :leaseToken'
              : ''
          }`,
      {
        type: QueryTypes.UPDATE,
        replacements: {
          ...values,
          dispatchId,
          expectedExecutionVersion,
          expectedRecoveryVersion,
          ...statusParameters,
          ...(fence ?? {}),
        },
        transaction,
      },
    );
    if (affected !== 1) throw new ApprovedActionRecoveryFenceRejectedError();
  }

  private async selectAuthorizationFact(
    dispatchId: string,
    transaction: Transaction,
  ): Promise<Readonly<ApprovedActionRecoveryAuthorizationFact> | null> {
    const rows = await this.database.query<AuthorizationFactRow>(
      `SELECT dispatch_id, project_id, mutation_id, resolved_by_id,
              authentication_id, assurance, authenticated_at_ms,
              project_version, binding_version, authorized_at_ms, fact_digest
         FROM "${APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE}"
        WHERE dispatch_id = :dispatchId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId },
        transaction,
      },
    );
    if (rows.length > 1) throw new ApprovedActionRecoveryRepositoryError();
    return rows.length === 0 ? null : rowToAuthorizationFact(rows[0]);
  }

  private async assertAuthorizationFence(
    fact: Readonly<ApprovedActionRecoveryAuthorizationFact>,
    transaction: Transaction,
  ): Promise<void> {
    const rows = await this.database.query<PolicyFenceRow>(
      `SELECT project.version AS project_version,
              (SELECT MAX(binding.version)
                 FROM "${PROJECT_ROLE_BINDING_TABLE}" AS binding
                WHERE binding.project_id = project.id
                  AND binding.subject_type = 'user'
                  AND binding.subject_id = :subjectId) AS binding_version
         FROM "${PROJECT_TABLE}" AS project
        WHERE project.id = :projectId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          projectId: fact.projectId,
          subjectId: fact.resolvedBy.id,
        },
        transaction,
      },
    );
    if (
      rows.length !== 1 ||
      Number(rows[0].project_version) !== fact.projectVersion ||
      rows[0].binding_version === null ||
      Number(rows[0].binding_version) !== fact.bindingVersion
    ) {
      throw new ApprovedActionRecoveryFenceRejectedError();
    }
  }

  private async insertAuthorizationFact(
    fact: Readonly<ApprovedActionRecoveryAuthorizationFact>,
    transaction: Transaction,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO "${APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE}"
        (dispatch_id, project_id, mutation_id, resolved_by_id,
         authentication_id, assurance, authenticated_at_ms, project_version,
         binding_version, authorized_at_ms, fact_digest)
       VALUES
        (:dispatchId, :projectId, :mutationId, :resolvedById,
         :authenticationId, :assurance, :authenticatedAtMs, :projectVersion,
         :bindingVersion, :authorizedAtMs, :factDigest)`,
      {
        replacements: {
          dispatchId: fact.dispatchId,
          projectId: fact.projectId,
          mutationId: fact.mutationId,
          resolvedById: fact.resolvedBy.id,
          authenticationId: fact.authenticationId,
          assurance: fact.assurance,
          authenticatedAtMs: fact.authenticatedAtMs,
          projectVersion: fact.projectVersion,
          bindingVersion: fact.bindingVersion,
          authorizedAtMs: fact.authorizedAtMs,
          factDigest: fact.factDigest,
        },
        transaction,
      },
    );
  }

  async findById(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionRecoverySnapshot> | null> {
    assertApprovalMutationId(dispatchId);
    return this.selectSnapshot(dispatchId);
  }

  async listDue(
    query: ListDueApprovedActionRecoveriesQuery,
  ): Promise<ListDueApprovedActionRecoveriesResult> {
    assertCommand(
      query,
      query.cursor === undefined
        ? ['nowMs', 'limit']
        : ['nowMs', 'limit', 'cursor'],
    );
    assertApprovalTimestamp('nowMs', query.nowMs);
    assertApprovedActionRecoveryPageSize(query.limit);
    const cursor = query.cursor
      ? normalizeApprovedActionRecoveryCursor(query.cursor)
      : undefined;
    const rows = await this.database.query<RecoveryRow>(
      `${RECOVERY_SELECT}
       WHERE execution.status = 'executing'
         AND execution.lease_expires_at_ms IS NOT NULL
         AND execution.lease_expires_at_ms <= :nowMs
         AND recovery.status IN ('armed', 'leased')
         AND recovery.next_scan_at_ms IS NOT NULL
         AND recovery.next_scan_at_ms <= :nowMs
         ${
           cursor
             ? `AND (recovery.next_scan_at_ms > :cursorAt
                     OR (recovery.next_scan_at_ms = :cursorAt
                         AND dispatch.id > :cursorId))`
             : ''
         }
       ORDER BY recovery.next_scan_at_ms ASC, dispatch.id ASC
       LIMIT :rowLimit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          nowMs: query.nowMs,
          rowLimit: query.limit + 1,
          ...(cursor
            ? { cursorAt: cursor.nextScanAtMs, cursorId: cursor.dispatchId }
            : {}),
        },
      },
    );
    const truncated = rows.length > query.limit;
    const selected = rows.slice(0, query.limit).map(rowToRecoverySnapshot);
    const last = selected[selected.length - 1];
    return Object.freeze({
      recoveries: Object.freeze(selected),
      truncated,
      ...(truncated && last
        ? {
            nextCursor: Object.freeze({
              nextScanAtMs: last.recovery.nextScanAtMs!,
              dispatchId: last.action.dispatch.id,
            }),
          }
        : {}),
    });
  }

  async claim(
    command: ClaimApprovedActionRecoveryCommand,
  ): Promise<ClaimApprovedActionRecoveryResult> {
    assertCommand(command, [
      'dispatchId',
      'owner',
      'leaseToken',
      'nowMs',
      'leaseDurationMs',
    ]);
    assertApprovalMutationId(command.dispatchId);
    assertApprovedActionLeaseIdentity(command.owner);
    assertApprovedActionLeaseIdentity(command.leaseToken);
    assertApprovedActionRecoveryLeaseDuration(command.leaseDurationMs);
    assertApprovalTimestamp('nowMs', command.nowMs);
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) return { status: 'not_found' as const };
      const current = snapshot.recovery;
      if (current.status === 'resolved') {
        return { status: 'resolved' as const, snapshot };
      }
      if (current.status === 'manual_required') {
        return { status: 'manual_required' as const, snapshot };
      }
      const execution = snapshot.action.execution;
      if (
        execution.status !== 'executing' ||
        execution.leaseExpiresAtMs === null ||
        execution.leaseExpiresAtMs > command.nowMs
      ) {
        return { status: 'execution_active' as const, snapshot };
      }
      if (
        current.status === 'leased' &&
        current.leaseOwner === command.owner &&
        current.leaseToken === command.leaseToken &&
        current.leaseExpiresAtMs! > command.nowMs
      ) {
        return { status: 'claimed' as const, snapshot };
      }
      if (
        current.status === 'leased' &&
        current.leaseExpiresAtMs! > command.nowMs
      ) {
        return { status: 'leased' as const, snapshot };
      }
      if (
        current.nextScanAtMs === null ||
        current.nextScanAtMs > command.nowMs
      ) {
        return { status: 'not_due' as const, snapshot };
      }
      const leaseExpiresAtMs = command.nowMs + command.leaseDurationMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs)) {
        throw new RangeError(
          'Approved action recovery lease expiry is invalid',
        );
      }
      await this.updateControl(
        command.dispatchId,
        current.executionVersion,
        current.version,
        [current.status],
        {
          status: 'leased',
          version: current.version + 1,
          next_scan_at_ms: leaseExpiresAtMs,
          lease_owner: command.owner,
          lease_token: command.leaseToken,
          lease_expires_at_ms: leaseExpiresAtMs,
          updated_at_ms: command.nowMs,
        },
        transaction,
      );
      return {
        status: 'claimed' as const,
        snapshot: (await this.selectSnapshot(command.dispatchId, transaction))!,
      };
    });
  }

  async recordFinding(
    command: RecordApprovedActionRecoveryFindingCommand,
  ): Promise<Readonly<ApprovedActionRecoverySnapshot>> {
    assertCommand(
      command,
      command.evidenceDigest === undefined && command.retryAtMs === undefined
        ? [
            'dispatchId',
            'expectedExecutionVersion',
            'expectedRecoveryVersion',
            'owner',
            'leaseToken',
            'findingMutationId',
            'finding',
            'resultCode',
            'observedAtMs',
          ]
        : [
            'dispatchId',
            'expectedExecutionVersion',
            'expectedRecoveryVersion',
            'owner',
            'leaseToken',
            'findingMutationId',
            'finding',
            'resultCode',
            ...(command.evidenceDigest === undefined ? [] : ['evidenceDigest']),
            'observedAtMs',
            ...(command.retryAtMs === undefined ? [] : ['retryAtMs']),
          ],
    );
    assertApprovalMutationId(command.dispatchId);
    assertVersion(command.expectedExecutionVersion);
    assertVersion(command.expectedRecoveryVersion);
    assertApprovalMutationId(command.findingMutationId);
    assertApprovedActionLeaseIdentity(command.owner);
    assertApprovedActionLeaseIdentity(command.leaseToken);
    if (
      ![
        'still_running',
        'missing',
        'conflict',
        'unsupported',
        'unavailable',
      ].includes(command.finding)
    ) {
      throw new TypeError('Approved action recovery finding is invalid');
    }
    if (command.evidenceDigest !== undefined) {
      assertApprovedActionEvidenceDigest(command.evidenceDigest);
    }
    assertApprovedActionResultCode(command.resultCode);
    assertApprovalTimestamp('observedAtMs', command.observedAtMs);
    const retryable = ['still_running', 'missing', 'unavailable'].includes(
      command.finding,
    );
    if (retryable !== (command.retryAtMs !== undefined)) {
      throw new TypeError('Approved action recovery retry shape is invalid');
    }
    if (command.retryAtMs !== undefined) {
      assertApprovalTimestamp('retryAtMs', command.retryAtMs);
      if (command.retryAtMs <= command.observedAtMs) {
        throw new RangeError('Approved action recovery retry must be future');
      }
    }
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) throw new ApprovedActionRecoveryFenceRejectedError();
      const current = snapshot.recovery;
      const nextStatus = retryable ? 'armed' : 'manual_required';
      if (
        current.version === command.expectedRecoveryVersion + 1 &&
        current.executionVersion === command.expectedExecutionVersion &&
        current.status === nextStatus &&
        current.lastFindingMutationId === command.findingMutationId &&
        current.lastFinding === command.finding &&
        current.lastResultCode === command.resultCode &&
        current.lastEvidenceDigest === (command.evidenceDigest ?? null) &&
        current.nextScanAtMs === (command.retryAtMs ?? null) &&
        current.updatedAtMs === command.observedAtMs
      ) {
        return snapshot;
      }
      if (
        snapshot.action.execution.status !== 'executing' ||
        snapshot.action.execution.version !== command.expectedExecutionVersion
      ) {
        throw new ApprovedActionRecoveryFenceRejectedError();
      }
      await this.updateControl(
        command.dispatchId,
        command.expectedExecutionVersion,
        command.expectedRecoveryVersion,
        ['leased'],
        {
          status: nextStatus,
          version: command.expectedRecoveryVersion + 1,
          next_scan_at_ms: command.retryAtMs ?? null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          finding_count: Math.min(
            MAX_APPROVED_ACTION_RECOVERY_FINDINGS,
            current.findingCount + 1,
          ),
          last_finding_mutation_id: command.findingMutationId,
          last_finding: command.finding,
          last_result_code: command.resultCode,
          last_evidence_digest: command.evidenceDigest ?? null,
          updated_at_ms: command.observedAtMs,
        },
        transaction,
        { owner: command.owner, leaseToken: command.leaseToken },
      );
      return (await this.selectSnapshot(command.dispatchId, transaction))!;
    });
  }

  async resolve(
    command: ResolveApprovedActionRecoveryCommand,
  ): Promise<ResolveApprovedActionRecoveryResult> {
    assertCommand(
      command,
      command.source === 'automatic_evidence'
        ? [
            'dispatchId',
            'expectedExecutionVersion',
            'expectedRecoveryVersion',
            'owner',
            'leaseToken',
            'mutationId',
            'source',
            'decision',
            'evidenceDigest',
            'reasonCode',
            'resolvedAtMs',
          ]
        : [
            'dispatchId',
            'expectedExecutionVersion',
            'expectedRecoveryVersion',
            'mutationId',
            'source',
            'decision',
            ...(command.evidenceDigest === undefined ? [] : ['evidenceDigest']),
            'reasonCode',
            'resolvedBy',
            'resolvedAtMs',
            'authorizationFact',
          ],
    );
    assertApprovalMutationId(command.dispatchId);
    assertVersion(command.expectedExecutionVersion);
    assertVersion(command.expectedRecoveryVersion);
    assertApprovalMutationId(command.mutationId);
    assertApprovedActionResultCode(command.reasonCode);
    if (command.source === 'automatic_evidence') {
      assertApprovedActionLeaseIdentity(command.owner);
      assertApprovedActionLeaseIdentity(command.leaseToken);
    }
    if (command.evidenceDigest !== undefined) {
      assertApprovedActionEvidenceDigest(command.evidenceDigest);
    }
    assertApprovalTimestamp('resolvedAtMs', command.resolvedAtMs);
    const authorizationFact =
      command.source === 'human'
        ? normalizeApprovedActionRecoveryAuthorizationFact(
            command.authorizationFact,
          )
        : null;
    if (command.source === 'human') normalizePolicySubject(command.resolvedBy);
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) return { status: 'not_found' as const };
      const expectedResolution =
        normalizeApprovedActionRecoveryResolutionRecord({
          dispatchId: command.dispatchId,
          projectId: snapshot.action.dispatch.projectId,
          executionVersion: command.expectedExecutionVersion,
          mutationId: command.mutationId,
          source: command.source,
          decision: command.decision,
          evidenceDigest: command.evidenceDigest ?? null,
          reasonCode: command.reasonCode,
          resolvedBy: command.source === 'human' ? command.resolvedBy : null,
          resolvedAtMs: command.resolvedAtMs,
        });
      if (snapshot.resolution) {
        if (
          JSON.stringify(snapshot.resolution) ===
          JSON.stringify(expectedResolution)
        ) {
          if (command.source === 'human') {
            const storedAuthorization = await this.selectAuthorizationFact(
              command.dispatchId,
              transaction,
            );
            if (
              !storedAuthorization ||
              JSON.stringify(storedAuthorization) !==
                JSON.stringify(authorizationFact)
            ) {
              return { status: 'already_terminal' as const, snapshot };
            }
          }
          return { status: 'resolved' as const, snapshot };
        }
        return { status: 'already_terminal' as const, snapshot };
      }
      if (
        snapshot.action.execution.status !== 'executing' ||
        snapshot.recovery.status === 'resolved'
      ) {
        return { status: 'already_terminal' as const, snapshot };
      }
      if (
        snapshot.action.execution.version !==
          command.expectedExecutionVersion ||
        snapshot.recovery.executionVersion !==
          command.expectedExecutionVersion ||
        snapshot.recovery.version !== command.expectedRecoveryVersion ||
        snapshot.action.execution.startedAtMs === null ||
        snapshot.action.execution.leaseExpiresAtMs === null ||
        command.resolvedAtMs < snapshot.action.execution.leaseExpiresAtMs ||
        command.resolvedAtMs < snapshot.action.execution.startedAtMs
      ) {
        throw new ApprovedActionRecoveryFenceRejectedError();
      }
      if (
        command.source === 'automatic_evidence' &&
        (snapshot.recovery.status !== 'leased' ||
          snapshot.recovery.leaseOwner !== command.owner ||
          snapshot.recovery.leaseToken !== command.leaseToken)
      ) {
        throw new ApprovedActionRecoveryFenceRejectedError();
      }
      if (command.source === 'human') {
        if (
          authorizationFact === null ||
          authorizationFact.dispatchId !== command.dispatchId ||
          authorizationFact.projectId !== snapshot.action.dispatch.projectId ||
          authorizationFact.mutationId !== command.mutationId ||
          authorizationFact.resolvedBy.type !== 'user' ||
          authorizationFact.resolvedBy.id !== command.resolvedBy.id ||
          authorizationFact.authorizedAtMs !== command.resolvedAtMs
        ) {
          throw new ApprovedActionRecoveryFenceRejectedError();
        }
        await this.assertAuthorizationFence(authorizationFact, transaction);
      }
      const nextExecutionVersion = command.expectedExecutionVersion + 1;
      const nextRecoveryVersion = command.expectedRecoveryVersion + 1;
      const status = terminalStatus(command.decision);
      const [, executionAffected] = await this.database.query(
        `UPDATE "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
            SET status = :status,
                version = :nextExecutionVersion,
                eligible_at_ms = NULL,
                next_attempt_at_ms = NULL,
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at_ms = NULL,
                result_mutation_id = :mutationId,
                last_result_code = :reasonCode,
                completed_at_ms = :resolvedAtMs,
                updated_at_ms = :resolvedAtMs
          WHERE dispatch_id = :dispatchId
            AND status = 'executing'
            AND version = :expectedExecutionVersion`,
        {
          type: QueryTypes.UPDATE,
          replacements: {
            dispatchId: command.dispatchId,
            expectedExecutionVersion: command.expectedExecutionVersion,
            nextExecutionVersion,
            mutationId: command.mutationId,
            reasonCode: command.reasonCode,
            resolvedAtMs: command.resolvedAtMs,
            status,
          },
          transaction,
        },
      );
      if (executionAffected !== 1) {
        throw new ApprovedActionRecoveryFenceRejectedError();
      }
      const automatic = command.source === 'automatic_evidence';
      await this.updateControl(
        command.dispatchId,
        command.expectedExecutionVersion,
        command.expectedRecoveryVersion,
        automatic ? ['leased'] : ['armed', 'leased', 'manual_required'],
        {
          execution_version: nextExecutionVersion,
          status: 'resolved',
          version: nextRecoveryVersion,
          next_scan_at_ms: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          ...(automatic
            ? {
                finding_count: Math.min(
                  MAX_APPROVED_ACTION_RECOVERY_FINDINGS,
                  snapshot.recovery.findingCount + 1,
                ),
                last_finding_mutation_id: command.mutationId,
                last_finding:
                  command.decision === 'confirm_succeeded'
                    ? 'verified_succeeded'
                    : 'verified_failed',
                last_result_code: command.reasonCode,
                last_evidence_digest: command.evidenceDigest,
              }
            : {}),
          resolution_mutation_id: command.mutationId,
          updated_at_ms: command.resolvedAtMs,
        },
        transaction,
        automatic
          ? { owner: command.owner, leaseToken: command.leaseToken }
          : undefined,
      );
      await this.database.query(
        `INSERT INTO "${APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE}"
          (dispatch_id, project_id, execution_version, mutation_id, source,
           decision, evidence_digest, reason_code, resolved_by_type,
           resolved_by_id, resolved_at_ms)
         VALUES
          (:dispatchId, :projectId, :executionVersion, :mutationId, :source,
           :decision, :evidenceDigest, :reasonCode, :resolvedByType,
           :resolvedById, :resolvedAtMs)`,
        {
          replacements: {
            dispatchId: expectedResolution.dispatchId,
            projectId: expectedResolution.projectId,
            executionVersion: expectedResolution.executionVersion,
            mutationId: expectedResolution.mutationId,
            source: expectedResolution.source,
            decision: expectedResolution.decision,
            evidenceDigest: expectedResolution.evidenceDigest,
            reasonCode: expectedResolution.reasonCode,
            resolvedByType: expectedResolution.resolvedBy?.type ?? null,
            resolvedById: expectedResolution.resolvedBy?.id ?? null,
            resolvedAtMs: expectedResolution.resolvedAtMs,
          },
          transaction,
        },
      );
      if (authorizationFact !== null) {
        await this.insertAuthorizationFact(authorizationFact, transaction);
      }
      return {
        status: 'resolved' as const,
        snapshot: (await this.selectSnapshot(command.dispatchId, transaction))!,
      };
    });
  }
}
