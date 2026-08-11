import { randomUUID } from 'node:crypto';

import {
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS,
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
  MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
  type ClusterRunAttemptLogRetentionClaim,
  type ClusterRunAttemptLogRetentionClaimPage,
  type ClusterRunAttemptLogRetentionClaimRepository,
  type ClusterRunAttemptLogRetentionFailureCode,
  type ClusterRunAttemptLogRetentionSettlement,
} from '@qinglong/runtime-core/cluster-run-attempt-log-retention';
import {
  MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
  MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
  RunAttemptLogRetentionUnavailableError,
  normalizeRunAttemptLogRetentionCandidate,
  normalizeRunAttemptLogRetirementRecord,
  type RunAttemptLogRetentionState,
  type RunAttemptLogRetirementRecord,
} from '@qinglong/runtime-core/run-attempt-log-retention';
import type { RunAttemptLogReadIdentity } from '@qinglong/runtime-core/run-attempt-log-read';
import type {
  PostgresPool,
  PostgresQueryable,
} from '@qinglong/runtime-core';

type Row = Record<string, unknown>;

const CLAIM_SQL = `
WITH observation AS (
  SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
    AS observed_at_ms
), eligible AS (
  SELECT attempt.id,
         run.project_id,
         attempt.run_id,
         attempt.log_artifact_id,
         attempt.executor_type,
         attempt.finished_at_ms,
         observation.observed_at_ms
  FROM "ql3"."run_attempts" AS attempt
  JOIN "ql3"."runs" AS run ON run.id = attempt.run_id
  CROSS JOIN observation
  LEFT JOIN "ql3"."run_attempt_log_retention_controls" AS control
    ON control.attempt_id = attempt.id
  LEFT JOIN "ql3"."run_attempt_log_artifact_tombstones" AS tombstone
    ON tombstone.attempt_id = attempt.id
      OR tombstone.log_artifact_id = attempt.log_artifact_id
  WHERE run.execution_owner = 'runtime'
    AND run.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
    AND run.finished_at_ms IS NOT NULL
    AND attempt.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
    AND attempt.executor_type = 'remote_worker'
    AND attempt.finished_at_ms IS NOT NULL
    AND attempt.log_artifact_id ~ '^wlog-[a-f0-9]{30}$'
    AND attempt.finished_at_ms <= observation.observed_at_ms - $1::bigint
    AND run.finished_at_ms <= observation.observed_at_ms - $1::bigint
    AND tombstone.attempt_id IS NULL
    AND (
      control.attempt_id IS NULL
      OR (
        control.claim_version < 2147483647
        AND (
          (control.state = 'retry'
            AND control.next_claim_at_ms <= observation.observed_at_ms)
          OR (control.state = 'claimed'
            AND control.claim_expires_at_ms <= observation.observed_at_ms)
        )
      )
    )
  ORDER BY attempt.finished_at_ms, attempt.id
  FOR UPDATE OF attempt SKIP LOCKED
  LIMIT $2
)
INSERT INTO "ql3"."run_attempt_log_retention_controls" (
  attempt_id, project_id, run_id, log_artifact_id, executor_type,
  finished_at_ms, eligible_at_ms, state, claim_owner, claim_token,
  claim_version, claim_expires_at_ms, failure_count, last_failure_code,
  created_at_ms, updated_at_ms
)
SELECT id, project_id, run_id, log_artifact_id, executor_type,
       finished_at_ms, finished_at_ms + $1::bigint, 'claimed', $3, $4,
       1, observed_at_ms + $5::bigint, 0, NULL,
       observed_at_ms, observed_at_ms
FROM eligible
ON CONFLICT (attempt_id) DO UPDATE
SET state = 'claimed',
    claim_owner = EXCLUDED.claim_owner,
    claim_token = EXCLUDED.claim_token,
    claim_version = "ql3"."run_attempt_log_retention_controls".claim_version + 1,
    claim_expires_at_ms = EXCLUDED.claim_expires_at_ms,
    next_claim_at_ms = NULL,
    updated_at_ms = GREATEST(
      "ql3"."run_attempt_log_retention_controls".updated_at_ms,
      EXCLUDED.updated_at_ms
    )
WHERE "ql3"."run_attempt_log_retention_controls".project_id = EXCLUDED.project_id
  AND "ql3"."run_attempt_log_retention_controls".run_id = EXCLUDED.run_id
  AND "ql3"."run_attempt_log_retention_controls".log_artifact_id = EXCLUDED.log_artifact_id
  AND "ql3"."run_attempt_log_retention_controls".executor_type = EXCLUDED.executor_type
  AND "ql3"."run_attempt_log_retention_controls".finished_at_ms = EXCLUDED.finished_at_ms
  AND "ql3"."run_attempt_log_retention_controls".eligible_at_ms = EXCLUDED.eligible_at_ms
  AND "ql3"."run_attempt_log_retention_controls".claim_version < 2147483647
  AND (
    ("ql3"."run_attempt_log_retention_controls".state = 'retry'
      AND "ql3"."run_attempt_log_retention_controls".next_claim_at_ms <= EXCLUDED.updated_at_ms)
    OR ("ql3"."run_attempt_log_retention_controls".state = 'claimed'
      AND "ql3"."run_attempt_log_retention_controls".claim_expires_at_ms <= EXCLUDED.updated_at_ms)
  )
RETURNING project_id AS "projectId", run_id AS "runId",
  attempt_id AS "attemptId", log_artifact_id AS "logArtifactId",
  executor_type AS "executorType", finished_at_ms AS "finishedAtMs",
  eligible_at_ms AS "eligibleAtMs", updated_at_ms AS "observedAtMs",
  claim_owner AS "claimOwner", claim_token AS "claimToken",
  claim_version AS "claimVersion", claim_expires_at_ms AS "claimExpiresAtMs",
  failure_count AS "failureCount"
`.trim();

