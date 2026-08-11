import type { DatabaseSync } from 'node:sqlite';

import {
  ApprovedActionExecutionFenceConflictError,
  ApprovedActionExecutionStateConflictError,
  ApprovedActionExecutionUnavailableError,
  approvedActionExecutionEffectiveStatus,
  claimApprovedActionExecution,
  completeApprovedActionExecution,
  createApprovedActionExecution,
  normalizeApprovedActionExecutionCursor,
  normalizeApprovedActionExecutionRecord,
  normalizeApprovedActionExecutionSnapshot,
  releaseApprovedActionExecutionBeforeStart,
  renewApprovedActionExecution,
  startApprovedActionExecution,
  type ApprovedActionExecutionRecord,
  type ApprovedActionExecutionRepository,
  type ApprovedActionExecutionSnapshot,
  type ClaimApprovedActionExecutionCommand,
  type ClaimApprovedActionExecutionResult,
  type CompleteApprovedActionExecutionCommand,
  type ListDueApprovedActionExecutionsQuery,
  type ListDueApprovedActionExecutionsResult,
  type ReleaseApprovedActionExecutionBeforeStartCommand,
  type RenewApprovedActionExecutionCommand,
  type StartApprovedActionExecutionCommand,
} from '@qinglong/runtime-core/approved-action-execution';
import {
  normalizeApprovedActionDispatchRecord,
  type ApprovedActionDispatchRecord,
} from '@qinglong/runtime-core/approved-action';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new ApprovedActionExecutionUnavailableError();
  }
  return value;
}

function parseExecution(row: Row): Readonly<ApprovedActionExecutionRecord> {
  try {
    const execution = normalizeApprovedActionExecutionRecord(
      JSON.parse(text(row, 'executionJson')) as ApprovedActionExecutionRecord,
    );
    if (execution.executionDigest !== text(row, 'executionDigest')) {
      throw new ApprovedActionExecutionUnavailableError();
    }
    return execution;
  } catch (error) {
    if (error instanceof ApprovedActionExecutionUnavailableError) throw error;
    throw new ApprovedActionExecutionUnavailableError();
  }
}

function parseDispatch(row: Row): Readonly<ApprovedActionDispatchRecord> {
  try {
    return normalizeApprovedActionDispatchRecord(
      JSON.parse(text(row, 'dispatchJson')) as ApprovedActionDispatchRecord,
    );
  } catch {
    throw new ApprovedActionExecutionUnavailableError();
  }
}

