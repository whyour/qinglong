import type { DatabaseSync } from 'node:sqlite';

import type { Row } from './authority';
import {
  COMPLETION_SELECT,
  RESOLUTION_SELECT,
  START_SELECT,
  USAGE_SELECT,
} from './codec';

export function startRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT ${START_SELECT}
       FROM "ModelInvocationStarts" AS start
       JOIN "StepRunMutations" AS mutation
         ON mutation.mutation_id = start.mutation_id
       JOIN "RunEvents" AS event ON event.id = start.run_event_id
       WHERE ${where}
       LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function completionRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT ${COMPLETION_SELECT}
       FROM "ModelInvocationCompletions" AS completion
       JOIN "StepRunMutations" AS mutation
         ON mutation.mutation_id = completion.mutation_id
       JOIN "RunEvents" AS event ON event.id = completion.run_event_id
       WHERE ${where}
       LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function usageRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
  limit = 2,
): readonly Row[] {
  return client
    .prepare(
      `SELECT ${USAGE_SELECT}
       FROM "ModelInvocationUsageLedger" AS usage
       WHERE ${where}
       ORDER BY usage.settled_at_ms, usage.invocation_id
       LIMIT ?`,
    )
    .all(...values, limit) as Row[];
}

export function quotaReservationRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
  limit = 2,
): readonly Row[] {
  return client
    .prepare(
      `SELECT reservation.record_json AS "recordJson"
       FROM "ModelInvocationQuotaReservations" AS reservation
       WHERE ${where}
       ORDER BY reservation.window_start_ms, reservation.invocation_id
       LIMIT ?`,
    )
    .all(...values, limit) as Row[];
}

export function quotaSettlementRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT settlement.record_json AS "recordJson"
       FROM "ModelInvocationQuotaSettlements" AS settlement
       WHERE ${where}
       LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function priceQuoteRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT quote.record_json AS "recordJson"
       FROM "ModelInvocationPriceQuotes" AS quote
       WHERE ${where}
       LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function priceSettlementRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT settlement.record_json AS "recordJson"
       FROM "ModelInvocationPriceSettlements" AS settlement
       WHERE ${where}
       LIMIT 2`,
    )
    .all(...values) as Row[];
}

export function resolutionRows(
  client: DatabaseSync,
  where: string,
  values: readonly (string | number)[],
): readonly Row[] {
  return client
    .prepare(
      `SELECT ${RESOLUTION_SELECT}
       FROM "ModelInvocationResolutions" AS resolution
       JOIN "StepRunMutations" AS mutation
         ON mutation.mutation_id = resolution.mutation_id
       JOIN "RunEvents" AS event ON event.id = resolution.run_event_id
       WHERE ${where}
       LIMIT 2`,
    )
    .all(...values) as Row[];
}
