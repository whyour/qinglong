import type { DatabaseSync } from 'node:sqlite';

import {
  type ModelInvocationPriceQuote,
  type ModelInvocationPriceSettlement,
  type PricingAwareModelInvocationRepository,
} from '../../pricing/pricing';
import { type PluginPackagePromptOutputArtifact } from '../../prompt-output/pluginPackagePromptOutputArtifact';
import {
  type CommitPluginPackagePromptOutputResult,
  type PluginPackagePromptOutputCompletionRepository,
} from '../../prompt-output/pluginPackagePromptOutputCompletion';
import type { PluginPackagePromptOutputArtifactTombstone } from '../../prompt-output/pluginPackagePromptOutputRetention';
import {
  type ModelInvocationUsageLedgerPage,
  type ModelInvocationUsageLedgerQuery,
  type ModelInvocationUsageLedgerRecord,
  type ModelInvocationUsageLedgerRepository,
  type ModelInvocationUsageLedgerSummary,
  type ModelInvocationUsageLedgerSummaryQuery,
} from '../../usage/usageLedger';
import {
  type ModelInvocationQuotaAdmission,
  type ModelInvocationQuotaReservation,
  type ModelInvocationQuotaSettlement,
  type ModelInvocationQuotaWindowUsage,
  type QuotaAwareModelInvocationRepository,
} from '../../usage/usageQuota';
import {
  type CommitModelInvocationResult,
  type ModelInvocationAuthoritySnapshot,
  type ModelInvocationCompletionCommand,
  type ModelInvocationCompletionRecord,
  type ModelInvocationRecoveryPage,
  type ModelInvocationRepository,
  type ModelInvocationStartCommand,
  type ModelInvocationStartRecord,
} from '../modelInvocation';
import {
  type ModelInvocationResolutionCommand,
  type ModelInvocationResolutionRecord,
  type ModelInvocationResolutionRepository,
} from '../modelInvocationResolution';

import {
  admitOperation,
  admitWithPricingOperation,
  admitWithQuotaOperation,
} from './admissionOperations';
import {
  PrivateLocalAuthority,
  isAuthority,
  type LocalModelInvocationOperationAuthority,
} from './authority';
import {
  completeOperation,
  completeWithPricingOperation,
  completeWithPromptOutputArtifactOperation,
  completeWithQuotaOperation,
} from './completionOperations';
import {
  findCompletionOperation,
  findPriceQuoteOperation,
  findPriceSettlementOperation,
  findPromptOutputArtifactOperation,
  findPromptOutputArtifactTombstoneOperation,
  findQuotaReservationOperation,
  findQuotaSettlementOperation,
  findStartOperation,
  findUsageOperation,
  listProjectUsageOperation,
  readQuotaWindowUsageOperation,
  summarizeProjectUsageOperation,
} from './readOperations';
import {
  findResolutionOperation,
  listIncompleteOperation,
  readAuthorityOperation,
  resolveOperation,
} from './recoveryResolutionOperations';