function storageError(error: unknown): Error {
  if (
    error instanceof ApprovedActionExecutionFenceConflictError ||
    error instanceof ApprovedActionExecutionStateConflictError ||
    error instanceof ApprovedActionExecutionUnavailableError ||
    (error instanceof Error &&
      error.name.startsWith('ApprovedActionExecution'))
  ) {
    return error;
  }
  return new ApprovedActionExecutionUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

const EXECUTION_COLUMNS = `
  "dispatch_id", "dispatch_digest", "project_id", "status", "version",
  "attempt_count", "max_attempts", "eligible_at_ms", "next_attempt_at_ms",
  "lease_owner", "lease_token", "lease_expires_at_ms", "started_at_ms",
  "result_mutation_id", "result_code", "result_digest", "completed_at_ms",
  "created_at_ms", "updated_at_ms", "execution_json", "execution_digest"
`;

function executionValues(
  execution: Readonly<ApprovedActionExecutionRecord>,
): readonly (string | number | null)[] {
  return [
    execution.dispatchId,
    execution.dispatchDigest,
    execution.projectId,
    execution.status,
    execution.version,
    execution.attemptCount,
    execution.maxAttempts,
    execution.eligibleAtMs,
    execution.nextAttemptAtMs,
    execution.leaseOwner,
    execution.leaseToken,
    execution.leaseExpiresAtMs,
    execution.startedAtMs,
    execution.resultMutationId,
    execution.resultCode,
    execution.resultDigest,
    execution.completedAtMs,
    execution.createdAtMs,
    execution.updatedAtMs,
    JSON.stringify(execution),
    execution.executionDigest,
  ];
}

export function insertLocalApprovedActionExecutionBaseline(
  client: DatabaseSync,
  dispatchValue: ApprovedActionDispatchRecord,
): Readonly<ApprovedActionExecutionRecord> {
  const execution = createApprovedActionExecution(dispatchValue);
  client
    .prepare(
      `INSERT INTO "QingLong3ApprovedActionExecutions" (${EXECUTION_COLUMNS})
       VALUES (${new Array(21).fill('?').join(', ')})`,
    )
    .run(...executionValues(execution));
  return execution;
}

export function findLocalApprovedActionExecution(
  client: DatabaseSync,
  dispatchId: string,
): Readonly<ApprovedActionExecutionRecord> | null {
  const row = client
    .prepare(
      `SELECT "execution_json" AS "executionJson",
              "execution_digest" AS "executionDigest"
       FROM "QingLong3ApprovedActionExecutions"
       WHERE "dispatch_id" = ?`,
    )
    .get(dispatchId) as Row | undefined;
  return row ? parseExecution(row) : null;
}

function snapshot(
  client: DatabaseSync,
  dispatchId: string,
): Readonly<ApprovedActionExecutionSnapshot> | null {
  const row = client
    .prepare(
      `SELECT execution."execution_json" AS "executionJson",
              execution."execution_digest" AS "executionDigest",
              dispatch."dispatch_json" AS "dispatchJson"
       FROM "QingLong3ApprovedActionExecutions" AS execution
       JOIN "QingLong3ApprovedActionDispatches" AS dispatch
         ON dispatch."dispatch_id" = execution."dispatch_id"
       WHERE execution."dispatch_id" = ?`,
    )
    .get(dispatchId) as Row | undefined;
  if (!row) return null;
  return normalizeApprovedActionExecutionSnapshot({
    dispatch: parseDispatch(row),
    execution: parseExecution(row),
  });
}

function replaceExecution(
  client: DatabaseSync,
  previous: Readonly<ApprovedActionExecutionRecord>,
  next: Readonly<ApprovedActionExecutionRecord>,
): void {
  const result = client
    .prepare(
      `UPDATE "QingLong3ApprovedActionExecutions"
       SET "dispatch_digest" = ?, "project_id" = ?, "status" = ?,
           "version" = ?, "attempt_count" = ?, "max_attempts" = ?,
           "eligible_at_ms" = ?, "next_attempt_at_ms" = ?,
           "lease_owner" = ?, "lease_token" = ?, "lease_expires_at_ms" = ?,
           "started_at_ms" = ?, "result_mutation_id" = ?,
           "result_code" = ?, "result_digest" = ?, "completed_at_ms" = ?,
           "created_at_ms" = ?, "updated_at_ms" = ?, "execution_json" = ?,
           "execution_digest" = ?
       WHERE "dispatch_id" = ? AND "version" = ?
         AND "execution_digest" = ?`,
    )
    .run(
      ...executionValues(next).slice(1),
      previous.dispatchId,
      previous.version,
      previous.executionDigest,
    );
  if (result.changes !== 1) {
    throw new ApprovedActionExecutionFenceConflictError();
  }
}

function assertPageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new ApprovedActionExecutionStateConflictError();
  }
}

function actionTypes(values: readonly string[]): readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    values.some(
      (value) =>
        typeof value !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
    ) ||
    new Set(values).size !== values.length
  ) {
    throw new ApprovedActionExecutionStateConflictError();
  }
  return values;
}

