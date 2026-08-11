import type { PostgresPool } from '@qinglong/runtime-core';

import {
  normalizeModelInvocationPriceQuote,
  type ModelInvocationPriceQuote,
} from '../../pricing/pricing';
import {
  ModelInvocationProjectQuotaExceededError,
  createModelInvocationQuotaReservation,
  normalizeModelInvocationQuotaAdmission,
  type ModelInvocationQuotaAdmission,
  type ModelInvocationQuotaReservation,
} from '../../usage/usageQuota';
import {
  ModelInvocationConflictError,
  normalizeModelInvocationStartCommand,
  type CommitModelInvocationResult,
  type ModelInvocationStartCommand,
  type ModelInvocationStartRecord,
} from '../modelInvocation';

import type { Row } from './authority';
import { integer, unavailable } from './authority';
import { parsePriceQuote, parseQuotaReservation, parseStart } from './codec';
import {
  applyMutation,
  assertCurrent,
  insertPriceQuote,
  insertQuotaReservation,
  insertStart,
  quotaWindowUsage,
} from './mutations';
import { priceQuoteRows, quotaReservationRows, startRows } from './queries';
import { runPostgresModelInvocationTransaction } from './transaction';

export async function admitOperation(
  pool: PostgresPool,
  commandValue: ModelInvocationStartCommand,
): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>> {
  const command = normalizeModelInvocationStartCommand(commandValue);
  const start = command.start;
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const existing = await startRows(
      client,
      `start.invocation_id = $1 OR
         start.mutation_id = $2 OR start.run_event_id = $3`,
      [start.invocationId, start.stepRunMutationId, start.runEventId],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const stored = parseStart(existing[0]);
      if (JSON.stringify(stored) !== JSON.stringify(start)) {
        throw new ModelInvocationConflictError();
      }
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    await assertCurrent(client, command.stepRunMutation, start.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertStart(client, start);
    return Object.freeze({ status: 'created' as const, record: start });
  });
}

export async function admitWithQuotaOperation(
  pool: PostgresPool,
  commandValue: ModelInvocationStartCommand,
  admissionValue: ModelInvocationQuotaAdmission,
): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>> {
  const command = normalizeModelInvocationStartCommand(commandValue);
  const admission = normalizeModelInvocationQuotaAdmission(admissionValue);
  const start = command.start;
  if (
    admission.invocationId !== start.invocationId ||
    admission.projectId !== start.projectId ||
    admission.modelPolicyRevision !== start.policyRevision
  ) {
    throw new ModelInvocationConflictError();
  }
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const existing = await startRows(
      client,
      `start.invocation_id = $1 OR
         start.mutation_id = $2 OR start.run_event_id = $3`,
      [start.invocationId, start.stepRunMutationId, start.runEventId],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const stored = parseStart(existing[0]);
      const reservations = await quotaReservationRows(
        client,
        'reservation.invocation_id = $1',
        [start.invocationId],
      );
      if (
        JSON.stringify(stored) !== JSON.stringify(start) ||
        reservations.length !== 1 ||
        parseQuotaReservation(reservations[0]!).admissionDigest !==
          admission.admissionDigest
      ) {
        throw new ModelInvocationConflictError();
      }
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    const observation = await client.query<Row>(
      `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
           AS "observedAtMs"`,
    );
    const observedRow = observation.rows[0];
    if (observation.rows.length !== 1 || !observedRow) throw unavailable();
    const reservation = createModelInvocationQuotaReservation(
      admission,
      integer(observedRow, 'observedAtMs'),
    );
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [
        JSON.stringify([
          start.projectId,
          reservation.windowStartMs,
          reservation.windowMs,
        ]),
      ],
    );
    const usage = await quotaWindowUsage(
      client,
      start.projectId,
      reservation.windowStartMs,
      reservation.windowMs,
    );
    if (
      usage.invocationCount + 1 > reservation.maxInvocations ||
      usage.effectiveTokens + reservation.reservedTokens >
        reservation.maxTokens ||
      (reservation.maxCostMicros !== null &&
        (usage.unknownCostInvocations !== 0 ||
          usage.effectiveCostMicros + reservation.reservedCostMicros! >
            reservation.maxCostMicros))
    ) {
      throw new ModelInvocationProjectQuotaExceededError();
    }
    await assertCurrent(client, command.stepRunMutation, start.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertStart(client, start);
    await insertQuotaReservation(client, reservation);
    return Object.freeze({ status: 'created' as const, record: start });
  });
}

