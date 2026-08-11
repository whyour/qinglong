import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { APPROVED_ACTION_DISPATCH_TABLE } from '../../../migrations/0020-approval-requests';
import { APPROVED_ACTION_DISPATCH_EXECUTION_TABLE } from '../../../migrations/0021-approved-action-dispatch-executions';
import { APPROVED_ACTION_RECOVERY_CONTROL_TABLE } from '../../../migrations/0022-approved-action-recovery';
import {
  ApprovedActionDispatchBindingConflictError,
  ApprovedActionDispatchFenceRejectedError,
  ApprovedActionDispatchRepositoryError,
  approvedActionExecutionEffectiveStatus,
  assertApprovedActionLeaseDuration,
  assertApprovedActionLeaseIdentity,
  assertApprovedActionPageSize,
  assertApprovedActionResultCode,
  normalizeApprovedActionDispatchCursor,
  normalizeApprovedActionDispatchExecutionRecord,
  type ApprovedActionDispatchExecutionRecord,
  type ApprovedActionDispatchExecutionSnapshot,
} from '../../domain/approvedActionDispatchExecution';
import {
  ApprovedActionRecoveryRepositoryError,
  normalizeApprovedActionRecoveryControlRecord,
  type ApprovedActionRecoveryControlRecord,
} from '../../domain/approvedActionRecovery';
import {
  InvalidApprovalValueError,
  assertApprovalMutationId,
  assertApprovalTimestamp,
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '../../domain/approvalRequest';
import type {
  ApprovedActionDispatchRepository,
  ClaimApprovedActionDispatchCommand,
  ClaimApprovedActionDispatchResult,
  CompleteApprovedActionDispatchCommand,
  ListDueApprovedActionDispatchesQuery,
  ListDueApprovedActionDispatchesResult,
  ReleaseApprovedActionDispatchBeforeStartCommand,
  RenewApprovedActionDispatchLeaseCommand,
  StartApprovedActionDispatchCommand,
} from '../../ports/approvedActionDispatchRepository';

const RETRY_ATTEMPTS = 5;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface SnapshotRow {
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
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at_ms: number | string | null;
  started_at_ms: number | string | null;
  result_mutation_id: string | null;
  last_result_code: string | null;
  completed_at_ms: number | string | null;
  execution_created_at_ms: number | string;
  execution_updated_at_ms: number | string;
}

interface RecoveryControlRow {
  dispatch_id: string;
  project_id: string;
  execution_version: number | string;
  status: string;
  version: number | string;
  next_scan_at_ms: number | string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at_ms: number | string | null;
  finding_count: number | string;
  last_finding_mutation_id: string | null;
  last_finding: string | null;
  last_result_code: string | null;
  last_evidence_digest: string | null;
  resolution_mutation_id: string | null;
  created_at_ms: number | string;
  updated_at_ms: number | string;
}

const SNAPSHOT_SELECT = `SELECT dispatch.id AS dispatch_id,
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
       execution.lease_owner AS lease_owner,
       execution.lease_token AS lease_token,
       execution.lease_expires_at_ms AS lease_expires_at_ms,
       execution.started_at_ms AS started_at_ms,
       execution.result_mutation_id AS result_mutation_id,
       execution.last_result_code AS last_result_code,
       execution.completed_at_ms AS completed_at_ms,
       execution.created_at_ms AS execution_created_at_ms,
       execution.updated_at_ms AS execution_updated_at_ms
  FROM "${APPROVED_ACTION_DISPATCH_TABLE}" AS dispatch
  JOIN "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}" AS execution
    ON execution.dispatch_id = dispatch.id`;

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function rowToSnapshot(
  row: SnapshotRow,
): Readonly<ApprovedActionDispatchExecutionSnapshot> {
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
      leaseOwner: row.lease_owner,
      leaseToken: row.lease_token,
      leaseExpiresAtMs: numberOrNull(row.lease_expires_at_ms),
      startedAtMs: numberOrNull(row.started_at_ms),
      resultMutationId: row.result_mutation_id,
      lastResultCode: row.last_result_code,
      completedAtMs: numberOrNull(row.completed_at_ms),
      createdAtMs: Number(row.execution_created_at_ms),
      updatedAtMs: Number(row.execution_updated_at_ms),
    });
    if (
      dispatch.id !== execution.dispatchId ||
      dispatch.projectId !== execution.projectId ||
      dispatch.createdAtMs !== execution.createdAtMs
    ) {
      throw new ApprovedActionDispatchBindingConflictError();
    }
    return Object.freeze({ dispatch, execution });
  } catch (error) {
    if (error instanceof ApprovedActionDispatchBindingConflictError) {
      throw error;
    }
    throw new ApprovedActionDispatchRepositoryError();
  }
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    keys.length !== canonical.length ||
    keys.some((key, index) => key !== canonical[index])
  ) {
    throw new TypeError('Approved action dispatch command shape is invalid');
  }
}

