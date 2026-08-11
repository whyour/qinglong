// PostgreSQL distributed quota authority for authenticated management operations.
import type { PostgresPool } from '@qinglong/runtime-core';
import {
  PLUGIN_PACKAGE_MANAGEMENT_QUOTA_OPERATIONS,
  PluginPackageManagementQuotaExceededError,
  PluginPackageManagementUnavailableError,
  type ConsumePluginPackageManagementQuotaCommand,
  type PluginPackageManagementQuotaOperation,
  type PluginPackageManagementQuotaPort,
  type PluginPackageManagementQuotaResult,
} from '@qinglong/runtime-core/plugin-package-management';

import {
  postgresRequiredBoolean,
  postgresRequiredInteger,
} from '../repository/definitionRepositorySupport';

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMITS = Object.freeze({
  'plugin-package.propose': 30,
  'plugin-package.decide': 60,
  'plugin-package.inspect': 600,
});
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;

type Row = Record<string, unknown>;

export interface PostgresPluginPackageManagementQuotaOptions {
  readonly windowMs?: number;
  readonly limits?: Partial<
    Readonly<Record<PluginPackageManagementQuotaOperation, number>>
  >;
}

function unavailable(cause?: unknown): PluginPackageManagementUnavailableError {
  return new PluginPackageManagementUnavailableError({
    cause: cause instanceof Error ? cause : undefined,
  });
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new TypeError(`PostgreSQL Package management ${label} is invalid`);
  }
  return candidate;
}

function reviewedOptions(
  value: PostgresPluginPackageManagementQuotaOptions | undefined,
): Readonly<{
  windowMs: number;
  limits: Readonly<Record<PluginPackageManagementQuotaOperation, number>>;
}> {
  if (
    value !== undefined &&
    (!value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'windowMs' && key !== 'limits'))
  ) {
    throw new TypeError(
      'PostgreSQL Package management quota options are invalid',
    );
  }
  const limits = value?.limits;
  if (
    limits !== undefined &&
    (!limits ||
      typeof limits !== 'object' ||
      Array.isArray(limits) ||
      Object.keys(limits).some(
        (key) =>
          !PLUGIN_PACKAGE_MANAGEMENT_QUOTA_OPERATIONS.includes(
            key as PluginPackageManagementQuotaOperation,
          ),
      ))
  ) {
    throw new TypeError(
      'PostgreSQL Package management quota limits are invalid',
    );
  }
  return Object.freeze({
    windowMs: integer(
      value?.windowMs,
      DEFAULT_WINDOW_MS,
      1_000,
      5 * 60_000,
      'quota window',
    ),
    limits: Object.freeze({
      'plugin-package.propose': integer(
        limits?.['plugin-package.propose'],
        DEFAULT_LIMITS['plugin-package.propose'],
        1,
        1_000,
        'proposal quota',
      ),
      'plugin-package.decide': integer(
        limits?.['plugin-package.decide'],
        DEFAULT_LIMITS['plugin-package.decide'],
        1,
        1_000,
        'decision quota',
      ),
      'plugin-package.inspect': integer(
        limits?.['plugin-package.inspect'],
        DEFAULT_LIMITS['plugin-package.inspect'],
        1,
        1_000,
        'inspection quota',
      ),
    }),
  });
}

function validateCommand(
  command: ConsumePluginPackageManagementQuotaCommand,
): Readonly<ConsumePluginPackageManagementQuotaCommand> {
  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    Object.keys(command).some(
      (key) =>
        !['projectId', 'subject', 'operation', 'idempotencyKey'].includes(key),
    ) ||
    Object.keys(command).length !== 4 ||
    typeof command.projectId !== 'string' ||
    !PROJECT_PATTERN.test(command.projectId) ||
    !command.subject ||
    typeof command.subject !== 'object' ||
    Array.isArray(command.subject) ||
    Object.keys(command.subject).length !== 2 ||
    command.subject.type !== 'user' ||
    typeof command.subject.id !== 'string' ||
    command.subject.id.length < 1 ||
    command.subject.id.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(command.subject.id) ||
    !PLUGIN_PACKAGE_MANAGEMENT_QUOTA_OPERATIONS.includes(command.operation) ||
    typeof command.idempotencyKey !== 'string' ||
    !IDENTIFIER_PATTERN.test(command.idempotencyKey)
  ) {
    throw new TypeError(
      'PostgreSQL Package management quota command is invalid',
    );
  }
  return command;
}

