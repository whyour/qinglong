import {
  LOCAL_COMPLETION_RECEIPT_JOURNAL_STATES,
  type LocalCompletionReceiptJournalCandidate,
  type LocalCompletionReceiptJournalCursor,
  type LocalCompletionReceiptJournalPage,
  type QuarantineLocalCompletionReceiptCommand,
  type RegisterLocalCompletionReceiptCommand,
} from '@qinglong/runtime-core/local-completion-receipt-journal';
import {
  RUN_ATTEMPT_STATUSES,
  RunRepositoryConstraintError,
} from '@qinglong/runtime-core/run-repository';
import type { DatabaseSync } from 'node:sqlite';

type QueryRow = Record<string, unknown>;

function requiredString(row: QueryRow, property: string): string {
  const value = row[property];
  if (typeof value !== 'string' || value.length === 0) {
    throw new RunRepositoryConstraintError(
      `Local SQLite Run row has an invalid ${property}`,
    );
  }
  return value;
}

function optionalString(row: QueryRow, property: string): string | undefined {
  const value = row[property];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new RunRepositoryConstraintError(
      `Local SQLite Run row has an invalid ${property}`,
    );
  }
  return value;
}

function requiredInteger(row: QueryRow, property: string): number {
  const value = row[property];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new RunRepositoryConstraintError(
    `Local SQLite Run row has an invalid ${property}`,
  );
}

function optionalInteger(row: QueryRow, property: string): number | undefined {
  if (row[property] === null || row[property] === undefined) return undefined;
  return requiredInteger(row, property);
}

function requiredEnum<T extends string>(
  row: QueryRow,
  property: string,
  allowed: readonly T[],
): T {
  const value = requiredString(row, property);
  if (!allowed.includes(value as T)) {
    throw new RunRepositoryConstraintError(
      `Local SQLite Run row has an unsupported ${property}`,
    );
  }
  return value as T;
}

function assignOptional<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) record[key] = value;
}

function singleRow(rows: QueryRow[]): QueryRow | null {
  const [row] = rows;
  if (!row) return null;
  if (rows.length !== 1) {
    throw new RunRepositoryConstraintError(
      'Local SQLite Run repository returned duplicate identity rows',
    );
  }
  return row;
}

/**
 * Private synchronous storage collaborator. The owning Facade must call every
 * method inside its single LocalSqliteOperationAuthority queue.
 */
export class LocalSqliteCompletionReceiptJournalStore {
  constructor(private readonly client: DatabaseSync) {}

  private queryRows(
    sql: string,
    values: readonly (string | number | bigint | Uint8Array | null)[] = [],
  ): QueryRow[] {
    return this.client.prepare(sql).all(...values) as unknown as QueryRow[];
  }

  register(command: RegisterLocalCompletionReceiptCommand): void {
    const attempt = this.client
      .prepare(
        `SELECT "run_id" AS "runId", "executor_type" AS "executorType"
         FROM "RunAttempts" WHERE "id" = ? LIMIT 2`,
      )
      .all(command.attemptId) as unknown as QueryRow[];
    const row = singleRow(attempt);
    if (
      !row ||
      requiredString(row, 'runId') !== command.runId ||
      requiredString(row, 'executorType') !== 'local_process'
    ) {
      throw new RunRepositoryConstraintError(
        'Completion receipt registration does not match a local Attempt',
      );
    }
    const inserted = this.client
      .prepare(
        `INSERT INTO "LocalCompletionReceiptJournal"
           (attempt_id, run_id, state, quarantine_ref, purge_after_ms,
            registered_at_ms, updated_at_ms)
         VALUES (?, ?, 'pending', NULL, NULL, ?, ?)
         ON CONFLICT (attempt_id) DO NOTHING`,
      )
      .run(
        command.attemptId,
        command.runId,
        command.registeredAtMs,
        command.registeredAtMs,
      );
    if (inserted.changes === 1) return;
    const current = singleRow(
      this.queryRows(
        `SELECT "run_id" AS "runId", "state" AS "state",
                "registered_at_ms" AS "registeredAtMs"
         FROM "LocalCompletionReceiptJournal"
         WHERE "attempt_id" = ? LIMIT 2`,
        [command.attemptId],
      ),
    );
    if (
      current &&
      requiredString(current, 'runId') === command.runId &&
      requiredString(current, 'state') === 'pending' &&
      requiredInteger(current, 'registeredAtMs') === command.registeredAtMs
    ) {
      return;
    }
    throw new RunRepositoryConstraintError(
      'Completion receipt registration conflicts with durable state',
    );
  }

