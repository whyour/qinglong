import type { DatabaseSync } from 'node:sqlite';

import { createModelInvocationPriceSettlement } from '../../pricing/pricing';
import { type PluginPackagePromptOutputArtifact } from '../../prompt-output/pluginPackagePromptOutputArtifact';
import {
  assertPluginPackagePromptOutputCompletionBinding,
  type CommitPluginPackagePromptOutputResult,
} from '../../prompt-output/pluginPackagePromptOutputCompletion';
import {
  putLocalPluginPackagePromptOutputArtifactInTransaction,
  readLocalPluginPackagePromptOutputArtifactInTransaction,
} from '../../prompt-output/storage/localPluginPackagePromptOutputArtifactRepository';
import { createModelInvocationUsageLedgerRecord } from '../../usage/usageLedger';
import { createModelInvocationQuotaSettlement } from '../../usage/usageQuota';
import {
  ModelInvocationConflictError,
  normalizeModelInvocationCompletionCommand,
  type CommitModelInvocationResult,
  type ModelInvocationCompletionCommand,
  type ModelInvocationCompletionRecord,
} from '../modelInvocation';

import type { LocalModelInvocationOperationAuthority } from './authority';
import { enqueueLocalModelInvocation } from './authority';
import {
  parseCompletion,
  parsePriceQuote,
  parsePriceSettlement,
  parseQuotaReservation,
  parseQuotaSettlement,
  parseStart,
  parseUsage,
} from './codec';
import {
  applyMutation,
  assertCurrent,
  insertCompletion,
  insertPriceSettlement,
  insertQuotaSettlement,
  insertUsage,
} from './mutations';
import {
  completionRows,
  priceQuoteRows,
  priceSettlementRows,
  quotaReservationRows,
  quotaSettlementRows,
  startRows,
  usageRows,
} from './queries';

export function completeOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: ModelInvocationCompletionCommand,
): Promise<
  Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
> {
  const command = normalizeModelInvocationCompletionCommand(commandValue);
  const completion = command.completion;
  const expectedUsage = createModelInvocationUsageLedgerRecord(
    command.start,
    completion,
  );
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const existing = completionRows(
        client,
        `completion.invocation_id = ? OR
           completion.mutation_id = ? OR completion.run_event_id = ?`,
        [
          completion.invocationId,
          completion.stepRunMutationId,
          completion.runEventId,
        ],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseCompletion(existing[0]);
        if (JSON.stringify(stored) !== JSON.stringify(completion)) {
          throw new ModelInvocationConflictError();
        }
        const usage = usageRows(client, 'usage.invocation_id = ?', [
          completion.invocationId,
        ]);
        if (
          usage.length !== (expectedUsage ? 1 : 0) ||
          (expectedUsage &&
            JSON.stringify(parseUsage(usage[0]!)) !==
              JSON.stringify(expectedUsage))
        ) {
          throw new ModelInvocationConflictError();
        }
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      const starts = startRows(client, 'start.invocation_id = ?', [
        completion.invocationId,
      ]);
      if (
        starts.length !== 1 ||
        JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
      ) {
        throw new ModelInvocationConflictError();
      }
      assertCurrent(client, command.stepRunMutation, completion.projectId);
      applyMutation(client, command.stepRunMutation);
      insertCompletion(client, completion);
      if (expectedUsage) insertUsage(client, expectedUsage);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        record: completion,
      });
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

export function completeWithQuotaOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: ModelInvocationCompletionCommand,
): Promise<
  Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
> {
  const command = normalizeModelInvocationCompletionCommand(commandValue);
  const completion = command.completion;
  const expectedUsage = createModelInvocationUsageLedgerRecord(
    command.start,
    completion,
  );
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const reservationRows = quotaReservationRows(
        client,
        'reservation.invocation_id = ?',
        [completion.invocationId],
      );
      if (reservationRows.length !== 1) {
        throw new ModelInvocationConflictError();
      }
      const reservation = parseQuotaReservation(reservationRows[0]!);
      const expectedSettlement = createModelInvocationQuotaSettlement(
        reservation,
        completion,
      );
      const existing = completionRows(
        client,
        `completion.invocation_id = ? OR
           completion.mutation_id = ? OR completion.run_event_id = ?`,
        [
          completion.invocationId,
          completion.stepRunMutationId,
          completion.runEventId,
        ],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseCompletion(existing[0]);
        const usage = usageRows(client, 'usage.invocation_id = ?', [
          completion.invocationId,
        ]);
        const settlements = quotaSettlementRows(
          client,
          'settlement.invocation_id = ?',
          [completion.invocationId],
        );
        if (
          JSON.stringify(stored) !== JSON.stringify(completion) ||
          usage.length !== (expectedUsage ? 1 : 0) ||
          (expectedUsage &&
            JSON.stringify(parseUsage(usage[0]!)) !==
              JSON.stringify(expectedUsage)) ||
          settlements.length !== 1 ||
          JSON.stringify(
            parseQuotaSettlement(settlements[0]!, reservation, completion),
          ) !== JSON.stringify(expectedSettlement)
        ) {
          throw new ModelInvocationConflictError();
        }
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      const starts = startRows(client, 'start.invocation_id = ?', [
        completion.invocationId,
      ]);
      if (
        starts.length !== 1 ||
        JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
      ) {
        throw new ModelInvocationConflictError();
      }
      assertCurrent(client, command.stepRunMutation, completion.projectId);
      applyMutation(client, command.stepRunMutation);
      insertCompletion(client, completion);
      if (expectedUsage) insertUsage(client, expectedUsage);
      insertQuotaSettlement(client, expectedSettlement);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        record: completion,
      });
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

