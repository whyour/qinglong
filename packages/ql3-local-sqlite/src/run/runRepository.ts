import type {
  RunAttemptRecord,
  RunAttemptStatus,
  RunEventRecord,
  RunRecord,
  RunRepository,
  RunRepositoryTransaction,
  RunRetryPolicyRecord,
} from '@qinglong/runtime-core/run-repository';
import type {
  ProjectRunListQuery,
  ProjectRunListReader,
} from '@qinglong/runtime-core/project-run-list';
import {
  DuplicateIdempotencyKeyError,
  DuplicateRunAttemptError,
  DuplicateRunEventError,
  RunRepositoryBusyError,
  RunRepositoryConstraintError,
  RunRepositoryError,
  RunRepositoryOperationError,
  assertRunRetryPolicyRecord,
} from '@qinglong/runtime-core/run-repository';
import type { DatabaseSync } from 'node:sqlite';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';
import {
  ATTEMPT_COLUMNS,
  EVENT_COLUMNS,
  INSERT_ATTEMPT_SQL,
  INSERT_EVENT_SQL,
  INSERT_RETRY_POLICY_SQL,
  INSERT_RUN_SQL,
  RETRY_POLICY_COLUMNS,
  RUN_COLUMNS,
  UPDATE_ATTEMPT_SQL,
  UPDATE_RETRY_POLICY_SQL,
  UPDATE_RUN_SQL,
  assertEventPayloadSize,
  isSqliteError,
  mapSqliteError,
  sqliteErrorMessage,
  writeValues,
} from './runPersistence';
import { LocalSqliteRunReader } from './runReader';