export async function admitWithPricingOperation(
  pool: PostgresPool,
  commandValue: ModelInvocationStartCommand,
  quoteValue: ModelInvocationPriceQuote,
  admissionValue?: ModelInvocationQuotaAdmission,
): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>> {
  const command = normalizeModelInvocationStartCommand(commandValue);
  const quote = normalizeModelInvocationPriceQuote(quoteValue);
  const admission =
    admissionValue === undefined
      ? undefined
      : normalizeModelInvocationQuotaAdmission(admissionValue);
  const start = command.start;
  if (
    quote.invocationId !== start.invocationId ||
    quote.projectId !== start.projectId ||
    quote.modelPolicyRevision !== start.policyRevision ||
    quote.provider !== start.provider ||
    quote.model !== start.model ||
    quote.maxOutputTokens !== start.maxOutputTokens ||
    (admission !== undefined &&
      (admission.invocationId !== start.invocationId ||
        admission.projectId !== start.projectId ||
        admission.modelPolicyRevision !== start.policyRevision ||
        (admission.maxCostMicros !== null &&
          admission.reservedCostMicros !== quote.reservedCostMicros)))
  ) {
    throw new ModelInvocationConflictError();
  }
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const existing = await startRows(
      client,
      `start.invocation_id = $1 OR
         start.mutation_id = $2 OR start.run_event_id = $3`,
      [start.invocationId, start.stepRunMutationId, start.runEventId],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const [quotes, reservations] = await Promise.all([
        priceQuoteRows(client, 'quote.invocation_id = $1', [
          start.invocationId,
        ]),
        quotaReservationRows(client, 'reservation.invocation_id = $1', [
          start.invocationId,
        ]),
      ]);
      const stored = parseStart(existing[0]);
      if (
        JSON.stringify(stored) !== JSON.stringify(start) ||
        quotes.length !== 1 ||
        JSON.stringify(parsePriceQuote(quotes[0]!)) !== JSON.stringify(quote) ||
        reservations.length !== (admission ? 1 : 0) ||
        (admission !== undefined &&
          parseQuotaReservation(reservations[0]!).admissionDigest !==
            admission.admissionDigest)
      ) {
        throw new ModelInvocationConflictError();
      }
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    let reservation: Readonly<ModelInvocationQuotaReservation> | undefined;
    if (admission) {
      const observation = await client.query<Row>(
        `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
             AS "observedAtMs"`,
      );
      const observedRow = observation.rows[0];
      if (observation.rows.length !== 1 || !observedRow) {
        throw unavailable();
      }
      reservation = createModelInvocationQuotaReservation(
        admission,
        integer(observedRow, 'observedAtMs'),
      );
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          JSON.stringify([
            start.projectId,
            reservation.windowStartMs,
            reservation.windowMs,
          ]),
        ],
      );
      const usage = await quotaWindowUsage(
        client,
        start.projectId,
        reservation.windowStartMs,
        reservation.windowMs,
      );
      if (
        usage.invocationCount + 1 > reservation.maxInvocations ||
        usage.effectiveTokens + reservation.reservedTokens >
          reservation.maxTokens ||
        (reservation.maxCostMicros !== null &&
          (usage.unknownCostInvocations !== 0 ||
            usage.effectiveCostMicros + reservation.reservedCostMicros! >
              reservation.maxCostMicros))
      ) {
        throw new ModelInvocationProjectQuotaExceededError();
      }
    }
    await assertCurrent(client, command.stepRunMutation, start.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertStart(client, start);
    await insertPriceQuote(client, quote);
    if (reservation) await insertQuotaReservation(client, reservation);
    return Object.freeze({ status: 'created' as const, record: start });
  });
}
