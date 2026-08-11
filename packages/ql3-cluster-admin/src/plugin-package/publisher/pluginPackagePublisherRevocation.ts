// Cluster Plugin Package publisher boundary; keep revocation authority explicit.
import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import {
  normalizePluginPackagePublisherRevocationReceipt,
  type PluginPackagePublisherRevocationReceipt,
} from '@qinglong/runtime-core/plugin-package-publisher-provenance';
import {
  createPluginPackageQuarantineEvent,
  pluginPackageQuarantineMutationId,
} from '@qinglong/runtime-core/plugin-package-quarantine';
import {
  PostgresPluginPackagePublisherProvenanceRepository,
  PostgresPluginPackageQuarantineRepository,
  assertPostgresPackageExecutorSchemaReady,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/package-executor';

import {
  CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT,
  createClusterPluginPackageQuarantineService,
} from '../lifecycle/pluginPackageQuarantine';

export const MAX_CLUSTER_PLUGIN_PACKAGE_REVOCATION_PAGES = 64;

export interface RunClusterPluginPackagePublisherRevocationOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly receipt: Readonly<PluginPackagePublisherRevocationReceipt>;
  readonly confirmAuthorization: (
    receipt: Readonly<PluginPackagePublisherRevocationReceipt>,
  ) => void | Promise<void>;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ClusterPluginPackagePublisherRevocationRun {
  readonly database: PostgresSchemaReadinessReport;
  readonly receiptStatus: 'created' | 'existing';
  readonly receiptDigest: string;
  readonly impactDigest: string;
  readonly impacted: number;
  readonly pages: number;
  readonly quarantined: number;
  readonly existing: number;
  readonly remaining: boolean;
  readonly safeToAdmit: boolean;
}

function normalizedOptions(
  options: RunClusterPluginPackagePublisherRevocationOptions,
): Readonly<{
  receipt: Readonly<PluginPackagePublisherRevocationReceipt>;
  pageSize: number;
  maxPages: number;
}> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'openDatabase',
          'receipt',
          'confirmAuthorization',
          'pageSize',
          'maxPages',
        ].includes(key),
    ) ||
    typeof options.openDatabase !== 'function' ||
    typeof options.confirmAuthorization !== 'function'
  ) {
    throw new TypeError(
      'Cluster Plugin Package publisher revocation options are invalid',
    );
  }
  const pageSize = options.pageSize ?? 64;
  const maxPages = options.maxPages ?? 32;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > MAX_CLUSTER_PLUGIN_PACKAGE_REVOCATION_PAGES
  ) {
    throw new TypeError(
      'Cluster Plugin Package publisher revocation bounds are invalid',
    );
  }
  return Object.freeze({
    receipt: normalizePluginPackagePublisherRevocationReceipt(options.receipt),
    pageSize,
    maxPages,
  });
}

/**
 * Short-lived administration composition. The immutable revocation receipt
 * and its bounded impact are committed before quarantine materialization.
 * Re-running the same receipt converges on the same facts and skips targets
 * already quarantined or superseded by a newer installation head.
 */
export async function runClusterPluginPackagePublisherRevocation(
  options: RunClusterPluginPackagePublisherRevocationOptions,
): Promise<Readonly<ClusterPluginPackagePublisherRevocationRun>> {
  const normalized = normalizedOptions(options);
  let database: PostgresDatabaseResource | undefined;
  let result: Readonly<ClusterPluginPackagePublisherRevocationRun> | undefined;
  let failure: unknown;
  try {
    database = await options.openDatabase();
    const evidence = await assertPostgresPackageExecutorSchemaReady(
      database.pool,
    );
    const provenance =
      new PostgresPluginPackagePublisherProvenanceRepository(database.pool);
    const quarantine = createClusterPluginPackageQuarantineService(
      new PostgresPluginPackageQuarantineRepository(database.pool),
    );
    const impactResult = await provenance.recordRevocationImpact(
      normalized.receipt,
      () => options.confirmAuthorization(normalized.receipt),
    );
    let pages = 0;
    let quarantined = 0;
    let existing = 0;
    while (pages < normalized.maxPages) {
      const page = await provenance.listPendingQuarantineTargets(
        impactResult.impact.impactDigest,
        normalized.pageSize,
      );
      if (page.targets.length === 0) break;
      const events = page.targets.map((target) =>
        createPluginPackageQuarantineEvent({
          mutationId: pluginPackageQuarantineMutationId(
            normalized.receipt.receiptDigest,
            target,
          ),
          revocationReceiptDigest: normalized.receipt.receiptDigest,
          impactDigest: impactResult.impact.impactDigest,
          target,
          proposer: normalized.receipt.proposer,
          confirmer: normalized.receipt.confirmer,
          authorizationMode: normalized.receipt.authorizationMode,
          reasonCode: normalized.receipt.reasonCode,
          occurredAtMs: normalized.receipt.revokedAtMs,
        }),
      );
      const quarantineResults = await quarantine.quarantine(
        events,
        () => options.confirmAuthorization(normalized.receipt),
      );
      pages += 1;
      for (const item of quarantineResults) {
        if (item.status === 'created') quarantined += 1;
        else existing += 1;
      }
    }
    const probe = await provenance.listPendingQuarantineTargets(
      impactResult.impact.impactDigest,
      1,
    );
    const remaining = probe.targets.length > 0;
    result = Object.freeze({
      database: evidence,
      receiptStatus: impactResult.status,
      receiptDigest: normalized.receipt.receiptDigest,
      impactDigest: impactResult.impact.impactDigest,
      impacted: impactResult.impact.items.length,
      pages,
      quarantined,
      existing,
      remaining,
      safeToAdmit: !remaining,
    });
  } catch (error) {
    failure = error;
  }

  if (database) {
    try {
      await database.close();
    } catch (closeError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, closeError],
          'Cluster Plugin Package publisher revocation failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
  if (failure !== undefined) throw failure;
  if (!result) {
    throw new Error(
      'Cluster Plugin Package publisher revocation produced no result',
    );
  }
  return result;
}
