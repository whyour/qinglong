import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';

import type { Queryable, Row } from './authority';
import {
  COMPLETION_SELECT,
  RESOLUTION_SELECT,
  START_SELECT,
  USAGE_SELECT,
} from './codec';

export async function startRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${START_SELECT}
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" AS start
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = start.mutation_id
     JOIN "ql3"."run_events" AS event ON event.id = start.run_event_id
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function completionRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${COMPLETION_SELECT}
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" AS completion
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = completion.mutation_id
     JOIN "ql3"."run_events" AS event ON event.id = completion.run_event_id
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function usageRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
  limit = 2,
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${USAGE_SELECT}
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_usage_ledger" AS usage
     WHERE ${where}
     ORDER BY usage.settled_at_ms, usage.invocation_id
     LIMIT $${values.length + 1}`,
    [...values, limit],
  );
  return result.rows;
}

export async function quotaReservationRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
  limit = 2,
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT reservation.record_json AS "recordJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_reservations"
       AS reservation
     WHERE ${where}
     ORDER BY reservation.window_start_ms, reservation.invocation_id
     LIMIT $${values.length + 1}`,
    [...values, limit],
  );
  return result.rows;
}

export async function quotaSettlementRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT settlement.record_json AS "recordJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_quota_settlements"
       AS settlement
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function priceQuoteRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT quote.record_json AS "recordJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_quotes"
       AS quote
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function priceSettlementRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT settlement.record_json AS "recordJson"
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_price_settlements"
       AS settlement
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}

export async function resolutionRows(
  queryable: Queryable,
  where: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await queryable.query<Row>(
    `SELECT ${RESOLUTION_SELECT}
     FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_resolutions" AS resolution
     JOIN "ql3"."step_run_mutations" AS mutation
       ON mutation.mutation_id = resolution.mutation_id
     JOIN "ql3"."run_events" AS event ON event.id = resolution.run_event_id
     WHERE ${where}
     LIMIT 2`,
    values,
  );
  return result.rows;
}