export function completeWithPricingOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: ModelInvocationCompletionCommand,
): Promise<
  Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
> {
  const command = normalizeModelInvocationCompletionCommand(commandValue);
  const completion = command.completion;
  const expectedUsage = createModelInvocationUsageLedgerRecord(
    command.start,
    completion,
  );
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const quoteRows = priceQuoteRows(client, 'quote.invocation_id = ?', [
        completion.invocationId,
      ]);
      if (quoteRows.length !== 1) {
        throw new ModelInvocationConflictError();
      }
      const quote = parsePriceQuote(quoteRows[0]!);
      if (
        quote.invocationId !== command.start.invocationId ||
        quote.projectId !== command.start.projectId ||
        quote.modelPolicyRevision !== command.start.policyRevision ||
        quote.provider !== command.start.provider ||
        quote.model !== command.start.model
      ) {
        throw new ModelInvocationConflictError();
      }
      const expectedPriceSettlement = createModelInvocationPriceSettlement(
        quote,
        completion,
      );
      const reservationRows = quotaReservationRows(
        client,
        'reservation.invocation_id = ?',
        [completion.invocationId],
      );
      if (reservationRows.length > 1) {
        throw new ModelInvocationConflictError();
      }
      const reservation = reservationRows[0]
        ? parseQuotaReservation(reservationRows[0])
        : null;
      const expectedQuotaSettlement = reservation
        ? createModelInvocationQuotaSettlement(reservation, completion)
        : null;
      const existing = completionRows(
        client,
        `completion.invocation_id = ? OR
           completion.mutation_id = ? OR completion.run_event_id = ?`,
        [
          completion.invocationId,
          completion.stepRunMutationId,
          completion.runEventId,
        ],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseCompletion(existing[0]);
        const usage = usageRows(client, 'usage.invocation_id = ?', [
          completion.invocationId,
        ]);
        const priceSettlements = priceSettlementRows(
          client,
          'settlement.invocation_id = ?',
          [completion.invocationId],
        );
        const quotaSettlements = quotaSettlementRows(
          client,
          'settlement.invocation_id = ?',
          [completion.invocationId],
        );
        if (
          JSON.stringify(stored) !== JSON.stringify(completion) ||
          usage.length !== (expectedUsage ? 1 : 0) ||
          (expectedUsage &&
            JSON.stringify(parseUsage(usage[0]!)) !==
              JSON.stringify(expectedUsage)) ||
          priceSettlements.length !== (expectedPriceSettlement ? 1 : 0) ||
          (expectedPriceSettlement &&
            JSON.stringify(
              parsePriceSettlement(priceSettlements[0]!, quote, completion),
            ) !== JSON.stringify(expectedPriceSettlement)) ||
          quotaSettlements.length !== (expectedQuotaSettlement ? 1 : 0) ||
          (expectedQuotaSettlement &&
            JSON.stringify(
              parseQuotaSettlement(
                quotaSettlements[0]!,
                reservation!,
                completion,
              ),
            ) !== JSON.stringify(expectedQuotaSettlement))
        ) {
          throw new ModelInvocationConflictError();
        }
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      const starts = startRows(client, 'start.invocation_id = ?', [
        completion.invocationId,
      ]);
      if (
        starts.length !== 1 ||
        JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
      ) {
        throw new ModelInvocationConflictError();
      }
      assertCurrent(client, command.stepRunMutation, completion.projectId);
      applyMutation(client, command.stepRunMutation);
      insertCompletion(client, completion);
      if (expectedUsage) insertUsage(client, expectedUsage);
      if (expectedPriceSettlement) {
        insertPriceSettlement(client, expectedPriceSettlement);
      }
      if (expectedQuotaSettlement) {
        insertQuotaSettlement(client, expectedQuotaSettlement);
      }
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        record: completion,
      });
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

export function completeWithPromptOutputArtifactOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: ModelInvocationCompletionCommand,
  artifactValue: PluginPackagePromptOutputArtifact,
): Promise<Readonly<CommitPluginPackagePromptOutputResult>> {
  const command = normalizeModelInvocationCompletionCommand(commandValue);
  const completion = command.completion;
  const binding = assertPluginPackagePromptOutputCompletionBinding(
    command,
    artifactValue,
  );
  const expectedUsage = createModelInvocationUsageLedgerRecord(
    command.start,
    completion,
  );
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const quoteRows = priceQuoteRows(client, 'quote.invocation_id = ?', [
        completion.invocationId,
      ]);
      if (quoteRows.length > 1) throw new ModelInvocationConflictError();
      const quote = quoteRows[0] ? parsePriceQuote(quoteRows[0]) : null;
      if (
        quote &&
        (quote.invocationId !== command.start.invocationId ||
          quote.projectId !== command.start.projectId ||
          quote.modelPolicyRevision !== command.start.policyRevision ||
          quote.provider !== command.start.provider ||
          quote.model !== command.start.model)
      ) {
        throw new ModelInvocationConflictError();
      }
      const expectedPriceSettlement = quote
        ? createModelInvocationPriceSettlement(quote, completion)
        : null;
      const reservationRows = quotaReservationRows(
        client,
        'reservation.invocation_id = ?',
        [completion.invocationId],
      );
      if (reservationRows.length > 1) {
        throw new ModelInvocationConflictError();
      }
      const reservation = reservationRows[0]
        ? parseQuotaReservation(reservationRows[0])
        : null;
      const expectedQuotaSettlement = reservation
        ? createModelInvocationQuotaSettlement(reservation, completion)
        : null;
      const existing = completionRows(
        client,
        `completion.invocation_id = ? OR
           completion.mutation_id = ? OR completion.run_event_id = ?`,
        [
          completion.invocationId,
          completion.stepRunMutationId,
          completion.runEventId,
        ],
      );
      if (existing.length > 1) throw new ModelInvocationConflictError();
      if (existing[0]) {
        const stored = parseCompletion(existing[0]);
        const storedArtifact =
          readLocalPluginPackagePromptOutputArtifactInTransaction(
            client,
            binding.artifact.artifactId,
          );
        const usage = usageRows(client, 'usage.invocation_id = ?', [
          completion.invocationId,
        ]);
        const priceSettlements = priceSettlementRows(
          client,
          'settlement.invocation_id = ?',
          [completion.invocationId],
        );
        const quotaSettlements = quotaSettlementRows(
          client,
          'settlement.invocation_id = ?',
          [completion.invocationId],
        );
        if (
          JSON.stringify(stored) !== JSON.stringify(completion) ||
          !storedArtifact ||
          JSON.stringify(storedArtifact) !== JSON.stringify(binding.artifact) ||
          usage.length !== (expectedUsage ? 1 : 0) ||
          (expectedUsage &&
            JSON.stringify(parseUsage(usage[0]!)) !==
              JSON.stringify(expectedUsage)) ||
          priceSettlements.length !== (expectedPriceSettlement ? 1 : 0) ||
          (expectedPriceSettlement &&
            JSON.stringify(
              parsePriceSettlement(priceSettlements[0]!, quote!, completion),
            ) !== JSON.stringify(expectedPriceSettlement)) ||
          quotaSettlements.length !== (expectedQuotaSettlement ? 1 : 0) ||
          (expectedQuotaSettlement &&
            JSON.stringify(
              parseQuotaSettlement(
                quotaSettlements[0]!,
                reservation!,
                completion,
              ),
            ) !== JSON.stringify(expectedQuotaSettlement))
        ) {
          throw new ModelInvocationConflictError();
        }
        client.exec('COMMIT');
        began = false;
        return Object.freeze({
          status: 'existing' as const,
          record: stored,
          artifact: storedArtifact,
          reference: binding.reference,
        });
      }
      const starts = startRows(client, 'start.invocation_id = ?', [
        completion.invocationId,
      ]);
      if (
        starts.length !== 1 ||
        JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
      ) {
        throw new ModelInvocationConflictError();
      }
      assertCurrent(client, command.stepRunMutation, completion.projectId);
      const artifact = putLocalPluginPackagePromptOutputArtifactInTransaction(
        client,
        binding.artifact,
      ).artifact;
      applyMutation(client, command.stepRunMutation);
      insertCompletion(client, completion);
      if (expectedUsage) insertUsage(client, expectedUsage);
      if (expectedPriceSettlement) {
        insertPriceSettlement(client, expectedPriceSettlement);
      }
      if (expectedQuotaSettlement) {
        insertQuotaSettlement(client, expectedQuotaSettlement);
      }
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        record: completion,
        artifact,
        reference: binding.reference,
      });
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
