// PostgreSQL source for remote-execution dispatch candidates and lease recovery.
import type {
  ClusterDispatchCandidate,
  ClusterDispatchCandidatePage,
  ClusterDispatchCandidateCursor,
  ClusterDispatchRecovery,
  ClusterDispatchSource,
} from '@qinglong/runtime-core/remote-dispatch';
import {
  assertRemoteDispatchPageSize,
  normalizeClusterDispatchCandidate,
  normalizeClusterDispatchCursor,
} from '@qinglong/runtime-core/remote-dispatch';
import type {
  PostgresPool,
  RunDispatchLeaseRecord,
  RunDispatchLeaseStatus,
} from '@qinglong/runtime-core';
import {
  RUN_DISPATCH_LEASE_STATUSES,
  assertRunDispatchId,
  assertRunDispatchLeaseRecord,
} from '@qinglong/runtime-core';

type Row = Record<string, unknown>;

const CANDIDATE_COLUMNS = `
  run.id AS "runId",
  attempt.id AS "attemptId",
  COALESCE(workflow_task.project_id, run.project_id) AS "projectId",
  COALESCE(workflow_task.task_id, run.task_id) AS "taskId",
  COALESCE(workflow_task.task_revision, run.task_revision) AS "taskRevision",
  run.priority,
  COALESCE(workflow_task.admitted_at_ms, run.queued_at_ms) AS "queuedAtMs",
  attempt.created_at_ms AS "attemptCreatedAtMs",
  attempt.attempt AS "attemptNumber",
  attempt.executor_type AS "executorType"`.trim();