export class LocalModelInvocationRepository
  implements
    ModelInvocationRepository,
    ModelInvocationResolutionRepository,
    ModelInvocationUsageLedgerRepository,
    QuotaAwareModelInvocationRepository,
    PricingAwareModelInvocationRepository,
    PluginPackagePromptOutputCompletionRepository
{
  readonly #authority: LocalModelInvocationOperationAuthority;
  readonly #client: DatabaseSync;

  constructor(
    authority: LocalModelInvocationOperationAuthority | DatabaseSync,
  ) {
    this.#authority = isAuthority(authority)
      ? authority
      : new PrivateLocalAuthority(authority);
    this.#client = this.#authority.client;
  }

  findStart(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationStartRecord> | null> {
    return findStartOperation(this.#authority, this.#client, invocationIdValue);
  }

  findCompletion(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationCompletionRecord> | null> {
    return findCompletionOperation(
      this.#authority,
      this.#client,
      invocationIdValue,
    );
  }

  findPromptOutputArtifact(
    artifactIdValue: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
    return findPromptOutputArtifactOperation(
      this.#authority,
      this.#client,
      artifactIdValue,
    );
  }

  findPromptOutputArtifactTombstone(
    artifactIdValue: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone> | null> {
    return findPromptOutputArtifactTombstoneOperation(
      this.#authority,
      this.#client,
      artifactIdValue,
    );
  }

  findUsage(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationUsageLedgerRecord> | null> {
    return findUsageOperation(this.#authority, this.#client, invocationIdValue);
  }

  findPriceQuote(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationPriceQuote> | null> {
    return findPriceQuoteOperation(
      this.#authority,
      this.#client,
      invocationIdValue,
    );
  }

  findPriceSettlement(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationPriceSettlement> | null> {
    return findPriceSettlementOperation(
      this.#authority,
      this.#client,
      invocationIdValue,
    );
  }

  findQuotaReservation(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationQuotaReservation> | null> {
    return findQuotaReservationOperation(
      this.#authority,
      this.#client,
      invocationIdValue,
    );
  }

  findQuotaSettlement(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationQuotaSettlement> | null> {
    return findQuotaSettlementOperation(
      this.#authority,
      this.#client,
      invocationIdValue,
    );
  }

  readQuotaWindowUsage(
    projectIdValue: string,
    atMsValue?: number,
  ): Promise<Readonly<ModelInvocationQuotaWindowUsage> | null> {
    return readQuotaWindowUsageOperation(
      this.#authority,
      this.#client,
      projectIdValue,
      atMsValue,
    );
  }

  listProjectUsage(
    queryValue: ModelInvocationUsageLedgerQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerPage>> {
    return listProjectUsageOperation(this.#authority, this.#client, queryValue);
  }

  summarizeProjectUsage(
    queryValue: ModelInvocationUsageLedgerSummaryQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerSummary>> {
    return summarizeProjectUsageOperation(
      this.#authority,
      this.#client,
      queryValue,
    );
  }

  findResolution(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationResolutionRecord> | null> {
    return findResolutionOperation(
      this.#authority,
      this.#client,
      invocationIdValue,
    );
  }

  readAuthority(
    identity: Readonly<{
      projectId: string;
      runId: string;
      stepRunId: string;
    }>,
  ): Promise<Readonly<ModelInvocationAuthoritySnapshot> | null> {
    return readAuthorityOperation(this.#authority, this.#client, identity);
  }

  listIncomplete(
    limitValue: number,
  ): Promise<Readonly<ModelInvocationRecoveryPage>> {
    return listIncompleteOperation(this.#authority, this.#client, limitValue);
  }

  admit(
    commandValue: ModelInvocationStartCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>
  > {
    return admitOperation(this.#authority, this.#client, commandValue);
  }

  admitWithQuota(
    commandValue: ModelInvocationStartCommand,
    admissionValue: ModelInvocationQuotaAdmission,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>
  > {
    return admitWithQuotaOperation(
      this.#authority,
      this.#client,
      commandValue,
      admissionValue,
    );
  }

  admitWithPricing(
    commandValue: ModelInvocationStartCommand,
    quoteValue: ModelInvocationPriceQuote,
    admissionValue?: ModelInvocationQuotaAdmission,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>
  > {
    return admitWithPricingOperation(
      this.#authority,
      this.#client,
      commandValue,
      quoteValue,
      admissionValue,
    );
  }

  complete(
    commandValue: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  > {
    return completeOperation(this.#authority, this.#client, commandValue);
  }

  completeWithQuota(
    commandValue: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  > {
    return completeWithQuotaOperation(
      this.#authority,
      this.#client,
      commandValue,
    );
  }

  completeWithPricing(
    commandValue: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  > {
    return completeWithPricingOperation(
      this.#authority,
      this.#client,
      commandValue,
    );
  }

  completeWithPromptOutputArtifact(
    commandValue: ModelInvocationCompletionCommand,
    artifactValue: PluginPackagePromptOutputArtifact,
  ): Promise<Readonly<CommitPluginPackagePromptOutputResult>> {
    return completeWithPromptOutputArtifactOperation(
      this.#authority,
      this.#client,
      commandValue,
      artifactValue,
    );
  }

  resolve(
    commandValue: ModelInvocationResolutionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationResolutionRecord>>
  > {
    return resolveOperation(this.#authority, this.#client, commandValue);
  }
}
