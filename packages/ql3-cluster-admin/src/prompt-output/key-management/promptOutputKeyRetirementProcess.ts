/** Prompt Output key retirement transaction composition boundary. */
import type { OpenPostgresDatabase } from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/ai-maintenance';
import {
  PluginPackagePromptOutputKeyRetirementCoordinator,
  normalizePluginPackagePromptOutputKeyRetirementRequest,
  type PluginPackagePromptOutputKeyRetirementMaterialAuthority,
} from '@qinglong/ai/plugin-package-prompt-output-key-retirement';
import { PostgresPluginPackagePromptOutputKeyRetirementRepository } from '@qinglong/ai/postgres-plugin-package-prompt-output-key-retirement-storage';
import {
  assertPostgresPluginPackagePromptOutputMaintenanceReady,
  type PostgresPluginPackagePromptOutputMaintenanceReadinessReport,
} from '@qinglong/ai/postgres-plugin-package-prompt-output-retention-storage';

export interface RunClusterPromptOutputKeyRetirementProcessOptions {
  readonly database: Readonly<{
    readonly connection: PostgresConnectionOptions;
    readonly pool?: PostgresPoolOptions;
  }>;
  readonly request: Readonly<{
    readonly keyId: string;
    readonly retirementId: string;
    readonly requestId: string;
    readonly mutationId: string;
  }>;
  readonly materials: PluginPackagePromptOutputKeyRetirementMaterialAuthority;
  readonly openDatabase?: OpenPostgresDatabase;
}

export interface ClusterPromptOutputKeyRetirementProcessResult {
  readonly readiness: PostgresPluginPackagePromptOutputMaintenanceReadinessReport;
  readonly status: 'completed' | 'existing';
  readonly keyId: string;
  readonly retirementId: string;
  readonly preparationDigest: string;
  readonly completionDigest: string;
  readonly completedAtMs: number;
}

export class ClusterPromptOutputKeyRetirementProcessConfigError extends TypeError {
  readonly code = 'QL3_PROMPT_OUTPUT_KEY_RETIREMENT_PROCESS_CONFIG_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Prompt output key retirement process configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPromptOutputKeyRetirementProcessConfigError';
  }
}

export async function runClusterPromptOutputKeyRetirementProcess(
  options: RunClusterPromptOutputKeyRetirementProcessOptions,
): Promise<Readonly<ClusterPromptOutputKeyRetirementProcessResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !options.database ||
    typeof options.database !== 'object' ||
    Array.isArray(options.database) ||
    !options.materials ||
    typeof options.materials !== 'object' ||
    typeof options.materials.inspect !== 'function' ||
    typeof options.materials.retire !== 'function'
  ) {
    throw new ClusterPromptOutputKeyRetirementProcessConfigError(
      'options are invalid',
    );
  }
  let request;
  try {
    request = normalizePluginPackagePromptOutputKeyRetirementRequest(
      options.request,
    );
  } catch (cause) {
    throw new ClusterPromptOutputKeyRetirementProcessConfigError(
      'request is invalid',
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
    const result = await new PluginPackagePromptOutputKeyRetirementCoordinator({
      repository: new PostgresPluginPackagePromptOutputKeyRetirementRepository({
        pool: database.pool,
      }),
      materials: options.materials,
    }).retire(request);
    if (poolError) throw poolError;
    return Object.freeze({
      readiness,
      status: result.status,
      keyId: result.preparation.keyId,
      retirementId: result.preparation.retirementId,
      preparationDigest: result.preparation.preparationDigest,
      completionDigest: result.completion.completionDigest,
      completedAtMs: result.completion.completedAtMs,
    });
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
          'Prompt output key retirement failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
}
