import { QueryTypes, Sequelize } from 'sequelize';
import { RUN_TABLE } from '../../../migrations/0002-run-schema';
import {
  RUN_LOST_RETRY_INDEX,
  RUN_RETRY_POLICY_DUE_INDEX,
  RUN_RETRY_POLICY_TABLE,
} from '../../../migrations/0011-run-retry-policy';
import {
  MAX_RUN_LOST_RETRY_PAGE_SIZE,
  type ListRunLostRetryCandidatesOptions,
  type RunLostRetryCandidate,
  type RunLostRetrySource,
} from '../../ports/runLostRetrySource';

interface RunLostRetryCandidateRow {
  runId: string;
  phase: 'lost' | 'retry_wait';
  availableAtMs: number | string;
}

export class LegacySequelizeRunLostRetrySource implements RunLostRetrySource {
  constructor(private readonly database: Sequelize) {
    if (database.getDialect() !== 'sqlite') {
      throw new TypeError(
        'Legacy lost retry source is SQLite-only; cluster-control requires a PostgreSQL adapter',
      );
    }
  }

  async listCandidates({
    observedAtMs,
    limit = 16,
  }: ListRunLostRetryCandidatesOptions): Promise<
    readonly RunLostRetryCandidate[]
  > {
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new RangeError('observedAtMs must be a non-negative safe integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_RUN_LOST_RETRY_PAGE_SIZE
    ) {
      throw new RangeError(
        `limit must be between 1 and ${MAX_RUN_LOST_RETRY_PAGE_SIZE}`,
      );
    }
    const rows = await this.database.query<RunLostRetryCandidateRow>(
      `SELECT runId, phase, availableAtMs
       FROM (
         SELECT
           r.id AS runId,
           'lost' AS phase,
           0 AS availableAtMs
         FROM ${RUN_TABLE} r INDEXED BY ${RUN_LOST_RETRY_INDEX}
         WHERE r.execution_owner = 'runtime'
           AND r.status = 'lost'

         UNION ALL

         SELECT
           r.id AS runId,
           'retry_wait' AS phase,
           p.next_attempt_at_ms AS availableAtMs
         FROM ${RUN_RETRY_POLICY_TABLE} p INDEXED BY ${RUN_RETRY_POLICY_DUE_INDEX}
         INNER JOIN ${RUN_TABLE} r ON r.id = p.run_id
         WHERE p.next_attempt_at_ms IS NOT NULL
           AND p.next_attempt_at_ms <= :observedAtMs
           AND r.execution_owner = 'runtime'
           AND r.status = 'retry_wait'
       ) candidates
       ORDER BY availableAtMs ASC, runId ASC
       LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { observedAtMs, limit },
      },
    );
    return rows.map((row) => ({
      runId: row.runId,
      phase: row.phase,
      availableAtMs: Number(row.availableAtMs),
    }));
  }
}
