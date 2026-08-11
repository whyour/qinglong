import type { PostgresPool } from '@qinglong/runtime-core';

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
import { unavailable } from './authority';
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

export class PostgresModelInvocationRepository
  implements
    ModelInvocationRepository,
    ModelInvocationResolutionRepository,
    ModelInvocationUsageLedgerRepository,
    QuotaAwareModelInvocationRepository,
    PricingAwareModelInvocationRepository,
    PluginPackagePromptOutputCompletionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw unavailable();
    }
  }

  async findStart(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationStartRecord> | null> {
    return findStartOperation(this.pool, invocationIdValue);
  }

  async findCompletion(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationCompletionRecord> | null> {
    return findCompletionOperation(this.pool, invocationIdValue);
  }

  async findPromptOutputArtifact(
    artifactIdValue: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifact> | null> {
    return findPromptOutputArtifactOperation(this.pool, artifactIdValue);
  }

  async findPromptOutputArtifactTombstone(
    artifactIdValue: string,
  ): Promise<Readonly<PluginPackagePromptOutputArtifactTombstone> | null> {
    return findPromptOutputArtifactTombstoneOperation(
      this.pool,
      artifactIdValue,
    );
  }

  async findUsage(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationUsageLedgerRecord> | null> {
    return findUsageOperation(this.pool, invocationIdValue);
  }

  async findPriceQuote(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationPriceQuote> | null> {
    return findPriceQuoteOperation(this.pool, invocationIdValue);
  }

  async findPriceSettlement(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationPriceSettlement> | null> {
    return findPriceSettlementOperation(this.pool, invocationIdValue);
  }

  async findQuotaReservation(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationQuotaReservation> | null> {
    return findQuotaReservationOperation(this.pool, invocationIdValue);
  }

  async findQuotaSettlement(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationQuotaSettlement> | null> {
    return findQuotaSettlementOperation(this.pool, invocationIdValue);
  }

  async readQuotaWindowUsage(
    projectIdValue: string,
    atMsValue?: number,
  ): Promise<Readonly<ModelInvocationQuotaWindowUsage> | null> {
    return readQuotaWindowUsageOperation(this.pool, projectIdValue, atMsValue);
  }

  async listProjectUsage(
    queryValue: ModelInvocationUsageLedgerQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerPage>> {
    return listProjectUsageOperation(this.pool, queryValue);
  }

  async summarizeProjectUsage(
    queryValue: ModelInvocationUsageLedgerSummaryQuery,
  ): Promise<Readonly<ModelInvocationUsageLedgerSummary>> {
    return summarizeProjectUsageOperation(this.pool, queryValue);
  }

  async findResolution(
    invocationIdValue: string,
  ): Promise<Readonly<ModelInvocationResolutionRecord> | null> {
    return findResolutionOperation(this.pool, invocationIdValue);
  }

  async readAuthority(
    identity: Readonly<{
      projectId: string;
      runId: string;
      stepRunId: string;
    }>,
  ): Promise<Readonly<ModelInvocationAuthoritySnapshot> | null> {
    return readAuthorityOperation(this.pool, identity);
  }

  async listIncomplete(
    limitValue: number,
  ): Promise<Readonly<ModelInvocationRecoveryPage>> {
    return listIncompleteOperation(this.pool, limitValue);
  }

  async admit(
    commandValue: ModelInvocationStartCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>
  > {
    return admitOperation(this.pool, commandValue);
  }

  async admitWithQuota(
    commandValue: ModelInvocationStartCommand,
    admissionValue: ModelInvocationQuotaAdmission,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>
  > {
    return admitWithQuotaOperation(this.pool, commandValue, admissionValue);
  }

  async admitWithPricing(
    commandValue: ModelInvocationStartCommand,
    quoteValue: ModelInvocationPriceQuote,
    admissionValue?: ModelInvocationQuotaAdmission,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationStartRecord>>
  > {
    return admitWithPricingOperation(
      this.pool,
      commandValue,
      quoteValue,
      admissionValue,
    );
  }

  async complete(
    commandValue: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  > {
    return completeOperation(this.pool, commandValue);
  }

  async completeWithQuota(
    commandValue: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  > {
    return completeWithQuotaOperation(this.pool, commandValue);
  }

  async completeWithPricing(
    commandValue: ModelInvocationCompletionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationCompletionRecord>>
  > {
    return completeWithPricingOperation(this.pool, commandValue);
  }

  async completeWithPromptOutputArtifact(
    commandValue: ModelInvocationCompletionCommand,
    artifactValue: PluginPackagePromptOutputArtifact,
  ): Promise<Readonly<CommitPluginPackagePromptOutputResult>> {
    return completeWithPromptOutputArtifactOperation(
      this.pool,
      commandValue,
      artifactValue,
    );
  }

  async resolve(
    commandValue: ModelInvocationResolutionCommand,
  ): Promise<
    Readonly<CommitModelInvocationResult<ModelInvocationResolutionRecord>>
  > {
    return resolveOperation(this.pool, commandValue);
  }
}