export class LocalSqliteApprovedActionExecutionRepository
  implements ApprovedActionExecutionRepository
{
  readonly #authority: LocalSqliteOperationAuthority;
  readonly #client: DatabaseSync;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
    this.#client = this.#authority.client;
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        try {
          return await work();
        } catch (error) {
          throw storageError(error);
        }
      },
      () => new ApprovedActionExecutionUnavailableError(),
    );
  }

  #transaction<T>(work: () => T): T {
    this.#client.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#client.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#client.isTransaction) this.#client.exec('ROLLBACK');
      throw error;
    }
  }

  findExecutionByDispatchId(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot> | null> {
    return this.#enqueue(() => snapshot(this.#client, dispatchId));
  }

  listDueExecutions(
    query: ListDueApprovedActionExecutionsQuery,
  ): Promise<ListDueApprovedActionExecutionsResult> {
    return this.#enqueue(() => {
      assertPageSize(query.limit);
      const handledActionTypes = actionTypes(query.actionTypes);
      const cursor = query.cursor
        ? normalizeApprovedActionExecutionCursor(query.cursor)
        : undefined;
      if (!Number.isSafeInteger(query.nowMs) || query.nowMs < 0) {
        throw new ApprovedActionExecutionStateConflictError();
      }
      if (handledActionTypes.length === 0) {
        return Object.freeze({
          executions: Object.freeze([]),
          truncated: false,
        });
      }
      const actionTypePlaceholders = handledActionTypes.map(() => '?').join(',');
      const rows = this.#client
        .prepare(
          `SELECT execution."execution_json" AS "executionJson",
                  execution."execution_digest" AS "executionDigest",
                  dispatch."dispatch_json" AS "dispatchJson"
           FROM "QingLong3ApprovedActionExecutions" AS execution
           JOIN "QingLong3ApprovedActionDispatches" AS dispatch
             ON dispatch."dispatch_id" = execution."dispatch_id"
           WHERE execution."status" IN ('pending','leased','retry_wait')
             AND execution."eligible_at_ms" <= ?
             AND dispatch."action_type" IN (${actionTypePlaceholders})
             AND (
               ? IS NULL OR execution."eligible_at_ms" > ? OR
               (execution."eligible_at_ms" = ? AND execution."dispatch_id" > ?)
             )
           ORDER BY execution."eligible_at_ms", execution."dispatch_id"
           LIMIT ?`,
        )
        .all(
          query.nowMs,
          ...handledActionTypes,
          cursor?.dispatchId ?? null,
          cursor?.eligibleAtMs ?? 0,
          cursor?.eligibleAtMs ?? 0,
          cursor?.dispatchId ?? '',
          query.limit + 1,
        ) as Row[];
      const truncated = rows.length > query.limit;
      const pageRows = truncated ? rows.slice(0, query.limit) : rows;
      const executions = pageRows.map((row) =>
        normalizeApprovedActionExecutionSnapshot({
          dispatch: parseDispatch(row),
          execution: parseExecution(row),
        }),
      );
      const last = executions.at(-1)?.execution;
      return Object.freeze({
        executions: Object.freeze(executions),
        truncated,
        ...(truncated && last?.eligibleAtMs !== null
          ? {
              nextCursor: Object.freeze({
                eligibleAtMs: last!.eligibleAtMs!,
                dispatchId: last!.dispatchId,
              }),
            }
          : {}),
      });
    });
  }

  claimExecution(
    command: ClaimApprovedActionExecutionCommand,
  ): Promise<ClaimApprovedActionExecutionResult> {
    return this.#enqueue(() =>
      this.#transaction(() => {
        const current = snapshot(this.#client, command.dispatchId);
        if (!current) return Object.freeze({ status: 'not_found' as const });
        const effective = approvedActionExecutionEffectiveStatus(
          current.execution,
          command.nowMs,
        );
        if (
          current.execution.status === 'leased' &&
          current.execution.leaseExpiresAtMs !== null &&
          current.execution.leaseExpiresAtMs <= command.nowMs &&
          current.execution.attemptCount >= current.execution.maxAttempts
        ) {
          return Object.freeze({
            status: 'recovery_required' as const,
            snapshot: current,
          });
        }
        const due =
          current.execution.eligibleAtMs !== null &&
          current.execution.eligibleAtMs <= command.nowMs;
        if (
          effective !== 'pending' &&
          effective !== 'retry_wait' &&
          !(effective === 'leased' && due)
        ) {
          return Object.freeze({ status: effective, snapshot: current });
        }
        if (!due) {
          return Object.freeze({
            status: 'not_due' as const,
            snapshot: current,
          });
        }
        const next = claimApprovedActionExecution(current.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          nowMs: command.nowMs,
          leaseDurationMs: command.leaseDurationMs,
        });
        replaceExecution(this.#client, current.execution, next);
        return Object.freeze({
          status: 'claimed' as const,
          snapshot: Object.freeze({
            dispatch: current.dispatch,
            execution: next,
          }),
        });
      }),
    );
  }

  startExecution(
    command: StartApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      startApprovedActionExecution(current, command),
    );
  }

  renewExecution(
    command: RenewApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      renewApprovedActionExecution(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        nowMs: command.nowMs,
        leaseDurationMs: command.leaseDurationMs,
      }),
    );
  }

  releaseExecutionBeforeStart(
    command: ReleaseApprovedActionExecutionBeforeStartCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      releaseApprovedActionExecutionBeforeStart(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        resultMutationId: command.resultMutationId,
        resultCode: command.resultCode,
        atMs: command.atMs,
        ...(command.retryAtMs === undefined
          ? {}
          : { retryAtMs: command.retryAtMs }),
      }),
    );
  }

  completeExecution(
    command: CompleteApprovedActionExecutionCommand,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#mutate(command.dispatchId, (current) =>
      completeApprovedActionExecution(current.execution, {
        owner: command.owner,
        leaseToken: command.leaseToken,
        expectedVersion: command.expectedVersion,
        resultMutationId: command.resultMutationId,
        outcome: command.outcome,
        resultCode: command.resultCode,
        ...(command.resultDigest === undefined
          ? {}
          : { resultDigest: command.resultDigest }),
        completedAtMs: command.completedAtMs,
      }),
    );
  }

  #mutate(
    dispatchId: string,
    transition: (
      current: Readonly<ApprovedActionExecutionSnapshot>,
    ) => Readonly<ApprovedActionExecutionRecord>,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot>> {
    return this.#enqueue(() =>
      this.#transaction(() => {
        const current = snapshot(this.#client, dispatchId);
        if (!current) {
          throw new ApprovedActionExecutionStateConflictError();
        }
        const next = transition(current);
        replaceExecution(this.#client, current.execution, next);
        return Object.freeze({
          dispatch: current.dispatch,
          execution: next,
        });
      }),
    );
  }
}