const LOCK_CLAIM_SQL = `
WITH observation AS (
  SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
    AS observed_at_ms
)
SELECT control.project_id AS "projectId", control.run_id AS "runId",
  control.attempt_id AS "attemptId", control.log_artifact_id AS "logArtifactId",
  control.executor_type AS "executorType", control.finished_at_ms AS "finishedAtMs",
  control.eligible_at_ms AS "eligibleAtMs",
  control.claim_owner AS "claimOwner", control.claim_token AS "claimToken",
  control.claim_version AS "claimVersion",
  control.claim_expires_at_ms AS "claimExpiresAtMs",
  control.failure_count AS "failureCount",
  observation.observed_at_ms AS "observedAtMs"
FROM "ql3"."run_attempt_log_retention_controls" AS control
JOIN "ql3"."run_attempts" AS attempt ON attempt.id = control.attempt_id
JOIN "ql3"."runs" AS run ON run.id = control.run_id
CROSS JOIN observation
WHERE control.attempt_id = $1
  AND control.state = 'claimed'
  AND control.claim_owner = $2
  AND control.claim_token = $3
  AND control.claim_version = $4
  AND control.claim_expires_at_ms = $5::bigint
  AND control.claim_expires_at_ms > observation.observed_at_ms
  AND attempt.run_id = control.run_id
  AND attempt.log_artifact_id = control.log_artifact_id
  AND attempt.executor_type = 'remote_worker'
  AND attempt.finished_at_ms = control.finished_at_ms
  AND attempt.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
  AND run.project_id = control.project_id
  AND run.execution_owner = 'runtime'
  AND run.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
FOR UPDATE OF control
`.trim();

const INSERT_TOMBSTONE_SQL = `
INSERT INTO "ql3"."run_attempt_log_artifact_tombstones" (
  log_artifact_id, project_id, run_id, attempt_id, executor_type,
  finished_at_ms, eligible_at_ms, retired_at_ms, disposition,
  byte_length, truncated, maximum_bytes, truncation_observed_at_ms,
  record_digest
) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint,
  $9, $10::bigint, $11, $12::bigint, $13::bigint, $14)
ON CONFLICT DO NOTHING
RETURNING record_digest AS "recordDigest"
`.trim();

const READ_TOMBSTONE_SQL = `
SELECT record_digest AS "recordDigest"
FROM "ql3"."run_attempt_log_artifact_tombstones"
WHERE attempt_id = $1 OR log_artifact_id = $2
`.trim();

const DELETE_CONTROL_SQL = `
DELETE FROM "ql3"."run_attempt_log_retention_controls"
WHERE attempt_id = $1 AND state = 'claimed'
  AND claim_owner = $2 AND claim_token = $3 AND claim_version = $4
  AND claim_expires_at_ms = $5::bigint
`.trim();