  markQuarantined(command: QuarantineLocalCompletionReceiptCommand): void {
    const updated = this.client
      .prepare(
        `UPDATE "LocalCompletionReceiptJournal"
         SET state = 'quarantined', quarantine_ref = ?, purge_after_ms = ?,
             updated_at_ms = ?
         WHERE attempt_id = ? AND state = 'pending'`,
      )
      .run(
        command.quarantineRef,
        command.purgeAfterMs,
        command.updatedAtMs,
        command.attemptId,
      );
    if (updated.changes === 1) return;
    const current = singleRow(
      this.queryRows(
        `SELECT "state" AS "state", "quarantine_ref" AS "quarantineRef",
                "purge_after_ms" AS "purgeAfterMs",
                "updated_at_ms" AS "updatedAtMs"
         FROM "LocalCompletionReceiptJournal"
         WHERE "attempt_id" = ? LIMIT 2`,
        [command.attemptId],
      ),
    );
    if (
      current &&
      requiredString(current, 'state') === 'quarantined' &&
      requiredString(current, 'quarantineRef') === command.quarantineRef &&
      requiredInteger(current, 'purgeAfterMs') === command.purgeAfterMs &&
      requiredInteger(current, 'updatedAtMs') === command.updatedAtMs
    ) {
      return;
    }
    throw new RunRepositoryConstraintError(
      'Completion receipt quarantine transition conflicts',
    );
  }

  resolve(attemptId: string): boolean {
    return (
      this.client
        .prepare(
          `DELETE FROM "LocalCompletionReceiptJournal"
           WHERE "attempt_id" = ?`,
        )
        .run(attemptId).changes === 1
    );
  }

  listCandidates(options: {
    observedAtMs: number;
    cursor?: LocalCompletionReceiptJournalCursor;
    limit: number;
  }): LocalCompletionReceiptJournalPage {
    const rows = this.queryRows(
      `SELECT
         "journal"."attempt_id" AS "attemptId",
         "journal"."run_id" AS "runId",
         "journal"."state" AS "state",
         "journal"."quarantine_ref" AS "quarantineRef",
         "journal"."purge_after_ms" AS "purgeAfterMs",
         "journal"."registered_at_ms" AS "registeredAtMs",
         "journal"."updated_at_ms" AS "updatedAtMs",
         "attempt"."run_id" AS "attemptRunId",
         "attempt"."status" AS "attemptStatus",
         "attempt"."executor_type" AS "executorType",
         "attempt"."finished_at_ms" AS "finishedAtMs"
       FROM "LocalCompletionReceiptJournal" AS "journal"
       INNER JOIN "RunAttempts" AS "attempt"
         ON "attempt"."id" = "journal"."attempt_id"
       WHERE (
         "journal"."state" = 'pending' OR
         ("journal"."state" = 'quarantined' AND
          "journal"."purge_after_ms" <= ?)
       )
         AND (? IS NULL OR "journal"."updated_at_ms" > ? OR
           ("journal"."updated_at_ms" = ? AND "journal"."attempt_id" > ?))
       ORDER BY "journal"."updated_at_ms", "journal"."attempt_id"
       LIMIT ?`,
      [
        options.observedAtMs,
        options.cursor?.updatedAtMs ?? null,
        options.cursor?.updatedAtMs ?? null,
        options.cursor?.updatedAtMs ?? null,
        options.cursor?.attemptId ?? null,
        options.limit + 1,
      ],
    );
    const truncated = rows.length > options.limit;
    const candidates = rows.slice(0, options.limit).map((row) => {
      const runId = requiredString(row, 'runId');
      if (requiredString(row, 'attemptRunId') !== runId) {
        throw new RunRepositoryConstraintError(
          'Completion receipt journal Run identity is corrupt',
        );
      }
      const candidate: LocalCompletionReceiptJournalCandidate = {
        attemptId: requiredString(row, 'attemptId'),
        runId,
        state: requiredEnum(
          row,
          'state',
          LOCAL_COMPLETION_RECEIPT_JOURNAL_STATES,
        ),
        registeredAtMs: requiredInteger(row, 'registeredAtMs'),
        updatedAtMs: requiredInteger(row, 'updatedAtMs'),
        attemptStatus: requiredEnum(
          row,
          'attemptStatus',
          RUN_ATTEMPT_STATUSES,
        ),
        executorType: requiredString(row, 'executorType'),
      };
      assignOptional(
        candidate,
        'quarantineRef',
        optionalString(row, 'quarantineRef'),
      );
      assignOptional(
        candidate,
        'purgeAfterMs',
        optionalInteger(row, 'purgeAfterMs'),
      );
      assignOptional(
        candidate,
        'finishedAtMs',
        optionalInteger(row, 'finishedAtMs'),
      );
      return Object.freeze(candidate);
    });
    const last = candidates.at(-1);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated,
      ...(last === undefined
        ? {}
        : {
            nextCursor: Object.freeze({
              updatedAtMs: last.updatedAtMs,
              attemptId: last.attemptId,
            }),
          }),
    });
  }
}
