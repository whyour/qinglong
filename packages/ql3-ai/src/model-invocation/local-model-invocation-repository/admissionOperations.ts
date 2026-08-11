import type { DatabaseSync } from 'node:sqlite';

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

import type { LocalModelInvocationOperationAuthority, Row } from './authority';
import {
  assertLocalFeatureActive,
  enqueueLocalModelInvocation,
  integer,
  unavailable,
} from './authority';
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

export function admitOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: ModelInvocationStartCommand,
): Promise<Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>> {
  const command = normalizeModelInvocationStartCommand(commandValue);
  const start = command.start;
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const existing = startRows(
        client,
        `start.invocation_id = ? OR
           start.mutation_id = ? OR start.run_event_id = ?`,
        [start.invocationId, start.stepRunMutationId, start.runEventId],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseStart(existing[0]);
        if (JSON.stringify(stored) !== JSON.stringify(start)) {
          throw new ModelInvocationConflictError();
        }
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      assertLocalFeatureActive(client);
      assertCurrent(client, command.stepRunMutation, start.projectId);
      applyMutation(client, command.stepRunMutation);
      insertStart(client, start);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, record: start });
    } catch (error) {
      if (began && client.isTransaction) {
        try {
          client.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
      }
      throw error;
    }
  });
}

export function admitWithQuotaOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
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
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const existing = startRows(
        client,
        `start.invocation_id = ? OR
           start.mutation_id = ? OR start.run_event_id = ?`,
        [start.invocationId, start.stepRunMutationId, start.runEventId],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseStart(existing[0]);
        const reservations = quotaReservationRows(
          client,
          'reservation.invocation_id = ?',
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
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      assertLocalFeatureActive(client);
      const observed = client
        .prepare(
          `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
               AS "observedAtMs"`,
        )
        .get() as Row | undefined;
      if (!observed) throw unavailable();
      const reservation = createModelInvocationQuotaReservation(
        admission,
        integer(observed, 'observedAtMs'),
      );
      const usage = quotaWindowUsage(
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
      assertCurrent(client, command.stepRunMutation, start.projectId);
      applyMutation(client, command.stepRunMutation);
      insertStart(client, start);
      insertQuotaReservation(client, reservation);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, record: start });
    } catch (error) {
      if (began && client.isTransaction) {
        try {
          client.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
      }
      throw error;
    }
  });
}

export function admitWithPricingOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
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
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const existing = startRows(
        client,
        `start.invocation_id = ? OR
           start.mutation_id = ? OR start.run_event_id = ?`,
        [start.invocationId, start.stepRunMutationId, start.runEventId],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseStart(existing[0]);
        const quotes = priceQuoteRows(client, 'quote.invocation_id = ?', [
          start.invocationId,
        ]);
        const reservations = quotaReservationRows(
          client,
          'reservation.invocation_id = ?',
          [start.invocationId],
        );
        if (
          JSON.stringify(stored) !== JSON.stringify(start) ||
          quotes.length !== 1 ||
          JSON.stringify(parsePriceQuote(quotes[0]!)) !==
            JSON.stringify(quote) ||
          reservations.length !== (admission ? 1 : 0) ||
          (admission !== undefined &&
            parseQuotaReservation(reservations[0]!).admissionDigest !==
              admission.admissionDigest)
        ) {
          throw new ModelInvocationConflictError();
        }
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      assertLocalFeatureActive(client);
      let reservation: Readonly<ModelInvocationQuotaReservation> | undefined;
      if (admission) {
        const observed = client
          .prepare(
            `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
                 AS "observedAtMs"`,
          )
          .get() as Row | undefined;
        if (!observed) throw unavailable();
        reservation = createModelInvocationQuotaReservation(
          admission,
          integer(observed, 'observedAtMs'),
        );
        const usage = quotaWindowUsage(
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
      assertCurrent(client, command.stepRunMutation, start.projectId);
      applyMutation(client, command.stepRunMutation);
      insertStart(client, start);
      insertPriceQuote(client, quote);
      if (reservation) {
        insertQuotaReservation(client, reservation);
      }
      client.exec('COMMIT');
      began = false;
      return Object.freeze({ status: 'created' as const, record: start });
    } catch (error) {
      if (began && client.isTransaction) {
        try {
          client.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
      }
      throw error;
    }
  });
}
