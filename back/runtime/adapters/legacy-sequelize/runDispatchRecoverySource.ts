import { QueryTypes, Sequelize } from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import {
  RUN_DISPATCH_LEASE_EXPIRY_INDEX,
  RUN_DISPATCH_LEASE_TABLE,
} from '../../../migrations/0009-run-dispatch-lease';
import { WORKER_REGISTRY_TABLE } from '../../../migrations/0008-worker-registry';
import type { RunDispatchCandidate } from '../../domain/runDispatchCandidate';
import {
  MAX_RUN_DISPATCH_RECOVERY_PAGE_SIZE,
  assertRecoverableRunDispatch,
  assertRunDispatchRecoveryCursor,
  assertRunDispatchRecoveryPageSize,
  type RecoverableRunDispatch,
} from '../../domain/runDispatchRecovery';
import {
  assertRunDispatchLeaseVersion,
  type RunDispatchLeaseRecord,
} from '../../domain/runDispatchLease';
import type {
  ListRecoverableRunDispatchesOptions,
  RunDispatchRecoverySource,
} from '../../ports/runDispatchRecoverySource';

interface RecoveryRow {
  runId: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  priority: number | string;
  queuedAtMs: number | string;
  attemptCreatedAtMs: number | string;
  executorType: string;
  version: number | string;
  leaseGeneration: number | string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number | string;
  leaseToken: string;
  acquiredAtMs: number | string;
  renewedAtMs: number | string;
  expiresAtMs: number | string;
  updatedAtMs: number | string;
}

export class LegacySequelizeRunDispatchRecoverySource
  implements RunDispatchRecoverySource
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy Run dispatch recovery source is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async listRecoverable({
    observedAtMs,
    after,
    limit = MAX_RUN_DISPATCH_RECOVERY_PAGE_SIZE,
  }: ListRecoverableRunDispatchesOptions): Promise<RecoverableRunDispatch[]> {
    assertRunDispatchLeaseVersion('observedAtMs', observedAtMs);
    assertRunDispatchRecoveryPageSize(limit);
    if (after) assertRunDispatchRecoveryCursor(after);
    const cursorPredicate = after
      ? `AND (
          l.expires_at_ms > :afterExpiresAtMs
          OR (
            l.expires_at_ms = :afterExpiresAtMs
            AND l.attempt_id > :afterAttemptId
          )
        )`
      : '';
    const rows = await this.database.query<RecoveryRow>(
      `SELECT
         r.id AS runId,
         a.id AS attemptId,
         r.project_id AS projectId,
         r.task_id AS taskId,
         r.task_revision AS taskRevision,
         r.priority AS priority,
         r.queued_at_ms AS queuedAtMs,
         a.created_at_ms AS attemptCreatedAtMs,
         a.executor_type AS executorType,
         l.version AS version,
         l.lease_generation AS leaseGeneration,
         l.worker_id AS workerId,
         l.worker_session_id AS workerSessionId,
         l.worker_generation AS workerGeneration,
         l.lease_token AS leaseToken,
         l.acquired_at_ms AS acquiredAtMs,
         l.renewed_at_ms AS renewedAtMs,
         l.expires_at_ms AS expiresAtMs,
         l.updated_at_ms AS updatedAtMs
       FROM ${RUN_DISPATCH_LEASE_TABLE} l INDEXED BY ${RUN_DISPATCH_LEASE_EXPIRY_INDEX}
       INNER JOIN ${RUN_TABLE} r ON r.id = l.run_id
       INNER JOIN ${RUN_ATTEMPT_TABLE} a ON a.id = l.attempt_id
       INNER JOIN ${WORKER_REGISTRY_TABLE} w ON w.id = l.worker_id
       WHERE l.status = 'leased'
         AND l.expires_at_ms > :observedAtMs
         AND r.execution_owner = 'runtime'
         AND r.status = 'dispatching'
         AND r.cancel_requested_at_ms IS NULL
         AND r.queued_at_ms IS NOT NULL
         AND a.run_id = r.id
         AND a.status = 'claimed'
         AND w.session_id = l.worker_session_id
         AND w.generation = l.worker_generation
         AND w.status IN ('online', 'draining')
         AND w.lease_expires_at_ms > :observedAtMs
         ${cursorPredicate}
       ORDER BY l.expires_at_ms ASC, l.attempt_id ASC
       LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          observedAtMs,
          limit,
          ...(after
            ? {
                afterExpiresAtMs: after.expiresAtMs,
                afterAttemptId: after.attemptId,
              }
            : {}),
        },
      },
    );
    return rows.map((row) => {
      const candidate: RunDispatchCandidate = {
        runId: row.runId,
        attemptId: row.attemptId,
        projectId: row.projectId,
        taskId: row.taskId,
        taskRevision: row.taskRevision,
        priority: Number(row.priority),
        queuedAtMs: Number(row.queuedAtMs),
        attemptCreatedAtMs: Number(row.attemptCreatedAtMs),
        executorType: row.executorType,
      };
      const lease: RunDispatchLeaseRecord = {
        attemptId: row.attemptId,
        runId: row.runId,
        status: 'leased',
        version: Number(row.version),
        leaseGeneration: Number(row.leaseGeneration),
        workerId: row.workerId,
        workerSessionId: row.workerSessionId,
        workerGeneration: Number(row.workerGeneration),
        leaseToken: row.leaseToken,
        acquiredAtMs: Number(row.acquiredAtMs),
        renewedAtMs: Number(row.renewedAtMs),
        expiresAtMs: Number(row.expiresAtMs),
        updatedAtMs: Number(row.updatedAtMs),
      };
      const recovery = { candidate, lease };
      assertRecoverableRunDispatch(recovery);
      return recovery;
    });
  }
}
