import { QueryTypes, Sequelize } from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { RUN_DISPATCH_LEASE_TABLE } from '../../../migrations/0009-run-dispatch-lease';
import { RUN_DISPATCH_CANDIDATE_RUN_INDEX } from '../../../migrations/0010-run-dispatch-candidates';
import {
  MAX_RUN_DISPATCH_CANDIDATE_PAGE_SIZE,
  assertRunDispatchCandidate,
  assertRunDispatchCandidateCursor,
  assertRunDispatchCandidatePageSize,
  type RunDispatchCandidate,
} from '../../domain/runDispatchCandidate';
import { assertRunDispatchLeaseVersion } from '../../domain/runDispatchLease';
import type {
  ListRunDispatchCandidatesOptions,
  RunDispatchCandidateSource,
} from '../../ports/runDispatchCandidateSource';

interface CandidateRow {
  runId: string;
  attemptId: string;
  projectId: string;
  taskId: string;
  taskRevision: string;
  priority: number | string;
  queuedAtMs: number | string;
  attemptCreatedAtMs: number | string;
  executorType: string;
}

const CANDIDATE_ORDER = `
  r.priority DESC,
  r.queued_at_ms ASC,
  a.created_at_ms ASC,
  a.id ASC
`;

export class LegacySequelizeRunDispatchCandidateSource
  implements RunDispatchCandidateSource
{
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy Run dispatch candidate source is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async listCandidates({
    observedAtMs,
    after,
    limit = MAX_RUN_DISPATCH_CANDIDATE_PAGE_SIZE,
  }: ListRunDispatchCandidatesOptions): Promise<RunDispatchCandidate[]> {
    assertRunDispatchLeaseVersion('observedAtMs', observedAtMs);
    assertRunDispatchCandidatePageSize(limit);
    if (after) assertRunDispatchCandidateCursor(after);

    const cursorPredicate = after
      ? `AND (
          r.priority < :afterPriority
          OR (r.priority = :afterPriority AND r.queued_at_ms > :afterQueuedAtMs)
          OR (
            r.priority = :afterPriority
            AND r.queued_at_ms = :afterQueuedAtMs
            AND a.created_at_ms > :afterAttemptCreatedAtMs
          )
          OR (
            r.priority = :afterPriority
            AND r.queued_at_ms = :afterQueuedAtMs
            AND a.created_at_ms = :afterAttemptCreatedAtMs
            AND a.id > :afterAttemptId
          )
        )`
      : '';
    const rows = await this.database.query<CandidateRow>(
      `SELECT
         r.id AS runId,
         a.id AS attemptId,
         r.project_id AS projectId,
         r.task_id AS taskId,
         r.task_revision AS taskRevision,
         r.priority AS priority,
         r.queued_at_ms AS queuedAtMs,
         a.created_at_ms AS attemptCreatedAtMs,
         a.executor_type AS executorType
       FROM ${RUN_TABLE} r INDEXED BY ${RUN_DISPATCH_CANDIDATE_RUN_INDEX}
       INNER JOIN ${RUN_ATTEMPT_TABLE} a ON a.run_id = r.id
       LEFT JOIN ${RUN_DISPATCH_LEASE_TABLE} l ON l.attempt_id = a.id
       WHERE r.execution_owner = 'runtime'
         AND r.status IN ('queued', 'dispatching')
         AND r.queued_at_ms IS NOT NULL
         AND r.cancel_requested_at_ms IS NULL
         AND a.status = 'claimed'
         AND (
           l.attempt_id IS NULL
           OR l.status = 'released'
           OR (l.status = 'leased' AND l.expires_at_ms <= :observedAtMs)
         )
         ${cursorPredicate}
       ORDER BY ${CANDIDATE_ORDER}
       LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          observedAtMs,
          limit,
          ...(after
            ? {
                afterPriority: after.priority,
                afterQueuedAtMs: after.queuedAtMs,
                afterAttemptCreatedAtMs: after.attemptCreatedAtMs,
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
      assertRunDispatchCandidate(candidate);
      return candidate;
    });
  }
}
