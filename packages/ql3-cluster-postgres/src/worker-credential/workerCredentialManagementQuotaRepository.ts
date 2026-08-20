// PostgreSQL Worker Credential management quota is owned by this domain.
import type { PostgresPool, SecuritySubject } from '@qinglong/runtime-core';
import {
  postgresRequiredBoolean,
  postgresRequiredInteger,
} from '../repository/definitionRepositorySupport';

const OPERATIONS = [
  'worker-credential.plan',
  'worker-credential.propose',
  'worker-credential.decide',
  'worker-credential.inspect',
  'worker-session.observe',
] as const;
type Operation = (typeof OPERATIONS)[number];
type Row = Record<string, unknown>;

export interface PostgresWorkerCredentialManagementQuotaOptions {
  readonly windowMs?: number;
  readonly limits?: Partial<Readonly<Record<Operation, number>>>;
}

export interface ConsumePostgresWorkerCredentialManagementQuotaCommand {
  readonly projectId: string;
  readonly subject: Readonly<SecuritySubject>;
  readonly operation: Operation;
  readonly idempotencyKey: string;
}

const DEFAULT_LIMITS: Readonly<Record<Operation, number>> = Object.freeze({
  'worker-credential.plan': 30,
  'worker-credential.propose': 30,
  'worker-credential.decide': 60,
  'worker-credential.inspect': 600,
  'worker-session.observe': 600,
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TypeError('PostgreSQL Worker credential quota bound is invalid');
  }
  return candidate;
}

export class PostgresWorkerCredentialManagementQuotaRepository {
  readonly #windowMs: number;
  readonly #limits: Readonly<Record<Operation, number>>;