const SET_FAILURE_SQL = `
WITH observation AS (
  SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
    AS observed_at_ms
)
UPDATE "ql3"."run_attempt_log_retention_controls" AS control
SET state = $6,
    claim_owner = NULL,
    claim_token = NULL,
    claim_expires_at_ms = NULL,
    next_claim_at_ms = CASE WHEN $6 = 'retry'
      THEN observation.observed_at_ms + $7::bigint ELSE NULL END,
    failure_count = LEAST(control.failure_count + 1, 2147483647),
    last_failure_code = $8,
    updated_at_ms = GREATEST(control.updated_at_ms, observation.observed_at_ms)
FROM observation
WHERE control.attempt_id = $1
  AND control.state = 'claimed'
  AND control.claim_owner = $2
  AND control.claim_token = $3
  AND control.claim_version = $4
  AND control.claim_expires_at_ms = $5::bigint
  AND control.claim_expires_at_ms > observation.observed_at_ms
RETURNING control.attempt_id AS "attemptId"
`.trim();

const READ_TOMBSTONE_STATE_SQL = `
SELECT project_id AS "projectId", run_id AS "runId",
  attempt_id AS "attemptId", log_artifact_id AS "logArtifactId",
  executor_type AS "executorType", finished_at_ms AS "finishedAtMs",
  eligible_at_ms AS "eligibleAtMs", retired_at_ms AS "retiredAtMs",
  disposition, byte_length AS "byteLength", truncated,
  maximum_bytes AS "maximumBytes",
  truncation_observed_at_ms AS "truncationObservedAtMs",
  record_digest AS "recordDigest"
FROM "ql3"."run_attempt_log_artifact_tombstones"
WHERE log_artifact_id = $1
`.trim();

const FAILURE_CODES = new Set<ClusterRunAttemptLogRetentionFailureCode>([
  'artifact_unavailable',
  'artifact_integrity_mismatch',
  'retirement_record_unavailable',
]);