class LocalSqliteRunTransaction
  extends LocalSqliteRunReader
  implements RunRepositoryTransaction
{
  private assertRunTaskRevisionIsNotQuarantined(run: RunRecord): void {
    if (run.status !== 'dispatching' && run.status !== 'running') return;
    const quarantined = this.client
      .prepare(
        `SELECT 1
         FROM "QingLong3PluginPackageQuarantineEvents" AS quarantine
         JOIN "QingLong3PluginPackageTaskReconciliations" AS reconciliation
           ON reconciliation.project_id = quarantine.project_id
          AND reconciliation.package_name = quarantine.package_name
          AND reconciliation.lock_digest = quarantine.lock_digest
         JOIN "QingLong3PluginPackageTaskReconciliationItems" AS item
           ON item.generation_digest = reconciliation.generation_digest
          AND item.task_id = ?
          AND 'qltd:v1:' || item.revision || ':' || item.content_digest = ?
         WHERE quarantine.project_id = ?
         LIMIT 1`,
      )
      .get(run.taskId, run.taskRevision, run.projectId);
    if (quarantined) {
      throw new RunRepositoryConstraintError(
        'Run Task revision belongs to a quarantined Package lock',
      );
    }
  }

  private assertRunTaskRevisionHasActivePackageLifecycle(run: RunRecord): void {
    if (run.status !== 'dispatching' && run.status !== 'running') return;
    const inactive = this.client
      .prepare(
        `SELECT 1
         FROM "QingLong3PluginPackageLifecycleHeads" AS lifecycle
         JOIN "QingLong3PluginPackageTaskReconciliations" AS reconciliation
           ON reconciliation.project_id = lifecycle.project_id
          AND reconciliation.package_name = lifecycle.package_name
          AND reconciliation.lock_digest = lifecycle.lock_digest
         JOIN "QingLong3PluginPackageTaskReconciliationItems" AS item
           ON item.generation_digest = reconciliation.generation_digest
          AND item.task_id = ?
          AND 'qltd:v1:' || item.revision || ':' || item.content_digest = ?
         WHERE lifecycle.project_id = ?
           AND lifecycle.disposition <> 'active'
         LIMIT 1`,
      )
      .get(run.taskId, run.taskRevision, run.projectId);
    if (inactive) {
      throw new RunRepositoryConstraintError(
        'Run Task revision belongs to a non-active Package lifecycle',
      );
    }
  }

  async insertRun(run: RunRecord): Promise<void> {
    try {
      this.client.prepare(INSERT_RUN_SQL).run(...writeValues(run, RUN_COLUMNS));
    } catch (error) {
      if (
        run.idempotencyKey &&
        sqliteErrorMessage(error).includes(
          'Runs.project_id, Runs.idempotency_key',
        )
      ) {
        throw new DuplicateIdempotencyKeyError(
          run.projectId,
          run.idempotencyKey,
        );
      }
      throw mapSqliteError(error);
    }
  }

  async insertAttempt(attempt: RunAttemptRecord): Promise<void> {
    try {
      this.client
        .prepare(INSERT_ATTEMPT_SQL)
        .run(...writeValues(attempt, ATTEMPT_COLUMNS));
    } catch (error) {
      if (
        sqliteErrorMessage(error).includes(
          'RunAttempts.run_id, RunAttempts.attempt',
        )
      ) {
        throw new DuplicateRunAttemptError(attempt.runId, attempt.attempt);
      }
      throw mapSqliteError(error);
    }
  }

  async insertRetryPolicy(policy: RunRetryPolicyRecord): Promise<void> {
    assertRunRetryPolicyRecord(policy);
    try {
      this.client
        .prepare(INSERT_RETRY_POLICY_SQL)
        .run(...writeValues(policy, RETRY_POLICY_COLUMNS));
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  async compareAndSetRun(
    run: RunRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (run.version !== expectedVersion + 1) {
      throw new RunRepositoryConstraintError(
        'A compare-and-set Run write must increment version exactly once',
      );
    }
    try {
      this.assertRunTaskRevisionIsNotQuarantined(run);
      this.assertRunTaskRevisionHasActivePackageLifecycle(run);
      const values = writeValues(run, RUN_COLUMNS);
      const result = this.client
        .prepare(UPDATE_RUN_SQL)
        .run(...values.slice(1), values[0]!, expectedVersion);
      if (result.changes > 1) {
        throw new RunRepositoryConstraintError(
          'Local SQLite compare-and-set affected more than one Run',
        );
      }
      return result.changes === 1;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  async compareAndSetAttempt(
    attempt: RunAttemptRecord,
    expected: { status: RunAttemptStatus; callbackSequence: number },
  ): Promise<boolean> {
    try {
      const values = writeValues(attempt, ATTEMPT_COLUMNS);
      const result = this.client
        .prepare(UPDATE_ATTEMPT_SQL)
        .run(
          ...values.slice(1),
          values[0]!,
          expected.status,
          expected.callbackSequence,
        );
      if (result.changes > 1) {
        throw new RunRepositoryConstraintError(
          'Local SQLite compare-and-set affected more than one Attempt',
        );
      }
      return result.changes === 1;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  async compareAndSetRetryPolicy(
    policy: RunRetryPolicyRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    if (policy.version !== expectedVersion + 1) {
      throw new RunRepositoryConstraintError(
        'A compare-and-set retry policy write must increment version exactly once',
      );
    }
    assertRunRetryPolicyRecord(policy);
    try {
      const values = writeValues(policy, RETRY_POLICY_COLUMNS);
      const result = this.client
        .prepare(UPDATE_RETRY_POLICY_SQL)
        .run(...values.slice(1), values[0]!, expectedVersion);
      if (result.changes > 1) {
        throw new RunRepositoryConstraintError(
          'Local SQLite compare-and-set affected more than one retry policy',
        );
      }
      return result.changes === 1;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  async appendEvent(event: RunEventRecord): Promise<void> {
    const serialized = assertEventPayloadSize(event);
    try {
      const values = writeValues(
        { ...event, payload: serialized },
        EVENT_COLUMNS,
      );
      this.client.prepare(INSERT_EVENT_SQL).run(...values);
    } catch (error) {
      const message = sqliteErrorMessage(error);
      if (
        message.includes('RunEvents.run_id, RunEvents.sequence') ||
        message.includes('RunEvents.run_id, RunEvents.dedupe_key')
      ) {
        throw new DuplicateRunEventError(event.runId, event.dedupeKey);
      }
      throw mapSqliteError(error);
    }
  }
}

/**
 * One Node SQLite connection is a single local authority. Every operation is
 * serialized and every transaction uses BEGIN IMMEDIATE so async application
 * code cannot interleave writes on the synchronous driver.
 */
export class LocalSqliteRunRepository
  implements RunRepository, ProjectRunListReader
{
  private readonly reader: LocalSqliteRunReader;
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly client: DatabaseSync;

  constructor(client: DatabaseSync | LocalSqliteOperationAuthority) {
    this.authority =
      client instanceof LocalSqliteOperationAuthority
        ? client
        : new LocalSqliteOperationAuthority(client);
    this.client = this.authority.client;
    this.reader = new LocalSqliteRunReader(this.client);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    return this.authority.enqueue(work, (reason) =>
      reason === 'busy'
        ? new RunRepositoryBusyError()
        : new RunRepositoryOperationError(
            new Error('Local SQLite Run repository is closed'),
          ),
    );
  }

  findRunById(runId: string): Promise<RunRecord | null> {
    return this.enqueue(() => this.reader.findRunById(runId));
  }

  listRunsByProject(
    query: Readonly<ProjectRunListQuery>,
  ): Promise<readonly RunRecord[]> {
    return this.enqueue(() => this.reader.listRunsByProject(query));
  }

  findAttemptById(attemptId: string): Promise<RunAttemptRecord | null> {
    return this.enqueue(() => this.reader.findAttemptById(attemptId));
  }

  findLatestAttemptByRunId(runId: string): Promise<RunAttemptRecord | null> {
    return this.enqueue(() => this.reader.findLatestAttemptByRunId(runId));
  }

  findRetryPolicyByRunId(runId: string): Promise<RunRetryPolicyRecord | null> {
    return this.enqueue(() => this.reader.findRetryPolicyByRunId(runId));
  }

  listEvents(
    runId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<RunEventRecord[]> {
    return this.enqueue(() => this.reader.listEvents(runId, options));
  }

  listCancellationRequested(options?: {
    beforeMs?: number;
    limit?: number;
  }): Promise<RunRecord[]> {
    return this.enqueue(() => this.reader.listCancellationRequested(options));
  }

  transaction<T>(
    work: (transaction: RunRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    if (typeof work !== 'function') {
      return Promise.reject(
        new RunRepositoryConstraintError('transaction work must be a function'),
      );
    }
    return this.enqueue(async () => {
      let began = false;
      try {
        this.client.exec('BEGIN IMMEDIATE');
        began = true;
        const result = await work(new LocalSqliteRunTransaction(this.client));
        this.client.exec('COMMIT');
        began = false;
        return result;
      } catch (error) {
        if (began && this.client.isTransaction) {
          try {
            this.client.exec('ROLLBACK');
          } catch {
            // Preserve the work failure; close will discard a broken handle.
          }
        }
        if (error instanceof RunRepositoryError) throw error;
        if (isSqliteError(error)) throw mapSqliteError(error);
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.authority.close();
  }
}
