// PostgreSQL authority source for outstanding cluster recovery candidates.
import {
  MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE,
  type ClusterControlRecoveryCandidate,
  type ClusterControlRecoveryPage,
  type ClusterControlRecoverySource,
  type PostgresQueryable,
} from '@qinglong/runtime-core';

type RecoveryRow = Record<string, unknown> & {
  observedAtMs: unknown;
  kind: unknown;
  id: unknown;
  runId: unknown;
  status: unknown;
  createdAtMs: unknown;
};

const ACTIVE_RUN_STATUSES = new Set(['created', 'dispatching', 'running']);
const ACTIVE_ATTEMPT_STATUSES = new Set(['claimed', 'starting', 'running']);

const OUTSTANDING_RECOVERY_SQL = `
WITH observation AS (
  SELECT floor(
    extract(epoch FROM statement_timestamp()) * 1000
  )::bigint AS observed_at_ms
), run_candidates AS (
  SELECT
    'run'::text AS "kind",
    id AS "id",
    id AS "runId",
    status AS "status",
    created_at_ms AS "createdAtMs"
  FROM "ql3"."runs"
  CROSS JOIN observation
  WHERE execution_owner = 'runtime'
    AND trigger_type NOT IN (
      'plugin_package_workflow',
      'copilot_failure_diagnosis'
    )
    AND (
      status = 'created'
      OR (
        status IN ('dispatching', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM "ql3"."run_attempts" AS active_attempt
          WHERE active_attempt.run_id = "ql3"."runs".id
            AND active_attempt.status IN ('claimed', 'starting', 'running')
            AND active_attempt.lease_expires_at_ms > observation.observed_at_ms
        )
      )
    )
  ORDER BY created_at_ms, id
  LIMIT $1
), attempt_candidates AS (
  SELECT
    'attempt'::text AS "kind",
    attempt.id AS "id",
    attempt.run_id AS "runId",
    attempt.status AS "status",
    attempt.created_at_ms AS "createdAtMs"
  FROM "ql3"."run_attempts" AS attempt
  INNER JOIN "ql3"."runs" AS attempt_run
    ON attempt_run.id = attempt.run_id
  CROSS JOIN observation
  WHERE attempt.status IN ('claimed', 'starting', 'running')
    AND (
      attempt.lease_expires_at_ms IS NULL
      OR attempt.lease_expires_at_ms <= observation.observed_at_ms
    )
    AND NOT (
      attempt_run.execution_owner = 'runtime'
      AND attempt_run.status = 'queued'
      AND attempt_run.cancel_requested_at_ms IS NULL
      AND attempt_run.queued_at_ms IS NOT NULL
      AND attempt.status = 'claimed'
      AND attempt.executor_type = 'remote_worker'
      AND attempt.worker_id IS NULL
      AND attempt.worker_session_id IS NULL
      AND attempt.worker_generation IS NULL
      AND attempt.executor_handle IS NULL
      AND attempt.pid IS NULL
      AND attempt.log_artifact_id IS NULL
      AND attempt.lease_token IS NULL
      AND attempt.lease_token_digest IS NULL
      AND attempt.lease_generation IS NULL
      AND attempt.lease_version IS NULL
      AND attempt.lease_expires_at_ms IS NULL
      AND attempt.offer_id IS NULL
      AND attempt.deadline_at_ms IS NULL
      AND attempt.callback_token_hash IS NULL
      AND attempt.callback_sequence = 0
      AND attempt.started_at_ms IS NULL
      AND attempt.finished_at_ms IS NULL
      AND attempt.exit_code IS NULL
      AND attempt.error_code IS NULL
      AND attempt.error_summary IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "ql3"."run_attempts" AS newer_attempt
        WHERE newer_attempt.run_id = attempt.run_id
          AND newer_attempt.attempt > attempt.attempt
      )
    )
    AND NOT (
      attempt_run.execution_owner = 'runtime'
      AND attempt_run.trigger_type = 'plugin_package_workflow'
      AND attempt_run.status = 'running'
      AND attempt_run.cancel_requested_at_ms IS NULL
      AND attempt.status = 'claimed'
      AND attempt.executor_type = 'remote_worker'
      AND attempt.worker_id IS NULL
      AND attempt.worker_session_id IS NULL
      AND attempt.worker_generation IS NULL
      AND attempt.executor_handle IS NULL
      AND attempt.pid IS NULL
      AND attempt.log_artifact_id IS NULL
      AND attempt.lease_token IS NULL
      AND attempt.lease_token_digest IS NULL
      AND attempt.lease_generation IS NULL
      AND attempt.lease_version IS NULL
      AND attempt.lease_expires_at_ms IS NULL
      AND attempt.offer_id IS NULL
      AND attempt.deadline_at_ms IS NULL
      AND attempt.callback_token_hash IS NULL
      AND attempt.callback_sequence = 0
      AND attempt.started_at_ms IS NULL
      AND attempt.finished_at_ms IS NULL
      AND attempt.exit_code IS NULL
      AND attempt.error_code IS NULL
      AND attempt.error_summary IS NULL
      AND EXISTS (
        SELECT 1
        FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
          AS workflow_task
        WHERE workflow_task.attempt_id = attempt.id
          AND workflow_task.run_id = attempt.run_id
      )
    )
  ORDER BY attempt.created_at_ms, attempt.id
  LIMIT $1
), outstanding AS (
  SELECT *
  FROM (
    SELECT * FROM run_candidates
    UNION ALL
    SELECT * FROM attempt_candidates
  ) AS combined
  ORDER BY "createdAtMs", "kind", "id"
  LIMIT $1
)
SELECT
  observation.observed_at_ms AS "observedAtMs",
  outstanding."kind",
  outstanding."id",
  outstanding."runId",
  outstanding."status",
  outstanding."createdAtMs"
FROM observation
LEFT JOIN outstanding ON TRUE
ORDER BY outstanding."createdAtMs", outstanding."kind", outstanding."id"
`.trim();