export class PostgresPluginPackageManagementQuotaRepository
  implements PluginPackageManagementQuotaPort
{
  readonly #windowMs: number;
  readonly #limits: Readonly<
    Record<PluginPackageManagementQuotaOperation, number>
  >;

  constructor(
    private readonly pool: PostgresPool,
    options?: PostgresPluginPackageManagementQuotaOptions,
  ) {
    if (!pool || typeof pool.query !== 'function') {
      throw new TypeError(
        'PostgreSQL Package management quota pool is invalid',
      );
    }
    const reviewed = reviewedOptions(options);
    this.#windowMs = reviewed.windowMs;
    this.#limits = reviewed.limits;
  }

  async consume(
    commandValue: ConsumePluginPackageManagementQuotaCommand,
  ): Promise<Readonly<PluginPackageManagementQuotaResult>> {
    const command = validateCommand(commandValue);
    const limit = this.#limits[command.operation];
    let result;
    try {
      result = await this.pool.query<Row>(
        `
WITH database_clock AS (
  SELECT floor(
    extract(epoch FROM clock_timestamp()) * 1000
  )::bigint AS now_ms
)
INSERT INTO "ql3"."plugin_package_management_quota_buckets" (
    project_id, subject_type, subject_id, operation,
    window_started_at_ms, consumed_count, receipt_ids, updated_at_ms
)
SELECT
  $1, $2, $3, $4,
  (now_ms / $6::bigint) * $6::bigint,
  1,
  jsonb_build_array($5::text),
  now_ms
FROM database_clock
ON CONFLICT (project_id, subject_type, subject_id, operation)
DO UPDATE SET
    window_started_at_ms = CASE
      WHEN "plugin_package_management_quota_buckets".window_started_at_ms
           + $6::bigint <= EXCLUDED.updated_at_ms
      THEN (EXCLUDED.updated_at_ms / $6::bigint) * $6::bigint
      ELSE "plugin_package_management_quota_buckets".window_started_at_ms
    END,
    consumed_count = CASE
      WHEN "plugin_package_management_quota_buckets".window_started_at_ms
           + $6::bigint <= EXCLUDED.updated_at_ms
      THEN 1
      WHEN "plugin_package_management_quota_buckets".receipt_ids ? $5::text
      THEN "plugin_package_management_quota_buckets".consumed_count
      ELSE "plugin_package_management_quota_buckets".consumed_count + 1
    END,
    receipt_ids = CASE
      WHEN "plugin_package_management_quota_buckets".window_started_at_ms
           + $6::bigint <= EXCLUDED.updated_at_ms
      THEN jsonb_build_array($5::text)
      WHEN "plugin_package_management_quota_buckets".receipt_ids ? $5::text
      THEN "plugin_package_management_quota_buckets".receipt_ids
      ELSE "plugin_package_management_quota_buckets".receipt_ids
           || jsonb_build_array($5::text)
    END,
    updated_at_ms = EXCLUDED.updated_at_ms
WHERE
  "plugin_package_management_quota_buckets".window_started_at_ms
    + $6::bigint <= EXCLUDED.updated_at_ms
  OR "plugin_package_management_quota_buckets".receipt_ids ? $5::text
  OR "plugin_package_management_quota_buckets".consumed_count < $7::integer
RETURNING
  true AS admitted,
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
    } catch (error) {
      throw unavailable(error);
    }
    if (result.rows.length === 0) {
      try {
        result = await this.pool.query<Row>(
          `
WITH database_clock AS (
  SELECT floor(
    extract(epoch FROM clock_timestamp()) * 1000
  )::bigint AS now_ms
)
SELECT
  false AS admitted,
  buckets.consumed_count AS "consumedCount",
  buckets.window_started_at_ms + $5::bigint AS "resetAtMs",
  database_clock.now_ms AS "observedAtMs"
FROM "ql3"."plugin_package_management_quota_buckets" AS buckets
CROSS JOIN database_clock
WHERE buckets.project_id = $1
  AND buckets.subject_type = $2
  AND buckets.subject_id = $3
  AND buckets.operation = $4
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
      } catch (error) {
        throw unavailable(error);
      }
    }
    if (result.rows.length !== 1) throw unavailable();
    const row = result.rows[0]!;
    const admitted = postgresRequiredBoolean(row.admitted, unavailable);
    const consumedCount = postgresRequiredInteger(
      row.consumedCount,
      unavailable,
    );
    const resetAtMs = postgresRequiredInteger(row.resetAtMs, unavailable);
    const observedAtMs = postgresRequiredInteger(row.observedAtMs, unavailable);
    if (
      consumedCount < 1 ||
      consumedCount > limit ||
      resetAtMs <= observedAtMs ||
      resetAtMs > observedAtMs + this.#windowMs
    ) {
      throw unavailable();
    }
    if (!admitted) {
      throw new PluginPackageManagementQuotaExceededError(
        Math.max(1, resetAtMs - observedAtMs),
      );
    }
    return Object.freeze({
      remaining: limit - consumedCount,
      resetAtMs,
      observedAtMs,
    });
  }
}