function integer(
  name: string,
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const converted =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (
    typeof converted !== 'number' ||
    !Number.isSafeInteger(converted) ||
    converted < minimum ||
    converted > maximum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return converted;
}

function identifier(name: string, value: unknown, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function optionalInteger(
  name: string,
  value: unknown,
  minimum: number,
): number | undefined {
  return value === null ? undefined : integer(name, value, minimum);
}

function readIdentity(
  value: Readonly<RunAttemptLogReadIdentity>,
): Readonly<RunAttemptLogReadIdentity> {
  const normalized = Object.freeze({
    projectId: identifier('Cluster log retention projectId', value?.projectId),
    runId: identifier('Cluster log retention runId', value?.runId),
    attemptId: identifier('Cluster log retention attemptId', value?.attemptId),
    logArtifactId: identifier(
      'Cluster log retention logArtifactId',
      value?.logArtifactId,
      36,
    ),
  });
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'attemptId,logArtifactId,projectId,runId' ||
    !/^wlog-[a-f0-9]{30}$/.test(normalized.logArtifactId)
  ) {
    throw new TypeError('Cluster Run Attempt log retention identity is invalid');
  }
  return normalized;
}

function tombstoneFromRow(
  row: Row,
): Readonly<RunAttemptLogRetirementRecord> {
  const truncated = row.truncated;
  if (
    truncated !== 'true' &&
    truncated !== 'false' &&
    truncated !== 'unknown'
  ) {
    throw new TypeError('PostgreSQL retention tombstone is invalid');
  }
  return normalizeRunAttemptLogRetirementRecord({
    schema: 'qinglong/run-attempt-log-retirement@v1',
    projectId: identifier('PostgreSQL tombstone projectId', row.projectId),
    runId: identifier('PostgreSQL tombstone runId', row.runId),
    attemptId: identifier('PostgreSQL tombstone attemptId', row.attemptId),
    logArtifactId: identifier(
      'PostgreSQL tombstone logArtifactId',
      row.logArtifactId,
      36,
    ),
    executorType: row.executorType as 'remote_worker',
    finishedAtMs: integer(
      'PostgreSQL tombstone finishedAtMs',
      row.finishedAtMs,
      0,
    ),
    eligibleAtMs: integer(
      'PostgreSQL tombstone eligibleAtMs',
      row.eligibleAtMs,
      0,
    ),
    retiredAtMs: integer(
      'PostgreSQL tombstone retiredAtMs',
      row.retiredAtMs,
      0,
    ),
    disposition: row.disposition as 'deleted' | 'already_absent',
    byteLength: integer(
      'PostgreSQL tombstone byteLength',
      row.byteLength,
      0,
    ),
    truncation:
      truncated === 'unknown'
        ? Object.freeze({ truncated: 'unknown' as const })
        : Object.freeze({
            truncated: truncated === 'true',
            maximumBytes: optionalInteger(
              'PostgreSQL tombstone maximumBytes',
              row.maximumBytes,
              1,
            )!,
            observedAtMs: optionalInteger(
              'PostgreSQL tombstone truncationObservedAtMs',
              row.truncationObservedAtMs,
              0,
            )!,
          }),
    recordDigest: identifier(
      'PostgreSQL tombstone recordDigest',
      row.recordDigest,
      64,
    ),
  });
}

function failureCode(
  value: unknown,
): ClusterRunAttemptLogRetentionFailureCode {
  if (!FAILURE_CODES.has(value as ClusterRunAttemptLogRetentionFailureCode)) {
    throw new TypeError('Cluster Run Attempt log retention failure code is invalid');
  }
  return value as ClusterRunAttemptLogRetentionFailureCode;
}

function claimFromRow(row: Row): Readonly<ClusterRunAttemptLogRetentionClaim> {
  const candidate = normalizeRunAttemptLogRetentionCandidate({
    projectId: identifier('PostgreSQL retention projectId', row.projectId),
    runId: identifier('PostgreSQL retention runId', row.runId),
    attemptId: identifier('PostgreSQL retention attemptId', row.attemptId),
    logArtifactId: identifier(
      'PostgreSQL retention logArtifactId',
      row.logArtifactId,
    ),
    executorType: row.executorType as 'remote_worker',
    finishedAtMs: integer(
      'PostgreSQL retention finishedAtMs',
      row.finishedAtMs,
      0,
    ),
  });
  if (
    candidate.executorType !== 'remote_worker' ||
    !/^wlog-[a-f0-9]{30}$/.test(candidate.logArtifactId)
  ) {
    throw new TypeError('PostgreSQL retention candidate is invalid');
  }
  const observedAtMs = integer(
    'PostgreSQL retention observedAtMs',
    row.observedAtMs,
    0,
  );
  const eligibleAtMs = integer(
    'PostgreSQL retention eligibleAtMs',
    row.eligibleAtMs,
    candidate.finishedAtMs,
  );
  return Object.freeze({
    candidate,
    eligibleAtMs,
    observedAtMs,
    ownerId: identifier('PostgreSQL retention claimOwner', row.claimOwner),
    token: identifier('PostgreSQL retention claimToken', row.claimToken, 64),
    version: integer(
      'PostgreSQL retention claimVersion',
      row.claimVersion,
      1,
      2147483647,
    ),
    expiresAtMs: integer(
      'PostgreSQL retention claimExpiresAtMs',
      row.claimExpiresAtMs,
      observedAtMs + 1,
    ),
    failureCount: integer(
      'PostgreSQL retention failureCount',
      row.failureCount,
      0,
      2147483647,
    ),
  });
}

function assertClaim(
  value: Readonly<ClusterRunAttemptLogRetentionClaim>,
): Readonly<ClusterRunAttemptLogRetentionClaim> {
  const normalized = claimFromRow({
    projectId: value?.candidate?.projectId,
    runId: value?.candidate?.runId,
    attemptId: value?.candidate?.attemptId,
    logArtifactId: value?.candidate?.logArtifactId,
    executorType: value?.candidate?.executorType,
    finishedAtMs: value?.candidate?.finishedAtMs,
    eligibleAtMs: value?.eligibleAtMs,
    observedAtMs: value?.observedAtMs,
    claimOwner: value?.ownerId,
    claimToken: value?.token,
    claimVersion: value?.version,
    claimExpiresAtMs: value?.expiresAtMs,
    failureCount: value?.failureCount,
  });
  if (normalized.expiresAtMs !== value.expiresAtMs) {
    throw new TypeError('Cluster Run Attempt log retention claim is invalid');
  }
  return normalized;
}

function sameClaim(
  actual: Readonly<ClusterRunAttemptLogRetentionClaim>,
  expected: Readonly<ClusterRunAttemptLogRetentionClaim>,
): boolean {
  return (
    actual.candidate.projectId === expected.candidate.projectId &&
    actual.candidate.runId === expected.candidate.runId &&
    actual.candidate.attemptId === expected.candidate.attemptId &&
    actual.candidate.logArtifactId === expected.candidate.logArtifactId &&
    actual.candidate.executorType === expected.candidate.executorType &&
    actual.candidate.finishedAtMs === expected.candidate.finishedAtMs &&
    actual.eligibleAtMs === expected.eligibleAtMs &&
    actual.ownerId === expected.ownerId &&
    actual.token === expected.token &&
    actual.version === expected.version &&
    actual.expiresAtMs === expected.expiresAtMs
  );
}

function sameRecordClaim(
  record: Readonly<RunAttemptLogRetirementRecord>,
  claim: Readonly<ClusterRunAttemptLogRetentionClaim>,
): boolean {
  const candidate = claim.candidate;
  return (
    record.projectId === candidate.projectId &&
    record.runId === candidate.runId &&
    record.attemptId === candidate.attemptId &&
    record.logArtifactId === candidate.logArtifactId &&
    record.executorType === candidate.executorType &&
    record.finishedAtMs === candidate.finishedAtMs &&
    record.eligibleAtMs === claim.eligibleAtMs
  );
}

function unavailable(error: unknown): RunAttemptLogRetentionUnavailableError {
  return error instanceof RunAttemptLogRetentionUnavailableError
    ? error
    : new RunAttemptLogRetentionUnavailableError({ cause: error });
}

async function rollback(queryable: PostgresQueryable): Promise<void> {
  try {
    await queryable.query('ROLLBACK');
  } catch {
    // Preserve the originating authority failure.
  }
}

export class PostgresRunAttemptLogRetentionClaimRepository
  implements ClusterRunAttemptLogRetentionClaimRepository
{
  constructor(
    private readonly pool: PostgresPool,
    private readonly createToken: () => string = randomUUID,
  ) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function' ||
      typeof createToken !== 'function'
    ) {
      throw new TypeError(
        'PostgreSQL Run Attempt log retention repository is invalid',
      );
    }
  }

  async inspect(
    rawIdentity: Readonly<RunAttemptLogReadIdentity>,
  ): Promise<RunAttemptLogRetentionState> {
    const expected = readIdentity(rawIdentity);
    try {
      const result = await this.pool.query<Row>(READ_TOMBSTONE_STATE_SQL, [
        expected.logArtifactId,
      ]);
      if (result.rows.length === 0) {
        return Object.freeze({ status: 'active' as const });
      }
      if (result.rows.length !== 1) {
        throw new TypeError('PostgreSQL retention tombstone is not unique');
      }
      const record = tombstoneFromRow(result.rows[0]!);
      if (
        record.projectId !== expected.projectId ||
        record.runId !== expected.runId ||
        record.attemptId !== expected.attemptId ||
        record.logArtifactId !== expected.logArtifactId
      ) {
        throw new TypeError('PostgreSQL retention tombstone identity changed');
      }
      return Object.freeze({ status: 'retired' as const, record });
    } catch (error) {
      throw unavailable(error);
    }
  }

  async claim(options: Readonly<{
    ownerId: string;
    retentionMs: number;
    limit: number;
    leaseMs: number;
  }>): Promise<Readonly<ClusterRunAttemptLogRetentionClaimPage>> {
    const ownerId = identifier(
      'Cluster Run Attempt log retention ownerId',
      options?.ownerId,
    );
    const retentionMs = integer(
      'Cluster Run Attempt log retention duration',
      options?.retentionMs,
      MIN_RUN_ATTEMPT_LOG_RETENTION_MS,
      MAX_RUN_ATTEMPT_LOG_RETENTION_MS,
    );
    const limit = integer(
      'Cluster Run Attempt log retention claim limit',
      options?.limit,
      1,
      MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_CLAIMS,
    );
    const leaseMs = integer(
      'Cluster Run Attempt log retention lease',
      options?.leaseMs,
      MIN_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
      MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_LEASE_MS,
    );
    const token = identifier(
      'Cluster Run Attempt log retention generated token',
      this.createToken(),
      64,
    );
    if (token.length < 16) {
      throw new TypeError(
        'Cluster Run Attempt log retention generated token is invalid',
      );
    }
    const client = await this.pool.connect().catch((error: unknown) => {
      throw unavailable(error);
    });
    let transactionOpen = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      transactionOpen = true;
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const result = await client.query<Row>(CLAIM_SQL, [
        retentionMs,
        limit,
        ownerId,
        token,
        leaseMs,
      ]);
      const claims = result.rows.map(claimFromRow);
      if (claims.length > limit) {
        throw new TypeError('PostgreSQL retention claim bound was violated');
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return Object.freeze({
        claims: Object.freeze(claims),
        hasMore: claims.length === limit,
      });
    } catch (error) {
      if (transactionOpen) await rollback(client);
      throw unavailable(error);
    } finally {
      client.release();
    }
  }

  async settle(
    rawClaim: Readonly<ClusterRunAttemptLogRetentionClaim>,
    settlement: Readonly<ClusterRunAttemptLogRetentionSettlement>,
  ): Promise<'settled' | 'fenced'> {
    const claim = assertClaim(rawClaim);
    if (!settlement || typeof settlement !== 'object') {
      throw new TypeError(
        'Cluster Run Attempt log retention settlement is invalid',
      );
    }
    if (settlement.status === 'retired') {
      return this.recordRetirement(claim, settlement.record);
    }
    if (settlement.status !== 'retry' && settlement.status !== 'manual') {
      throw new TypeError(
        'Cluster Run Attempt log retention settlement is invalid',
      );
    }
    const delayMs =
      settlement.status === 'retry'
        ? integer(
            'Cluster Run Attempt log retention retry delay',
            settlement.delayMs,
            0,
            MAX_CLUSTER_RUN_ATTEMPT_LOG_RETENTION_RETRY_DELAY_MS,
          )
        : 0;
    const code = failureCode(settlement.failureCode);
    try {
      const result = await this.pool.query<Row>(SET_FAILURE_SQL, [
        claim.candidate.attemptId,
        claim.ownerId,
        claim.token,
        claim.version,
        claim.expiresAtMs,
        settlement.status,
        delayMs,
        code,
      ]);
      return result.rows.length === 1 ? 'settled' : 'fenced';
    } catch (error) {
      throw unavailable(error);
    }
  }

  private async recordRetirement(
    claim: Readonly<ClusterRunAttemptLogRetentionClaim>,
    rawRecord: Readonly<RunAttemptLogRetirementRecord>,
  ): Promise<'settled' | 'fenced'> {
    const record = normalizeRunAttemptLogRetirementRecord(rawRecord);
    if (!sameRecordClaim(record, claim)) {
      throw new TypeError(
        'Cluster Run Attempt log retirement record does not match its claim',
      );
    }
    const client = await this.pool.connect().catch((error: unknown) => {
      throw unavailable(error);
    });
    let transactionOpen = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      transactionOpen = true;
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const locked = await client.query<Row>(LOCK_CLAIM_SQL, [
        claim.candidate.attemptId,
        claim.ownerId,
        claim.token,
        claim.version,
        claim.expiresAtMs,
      ]);
      if (locked.rows.length !== 1) {
        await client.query('COMMIT');
        transactionOpen = false;
        return 'fenced';
      }
      if (!sameClaim(claimFromRow(locked.rows[0]!), claim)) {
        throw new TypeError('PostgreSQL retention claim authority changed');
      }
      const truncation = record.truncation;
      const inserted = await client.query<Row>(INSERT_TOMBSTONE_SQL, [
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
        String(truncation.truncated),
        truncation.maximumBytes ?? null,
        truncation.observedAtMs ?? null,
        record.recordDigest,
      ]);
      if (inserted.rows.length === 0) {
        const existing = await client.query<Row>(READ_TOMBSTONE_SQL, [
          record.attemptId,
          record.logArtifactId,
        ]);
        if (
          existing.rows.length !== 1 ||
          existing.rows[0]?.recordDigest !== record.recordDigest
        ) {
          throw new TypeError('PostgreSQL retention tombstone conflicts');
        }
      }
      const removed = await client.query<Row>(DELETE_CONTROL_SQL, [
        claim.candidate.attemptId,
        claim.ownerId,
        claim.token,
        claim.version,
        claim.expiresAtMs,
      ]);
      if (removed.rowCount !== 1) {
        throw new TypeError('PostgreSQL retention claim fence was lost');
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return 'settled';
    } catch (error) {
      if (transactionOpen) await rollback(client);
      throw unavailable(error);
    } finally {
      client.release();
    }
  }
}
