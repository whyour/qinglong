// Cluster Plugin Package lifecycle boundary; keep quarantine authority explicit.
import type {
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import {
  InvalidPluginPackageQuarantineError,
  normalizePluginPackageQuarantineEvent,
  type PluginPackageQuarantineEvent,
  type PluginPackageQuarantineRepository,
  type PluginPackageWithdrawalReceipt,
} from '@qinglong/runtime-core/plugin-package-quarantine';
import {
  PostgresPluginPackageQuarantineRepository,
  assertPostgresPackageExecutorSchemaReady,
  type PostgresSchemaReadinessReport,
} from '@qinglong/cluster-postgres/package-executor';

export const CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT = 128;

export interface ClusterPluginPackageQuarantineService {
  quarantine(
    events: readonly Readonly<PluginPackageQuarantineEvent>[],
    confirmAuthorization: (
      event: Readonly<PluginPackageQuarantineEvent>,
    ) => void | Promise<void>,
  ): Promise<
    readonly Readonly<{
      status: 'created' | 'existing';
      eventDigest: string;
      receipt: Readonly<PluginPackageWithdrawalReceipt>;
    }>[]
  >;
}

export interface RunClusterPluginPackageQuarantineOptions {
  readonly openDatabase: OpenPostgresDatabase;
  readonly events: readonly Readonly<PluginPackageQuarantineEvent>[];
  readonly confirmAuthorization: (
    event: Readonly<PluginPackageQuarantineEvent>,
  ) => void | Promise<void>;
}

export interface ClusterPluginPackageQuarantineRun {
  readonly database: PostgresSchemaReadinessReport;
  readonly results: readonly Readonly<{
    status: 'created' | 'existing';
    eventDigest: string;
    receipt: Readonly<PluginPackageWithdrawalReceipt>;
  }>[];
}

function targetKey(event: Readonly<PluginPackageQuarantineEvent>): string {
  return [
    event.target.projectId,
    event.target.packageName,
    event.target.installationId,
    event.target.lockDigest,
  ].join('\0');
}

function normalizedBatch(
  events: readonly Readonly<PluginPackageQuarantineEvent>[],
): readonly Readonly<PluginPackageQuarantineEvent>[] {
  if (
    !Array.isArray(events) ||
    events.length < 1 ||
    events.length > CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT ||
    Object.keys(events).some((key, index) => key !== String(index))
  ) {
    throw new InvalidPluginPackageQuarantineError(
      `events must contain 1-${CLUSTER_PLUGIN_PACKAGE_QUARANTINE_BATCH_LIMIT} dense items`,
    );
  }
  const normalized = events.map(normalizePluginPackageQuarantineEvent);
  const eventDigests = new Set<string>();
  const targets = new Set<string>();
  for (const event of normalized) {
    const target = targetKey(event);
    if (eventDigests.has(event.eventDigest) || targets.has(target)) {
      throw new InvalidPluginPackageQuarantineError(
        'batch event digests and targets must be unique',
      );
    }
    eventDigests.add(event.eventDigest);
    targets.add(target);
  }
  return Object.freeze(normalized);
}

export function createClusterPluginPackageQuarantineService(
  repository: PluginPackageQuarantineRepository,
): Readonly<ClusterPluginPackageQuarantineService> {
  if (
    !repository ||
    typeof repository.findTargetsByLockDigest !== 'function' ||
    typeof repository.findByEventDigest !== 'function' ||
    typeof repository.quarantine !== 'function'
  ) {
    throw new TypeError(
      'Cluster Plugin Package quarantine repository is invalid',
    );
  }
  return Object.freeze({
    async quarantine(
      events: readonly Readonly<PluginPackageQuarantineEvent>[],
      confirmAuthorization: (
        event: Readonly<PluginPackageQuarantineEvent>,
      ) => void | Promise<void>,
    ) {
      const batch = normalizedBatch(events);
      if (typeof confirmAuthorization !== 'function') {
        throw new InvalidPluginPackageQuarantineError(
          'confirmAuthorization is invalid',
        );
      }
      const results = [];
      for (const event of batch) {
        const result = await repository.quarantine(event, () =>
          confirmAuthorization(event),
        );
        results.push(
          Object.freeze({
            status: result.status,
            eventDigest: event.eventDigest,
            receipt: result.receipt,
          }),
        );
      }
      return Object.freeze(results);
    },
  });
}

export async function runClusterPluginPackageQuarantine(
  options: RunClusterPluginPackageQuarantineOptions,
): Promise<Readonly<ClusterPluginPackageQuarantineRun>> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(
      'Cluster Plugin Package quarantine options are invalid',
    );
  }
  if (
    Object.keys(options).some(
      (key) =>
        !['openDatabase', 'events', 'confirmAuthorization'].includes(key),
    ) ||
    typeof options.openDatabase !== 'function'
  ) {
    throw new TypeError(
      'Cluster Plugin Package quarantine options shape is invalid',
    );
  }
  const events = normalizedBatch(options.events);
  if (typeof options.confirmAuthorization !== 'function') {
    throw new InvalidPluginPackageQuarantineError(
      'confirmAuthorization is invalid',
    );
  }
  let database: PostgresDatabaseResource | undefined;
  try {
    database = await options.openDatabase();
    const evidence = await assertPostgresPackageExecutorSchemaReady(
      database.pool,
    );
    const results =
      await createClusterPluginPackageQuarantineService(
        new PostgresPluginPackageQuarantineRepository(database.pool),
      ).quarantine(events, options.confirmAuthorization);
    return Object.freeze({ database: evidence, results });
  } finally {
    await database?.close();
  }
}
