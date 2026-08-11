import type { DatabaseSync } from 'node:sqlite';

import {
  type ModelInvocationPriceQuote,
  type ModelInvocationPriceSettlement,
} from '../../pricing/pricing';
import { type PluginPackagePromptOutputArtifact } from '../../prompt-output/pluginPackagePromptOutputArtifact';
import type { PluginPackagePromptOutputArtifactTombstone } from '../../prompt-output/pluginPackagePromptOutputRetention';
import { readLocalPluginPackagePromptOutputArtifactInTransaction } from '../../prompt-output/storage/localPluginPackagePromptOutputArtifactRepository';
import { readLocalPluginPackagePromptOutputArtifactTombstoneInTransaction } from '../../prompt-output/storage/localPluginPackagePromptOutputRetentionRepository';
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

import type { LocalModelInvocationOperationAuthority, Row } from './authority';
import {
  enqueueLocalModelInvocation,
  identifier,
  integer,
  unavailable,
} from './authority';
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

export function findStartOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationStartRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = startRows(client, 'start.invocation_id = ?', [invocationId]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseStart(rows[0]) : null;
  });
}

export function findCompletionOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationCompletionRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = completionRows(client, 'completion.invocation_id = ?', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseCompletion(rows[0]) : null;
  });
}

export function findPromptOutputArtifactOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  artifactIdValue: string,
): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
  const artifactId = identifier(artifactIdValue);
  return enqueueLocalModelInvocation(authority, () =>
    readLocalPluginPackagePromptOutputArtifactInTransaction(client, artifactId),
  );
}

export function findPromptOutputArtifactTombstoneOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  artifactIdValue: string,
): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone> | null> {
  const artifactId = identifier(artifactIdValue);
  return enqueueLocalModelInvocation(authority, () =>
    readLocalPluginPackagePromptOutputArtifactTombstoneInTransaction(
      client,
      artifactId,
    ),
  );
}

export function findUsageOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationUsageLedgerRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = usageRows(client, 'usage.invocation_id = ?', [invocationId]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseUsage(rows[0]) : null;
  });
}

export function findPriceQuoteOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationPriceQuote> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = priceQuoteRows(client, 'quote.invocation_id = ?', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parsePriceQuote(rows[0]) : null;
  });
}

export function findPriceSettlementOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationPriceSettlement> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const quotes = priceQuoteRows(client, 'quote.invocation_id = ?', [
      invocationId,
    ]);
    const completions = completionRows(client, 'completion.invocation_id = ?', [
      invocationId,
    ]);
    const settlements = priceSettlementRows(
      client,
      'settlement.invocation_id = ?',
      [invocationId],
    );
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
  });
}

export function findQuotaReservationOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationQuotaReservation> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = quotaReservationRows(client, 'reservation.invocation_id = ?', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseQuotaReservation(rows[0]) : null;
  });
}

export function findQuotaSettlementOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationQuotaSettlement> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const reservations = quotaReservationRows(
      client,
      'reservation.invocation_id = ?',
      [invocationId],
    );
    const completions = completionRows(client, 'completion.invocation_id = ?', [
      invocationId,
    ]);
    const settlements = quotaSettlementRows(
      client,
      'settlement.invocation_id = ?',
      [invocationId],
    );
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
  });
}

export function readQuotaWindowUsageOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
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
  return enqueueLocalModelInvocation(authority, () => {
    const atMs =
      atMsValue ??
      integer(
        client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS "atMs"`,
          )
          .get() as Row,
        'atMs',
      );
    const row = client
      .prepare(
        `SELECT reservation.record_json AS "recordJson"
           FROM "ModelInvocationQuotaReservations" AS reservation
           WHERE reservation.project_id = ?
             AND reservation.window_start_ms <= ?
             AND reservation.window_end_ms > ?
           ORDER BY reservation.reserved_at_ms DESC,
                    reservation.invocation_id DESC
           LIMIT 1`,
      )
      .get(projectId, atMs, atMs) as Row | undefined;
    if (!row) return null;
    const reservation = parseQuotaReservation(row);
    return quotaWindowUsage(
      client,
      projectId,
      reservation.windowStartMs,
      reservation.windowMs,
    );
  });
}

export function listProjectUsageOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  queryValue: ModelInvocationUsageLedgerQuery,
): Promise<Readonly<ModelInvocationUsageLedgerPage>> {
  const query = normalizeModelInvocationUsageLedgerQuery(queryValue);
  return enqueueLocalModelInvocation(authority, () => {
    const cursor = query.after;
    const rows = usageRows(
      client,
      `usage.project_id = ?
         AND usage.settled_at_ms >= ? AND usage.settled_at_ms < ?
         ${
           cursor
             ? `AND (
                  usage.settled_at_ms > ? OR
                  (usage.settled_at_ms = ? AND usage.invocation_id > ?)
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
  });
}

export function summarizeProjectUsageOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  queryValue: ModelInvocationUsageLedgerSummaryQuery,
): Promise<Readonly<ModelInvocationUsageLedgerSummary>> {
  const query = normalizeModelInvocationUsageLedgerSummaryQuery(queryValue);
  return enqueueLocalModelInvocation(authority, () => {
    const row = client
      .prepare(
        `SELECT
             COUNT(*) AS "invocationCount",
             COALESCE(SUM(input_tokens), 0) AS "inputTokens",
             COALESCE(SUM(output_tokens), 0) AS "outputTokens",
             COALESCE(SUM(total_tokens), 0) AS "totalTokens",
             COALESCE(SUM(cost_micros), 0) AS "knownCostMicros",
             COALESCE(SUM(CASE WHEN cost_micros IS NULL THEN 1 ELSE 0 END), 0)
               AS "unknownCostInvocations"
           FROM (
             SELECT input_tokens, output_tokens, total_tokens, cost_micros
             FROM "ModelInvocationUsageLedger"
             WHERE project_id = ?
               AND settled_at_ms >= ? AND settled_at_ms < ?
             ORDER BY settled_at_ms, invocation_id
             LIMIT ?
           ) AS bounded_usage`,
      )
      .get(
        query.projectId,
        query.fromMsInclusive,
        query.toMsExclusive,
        MAX_MODEL_INVOCATION_USAGE_SUMMARY_ROWS + 1,
      ) as Row | undefined;
    if (!row) throw unavailable();
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
  });
}
