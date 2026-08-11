import {
  InvalidRunAttemptLogRetentionError,
  MAX_RUN_ATTEMPT_LOG_RETENTION_PAGE_SIZE,
  RunAttemptLogRetentionUnavailableError,
  normalizeRunAttemptLogRetentionCandidate,
  normalizeRunAttemptLogRetentionCursor,
  normalizeRunAttemptLogRetirementRecord,
  type RunAttemptLogRetentionCursor,
  type RunAttemptLogRetentionPage,
  type RunAttemptLogRetentionRepository,
  type RunAttemptLogRetirementRecord,
} from '@qinglong/runtime-core/run-attempt-log-retention';
import type { RunAttemptLogReadIdentity } from '@qinglong/runtime-core/run-attempt-log-read';

import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const LOCAL_ARTIFACT_ID = /^local-[a-f0-9]{30}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const TOMBSTONE_SELECT = `
  tombstone."log_artifact_id" AS "logArtifactId",
  tombstone."project_id" AS "projectId",
  tombstone."run_id" AS "runId",
  tombstone."attempt_id" AS "attemptId",
  tombstone."executor_type" AS "executorType",
  tombstone."finished_at_ms" AS "finishedAtMs",
  tombstone."eligible_at_ms" AS "eligibleAtMs",
  tombstone."retired_at_ms" AS "retiredAtMs",
  tombstone."disposition" AS "disposition",
  tombstone."byte_length" AS "byteLength",
  tombstone."truncated" AS "truncated",
  tombstone."maximum_bytes" AS "maximumBytes",
  tombstone."truncation_observed_at_ms" AS "truncationObservedAtMs",
  tombstone."record_digest" AS "recordDigest"
`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new RunAttemptLogRetentionUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RunAttemptLogRetentionUnavailableError();
  }
  return Number(value);
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null ? undefined : integer(row, key);
}

function identity(
  value: Readonly<RunAttemptLogReadIdentity>,
): Readonly<RunAttemptLogReadIdentity> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'attemptId,logArtifactId,projectId,runId' ||
    !ID_PATTERN.test(value.projectId) ||
    !ID_PATTERN.test(value.runId) ||
    !ID_PATTERN.test(value.attemptId) ||
    !LOCAL_ARTIFACT_ID.test(value.logArtifactId)
  ) {
    throw new InvalidRunAttemptLogRetentionError('identity is invalid');
  }
  return Object.freeze({ ...value });
}

function tombstone(row: Row): Readonly<RunAttemptLogRetirementRecord> {
  const truncated = text(row, 'truncated');
  return normalizeRunAttemptLogRetirementRecord({
    schema: 'qinglong/run-attempt-log-retirement@v1',
    projectId: text(row, 'projectId'),
    runId: text(row, 'runId'),
    attemptId: text(row, 'attemptId'),
    logArtifactId: text(row, 'logArtifactId'),
    executorType: text(row, 'executorType') as 'local_process',
    finishedAtMs: integer(row, 'finishedAtMs'),
    eligibleAtMs: integer(row, 'eligibleAtMs'),
    retiredAtMs: integer(row, 'retiredAtMs'),
    disposition: text(row, 'disposition') as 'deleted' | 'already_absent',
    byteLength: integer(row, 'byteLength'),
    truncation:
      truncated === 'unknown'
        ? Object.freeze({ truncated: 'unknown' as const })
        : Object.freeze({
            truncated: truncated === 'true',
            maximumBytes: optionalInteger(row, 'maximumBytes')!,
            observedAtMs: optionalInteger(row, 'truncationObservedAtMs')!,
          }),
    recordDigest: text(row, 'recordDigest'),
  });
}

function unavailable(error?: unknown): RunAttemptLogRetentionUnavailableError {
  return new RunAttemptLogRetentionUnavailableError(
    error === undefined ? undefined : { cause: error },
  );
}

