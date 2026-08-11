/** Prompt Output key rotation transaction composition boundary. */
import type { OpenPostgresDatabase } from '@qinglong/runtime-core';
import {
  createPostgresDatabaseOpener,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/ai-maintenance';
import {
  PluginPackagePromptOutputKeyRotationCoordinator,
  normalizePluginPackagePromptOutputKeyRotationRequest,
  type PluginPackagePromptOutputKeyRotationMaterialAuthority,
  type PluginPackagePromptOutputKeyRotationRequest,
} from '@qinglong/ai/plugin-package-prompt-output-key-rotation';
import { PostgresPluginPackagePromptOutputKeyRotationRepository } from '@qinglong/ai/postgres-plugin-package-prompt-output-key-rotation-storage';
import {
  assertPostgresPluginPackagePromptOutputMaintenanceReady,
  type PostgresPluginPackagePromptOutputMaintenanceReadinessReport,
} from '@qinglong/ai/postgres-plugin-package-prompt-output-retention-storage';

export interface RunClusterPromptOutputKeyRotationProcessOptions {
  readonly database: Readonly<{
    readonly connection: PostgresConnectionOptions;
    readonly pool?: PostgresPoolOptions;
  }>;
  readonly request: Readonly<PluginPackagePromptOutputKeyRotationRequest>;
  readonly material: Uint8Array;
  readonly materials: PluginPackagePromptOutputKeyRotationMaterialAuthority;
  readonly openDatabase?: OpenPostgresDatabase;
}

export interface ClusterPromptOutputKeyRotationProcessResult {
  readonly readiness: PostgresPluginPackagePromptOutputMaintenanceReadinessReport;
  readonly status: 'completed' | 'existing';
  readonly rotationId: string;
  readonly requestId: string;
  readonly mutationId: string;
  readonly preparationDigest: string;
  readonly completionDigest: string;
  readonly generation: number;
  readonly previousActiveKeyId: string;
  readonly activeKeyId: string;
  readonly catalogDigest: string;
  readonly materialProof: string;
  readonly completedAtMs: number;
}

export class ClusterPromptOutputKeyRotationProcessConfigError extends TypeError {
  readonly code = 'QL3_PROMPT_OUTPUT_KEY_ROTATION_PROCESS_CONFIG_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(
      `Prompt output key rotation process configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPromptOutputKeyRotationProcessConfigError';
  }
}

export async function runClusterPromptOutputKeyRotationProcess(
  options: RunClusterPromptOutputKeyRotationProcessOptions,
): Promise<Readonly<ClusterPromptOutputKeyRotationProcessResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !options.database ||
    typeof options.database !== 'object' ||
    Array.isArray(options.database) ||
    !(options.material instanceof Uint8Array) ||
    options.material.byteLength !== 32 ||
    !options.materials ||
    typeof options.materials !== 'object' ||
    typeof options.materials.rotate !== 'function'
  ) {
    throw new ClusterPromptOutputKeyRotationProcessConfigError(
      'options are invalid',
    );
  }
  let request;
  try {
    request = normalizePluginPackagePromptOutputKeyRotationRequest(
      options.request,
    );
  } catch (cause) {
    throw new ClusterPromptOutputKeyRotationProcessConfigError(
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
    const result = await new PluginPackagePromptOutputKeyRotationCoordinator({
      repository: new PostgresPluginPackagePromptOutputKeyRotationRepository({
        pool: database.pool,
      }),
      materials: options.materials,
    }).rotate({ request, material: options.material });
    if (poolError) throw poolError;
    return Object.freeze({
      readiness,
      status: result.status,
      rotationId: result.preparation.rotationId,
      requestId: result.preparation.requestId,
      mutationId: result.preparation.mutationId,
      preparationDigest: result.preparation.preparationDigest,
      completionDigest: result.completion.completionDigest,
      generation: result.completion.generation,
      previousActiveKeyId: result.completion.previousActiveKeyId,
      activeKeyId: result.completion.activeKeyId,
      catalogDigest: result.completion.catalogDigest,
      materialProof: result.completion.materialProof,
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
          'Prompt output key rotation failed and PostgreSQL did not close',
        );
      }
      throw closeError;
    }
  }
}
