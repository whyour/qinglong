import type { PostgresPool } from '@qinglong/runtime-core';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  type ModelInvocationPriceQuote,
  type ModelInvocationPriceSettlement,
} from '../../pricing/pricing';
import { type PluginPackagePromptOutputArtifact } from '../../prompt-output/pluginPackagePromptOutputArtifact';
import type { PluginPackagePromptOutputArtifactTombstone } from '../../prompt-output/pluginPackagePromptOutputRetention';
import { readPostgresPluginPackagePromptOutputArtifactInTransaction } from '../../prompt-output/storage/postgresPluginPackagePromptOutputArtifactRepository';
import { readPostgresPluginPackagePromptOutputArtifactTombstoneInTransaction } from '../../prompt-output/storage/postgresPluginPackagePromptOutputRetentionRepository';
import {
  MAX_MODEL_INVOCATION_USAGE_SUMMARY_ROWS,
  ModelInvocationUsageSummaryLimitExceededError,
  normalizeModelInvocationUsageLedgerQuery,
  normalizeModelInvocationUsageLedgerSummaryQuery,
  type ModelInvocationUsageLedgerPage,
  type ModelInvocationUsageLedgerQuery,
  type ModelInvocationUsageLedgerRecord,
  type ModelInvocationUsageLedgerSummary,
  type ModelInvocationUsageLedgerSummaryQuery,
} from '../../usage/usageLedger';
import {
  type ModelInvocationQuotaReservation,
  type ModelInvocationQuotaSettlement,
  type ModelInvocationQuotaWindowUsage,
} from '../../usage/usageQuota';
import {
  type ModelInvocationCompletionRecord,
  type ModelInvocationStartRecord,
} from '../modelInvocation';

import type { Row } from './authority';
import { identifier, integer, mapStorageError, unavailable } from './authority';
import {
  parseCompletion,
  parsePriceQuote,
  parsePriceSettlement,
  parseQuotaReservation,
  parseQuotaSettlement,
  parseStart,
  parseUsage,
} from './codec';
import { quotaWindowUsage } from './mutations';
import {
  completionRows,
  priceQuoteRows,
  priceSettlementRows,
  quotaReservationRows,
  quotaSettlementRows,
  startRows,
  usageRows,
} from './queries';