export class LocalSqliteRunAttemptLogRetentionRepository
  implements RunAttemptLogRetentionRepository
{
  constructor(private readonly authority: LocalSqliteOperationAuthority) {
    if (!(authority instanceof LocalSqliteOperationAuthority)) {
      throw new TypeError(
        'Local SQLite Run Attempt log retention authority is invalid',
      );
    }
  }

  inspect(rawIdentity: Readonly<RunAttemptLogReadIdentity>) {
    const expected = identity(rawIdentity);
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(
              `SELECT ${TOMBSTONE_SELECT}
               FROM "QingLong3RunAttemptLogArtifactTombstones" AS tombstone
               WHERE tombstone."log_artifact_id" = ?`,
            )
            .get(expected.logArtifactId) as Row | undefined;
          if (!row) return Object.freeze({ status: 'active' as const });
          const record = tombstone(row);
          if (
            record.projectId !== expected.projectId ||
            record.runId !== expected.runId ||
            record.attemptId !== expected.attemptId ||
            record.logArtifactId !== expected.logArtifactId
          ) {
            throw unavailable();
          }
          return Object.freeze({ status: 'retired' as const, record });
        } catch (error) {
          if (error instanceof RunAttemptLogRetentionUnavailableError) {
            throw error;
          }
          throw unavailable(error);
        }
      },
      () => unavailable(),
    );
  }

  loadCursor(): Promise<Readonly<RunAttemptLogRetentionCursor> | undefined> {
    return this.authority.enqueue(
      async () => {
        try {
          const row = this.authority.client
            .prepare(
              `SELECT cursor_finished_at_ms AS "finishedAtMs",
                      cursor_attempt_id AS "attemptId"
               FROM "QingLong3RunAttemptLogRetentionState"
               WHERE maintenance_id = 'local-run-attempt-log'`,
            )
            .get() as Row | undefined;
          if (!row) throw unavailable();
          if (row.finishedAtMs === null && row.attemptId === null) {
            return undefined;
          }
          return normalizeRunAttemptLogRetentionCursor({
            finishedAtMs: integer(row, 'finishedAtMs'),
            attemptId: text(row, 'attemptId'),
          });
        } catch (error) {
          if (error instanceof RunAttemptLogRetentionUnavailableError) {
            throw error;
          }
          throw unavailable(error);
        }
      },
      () => unavailable(),
    );
  }

  list(input: {
    readonly cutoffMs: number;
    readonly limit: number;
    readonly cursor?: Readonly<RunAttemptLogRetentionCursor>;
  }): Promise<RunAttemptLogRetentionPage> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !Number.isSafeInteger(input.cutoffMs) ||
      input.cutoffMs < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_RUN_ATTEMPT_LOG_RETENTION_PAGE_SIZE
    ) {
      throw new InvalidRunAttemptLogRetentionError('list input is invalid');
    }
    const cursor =
      input.cursor === undefined
        ? undefined
        : normalizeRunAttemptLogRetentionCursor(input.cursor);
    return this.authority.enqueue(
      async () => {
        try {
          const rows = this.authority.client
            .prepare(
              `SELECT run.project_id AS "projectId",
                      attempt.run_id AS "runId",
                      attempt.id AS "attemptId",
                      attempt.log_artifact_id AS "logArtifactId",
                      attempt.executor_type AS "executorType",
                      attempt.finished_at_ms AS "finishedAtMs"
               FROM "RunAttempts" AS attempt
               JOIN "Runs" AS run ON run.id = attempt.run_id
               WHERE run.execution_owner = 'runtime'
                 AND run.status IN ('succeeded','failed','cancelled','timed_out')
                 AND attempt.status IN ('succeeded','failed','cancelled','timed_out')
                 AND attempt.executor_type = 'local_process'
                 AND attempt.finished_at_ms IS NOT NULL
                 AND run.finished_at_ms IS NOT NULL
                 AND attempt.finished_at_ms <= ?
                 AND run.finished_at_ms <= ?
                 AND length(attempt.log_artifact_id) = 36
                 AND substr(attempt.log_artifact_id, 1, 6) = 'local-'
                 AND substr(attempt.log_artifact_id, 7) NOT GLOB '*[^0-9a-f]*'
                 AND NOT EXISTS (
                   SELECT 1 FROM "LocalCompletionReceiptJournal" AS receipt
                   WHERE receipt.attempt_id = attempt.id
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM "QingLong3RunAttemptLogArtifactTombstones" AS tombstone
                   WHERE tombstone.attempt_id = attempt.id
                      OR tombstone.log_artifact_id = attempt.log_artifact_id
                 )
                 AND (
                   ? IS NULL OR attempt.finished_at_ms > ? OR
                   (attempt.finished_at_ms = ? AND attempt.id > ?)
                 )
               ORDER BY attempt.finished_at_ms, attempt.id
               LIMIT ?`,
            )
            .all(
              input.cutoffMs,
              input.cutoffMs,
              cursor?.finishedAtMs ?? null,
              cursor?.finishedAtMs ?? null,
              cursor?.finishedAtMs ?? null,
              cursor?.attemptId ?? null,
              input.limit + 1,
            ) as Row[];
          const truncated = rows.length > input.limit;
          const candidates = rows.slice(0, input.limit).map((row) =>
            normalizeRunAttemptLogRetentionCandidate({
              projectId: text(row, 'projectId'),
              runId: text(row, 'runId'),
              attemptId: text(row, 'attemptId'),
              logArtifactId: text(row, 'logArtifactId'),
              executorType: text(row, 'executorType') as 'local_process',
              finishedAtMs: integer(row, 'finishedAtMs'),
            }),
          );
          const last = candidates.at(-1);
          return Object.freeze({
            candidates: Object.freeze(candidates),
            truncated,
            ...(truncated && last
              ? {
                  nextCursor: Object.freeze({
                    finishedAtMs: last.finishedAtMs,
                    attemptId: last.attemptId,
                  }),
                }
              : {}),
          });
        } catch (error) {
          throw unavailable(error);
        }
      },
      () => unavailable(),
    );
  }

  record(raw: Readonly<RunAttemptLogRetirementRecord>) {
    const record = normalizeRunAttemptLogRetirementRecord(raw);
    if (
      record.executorType !== 'local_process' ||
      !LOCAL_ARTIFACT_ID.test(record.logArtifactId)
    ) {
      throw new InvalidRunAttemptLogRetentionError(
        'Local retirement record is invalid',
      );
    }
    return this.authority.enqueue(
      async () => {
        const client = this.authority.client;
        client.exec('BEGIN IMMEDIATE');
        try {
          const replay = client
            .prepare(
              `SELECT ${TOMBSTONE_SELECT}
               FROM "QingLong3RunAttemptLogArtifactTombstones" AS tombstone
               WHERE tombstone.log_artifact_id = ? OR tombstone.attempt_id = ?`,
            )
            .get(record.logArtifactId, record.attemptId) as Row | undefined;
          if (replay) {
            const existing = tombstone(replay);
            if (existing.recordDigest !== record.recordDigest) {
              throw unavailable();
            }
            client.exec('COMMIT');
            return 'existing' as const;
          }
          const eligible = client
            .prepare(
              `SELECT 1 AS eligible
               FROM "RunAttempts" AS attempt
               JOIN "Runs" AS run ON run.id = attempt.run_id
               WHERE attempt.id = ?
                 AND attempt.run_id = ?
                 AND attempt.log_artifact_id = ?
                 AND attempt.executor_type = 'local_process'
                 AND attempt.finished_at_ms = ?
                 AND attempt.status IN ('succeeded','failed','cancelled','timed_out')
                 AND run.project_id = ?
                 AND run.execution_owner = 'runtime'
                 AND run.status IN ('succeeded','failed','cancelled','timed_out')
                 AND run.finished_at_ms IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM "LocalCompletionReceiptJournal" AS receipt
                   WHERE receipt.attempt_id = attempt.id
                 )`,
            )
            .get(
              record.attemptId,
              record.runId,
              record.logArtifactId,
              record.finishedAtMs,
              record.projectId,
            );
          if (!eligible) throw unavailable();
          client
            .prepare(
              `INSERT INTO "QingLong3RunAttemptLogArtifactTombstones" (
                 log_artifact_id, project_id, run_id, attempt_id, executor_type,
                 finished_at_ms, eligible_at_ms, retired_at_ms, disposition,
                 byte_length, truncated, maximum_bytes,
                 truncation_observed_at_ms, record_digest
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.logArtifactId,
              record.projectId,
              record.runId,
              record.attemptId,
              record.executorType,
              record.finishedAtMs,
              record.eligibleAtMs,
              record.retiredAtMs,
              record.disposition,
              record.byteLength,
              String(record.truncation.truncated),
              record.truncation.maximumBytes ?? null,
              record.truncation.observedAtMs ?? null,
              record.recordDigest,
            );
          client.exec('COMMIT');
          return 'recorded' as const;
        } catch (error) {
          try {
            client.exec('ROLLBACK');
          } catch {
            // Preserve the retention failure.
          }
          if (error instanceof RunAttemptLogRetentionUnavailableError) {
            throw error;
          }
          throw unavailable(error);
        }
      },
      () => unavailable(),
    );
  }

  saveCursor(
    rawCursor: Readonly<RunAttemptLogRetentionCursor> | undefined,
    updatedAtMs: number,
  ): Promise<void> {
    const cursor =
      rawCursor === undefined
        ? undefined
        : normalizeRunAttemptLogRetentionCursor(rawCursor);
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw new InvalidRunAttemptLogRetentionError(
        'cursor update time is invalid',
      );
    }
    return this.authority.enqueue(
      async () => {
        try {
          const result = this.authority.client
            .prepare(
              `UPDATE "QingLong3RunAttemptLogRetentionState"
               SET cursor_finished_at_ms = ?, cursor_attempt_id = ?, updated_at_ms = ?
               WHERE maintenance_id = 'local-run-attempt-log'`,
            )
            .run(
              cursor?.finishedAtMs ?? null,
              cursor?.attemptId ?? null,
              updatedAtMs,
            );
          if (result.changes !== 1) throw unavailable();
        } catch (error) {
          if (error instanceof RunAttemptLogRetentionUnavailableError) {
            throw error;
          }
          throw unavailable(error);
        }
      },
      () => unavailable(),
    );
  }
}
