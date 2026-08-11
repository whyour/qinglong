// PostgreSQL authority adapter for cluster run recovery claim ownership.
import { randomUUID } from 'node:crypto';
import {
  ClusterControlRecoveryStoreError,
  MAX_CLUSTER_CONTROL_RECOVERY_CLAIM_LEASE_MS,
  MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS,
  MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS,
  type ClusterControlRecoveryCandidate,
  type ClusterControlRecoveryClaim,
  type ClusterControlRecoveryClaimPage,
  type ClusterControlRecoveryClaimRepository,
  type ClusterControlRecoveryDisposition,
  type ClusterControlRecoverySource,
  type PostgresPool,
  type PostgresQueryable,
} from '@qinglong/runtime-core';
import { PostgresClusterControlRecoverySource } from './clusterRecoverySource';

type ClaimRow = Record<string, unknown> & {
  targetKind: unknown;
  targetId: unknown;
  runId: unknown;
  targetStatus: unknown;
  targetCreatedAtMs: unknown;
  observedAtMs: unknown;
  claimOwner: unknown;
  claimToken: unknown;
  claimVersion: unknown;
  claimExpiresAtMs: unknown;
};

const UPSERT_DISCOVERED_SQL = `
INSERT INTO "ql3"."run_recovery_controls" (
  target_kind, target_id, run_id, attempt_id, target_status,
  target_created_at_ms, observed_at_ms, state, claim_version,
  failure_count, created_at_ms, updated_at_ms
)
SELECT
  discovered.kind,
  discovered.id,
  discovered."runId",
  CASE WHEN discovered.kind = 'attempt' THEN discovered.id ELSE NULL END,
  discovered.status,
  discovered."createdAtMs",
  $2::bigint,
  'available',
  0,
  0,
  $2::bigint,
  $2::bigint
FROM jsonb_to_recordset($1::jsonb) AS discovered(
  kind varchar(16),
  id varchar(36),
  "runId" varchar(36),
  status varchar(32),
  "createdAtMs" bigint
)
ON CONFLICT (target_kind, target_id) DO UPDATE
SET run_id = EXCLUDED.run_id,
    attempt_id = EXCLUDED.attempt_id,
    target_status = EXCLUDED.target_status,
    target_created_at_ms = EXCLUDED.target_created_at_ms,
    observed_at_ms = EXCLUDED.observed_at_ms,
    updated_at_ms = GREATEST(
      "ql3"."run_recovery_controls".updated_at_ms,
      EXCLUDED.updated_at_ms
    )
`.trim();

const CLAIM_DISCOVERED_SQL = `
WITH discovered AS (
  SELECT kind, id
  FROM jsonb_to_recordset($1::jsonb) AS payload(
    kind varchar(16),
    id varchar(36)
  )
), eligible AS (
  SELECT control.target_kind, control.target_id
  FROM "ql3"."run_recovery_controls" AS control
  INNER JOIN discovered
    ON discovered.kind = control.target_kind
   AND discovered.id = control.target_id
  WHERE control.claim_version < 2147483647
    AND (
      control.state IN ('available', 'resolved')
      OR (control.state = 'retry' AND control.next_claim_at_ms <= $2::bigint)
      OR (
        control.state = 'claimed'
        AND control.claim_expires_at_ms <= $2::bigint
      )
    )
  ORDER BY control.target_created_at_ms, control.target_kind, control.target_id
  FOR UPDATE OF control SKIP LOCKED
  LIMIT $3
)
UPDATE "ql3"."run_recovery_controls" AS control
SET state = 'claimed',
    claim_owner = $4,
    claim_token = $5,
    claim_version = control.claim_version + 1,
    claim_expires_at_ms = $2::bigint + $6::bigint,
    next_claim_at_ms = NULL,
    updated_at_ms = GREATEST(control.updated_at_ms, $2::bigint)
FROM eligible
WHERE control.target_kind = eligible.target_kind
  AND control.target_id = eligible.target_id
RETURNING
  control.target_kind AS "targetKind",
  control.target_id AS "targetId",
  control.run_id AS "runId",
  control.target_status AS "targetStatus",
  control.target_created_at_ms AS "targetCreatedAtMs",
  control.observed_at_ms AS "observedAtMs",
  control.claim_owner AS "claimOwner",
  control.claim_token AS "claimToken",
  control.claim_version AS "claimVersion",
  control.claim_expires_at_ms AS "claimExpiresAtMs"
`.trim();

