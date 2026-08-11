import type { PostgresPool } from '@qinglong/runtime-core';

import { createModelInvocationPriceSettlement } from '../../pricing/pricing';
import { type PluginPackagePromptOutputArtifact } from '../../prompt-output/pluginPackagePromptOutputArtifact';
import {
  assertPluginPackagePromptOutputCompletionBinding,
  type CommitPluginPackagePromptOutputResult,
} from '../../prompt-output/pluginPackagePromptOutputCompletion';
import {
  putPostgresPluginPackagePromptOutputArtifactInTransaction,
  readPostgresPluginPackagePromptOutputArtifactInTransaction,
} from '../../prompt-output/storage/postgresPluginPackagePromptOutputArtifactRepository';
import { createModelInvocationUsageLedgerRecord } from '../../usage/usageLedger';
import { createModelInvocationQuotaSettlement } from '../../usage/usageQuota';
import {
  ModelInvocationConflictError,
  normalizeModelInvocationCompletionCommand,
  type CommitModelInvocationResult,
  type ModelInvocationCompletionCommand,
  type ModelInvocationCompletionRecord,
} from '../modelInvocation';

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
import { runPostgresModelInvocationTransaction } from './transaction';

export async function completeOperation(
  pool: PostgresPool,
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
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const existing = await completionRows(
      client,
      `completion.invocation_id = $1 OR
         completion.mutation_id = $2 OR completion.run_event_id = $3`,
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
      const usage = await usageRows(client, 'usage.invocation_id = $1', [
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
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    const starts = await startRows(client, 'start.invocation_id = $1', [
      completion.invocationId,
    ]);
    if (
      starts.length !== 1 ||
      JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
    ) {
      throw new ModelInvocationConflictError();
    }
    await assertCurrent(client, command.stepRunMutation, completion.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertCompletion(client, completion);
    if (expectedUsage) await insertUsage(client, expectedUsage);
    return Object.freeze({
      status: 'created' as const,
      record: completion,
    });
  });
}

export async function completeWithQuotaOperation(
  pool: PostgresPool,
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
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const reservationRows = await quotaReservationRows(
      client,
      'reservation.invocation_id = $1',
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
    const existing = await completionRows(
      client,
      `completion.invocation_id = $1 OR
         completion.mutation_id = $2 OR completion.run_event_id = $3`,
      [
        completion.invocationId,
        completion.stepRunMutationId,
        completion.runEventId,
      ],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const stored = parseCompletion(existing[0]);
      const usage = await usageRows(client, 'usage.invocation_id = $1', [
        completion.invocationId,
      ]);
      const settlements = await quotaSettlementRows(
        client,
        'settlement.invocation_id = $1',
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
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    const starts = await startRows(client, 'start.invocation_id = $1', [
      completion.invocationId,
    ]);
    if (
      starts.length !== 1 ||
      JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
    ) {
      throw new ModelInvocationConflictError();
    }
    await assertCurrent(client, command.stepRunMutation, completion.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertCompletion(client, completion);
    if (expectedUsage) await insertUsage(client, expectedUsage);
    await insertQuotaSettlement(client, expectedSettlement);
    return Object.freeze({
      status: 'created' as const,
      record: completion,
    });
  });
}

export async function completeWithPricingOperation(
  pool: PostgresPool,
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
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const quoteRows = await priceQuoteRows(client, 'quote.invocation_id = $1', [
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
    const reservationRows = await quotaReservationRows(
      client,
      'reservation.invocation_id = $1',
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
    const existing = await completionRows(
      client,
      `completion.invocation_id = $1 OR
         completion.mutation_id = $2 OR completion.run_event_id = $3`,
      [
        completion.invocationId,
        completion.stepRunMutationId,
        completion.runEventId,
      ],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const [usage, priceSettlements, quotaSettlements] = await Promise.all([
        usageRows(client, 'usage.invocation_id = $1', [
          completion.invocationId,
        ]),
        priceSettlementRows(client, 'settlement.invocation_id = $1', [
          completion.invocationId,
        ]),
        quotaSettlementRows(client, 'settlement.invocation_id = $1', [
          completion.invocationId,
        ]),
      ]);
      const stored = parseCompletion(existing[0]);
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
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    const starts = await startRows(client, 'start.invocation_id = $1', [
      completion.invocationId,
    ]);
    if (
      starts.length !== 1 ||
      JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
    ) {
      throw new ModelInvocationConflictError();
    }
    await assertCurrent(client, command.stepRunMutation, completion.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertCompletion(client, completion);
    if (expectedUsage) await insertUsage(client, expectedUsage);
    if (expectedPriceSettlement) {
      await insertPriceSettlement(client, expectedPriceSettlement);
    }
    if (expectedQuotaSettlement) {
      await insertQuotaSettlement(client, expectedQuotaSettlement);
    }
    return Object.freeze({
      status: 'created' as const,
      record: completion,
    });
  });
}

export async function completeWithPromptOutputArtifactOperation(
  pool: PostgresPool,
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
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const quoteRows = await priceQuoteRows(client, 'quote.invocation_id = $1', [
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
    const reservationRows = await quotaReservationRows(
      client,
      'reservation.invocation_id = $1',
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
    const existing = await completionRows(
      client,
      `completion.invocation_id = $1 OR
         completion.mutation_id = $2 OR completion.run_event_id = $3`,
      [
        completion.invocationId,
        completion.stepRunMutationId,
        completion.runEventId,
      ],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const [storedArtifact, usage, priceSettlements, quotaSettlements] =
        await Promise.all([
          readPostgresPluginPackagePromptOutputArtifactInTransaction(
            client,
            binding.artifact.artifactId,
          ),
          usageRows(client, 'usage.invocation_id = $1', [
            completion.invocationId,
          ]),
          priceSettlementRows(client, 'settlement.invocation_id = $1', [
            completion.invocationId,
          ]),
          quotaSettlementRows(client, 'settlement.invocation_id = $1', [
            completion.invocationId,
          ]),
        ]);
      const stored = parseCompletion(existing[0]);
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
      return Object.freeze({
        status: 'existing' as const,
        record: stored,
        artifact: storedArtifact,
        reference: binding.reference,
      });
    }
    const starts = await startRows(client, 'start.invocation_id = $1', [
      completion.invocationId,
    ]);
    if (
      starts.length !== 1 ||
      JSON.stringify(parseStart(starts[0]!)) !== JSON.stringify(command.start)
    ) {
      throw new ModelInvocationConflictError();
    }
    await assertCurrent(client, command.stepRunMutation, completion.projectId);
    const artifact = (
      await putPostgresPluginPackagePromptOutputArtifactInTransaction(
        client,
        binding.artifact,
      )
    ).artifact;
    await applyMutation(client, command.stepRunMutation);
    await insertCompletion(client, completion);
    if (expectedUsage) await insertUsage(client, expectedUsage);
    if (expectedPriceSettlement) {
      await insertPriceSettlement(client, expectedPriceSettlement);
    }
    if (expectedQuotaSettlement) {
      await insertQuotaSettlement(client, expectedQuotaSettlement);
    }
    return Object.freeze({
      status: 'created' as const,
      record: completion,
      artifact,
      reference: binding.reference,
    });
  });
}