function assertCommand(
  value: unknown,
  expected: readonly string[],
): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Approved action dispatch command must be an object');
  }
  assertExactKeys(value, expected);
}

function assertVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2_147_483_647) {
    throw new RangeError('Approved action dispatch version is invalid');
  }
}

function assertDigest(value: string): void {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new TypeError('Approved action dispatch digest is invalid');
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
    error instanceof ApprovedActionDispatchBindingConflictError ||
    error instanceof ApprovedActionDispatchFenceRejectedError ||
    error instanceof ApprovedActionDispatchRepositoryError ||
    error instanceof InvalidApprovalValueError ||
    error instanceof RangeError ||
    error instanceof TypeError
  );
}

function cloneSnapshot(
  snapshot: Readonly<ApprovedActionDispatchExecutionSnapshot>,
  execution: ApprovedActionDispatchExecutionRecord,
): Readonly<ApprovedActionDispatchExecutionSnapshot> {
  return Object.freeze({
    dispatch: snapshot.dispatch,
    execution: normalizeApprovedActionDispatchExecutionRecord(execution),
  });
}

function terminalStatus(
  outcome: CompleteApprovedActionDispatchCommand['outcome'],
): 'succeeded' | 'failed' | 'blocked' {
  if (outcome === 'indeterminate') return 'blocked';
  return outcome;
}

