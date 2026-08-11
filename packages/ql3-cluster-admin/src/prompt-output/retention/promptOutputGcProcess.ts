/** Prompt Output garbage collection PostgreSQL process boundary. */
import type { OpenPostgresDatabase } from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/ai-maintenance';
import {
  PostgresPluginPackagePromptOutputGarbageCollector,
  assertPostgresPluginPackagePromptOutputMaintenanceReady,
  type PostgresPluginPackagePromptOutputMaintenanceReadinessReport,
} from '@qinglong/ai/postgres-plugin-package-prompt-output-retention-storage';
import {
  createPluginPackagePromptOutputRetentionPolicyCatalogResolver,
  type PluginPackagePromptOutputRetentionPolicyCatalog,
} from '@qinglong/ai/plugin-package-prompt-output-retention';

export interface RunClusterPromptOutputGcProcessOptions {
  readonly database: Readonly<{
    readonly connection: PostgresConnectionOptions;
    readonly pool?: PostgresPoolOptions;
  }>;
  readonly retentionPolicyCatalog: PluginPackagePromptOutputRetentionPolicyCatalog;
  readonly limit?: number;
  readonly openDatabase?: OpenPostgresDatabase;
}

export interface ClusterPromptOutputGcProcessResult {
  readonly readiness: PostgresPluginPackagePromptOutputMaintenanceReadinessReport;
  readonly scanned: number;
  readonly tombstoned: number;
  readonly skipped: number;
  readonly hasMore: boolean;
}

export class ClusterPromptOutputGcProcessConfigError extends TypeError {
  readonly code = 'QL3_PROMPT_OUTPUT_GC_PROCESS_CONFIG_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Prompt output GC process configuration is invalid: ${message}`);
    this.name = 'ClusterPromptOutputGcProcessConfigError';
  }
}

export async function runClusterPromptOutputGcProcess(
  options: RunClusterPromptOutputGcProcessOptions,
): Promise<Readonly<ClusterPromptOutputGcProcessResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !options.database ||
    typeof options.database !== 'object' ||
    Array.isArray(options.database)
  ) {
    throw new ClusterPromptOutputGcProcessConfigError('options are invalid');
  }
  let policies;
  try {
    policies = createPluginPackagePromptOutputRetentionPolicyCatalogResolver(
      options.retentionPolicyCatalog,
    );
  } catch (cause) {
    throw new ClusterPromptOutputGcProcessConfigError(
      'retention policy catalog is invalid',
      cause,
    );
  }
  let poolError: Error | undefined;
  const openDatabase =
    options.openDatabase ??
    createPostgresDatabaseOpener({
      role: 'ai-maintenance',
      connection: options.database.connection,
      ...(options.database.pool === undefined
        ? {}
        : { pool: options.database.pool }),
      onPoolError(error) {
        poolError ??= error;
      },
    });
  const database = await openDatabase();
  let failure: unknown;
  try {
    const readiness =
      await assertPostgresPluginPackagePromptOutputMaintenanceReady(
        database.pool,
      );
    const result = await new PostgresPluginPackagePromptOutputGarbageCollector({
      pool: database.pool,
      policies,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }).collect();
    if (poolError) throw poolError;
    return Object.freeze({ readiness, ...result });
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    try {
      await database.close();
    } catch (closeError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, closeError],
          'Prompt output GC failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
}
