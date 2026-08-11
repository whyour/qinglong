// PostgreSQL authority source for runtime-level recovery candidates.
import {
  MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE,
  type ClusterControlRecoveryCandidate,
  type ClusterControlRecoveryPage,
  type ClusterControlRecoverySource,
  type PostgresQueryable,
} from '@qinglong/runtime-core';

type Row = Record<string, unknown>;

function integer(value: unknown, label: string): number {
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof normalized !== 'number' ||
    !Number.isSafeInteger(normalized) ||
    normalized < 0
  ) {
    throw new TypeError(`PostgreSQL runtime recovery ${label} is invalid`);
  }
  return normalized;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL runtime recovery ${label} is invalid`);
  }
  return value;
}

function pageSize(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE
  ) {
    throw new RangeError(
      `Cluster runtime recovery limit must be between 1 and ${MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE}`,
    );
  }
  return value;
}

/**
 * Continuous production recovery source. Unlike the startup source it never
 * scans orphaned `created` Runs; one bounded page contains only active
 * Attempts whose durable lease is absent or expired.
 */
export class PostgresClusterRuntimeRecoverySource
  implements ClusterControlRecoverySource
{
  constructor(private readonly queryable: PostgresQueryable) {
    if (!queryable || typeof queryable.query !== 'function') {
      throw new TypeError('PostgreSQL runtime recovery queryable is invalid');
    }
  }

  async listOutstanding(limit: number): Promise<ClusterControlRecoveryPage> {
    const maximum = pageSize(limit);
    const result = await this.queryable.query<Row>(
      `WITH observation AS MATERIALIZED (
         SELECT floor(
           extract(epoch FROM statement_timestamp()) * 1000
         )::bigint AS observed_at_ms
       ), candidates AS (
         SELECT attempt.id, attempt.run_id, attempt.status,
                attempt.created_at_ms
         FROM "ql3"."run_attempts" AS attempt
         JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
         CROSS JOIN observation
         WHERE run.execution_owner = 'runtime'
           AND run.status IN ('dispatching', 'running', 'lost')
           AND attempt.status IN ('claimed', 'starting', 'running')
           AND (
             attempt.lease_expires_at_ms IS NULL
             OR attempt.lease_expires_at_ms <= observation.observed_at_ms
           )
           AND NOT (
             attempt.status = 'claimed'
             AND attempt.executor_type = 'remote_worker'
             AND attempt.worker_id IS NULL
             AND attempt.worker_session_id IS NULL
             AND attempt.worker_generation IS NULL
             AND attempt.lease_generation IS NULL
             AND attempt.lease_version IS NULL
             AND attempt.lease_expires_at_ms IS NULL
             AND attempt.offer_id IS NULL
             AND attempt.started_at_ms IS NULL
           )
         ORDER BY attempt.lease_expires_at_ms NULLS FIRST,
                  attempt.created_at_ms, attempt.id
         LIMIT $1
       )
       SELECT observation.observed_at_ms AS "observedAtMs",
              candidate.id AS "attemptId",
              candidate.run_id AS "runId",
              candidate.status,
              candidate.created_at_ms AS "createdAtMs"
       FROM observation
       LEFT JOIN candidates AS candidate ON TRUE
       ORDER BY candidate.created_at_ms, candidate.id`,
      [maximum + 1],
    );
    if (result.rows.length < 1 || result.rows.length > maximum + 1) {
      throw new TypeError(
        'PostgreSQL runtime recovery violated its bounded page',
      );
    }
    const observedAtMs = integer(
      result.rows[0]!.observedAtMs,
      'observation',
    );
    const candidates: ClusterControlRecoveryCandidate[] = [];
    for (const row of result.rows) {
      if (row.attemptId === null || row.attemptId === undefined) continue;
      const status = text(row.status, 'Attempt status');
      if (!['claimed', 'starting', 'running'].includes(status)) {
        throw new TypeError(
          'PostgreSQL runtime recovery Attempt status is invalid',
        );
      }
      candidates.push(
        Object.freeze({
          kind: 'attempt' as const,
          id: text(row.attemptId, 'Attempt ID'),
          runId: text(row.runId, 'Run ID'),
          status: status as 'claimed' | 'starting' | 'running',
          createdAtMs: integer(row.createdAtMs, 'creation time'),
        }),
      );
    }
    const hasMore = candidates.length > maximum;
    return Object.freeze({
      observedAtMs,
      candidates: Object.freeze(candidates.slice(0, maximum)),
      hasMore,
    });
  }
}