function positivePageSize(limit: number): number {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE
  ) {
    throw new RangeError(
      `Cluster-control recovery limit must be between 1 and ${MAX_CLUSTER_CONTROL_RECOVERY_PAGE_SIZE}`,
    );
  }
  return limit;
}

function observationTime(value: unknown): number {
  const converted =
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof converted !== 'number' ||
    !Number.isSafeInteger(converted) ||
    converted < 0
  ) {
    throw new TypeError('PostgreSQL recovery observedAtMs is invalid');
  }
  return converted;
}

function nonemptyString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`PostgreSQL recovery ${name} is invalid`);
  }
  return value;
}

function createdAtMs(value: unknown): number {
  const converted =
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof converted !== 'number' ||
    !Number.isSafeInteger(converted) ||
    converted < 0
  ) {
    throw new TypeError('PostgreSQL recovery createdAtMs is invalid');
  }
  return converted;
}

function recoveryCandidate(row: RecoveryRow): ClusterControlRecoveryCandidate {
  const id = nonemptyString('id', row.id);
  const runId = nonemptyString('runId', row.runId);
  const status = nonemptyString('status', row.status);
  const timestamp = createdAtMs(row.createdAtMs);
  if (row.kind === 'run' && ACTIVE_RUN_STATUSES.has(status)) {
    return Object.freeze({
      kind: 'run',
      id,
      runId,
      status: status as Extract<
        ClusterControlRecoveryCandidate,
        { kind: 'run' }
      >['status'],
      createdAtMs: timestamp,
    });
  }
  if (row.kind === 'attempt' && ACTIVE_ATTEMPT_STATUSES.has(status)) {
    return Object.freeze({
      kind: 'attempt',
      id,
      runId,
      status: status as Extract<
        ClusterControlRecoveryCandidate,
        { kind: 'attempt' }
      >['status'],
      createdAtMs: timestamp,
    });
  }
  throw new TypeError(
    'PostgreSQL recovery candidate kind or status is invalid',
  );
}

export class PostgresClusterControlRecoverySource
  implements ClusterControlRecoverySource
{
  constructor(private readonly queryable: PostgresQueryable) {}

  async listOutstanding(limit: number): Promise<ClusterControlRecoveryPage> {
    const pageSize = positivePageSize(limit);
    const fetchSize = pageSize + 1;
    const result = await this.queryable.query<RecoveryRow>(
      OUTSTANDING_RECOVERY_SQL,
      [fetchSize],
    );
    if (result.rows.length === 0 || result.rows.length > fetchSize) {
      throw new TypeError(
        'PostgreSQL recovery query violated its bounded result contract',
      );
    }
    const observedAtMs = observationTime(result.rows[0]!.observedAtMs);
    if (
      result.rows.some(
        (row) => observationTime(row.observedAtMs) !== observedAtMs,
      )
    ) {
      throw new TypeError(
        'PostgreSQL recovery observation changed within a page',
      );
    }
    const empty = result.rows[0]!.kind === null;
    if (empty) {
      const row = result.rows[0]!;
      if (
        result.rows.length !== 1 ||
        row.id !== null ||
        row.runId !== null ||
        row.status !== null ||
        row.createdAtMs !== null
      ) {
        throw new TypeError('PostgreSQL recovery empty page is invalid');
      }
    }
    const mapped = empty ? [] : result.rows.map(recoveryCandidate);
    const candidates = mapped.slice(0, pageSize);
    return Object.freeze({
      observedAtMs,
      candidates: Object.freeze(candidates),
      hasMore: mapped.length > pageSize,
    });
  }
}