export class LegacySequelizeApprovedActionDispatchRepository
  implements ApprovedActionDispatchRepository
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Approved action dispatch repository is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  private async selectSnapshot(
    dispatchId: string,
    transaction?: Transaction,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot> | null> {
    const rows = await this.database.query<SnapshotRow>(
      `${SNAPSHOT_SELECT}
       WHERE dispatch.id = :dispatchId
       LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId },
        ...(transaction ? { transaction } : {}),
      },
    );
    if (rows.length === 0) {
      const dispatchRows = await this.database.query<{ id: string }>(
        `SELECT id
           FROM "${APPROVED_ACTION_DISPATCH_TABLE}"
          WHERE id = :dispatchId
          LIMIT 2`,
        {
          type: QueryTypes.SELECT,
          replacements: { dispatchId },
          ...(transaction ? { transaction } : {}),
        },
      );
      if (dispatchRows.length > 0) {
        throw new ApprovedActionDispatchRepositoryError();
      }
      return null;
    }
    if (rows.length !== 1) throw new ApprovedActionDispatchRepositoryError();
    return rowToSnapshot(rows[0]);
  }

  private async updateExecution(
    dispatchId: string,
    expectedVersion: number,
    expectedStatus: 'pending' | 'leased' | 'executing' | 'retry_wait',
    values: Record<string, string | number | null>,
    transaction: Transaction,
    fence?: { owner: string; leaseToken: string },
  ): Promise<void> {
    const assignments = Object.keys(values)
      .map((field) => `"${field}" = :${field}`)
      .join(', ');
    const [, affected] = await this.database.query(
      `UPDATE "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
          SET ${assignments}
        WHERE dispatch_id = :dispatchId
          AND version = :expectedVersion
          AND status = :expectedStatus
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
          expectedVersion,
          expectedStatus,
          ...(fence ?? {}),
        },
        transaction,
      },
    );
    if (affected !== 1) throw new ApprovedActionDispatchFenceRejectedError();
  }

  private async selectRecoveryControl(
    dispatchId: string,
    transaction: Transaction,
  ): Promise<Readonly<ApprovedActionRecoveryControlRecord> | null> {
    const rows = await this.database.query<RecoveryControlRow>(
      `SELECT dispatch_id, project_id, execution_version, status, version,
              next_scan_at_ms, lease_owner, lease_token, lease_expires_at_ms,
              finding_count, last_finding_mutation_id, last_finding,
              last_result_code, last_evidence_digest, resolution_mutation_id,
              created_at_ms, updated_at_ms
         FROM "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"
        WHERE dispatch_id = :dispatchId
        LIMIT 2`,
      {
        type: QueryTypes.SELECT,
        replacements: { dispatchId },
        transaction,
      },
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ApprovedActionRecoveryRepositoryError();
    const row = rows[0];
    try {
      return normalizeApprovedActionRecoveryControlRecord({
        dispatchId: row.dispatch_id,
        projectId: row.project_id,
        executionVersion: Number(row.execution_version),
        status: row.status as ApprovedActionRecoveryControlRecord['status'],
        version: Number(row.version),
        nextScanAtMs: numberOrNull(row.next_scan_at_ms),
        leaseOwner: row.lease_owner,
        leaseToken: row.lease_token,
        leaseExpiresAtMs: numberOrNull(row.lease_expires_at_ms),
        findingCount: Number(row.finding_count),
        lastFindingMutationId: row.last_finding_mutation_id,
        lastFinding:
          row.last_finding as ApprovedActionRecoveryControlRecord['lastFinding'],
        lastResultCode: row.last_result_code,
        lastEvidenceDigest: row.last_evidence_digest,
        resolutionMutationId: row.resolution_mutation_id,
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
      });
    } catch {
      throw new ApprovedActionRecoveryRepositoryError();
    }
  }

  private async updateRecoveryControlForExecution(
    dispatchId: string,
    expectedExecutionVersion: number,
    values: Record<string, string | number | null>,
    transaction: Transaction,
  ): Promise<void> {
    const assignments = Object.keys(values)
      .map((field) => `"${field}" = :${field}`)
      .join(', ');
    const [, affected] = await this.database.query(
      `UPDATE "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"
          SET ${assignments}
        WHERE dispatch_id = :dispatchId
          AND execution_version = :expectedExecutionVersion
          AND status IN ('armed', 'leased', 'manual_required')`,
      {
        type: QueryTypes.UPDATE,
        replacements: {
          ...values,
          dispatchId,
          expectedExecutionVersion,
        },
        transaction,
      },
    );
    if (affected !== 1) throw new ApprovedActionRecoveryRepositoryError();
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
        throw new ApprovedActionDispatchRepositoryError();
      }
    }
    throw new ApprovedActionDispatchRepositoryError();
  }

  async findById(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot> | null> {
    assertApprovalMutationId(dispatchId);
    return this.selectSnapshot(dispatchId);
  }

  async listDue(
    query: ListDueApprovedActionDispatchesQuery,
  ): Promise<ListDueApprovedActionDispatchesResult> {
    assertCommand(
      query,
      query.cursor === undefined
        ? ['nowMs', 'limit']
        : ['nowMs', 'limit', 'cursor'],
    );
    assertApprovalTimestamp('nowMs', query.nowMs);
    assertApprovedActionPageSize(query.limit);
    const cursor = query.cursor
      ? normalizeApprovedActionDispatchCursor(query.cursor)
      : undefined;
    const rows = await this.database.query<SnapshotRow>(
      `${SNAPSHOT_SELECT}
       WHERE execution.status IN ('pending', 'leased', 'retry_wait')
         AND execution.eligible_at_ms IS NOT NULL
         AND execution.eligible_at_ms <= :nowMs
         ${
           cursor
             ? `AND (execution.eligible_at_ms > :cursorAt
                     OR (execution.eligible_at_ms = :cursorAt
                         AND dispatch.id > :cursorId))`
             : ''
         }
       ORDER BY execution.eligible_at_ms ASC, dispatch.id ASC
       LIMIT :rowLimit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          nowMs: query.nowMs,
          rowLimit: query.limit + 1,
          ...(cursor
            ? { cursorAt: cursor.eligibleAtMs, cursorId: cursor.dispatchId }
            : {}),
        },
      },
    );
    const truncated = rows.length > query.limit;
    const selected = rows.slice(0, query.limit).map(rowToSnapshot);
    const last = selected[selected.length - 1];
    return Object.freeze({
      dispatches: Object.freeze(selected),
      truncated,
      ...(truncated && last
        ? {
            nextCursor: Object.freeze({
              eligibleAtMs: last.execution.eligibleAtMs!,
              dispatchId: last.dispatch.id,
            }),
          }
        : {}),
    });
  }

  async claim(
    command: ClaimApprovedActionDispatchCommand,
  ): Promise<ClaimApprovedActionDispatchResult> {
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
    assertApprovalTimestamp('nowMs', command.nowMs);
    assertApprovedActionLeaseDuration(command.leaseDurationMs);
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) return { status: 'not_found' as const };
      const current = snapshot.execution;
      if (
        current.status === 'succeeded' ||
        current.status === 'failed' ||
        current.status === 'blocked'
      ) {
        return { status: current.status, snapshot };
      }
      if (current.status === 'executing') {
        return {
          status: approvedActionExecutionEffectiveStatus(
            current,
            command.nowMs,
          ) as 'executing' | 'recovery_required',
          snapshot,
        };
      }
      if (
        current.status === 'leased' &&
        current.leaseOwner === command.owner &&
        current.leaseToken === command.leaseToken &&
        current.leaseExpiresAtMs! > command.nowMs
      ) {
        return { status: 'claimed', snapshot };
      }
      if (
        current.eligibleAtMs === null ||
        current.eligibleAtMs > command.nowMs
      ) {
        return {
          status: current.status === 'leased' ? 'leased' : 'not_due',
          snapshot,
        };
      }
      const nextVersion = current.version + 1;
      if (current.attemptCount >= current.maxAttempts) {
        await this.updateExecution(
          command.dispatchId,
          current.version,
          current.status,
          {
            status: 'blocked',
            version: nextVersion,
            eligible_at_ms: null,
            next_attempt_at_ms: null,
            lease_owner: null,
            lease_token: null,
            lease_expires_at_ms: null,
            result_mutation_id: `exhausted:${current.version}`,
            last_result_code: 'attempt_budget_exhausted',
            completed_at_ms: command.nowMs,
            updated_at_ms: command.nowMs,
          },
          transaction,
        );
        const blocked = cloneSnapshot(snapshot, {
          ...current,
          status: 'blocked',
          version: nextVersion,
          eligibleAtMs: null,
          nextAttemptAtMs: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAtMs: null,
          resultMutationId: `exhausted:${current.version}`,
          lastResultCode: 'attempt_budget_exhausted',
          completedAtMs: command.nowMs,
          updatedAtMs: command.nowMs,
        });
        return { status: 'blocked', snapshot: blocked };
      }
      const leaseExpiresAtMs = command.nowMs + command.leaseDurationMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs)) {
        throw new RangeError(
          'Approved action dispatch lease expiry is invalid',
        );
      }
      await this.updateExecution(
        command.dispatchId,
        current.version,
        current.status,
        {
          status: 'leased',
          version: nextVersion,
          attempt_count: current.attemptCount + 1,
          eligible_at_ms: leaseExpiresAtMs,
          next_attempt_at_ms: null,
          lease_owner: command.owner,
          lease_token: command.leaseToken,
          lease_expires_at_ms: leaseExpiresAtMs,
          result_mutation_id: null,
          last_result_code: null,
          completed_at_ms: null,
          updated_at_ms: command.nowMs,
        },
        transaction,
      );
      return {
        status: 'claimed',
        snapshot: cloneSnapshot(snapshot, {
          ...current,
          status: 'leased',
          version: nextVersion,
          attemptCount: current.attemptCount + 1,
          eligibleAtMs: leaseExpiresAtMs,
          nextAttemptAtMs: null,
          leaseOwner: command.owner,
          leaseToken: command.leaseToken,
          leaseExpiresAtMs,
          resultMutationId: null,
          lastResultCode: null,
          completedAtMs: null,
          updatedAtMs: command.nowMs,
        }),
      };
    });
  }

  async start(
    command: StartApprovedActionDispatchCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>> {
    assertCommand(command, [
      'dispatchId',
      'approvalRequestId',
      'actionDigest',
      'owner',
      'leaseToken',
      'expectedVersion',
      'startedAtMs',
    ]);
    assertApprovalMutationId(command.dispatchId);
    assertApprovalMutationId(command.approvalRequestId);
    assertDigest(command.actionDigest);
    assertApprovedActionLeaseIdentity(command.owner);
    assertApprovedActionLeaseIdentity(command.leaseToken);
    assertVersion(command.expectedVersion);
    assertApprovalTimestamp('startedAtMs', command.startedAtMs);
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) throw new ApprovedActionDispatchFenceRejectedError();
      const current = snapshot.execution;
      const identityMatches =
        snapshot.dispatch.approvalRequestId === command.approvalRequestId &&
        snapshot.dispatch.action.actionDigest === command.actionDigest;
      if (!identityMatches) {
        throw new ApprovedActionDispatchBindingConflictError();
      }
      if (
        current.status === 'executing' &&
        current.version === command.expectedVersion + 1 &&
        current.leaseOwner === command.owner &&
        current.leaseToken === command.leaseToken &&
        current.startedAtMs === command.startedAtMs
      ) {
        const recovery = await this.selectRecoveryControl(
          command.dispatchId,
          transaction,
        );
        if (
          !recovery ||
          recovery.projectId !== snapshot.dispatch.projectId ||
          recovery.executionVersion !== current.version ||
          recovery.status === 'resolved'
        ) {
          throw new ApprovedActionRecoveryRepositoryError();
        }
        return snapshot;
      }
      if (
        current.status !== 'leased' ||
        current.version !== command.expectedVersion ||
        current.leaseOwner !== command.owner ||
        current.leaseToken !== command.leaseToken ||
        current.leaseExpiresAtMs === null ||
        command.startedAtMs >= current.leaseExpiresAtMs
      ) {
        throw new ApprovedActionDispatchFenceRejectedError();
      }
      const nextVersion = current.version + 1;
      await this.updateExecution(
        command.dispatchId,
        current.version,
        'leased',
        {
          status: 'executing',
          version: nextVersion,
          eligible_at_ms: null,
          started_at_ms: command.startedAtMs,
          updated_at_ms: command.startedAtMs,
        },
        transaction,
        { owner: command.owner, leaseToken: command.leaseToken },
      );
      await this.database.query(
        `INSERT INTO "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"
          (dispatch_id, project_id, execution_version, status, version,
           next_scan_at_ms, lease_owner, lease_token, lease_expires_at_ms,
           finding_count, last_finding_mutation_id, last_finding,
           last_result_code, last_evidence_digest, resolution_mutation_id,
           created_at_ms, updated_at_ms)
         VALUES
          (:dispatchId, :projectId, :executionVersion, 'armed', 0,
           :nextScanAtMs, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL,
           :createdAtMs, :updatedAtMs)`,
        {
          replacements: {
            dispatchId: command.dispatchId,
            projectId: snapshot.dispatch.projectId,
            executionVersion: nextVersion,
            nextScanAtMs: current.leaseExpiresAtMs,
            createdAtMs: command.startedAtMs,
            updatedAtMs: command.startedAtMs,
          },
          transaction,
        },
      );
      return cloneSnapshot(snapshot, {
        ...current,
        status: 'executing',
        version: nextVersion,
        eligibleAtMs: null,
        startedAtMs: command.startedAtMs,
        updatedAtMs: command.startedAtMs,
      });
    });
  }

  async renew(
    command: RenewApprovedActionDispatchLeaseCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>> {
    assertCommand(command, [
      'dispatchId',
      'owner',
      'leaseToken',
      'expectedVersion',
      'nowMs',
      'leaseDurationMs',
    ]);
    assertApprovalMutationId(command.dispatchId);
    assertApprovedActionLeaseIdentity(command.owner);
    assertApprovedActionLeaseIdentity(command.leaseToken);
    assertVersion(command.expectedVersion);
    assertApprovalTimestamp('nowMs', command.nowMs);
    assertApprovedActionLeaseDuration(command.leaseDurationMs);
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) throw new ApprovedActionDispatchFenceRejectedError();
      const current = snapshot.execution;
      if (
        (current.status !== 'leased' && current.status !== 'executing') ||
        current.version !== command.expectedVersion ||
        current.leaseOwner !== command.owner ||
        current.leaseToken !== command.leaseToken ||
        (current.startedAtMs !== null && command.nowMs < current.startedAtMs)
      ) {
        throw new ApprovedActionDispatchFenceRejectedError();
      }
      const recovery =
        current.status === 'executing'
          ? await this.selectRecoveryControl(command.dispatchId, transaction)
          : null;
      if (
        current.status === 'executing' &&
        (!recovery ||
          recovery.projectId !== snapshot.dispatch.projectId ||
          recovery.executionVersion !== current.version ||
          recovery.status === 'resolved')
      ) {
        throw new ApprovedActionRecoveryRepositoryError();
      }
      const leaseExpiresAtMs = command.nowMs + command.leaseDurationMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs)) {
        throw new RangeError(
          'Approved action dispatch lease expiry is invalid',
        );
      }
      const nextVersion = current.version + 1;
      await this.updateExecution(
        command.dispatchId,
        current.version,
        current.status,
        {
          version: nextVersion,
          eligible_at_ms: current.status === 'leased' ? leaseExpiresAtMs : null,
          lease_expires_at_ms: leaseExpiresAtMs,
          updated_at_ms: command.nowMs,
        },
        transaction,
        { owner: command.owner, leaseToken: command.leaseToken },
      );
      if (current.status === 'executing') {
        await this.updateRecoveryControlForExecution(
          command.dispatchId,
          current.version,
          {
            execution_version: nextVersion,
            status: 'armed',
            version: recovery!.version + 1,
            next_scan_at_ms: leaseExpiresAtMs,
            lease_owner: null,
            lease_token: null,
            lease_expires_at_ms: null,
            resolution_mutation_id: null,
            updated_at_ms: command.nowMs,
          },
          transaction,
        );
      }
      return cloneSnapshot(snapshot, {
        ...current,
        version: nextVersion,
        eligibleAtMs: current.status === 'leased' ? leaseExpiresAtMs : null,
        leaseExpiresAtMs,
        updatedAtMs: command.nowMs,
      });
    });
  }

  async releaseBeforeStart(
    command: ReleaseApprovedActionDispatchBeforeStartCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>> {
    assertCommand(
      command,
      command.retryAtMs === undefined
        ? [
            'dispatchId',
            'owner',
            'leaseToken',
            'expectedVersion',
            'resultMutationId',
            'resultCode',
            'atMs',
          ]
        : [
            'dispatchId',
            'owner',
            'leaseToken',
            'expectedVersion',
            'resultMutationId',
            'resultCode',
            'atMs',
            'retryAtMs',
          ],
    );
    assertApprovalMutationId(command.dispatchId);
    assertApprovedActionLeaseIdentity(command.owner);
    assertApprovedActionLeaseIdentity(command.leaseToken);
    assertVersion(command.expectedVersion);
    assertApprovalMutationId(command.resultMutationId);
    assertApprovedActionResultCode(command.resultCode);
    assertApprovalTimestamp('atMs', command.atMs);
    if (command.retryAtMs !== undefined) {
      assertApprovalTimestamp('retryAtMs', command.retryAtMs);
      if (command.retryAtMs <= command.atMs) {
        throw new RangeError('Approved action retry must be in the future');
      }
    }
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) throw new ApprovedActionDispatchFenceRejectedError();
      const current = snapshot.execution;
      const retryable =
        command.retryAtMs !== undefined &&
        current.attemptCount < current.maxAttempts;
      const nextStatus = retryable ? 'retry_wait' : 'blocked';
      const nextVersion = current.version + 1;
      if (
        (current.status === 'retry_wait' || current.status === 'blocked') &&
        current.status === nextStatus &&
        current.version === command.expectedVersion + 1 &&
        current.resultMutationId === command.resultMutationId &&
        current.lastResultCode === command.resultCode &&
        current.updatedAtMs === command.atMs &&
        current.nextAttemptAtMs === (retryable ? command.retryAtMs! : null) &&
        current.completedAtMs === (retryable ? null : command.atMs)
      ) {
        return snapshot;
      }
      if (
        current.status !== 'leased' ||
        current.version !== command.expectedVersion ||
        current.leaseOwner !== command.owner ||
        current.leaseToken !== command.leaseToken ||
        command.atMs < current.updatedAtMs
      ) {
        throw new ApprovedActionDispatchFenceRejectedError();
      }
      await this.updateExecution(
        command.dispatchId,
        current.version,
        'leased',
        {
          status: nextStatus,
          version: nextVersion,
          eligible_at_ms: retryable ? command.retryAtMs! : null,
          next_attempt_at_ms: retryable ? command.retryAtMs! : null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          result_mutation_id: command.resultMutationId,
          last_result_code: command.resultCode,
          completed_at_ms: retryable ? null : command.atMs,
          updated_at_ms: command.atMs,
        },
        transaction,
        { owner: command.owner, leaseToken: command.leaseToken },
      );
      return cloneSnapshot(snapshot, {
        ...current,
        status: nextStatus,
        version: nextVersion,
        eligibleAtMs: retryable ? command.retryAtMs! : null,
        nextAttemptAtMs: retryable ? command.retryAtMs! : null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        resultMutationId: command.resultMutationId,
        lastResultCode: command.resultCode,
        completedAtMs: retryable ? null : command.atMs,
        updatedAtMs: command.atMs,
      });
    });
  }

  async complete(
    command: CompleteApprovedActionDispatchCommand,
  ): Promise<Readonly<ApprovedActionDispatchExecutionSnapshot>> {
    assertCommand(command, [
      'dispatchId',
      'owner',
      'leaseToken',
      'expectedVersion',
      'resultMutationId',
      'outcome',
      'resultCode',
      'completedAtMs',
    ]);
    assertApprovalMutationId(command.dispatchId);
    assertApprovedActionLeaseIdentity(command.owner);
    assertApprovedActionLeaseIdentity(command.leaseToken);
    assertVersion(command.expectedVersion);
    assertApprovalMutationId(command.resultMutationId);
    if (!['succeeded', 'failed', 'indeterminate'].includes(command.outcome)) {
      throw new TypeError('Approved action outcome is invalid');
    }
    assertApprovedActionResultCode(command.resultCode);
    assertApprovalTimestamp('completedAtMs', command.completedAtMs);
    return this.transactionWithRetry(async (transaction) => {
      const snapshot = await this.selectSnapshot(
        command.dispatchId,
        transaction,
      );
      if (!snapshot) throw new ApprovedActionDispatchFenceRejectedError();
      const current = snapshot.execution;
      const nextStatus = terminalStatus(command.outcome);
      if (
        current.status === nextStatus &&
        current.version === command.expectedVersion + 1 &&
        current.resultMutationId === command.resultMutationId &&
        current.lastResultCode === command.resultCode &&
        current.completedAtMs === command.completedAtMs
      ) {
        const recovery = await this.selectRecoveryControl(
          command.dispatchId,
          transaction,
        );
        if (
          !recovery ||
          recovery.status !== 'resolved' ||
          recovery.executionVersion !== current.version ||
          recovery.resolutionMutationId !== command.resultMutationId
        ) {
          throw new ApprovedActionRecoveryRepositoryError();
        }
        return snapshot;
      }
      if (
        current.status !== 'executing' ||
        current.version !== command.expectedVersion ||
        current.leaseOwner !== command.owner ||
        current.leaseToken !== command.leaseToken ||
        current.startedAtMs === null ||
        command.completedAtMs < current.startedAtMs
      ) {
        throw new ApprovedActionDispatchFenceRejectedError();
      }
      const recovery = await this.selectRecoveryControl(
        command.dispatchId,
        transaction,
      );
      if (
        !recovery ||
        recovery.projectId !== snapshot.dispatch.projectId ||
        recovery.executionVersion !== current.version ||
        recovery.status === 'resolved'
      ) {
        throw new ApprovedActionRecoveryRepositoryError();
      }
      const nextVersion = current.version + 1;
      await this.updateExecution(
        command.dispatchId,
        current.version,
        'executing',
        {
          status: nextStatus,
          version: nextVersion,
          eligible_at_ms: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          result_mutation_id: command.resultMutationId,
          last_result_code: command.resultCode,
          completed_at_ms: command.completedAtMs,
          updated_at_ms: command.completedAtMs,
        },
        transaction,
        { owner: command.owner, leaseToken: command.leaseToken },
      );
      await this.updateRecoveryControlForExecution(
        command.dispatchId,
        current.version,
        {
          execution_version: nextVersion,
          status: 'resolved',
          version: recovery.version + 1,
          next_scan_at_ms: null,
          lease_owner: null,
          lease_token: null,
          lease_expires_at_ms: null,
          resolution_mutation_id: command.resultMutationId,
          updated_at_ms: command.completedAtMs,
        },
        transaction,
      );
      return cloneSnapshot(snapshot, {
        ...current,
        status: nextStatus,
        version: nextVersion,
        eligibleAtMs: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAtMs: null,
        resultMutationId: command.resultMutationId,
        lastResultCode: command.resultCode,
        completedAtMs: command.completedAtMs,
        updatedAtMs: command.completedAtMs,
      });
    });
  }
}