const SETTLE_SQL = `
WITH observation AS (
  SELECT floor(
    extract(epoch FROM statement_timestamp()) * 1000
  )::bigint AS observed_at_ms
)
UPDATE "ql3"."run_recovery_controls" AS control
SET state = $6::varchar(16),
    claim_owner = NULL,
    claim_token = NULL,
    claim_expires_at_ms = NULL,
    next_claim_at_ms = CASE
      WHEN $6::varchar(16) = 'retry' THEN observation.observed_at_ms + $7::bigint
      ELSE NULL
    END,
    failure_count = CASE
      WHEN $6::varchar(16) IN ('retry', 'manual')
        THEN LEAST(control.failure_count + 1, 2147483647)
      ELSE control.failure_count
    END,
    updated_at_ms = GREATEST(
      control.updated_at_ms,
      observation.observed_at_ms
    )
FROM observation
WHERE control.target_kind = $1
  AND control.target_id = $2
  AND control.state = 'claimed'
  AND control.claim_owner = $3
  AND control.claim_token = $4
  AND control.claim_version = $5
  AND control.claim_expires_at_ms > observation.observed_at_ms
RETURNING control.target_id AS "targetId"
`.trim();

function integerInRange(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeIdentifier(name: string, value: string, maximum: number): string {
  const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maximum - 1}}$`);
  if (!pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeInteger(name: string, value: unknown, minimum = 0): number {
  const converted =
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof converted !== 'number' ||
    !Number.isSafeInteger(converted) ||
    converted < minimum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return converted;
}

function nonemptyString(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function candidateFromRow(row: ClaimRow): ClusterControlRecoveryCandidate {
  const kind = row.targetKind;
  const id = nonemptyString('PostgreSQL recovery targetId', row.targetId);
  const runId = nonemptyString('PostgreSQL recovery runId', row.runId);
  const status = nonemptyString(
    'PostgreSQL recovery targetStatus',
    row.targetStatus,
  );
  const createdAtMs = safeInteger(
    'PostgreSQL recovery targetCreatedAtMs',
    row.targetCreatedAtMs,
  );
  if (
    kind === 'run' &&
    ['created', 'dispatching', 'running'].includes(status)
  ) {
    return Object.freeze({
      kind,
      id,
      runId,
      status: status as 'created' | 'dispatching' | 'running',
      createdAtMs,
    });
  }
  if (
    kind === 'attempt' &&
    ['claimed', 'starting', 'running'].includes(status)
  ) {
    return Object.freeze({
      kind,
      id,
      runId,
      status: status as 'claimed' | 'starting' | 'running',
      createdAtMs,
    });
  }
  throw new TypeError('PostgreSQL recovery claim target is invalid');
}

function claimFromRow(row: ClaimRow): ClusterControlRecoveryClaim {
  const observedAtMs = safeInteger(
    'PostgreSQL recovery observedAtMs',
    row.observedAtMs,
  );
  const expiresAtMs = safeInteger(
    'PostgreSQL recovery claimExpiresAtMs',
    row.claimExpiresAtMs,
    observedAtMs + 1,
  );
  return Object.freeze({
    candidate: candidateFromRow(row),
    observedAtMs,
    ownerId: safeIdentifier(
      'PostgreSQL recovery claimOwner',
      nonemptyString('PostgreSQL recovery claimOwner', row.claimOwner),
      128,
    ),
    token: safeIdentifier(
      'PostgreSQL recovery claimToken',
      nonemptyString('PostgreSQL recovery claimToken', row.claimToken),
      64,
    ),
    version: safeInteger(
      'PostgreSQL recovery claimVersion',
      row.claimVersion,
      1,
    ),
    expiresAtMs,
  });
}

function settlement(
  disposition: ClusterControlRecoveryDisposition,
): readonly ['resolved' | 'retry' | 'manual', number] {
  if (disposition.status === 'resolved' || disposition.status === 'manual') {
    return [disposition.status, 0] as const;
  }
  if (disposition.status === 'retry') {
    return [
      'retry',
      integerInRange(
        'Cluster-control recovery retry delay',
        disposition.delayMs,
        0,
        MAX_CLUSTER_CONTROL_RECOVERY_RETRY_DELAY_MS,
      ),
    ] as const;
  }
  throw new TypeError('Cluster-control recovery disposition is invalid');
}

function assertSettlementClaim(claim: ClusterControlRecoveryClaim): void {
  safeIdentifier('Cluster-control recovery ownerId', claim.ownerId, 128);
  safeIdentifier('Cluster-control recovery token', claim.token, 64);
  integerInRange(
    'Cluster-control recovery claim version',
    claim.version,
    1,
    2147483647,
  );
  if (
    !claim.candidate ||
    !['run', 'attempt'].includes(claim.candidate.kind) ||
    typeof claim.candidate.id !== 'string' ||
    claim.candidate.id.length === 0
  ) {
    throw new TypeError('Cluster-control recovery claim target is invalid');
  }
}

export class PostgresClusterControlRecoveryClaimRepository
  implements ClusterControlRecoveryClaimRepository
{
  constructor(
    private readonly pool: PostgresPool,
    private readonly createToken: () => string = randomUUID,
    private readonly createSource: (
      queryable: PostgresQueryable,
    ) => ClusterControlRecoverySource = (queryable) =>
      new PostgresClusterControlRecoverySource(queryable),
  ) {
    if (
      !pool ||
      typeof pool.connect !== 'function' ||
      typeof createToken !== 'function' ||
      typeof createSource !== 'function'
    ) {
      throw new TypeError('PostgreSQL recovery claim repository is invalid');
    }
  }

  async claim(
    options: Readonly<{
      ownerId: string;
      limit: number;
      leaseMs: number;
    }>,
  ): Promise<ClusterControlRecoveryClaimPage> {
    const ownerId = safeIdentifier(
      'Cluster-control recovery ownerId',
      options.ownerId,
      128,
    );
    const limit = integerInRange(
      'Cluster-control recovery claim limit',
      options.limit,
      1,
      MAX_CLUSTER_CONTROL_RECOVERY_CLAIMS_PER_PASS,
    );
    const leaseMs = integerInRange(
      'Cluster-control recovery claim lease',
      options.leaseMs,
      1_000,
      MAX_CLUSTER_CONTROL_RECOVERY_CLAIM_LEASE_MS,
    );
    const token = safeIdentifier(
      'Cluster-control recovery generated token',
      this.createToken(),
      64,
    );
    if (token.length < 16) {
      throw new TypeError(
        'Cluster-control recovery generated token must be at least 16 characters',
      );
    }

    const client = await this.pool.connect().catch((error: unknown) => {
      throw new ClusterControlRecoveryStoreError(error);
    });
    let transactionOpen = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      transactionOpen = true;
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL lock_timeout = '1000ms'");
      const source = this.createSource(client);
      if (!source || typeof source.listOutstanding !== 'function') {
        throw new TypeError('PostgreSQL recovery source factory is invalid');
      }
      const page = await source.listOutstanding(limit);
      const payload = JSON.stringify(page.candidates);
      if (page.candidates.length > 0) {
        await client.query(UPSERT_DISCOVERED_SQL, [payload, page.observedAtMs]);
      }
      const result =
        page.candidates.length === 0
          ? { rows: [] as readonly ClaimRow[] }
          : await client.query<ClaimRow>(CLAIM_DISCOVERED_SQL, [
              payload,
              page.observedAtMs,
              limit,
              ownerId,
              token,
              leaseMs,
            ]);
      const claims = result.rows.map(claimFromRow);
      if (claims.length > page.candidates.length || claims.length > limit) {
        throw new TypeError(
          'PostgreSQL recovery claim query violated its bounded result contract',
        );
      }
      await client.query('COMMIT');
      transactionOpen = false;
      return Object.freeze({
        claims: Object.freeze(claims),
        discovered: page.candidates.length,
        hasMore: page.hasMore,
      });
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the originating failure; the connection is released below.
        }
      }
      if (error instanceof ClusterControlRecoveryStoreError) throw error;
      throw new ClusterControlRecoveryStoreError(error);
    } finally {
      client.release();
    }
  }

  async settle(
    claim: ClusterControlRecoveryClaim,
    disposition: ClusterControlRecoveryDisposition,
  ): Promise<'settled' | 'fenced'> {
    assertSettlementClaim(claim);
    const [state, delayMs] = settlement(disposition);
    try {
      const result = await this.pool.query(SETTLE_SQL, [
        claim.candidate.kind,
        claim.candidate.id,
        claim.ownerId,
        claim.token,
        claim.version,
        state,
        delayMs,
      ]);
      const rowCount = result.rowCount ?? result.rows.length;
      if (rowCount === 0) return 'fenced';
      if (rowCount === 1) return 'settled';
      throw new TypeError(
        'PostgreSQL recovery settlement updated more than one target',
      );
    } catch (error) {
      if (error instanceof ClusterControlRecoveryStoreError) throw error;
      throw new ClusterControlRecoveryStoreError(error);
    }
  }
}