  constructor(
    private readonly pool: PostgresPool,
    options: PostgresWorkerCredentialManagementQuotaOptions = {},
  ) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError('PostgreSQL Worker credential quota pool is invalid');
    }
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => key !== 'windowMs' && key !== 'limits') ||
      (options.limits !== undefined &&
        (!options.limits ||
          typeof options.limits !== 'object' ||
          Array.isArray(options.limits) ||
          Object.keys(options.limits).some(
            (key) => !OPERATIONS.includes(key as Operation),
          )))
    ) {
      throw new TypeError('PostgreSQL Worker credential quota options are invalid');
    }
    this.#windowMs = integer(options.windowMs, 60_000, 1_000, 5 * 60_000);
    this.#limits = Object.freeze(
      Object.fromEntries(
        OPERATIONS.map((operation) => [
          operation,
          integer(
            options.limits?.[operation],
            DEFAULT_LIMITS[operation],
            1,
            1_000,
          ),
        ]),
      ) as unknown as Record<Operation, number>,
    );
  }

  async consume(command: ConsumePostgresWorkerCredentialManagementQuotaCommand) {
    if (
      !command ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      Object.keys(command).length !== 4 ||
      Object.keys(command).some(
        (key) => !['projectId', 'subject', 'operation', 'idempotencyKey'].includes(key),
      ) ||
      typeof command.projectId !== 'string' ||
      !PROJECT.test(command.projectId) ||
      !command.subject ||
      command.subject.type !== 'user' ||
      typeof command.subject.id !== 'string' ||
      command.subject.id.length < 1 ||
      command.subject.id.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(command.subject.id) ||
      !OPERATIONS.includes(command.operation) ||
      typeof command.idempotencyKey !== 'string' ||
      !ID.test(command.idempotencyKey)
    ) {
      throw new TypeError('PostgreSQL Worker credential quota command is invalid');
    }
    const limit = this.#limits[command.operation];
    let result = await this.pool.query<Row>(
      `
WITH database_clock AS (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
)
INSERT INTO "ql3"."worker_credential_management_quota_buckets" (
  project_id, subject_type, subject_id, operation,
  window_started_at_ms, consumed_count, receipt_ids, updated_at_ms
)
SELECT $1, $2, $3, $4,
       (now_ms / $6::bigint) * $6::bigint,
       1, jsonb_build_array($5::text), now_ms
FROM database_clock
ON CONFLICT (project_id, subject_type, subject_id, operation)
DO UPDATE SET
  window_started_at_ms = CASE WHEN
    "worker_credential_management_quota_buckets".window_started_at_ms + $6::bigint
      <= EXCLUDED.updated_at_ms
    THEN (EXCLUDED.updated_at_ms / $6::bigint) * $6::bigint
    ELSE "worker_credential_management_quota_buckets".window_started_at_ms END,
  consumed_count = CASE WHEN
    "worker_credential_management_quota_buckets".window_started_at_ms + $6::bigint
      <= EXCLUDED.updated_at_ms THEN 1
    WHEN "worker_credential_management_quota_buckets".receipt_ids ? $5::text
      THEN "worker_credential_management_quota_buckets".consumed_count
    ELSE "worker_credential_management_quota_buckets".consumed_count + 1 END,
  receipt_ids = CASE WHEN
    "worker_credential_management_quota_buckets".window_started_at_ms + $6::bigint
      <= EXCLUDED.updated_at_ms THEN jsonb_build_array($5::text)
    WHEN "worker_credential_management_quota_buckets".receipt_ids ? $5::text
      THEN "worker_credential_management_quota_buckets".receipt_ids
    ELSE "worker_credential_management_quota_buckets".receipt_ids
      || jsonb_build_array($5::text) END,
  updated_at_ms = EXCLUDED.updated_at_ms
WHERE
  "worker_credential_management_quota_buckets".window_started_at_ms + $6::bigint
    <= EXCLUDED.updated_at_ms
  OR "worker_credential_management_quota_buckets".receipt_ids ? $5::text
  OR "worker_credential_management_quota_buckets".consumed_count < $7::integer
RETURNING true AS admitted,
  consumed_count AS "consumedCount",
  window_started_at_ms + $6::bigint AS "resetAtMs",
  updated_at_ms AS "observedAtMs"
      `.trim(),
      [
        command.projectId,
        command.subject.type,
        command.subject.id,
        command.operation,
        command.idempotencyKey,
        this.#windowMs,
        limit,
      ],
    );
    if (result.rows.length === 0) {
      result = await this.pool.query<Row>(
        `
WITH database_clock AS (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
)
SELECT false AS admitted,
  bucket.consumed_count AS "consumedCount",
  bucket.window_started_at_ms + $5::bigint AS "resetAtMs",
  database_clock.now_ms AS "observedAtMs"
FROM "ql3"."worker_credential_management_quota_buckets" AS bucket
CROSS JOIN database_clock
WHERE bucket.project_id = $1 AND bucket.subject_type = $2
  AND bucket.subject_id = $3 AND bucket.operation = $4
LIMIT 2
        `.trim(),
        [
          command.projectId,
          command.subject.type,
          command.subject.id,
          command.operation,
          this.#windowMs,
        ],
      );
    }
    if (result.rows.length !== 1) throw new Error('Worker credential quota is unavailable');
    const row = result.rows[0]!;
    const admitted = postgresRequiredBoolean(row.admitted, () => new Error());
    const consumed = postgresRequiredInteger(row.consumedCount, () => new Error());
    const resetAtMs = postgresRequiredInteger(row.resetAtMs, () => new Error());
    const observedAtMs = postgresRequiredInteger(row.observedAtMs, () => new Error());
    if (
      consumed < 1 ||
      consumed > limit ||
      resetAtMs <= observedAtMs ||
      resetAtMs > observedAtMs + this.#windowMs
    ) {
      throw new Error('Worker credential quota is unavailable');
    }
    return Object.freeze({
      admitted,
      retryAfterMs: admitted ? null : Math.max(1, resetAtMs - observedAtMs),
    });
  }
}