export async function findStartOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationStartRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const rows = await startRows(pool, 'start.invocation_id = $1', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseStart(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findCompletionOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationCompletionRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const rows = await completionRows(pool, 'completion.invocation_id = $1', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseCompletion(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findPromptOutputArtifactOperation(
  pool: PostgresPool,
  artifactIdValue: string,
): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
  const artifactId = identifier(artifactIdValue);
  try {
    return await readPostgresPluginPackagePromptOutputArtifactInTransaction(
      pool,
      artifactId,
    );
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findPromptOutputArtifactTombstoneOperation(
  pool: PostgresPool,
  artifactIdValue: string,
): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone> | null> {
  const artifactId = identifier(artifactIdValue);
  try {
    return await readPostgresPluginPackagePromptOutputArtifactTombstoneInTransaction(
      pool,
      artifactId,
    );
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findUsageOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationUsageLedgerRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const rows = await usageRows(pool, 'usage.invocation_id = $1', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseUsage(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findPriceQuoteOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationPriceQuote> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const rows = await priceQuoteRows(pool, 'quote.invocation_id = $1', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parsePriceQuote(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findPriceSettlementOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationPriceSettlement> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const [quotes, completions, settlements] = await Promise.all([
      priceQuoteRows(pool, 'quote.invocation_id = $1', [invocationId]),
      completionRows(pool, 'completion.invocation_id = $1', [invocationId]),
      priceSettlementRows(pool, 'settlement.invocation_id = $1', [
        invocationId,
      ]),
    ]);
    if (quotes.length > 1 || completions.length > 1 || settlements.length > 1) {
      throw unavailable();
    }
    if (!settlements[0]) return null;
    if (!quotes[0] || !completions[0]) throw unavailable();
    return parsePriceSettlement(
      settlements[0],
      parsePriceQuote(quotes[0]),
      parseCompletion(completions[0]),
    );
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findQuotaReservationOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationQuotaReservation> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const rows = await quotaReservationRows(
      pool,
      'reservation.invocation_id = $1',
      [invocationId],
    );
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseQuotaReservation(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function findQuotaSettlementOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationQuotaSettlement> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const [reservations, completions, settlements] = await Promise.all([
      quotaReservationRows(pool, 'reservation.invocation_id = $1', [
        invocationId,
      ]),
      completionRows(pool, 'completion.invocation_id = $1', [invocationId]),
      quotaSettlementRows(pool, 'settlement.invocation_id = $1', [
        invocationId,
      ]),
    ]);
    if (
      reservations.length > 1 ||
      completions.length > 1 ||
      settlements.length > 1
    ) {
      throw unavailable();
    }
    if (!settlements[0]) return null;
    if (!reservations[0] || !completions[0]) throw unavailable();
    return parseQuotaSettlement(
      settlements[0],
      parseQuotaReservation(reservations[0]),
      parseCompletion(completions[0]),
    );
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function readQuotaWindowUsageOperation(
  pool: PostgresPool,
  projectIdValue: string,
  atMsValue?: number,
): Promise<Readonly<ModelInvocationQuotaWindowUsage> | null> {
  const projectId = identifier(projectIdValue);
  if (
    atMsValue !== undefined &&
    (!Number.isSafeInteger(atMsValue) || atMsValue < 0)
  ) {
    throw unavailable();
  }
  try {
    let atMs = atMsValue;
    if (atMs === undefined) {
      const observation = await pool.query<Row>(
        `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
             AS "atMs"`,
      );
      const row = observation.rows[0];
      if (observation.rows.length !== 1 || !row) throw unavailable();
      atMs = integer(row, 'atMs');
    }
    const result = await pool.query<Row>(
      `SELECT reservation.record_json AS "recordJson"
         FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations"
           AS reservation
         WHERE reservation.project_id = $1
           AND reservation.window_start_ms <= $2
           AND reservation.window_end_ms > $3
         ORDER BY reservation.reserved_at_ms DESC,
                  reservation.invocation_id DESC
         LIMIT 1`,
      [projectId, atMs, atMs],
    );
    const row = result.rows[0];
    if (!row) return null;
    const reservation = parseQuotaReservation(row);
    return quotaWindowUsage(
      pool,
      projectId,
      reservation.windowStartMs,
      reservation.windowMs,
    );
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function listProjectUsageOperation(
  pool: PostgresPool,
  queryValue: ModelInvocationUsageLedgerQuery,
): Promise<Readonly<ModelInvocationUsageLedgerPage>> {
  const query = normalizeModelInvocationUsageLedgerQuery(queryValue);
  const cursor = query.after;
  try {
    const rows = await usageRows(
      pool,
      `usage.project_id = $1
         AND usage.settled_at_ms >= $2 AND usage.settled_at_ms < $3
         ${
           cursor
             ? `AND (
                  usage.settled_at_ms > $4 OR
                  (usage.settled_at_ms = $5 AND usage.invocation_id > $6)
                )`
             : ''
         }`,
      [
        query.projectId,
        query.fromMsInclusive,
        query.toMsExclusive,
        ...(cursor
          ? [cursor.settledAtMs, cursor.settledAtMs, cursor.invocationId]
          : []),
      ],
      query.limit + 1,
    );
    return Object.freeze({
      records: Object.freeze(
        rows.slice(0, query.limit).map((row) => parseUsage(row)),
      ),
      hasMore: rows.length > query.limit,
    });
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function summarizeProjectUsageOperation(
  pool: PostgresPool,
  queryValue: ModelInvocationUsageLedgerSummaryQuery,
): Promise<Readonly<ModelInvocationUsageLedgerSummary>> {
  const query = normalizeModelInvocationUsageLedgerSummaryQuery(queryValue);
  try {
    const result = await pool.query<Row>(
      `SELECT
           COUNT(*)::text AS "invocationCount",
           COALESCE(SUM(input_tokens), 0)::text AS "inputTokens",
           COALESCE(SUM(output_tokens), 0)::text AS "outputTokens",
           COALESCE(SUM(total_tokens), 0)::text AS "totalTokens",
           COALESCE(SUM(cost_micros), 0)::text AS "knownCostMicros",
           COUNT(*) FILTER (WHERE cost_micros IS NULL)::text
             AS "unknownCostInvocations"
         FROM (
           SELECT input_tokens, output_tokens, total_tokens, cost_micros
           FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger"
           WHERE project_id = $1
             AND settled_at_ms >= $2 AND settled_at_ms < $3
           ORDER BY settled_at_ms, invocation_id
           LIMIT $4
         ) AS bounded_usage`,
      [
        query.projectId,
        query.fromMsInclusive,
        query.toMsExclusive,
        MAX_MODEL_INVOCATION_USAGE_SUMMARY_ROWS + 1,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) throw unavailable();
    if (
      integer(row, 'invocationCount') > MAX_MODEL_INVOCATION_USAGE_SUMMARY_ROWS
    ) {
      throw new ModelInvocationUsageSummaryLimitExceededError();
    }
    return Object.freeze({
      invocationCount: integer(row, 'invocationCount'),
      inputTokens: integer(row, 'inputTokens'),
      outputTokens: integer(row, 'outputTokens'),
      totalTokens: integer(row, 'totalTokens'),
      knownCostMicros: integer(row, 'knownCostMicros'),
      unknownCostInvocations: integer(row, 'unknownCostInvocations'),
    });
  } catch (error) {
    throw mapStorageError(error);
  }
}