const LEASE_COLUMNS = `
  lease.status AS "leaseStatus",
  lease.version AS "leaseVersion",
  lease.lease_generation AS "leaseGeneration",
  lease.worker_id AS "workerId",
  lease.worker_session_id AS "workerSessionId",
  lease.worker_generation AS "workerGeneration",
  lease.lease_token_digest AS "leaseTokenDigest",
  lease.acquired_at_ms AS "acquiredAtMs",
  lease.renewed_at_ms AS "renewedAtMs",
  lease.expires_at_ms AS "expiresAtMs",
  lease.released_at_ms AS "releasedAtMs",
  lease.release_reason AS "releaseReason",
  lease.completed_at_ms AS "completedAtMs",
  lease.updated_at_ms AS "leaseUpdatedAtMs"`.trim();

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`PostgreSQL cluster dispatch ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const normalized = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
    ? Number(value)
    : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) {
    throw new TypeError(`PostgreSQL cluster dispatch ${key} is invalid`);
  }
  return normalized;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined ? undefined : integer(row, key);
}

function optionalString(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : string(row, key);
}

function candidate(row: Row): ClusterDispatchCandidate {
  return normalizeClusterDispatchCandidate({
    runId: string(row, 'runId'),
    attemptId: string(row, 'attemptId'),
    projectId: string(row, 'projectId'),
    taskId: string(row, 'taskId'),
    taskRevision: string(row, 'taskRevision'),
    priority: integer(row, 'priority'),
    queuedAtMs: integer(row, 'queuedAtMs'),
    attemptCreatedAtMs: integer(row, 'attemptCreatedAtMs'),
    attemptNumber: integer(row, 'attemptNumber'),
    executorType: string(row, 'executorType') as ClusterDispatchCandidate['executorType'],
  });
}

function lease(row: Row): RunDispatchLeaseRecord {
  const status = string(row, 'leaseStatus') as RunDispatchLeaseStatus;
  if (!RUN_DISPATCH_LEASE_STATUSES.includes(status)) {
    throw new TypeError('PostgreSQL cluster dispatch lease status is invalid');
  }
  const releasedAtMs = optionalInteger(row, 'releasedAtMs');
  const releaseReason = optionalString(row, 'releaseReason');
  const completedAtMs = optionalInteger(row, 'completedAtMs');
  const value: RunDispatchLeaseRecord = Object.freeze({
    attemptId: string(row, 'attemptId'),
    runId: string(row, 'runId'),
    status,
    version: integer(row, 'leaseVersion'),
    leaseGeneration: integer(row, 'leaseGeneration'),
    workerId: string(row, 'workerId'),
    workerSessionId: string(row, 'workerSessionId'),
    workerGeneration: integer(row, 'workerGeneration'),
    leaseTokenDigest: string(row, 'leaseTokenDigest'),
    acquiredAtMs: integer(row, 'acquiredAtMs'),
    renewedAtMs: integer(row, 'renewedAtMs'),
    expiresAtMs: integer(row, 'expiresAtMs'),
    updatedAtMs: integer(row, 'leaseUpdatedAtMs'),
    ...(releasedAtMs === undefined ? {} : { releasedAtMs }),
    ...(releaseReason === undefined ? {} : {
      releaseReason: releaseReason as NonNullable<RunDispatchLeaseRecord['releaseReason']>,
    }),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  });
  assertRunDispatchLeaseRecord(value);
  return value;
}

function cursor(value: ClusterDispatchCandidate): ClusterDispatchCandidateCursor {
  return Object.freeze({
    priority: value.priority,
    queuedAtMs: value.queuedAtMs,
    attemptCreatedAtMs: value.attemptCreatedAtMs,
    attemptId: value.attemptId,
  });
}

export class PostgresClusterDispatchSource implements ClusterDispatchSource {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL cluster dispatch pool is invalid');
    }
  }

  async listClusterDispatchCandidates(options: Readonly<{
    limit: number;
    after?: ClusterDispatchCandidateCursor;
  }>): Promise<ClusterDispatchCandidatePage> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('PostgreSQL cluster dispatch options are invalid');
    }
    const keys = Object.keys(options);
    if (!keys.includes('limit') || keys.some((key) => !['after', 'limit'].includes(key))) {
      throw new TypeError('PostgreSQL cluster dispatch options shape is invalid');
    }
    assertRemoteDispatchPageSize(options.limit);
    const after = options.after === undefined
      ? undefined
      : normalizeClusterDispatchCursor(options.after);
    const result = await this.pool.query<Row>(
      `WITH observation AS MATERIALIZED (
         SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           AS observed_at_ms
       ), candidates AS MATERIALIZED (
         SELECT ${CANDIDATE_COLUMNS}
         FROM observation
         JOIN "ql3"."runs" AS run ON true
         JOIN "ql3"."run_attempts" AS attempt ON attempt.run_id = run.id
         LEFT JOIN
           "ql3"."plugin_package_workflow_task_attempt_admissions"
             AS workflow_task
           ON workflow_task.attempt_id = attempt.id
         LEFT JOIN "ql3"."step_runs" AS workflow_step
           ON workflow_step.run_id = workflow_task.run_id
          AND workflow_step.id = workflow_task.step_run_id
         LEFT JOIN "ql3"."run_dispatch_leases" AS lease
           ON lease.attempt_id = attempt.id
         WHERE run.execution_owner = 'runtime'
           AND run.cancel_requested_at_ms IS NULL
           AND attempt.status = 'claimed'
           AND attempt.executor_type = 'remote_worker'
           AND (
             (
               workflow_task.attempt_id IS NULL
               AND run.status IN ('queued', 'dispatching')
               AND run.queued_at_ms IS NOT NULL
             ) OR (
               workflow_task.attempt_id IS NOT NULL
               AND run.status = 'running'
               AND attempt.step_run_id = workflow_task.step_run_id
               AND workflow_step.status = 'ready'
               AND workflow_step.version = workflow_task.step_run_version
               AND workflow_step.step_run_digest =
                 workflow_task.step_run_digest
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM "ql3"."run_attempts" AS newer
             WHERE newer.run_id = run.id
               AND newer.attempt > attempt.attempt
               AND (
                 workflow_task.attempt_id IS NULL
                 OR newer.step_run_id = attempt.step_run_id
               )
           )
           AND (
             lease.attempt_id IS NULL OR lease.status = 'released'
             OR (lease.status = 'leased' AND lease.expires_at_ms <= observation.observed_at_ms)
           )
           AND (
             $1::integer IS NULL OR run.priority < $1
             OR (
               run.priority = $1 AND
               COALESCE(workflow_task.admitted_at_ms, run.queued_at_ms) > $2
             )
             OR (run.priority = $1
                 AND COALESCE(
                   workflow_task.admitted_at_ms, run.queued_at_ms
                 ) = $2
                 AND attempt.created_at_ms > $3)
             OR (run.priority = $1
                 AND COALESCE(
                   workflow_task.admitted_at_ms, run.queued_at_ms
                 ) = $2
                 AND attempt.created_at_ms = $3 AND attempt.id > $4)
           )
         ORDER BY run.priority DESC,
                  COALESCE(
                    workflow_task.admitted_at_ms, run.queued_at_ms
                  ),
                  attempt.created_at_ms, attempt.id
         LIMIT $5
       )
       SELECT observation.observed_at_ms AS "observedAtMs", candidates.*
       FROM observation LEFT JOIN candidates ON true
       ORDER BY candidates.priority DESC, candidates."queuedAtMs",
                candidates."attemptCreatedAtMs", candidates."attemptId"`,
      [
        after?.priority ?? null,
        after?.queuedAtMs ?? null,
        after?.attemptCreatedAtMs ?? null,
        after?.attemptId ?? null,
        options.limit + 1,
      ],
    );
    if (result.rows.length < 1) {
      throw new TypeError('PostgreSQL cluster dispatch observation is missing');
    }
    const observedAtMs = integer(result.rows[0]!, 'observedAtMs');
    const mapped = result.rows
      .filter((row) => row.attemptId !== null && row.attemptId !== undefined)
      .map(candidate);
    const truncated = mapped.length > options.limit;
    const candidates = Object.freeze(mapped.slice(0, options.limit));
    const last = candidates.at(-1);
    return Object.freeze({
      observedAtMs,
      candidates,
      truncated,
      ...(truncated && last ? { next: cursor(last) } : {}),
    });
  }

  async findClusterDispatchRecovery(offerId: string): Promise<ClusterDispatchRecovery | null> {
    assertRunDispatchId('offerId', offerId);
    const result = await this.pool.query<Row>(
      `WITH observation AS MATERIALIZED (
         SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
           AS observed_at_ms
       )
       SELECT observation.observed_at_ms AS "observedAtMs",
              ${CANDIDATE_COLUMNS}, ${LEASE_COLUMNS},
              (
                worker.worker_id = lease.worker_id
                AND worker.session_id = lease.worker_session_id
                AND worker.generation = lease.worker_generation
                AND worker.status IN ('online', 'draining')
                AND worker.lease_expires_at_ms > observation.observed_at_ms
              ) AS "workerCurrent"
       FROM observation
       JOIN "ql3"."run_dispatch_leases" AS lease ON lease.offer_id = $1
       JOIN "ql3"."runs" AS run ON run.id = lease.run_id
       JOIN "ql3"."run_attempts" AS attempt ON attempt.id = lease.attempt_id
       LEFT JOIN
         "ql3"."plugin_package_workflow_task_attempt_admissions"
           AS workflow_task
         ON workflow_task.attempt_id = attempt.id
       LEFT JOIN "ql3"."step_runs" AS workflow_step
         ON workflow_step.run_id = workflow_task.run_id
        AND workflow_step.id = workflow_task.step_run_id
       LEFT JOIN "ql3"."worker_sessions" AS worker
         ON worker.worker_id = lease.worker_id
       LIMIT 2`,
      [offerId],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || typeof result.rows[0]!.workerCurrent !== 'boolean') {
      throw new TypeError('PostgreSQL cluster dispatch recovery is invalid');
    }
    return Object.freeze({
      observedAtMs: integer(result.rows[0]!, 'observedAtMs'),
      candidate: candidate(result.rows[0]!),
      lease: lease(result.rows[0]!),
      workerCurrent: result.rows[0]!.workerCurrent as boolean,
    });
  }
}
