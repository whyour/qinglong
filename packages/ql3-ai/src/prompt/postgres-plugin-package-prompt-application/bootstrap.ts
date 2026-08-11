import type { OpenPostgresDatabase } from '@qinglong/runtime-core';

import { PostgresModelInvocationRepository } from '../../model-invocation/postgresModelInvocationRepository';
import { PostgresModelPriceCatalogReader } from '../../pricing/storage/postgresModelPriceCatalogRepository';
import { PluginPackagePromptExecutor } from '../pluginPackagePromptExecutor';
import {
  PostgresPluginPackagePromptAdmissionRepository,
  type PostgresPluginPackagePromptAdmissionMutationGuard,
} from '../postgresPluginPackagePromptAdmissionRepository';
import { PostgresPluginPackagePromptExecutionInspectionRepository } from '../postgresPluginPackagePromptExecutionInspectionRepository';
import {
  PluginPackagePromptOutputCompletionCoordinator,
  type PluginPackagePromptOutputCompletionCapability,
} from '../../prompt-output/pluginPackagePromptOutputCompletion';
import type { PluginPackagePromptOutputReadService } from '../../prompt-output/pluginPackagePromptOutputRead';
import type { PluginPackagePromptExecutionOutputReadService } from '../../prompt-output/pluginPackagePromptExecutionOutputRead';
import { bootstrapModelGatewayProfile } from '../../profile/profileComposition';
import {
  PostgresPluginPackagePromptApplicationUnavailableError,
  unavailable,
  type BootstrapPostgresPluginPackagePromptApplicationOptions,
  type BootstrapPostgresPluginPackagePromptApplicationResult,
} from './contracts';
import {
  PostgresPluginPackagePromptCatalogService,
  PostgresPluginPackagePromptExecutionService,
} from './services';
import { assertPostgresPluginPackagePromptApplicationReady } from './readiness';

function assertAudit(
  value: unknown,
): asserts value is BootstrapPostgresPluginPackagePromptApplicationOptions['audit'] {
  if (typeof value !== 'function') {
    throw new TypeError('PostgreSQL Package Prompt audit sink is invalid');
  }
}

function assertEnabledOptions(
  options: Extract<
    BootstrapPostgresPluginPackagePromptApplicationOptions,
    { enabled: true }
  >,
): void {
  if (
    typeof options.openDatabase !== 'function' ||
    typeof options.loadProviders !== 'function' ||
    (options.assertReady !== undefined &&
      typeof options.assertReady !== 'function') ||
    (options.confirmActive !== undefined &&
      typeof options.confirmActive !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.promptOutputKeys !== undefined &&
      (!options.promptOutputKeys ||
        typeof options.promptOutputKeys !== 'object' ||
        typeof options.promptOutputKeys.active !== 'function' ||
        typeof options.promptOutputKeys.resolve !== 'function')) ||
    (options.promptOutputRead !== undefined &&
      (!options.promptOutputRead ||
        typeof options.promptOutputRead !== 'object' ||
        Array.isArray(options.promptOutputRead) ||
        !['authorizer', 'authorizer\0retention'].includes(
          Object.keys(options.promptOutputRead).sort().join('\0'),
        ) ||
        options.promptOutputKeys === undefined ||
        !options.promptOutputRead.authorizer ||
        typeof options.promptOutputRead.authorizer.authorize !== 'function' ||
        (options.promptOutputRead.retention !== undefined &&
          (!options.promptOutputRead.retention ||
            typeof options.promptOutputRead.retention.inspect !== 'function'))))
  ) {
    throw new TypeError('PostgreSQL Package Prompt options are invalid');
  }
}

/**
 * Explicit Cluster-only composition root. Disabled mode is loader-free. Active
 * mode proves PostgreSQL readiness and bounded recovery before provider load.
 */
export async function bootstrapPostgresPluginPackagePromptApplication(
  options: BootstrapPostgresPluginPackagePromptApplicationOptions,
): Promise<BootstrapPostgresPluginPackagePromptApplicationResult> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('PostgreSQL Package Prompt options are invalid');
  }
  assertAudit(options.audit);
  if (options.enabled !== true) {
    await options.audit({ profile: 'cluster', state: 'disabled' });
    return Object.freeze({
      status: 'disabled' as const,
      profile: 'cluster' as const,
      stop: async () => 'stopped' as const,
    });
  }
  assertEnabledOptions(options);

  let database: Awaited<ReturnType<OpenPostgresDatabase>> | undefined;
  let storageOwnedByProfile = false;
  try {
    database = await options.openDatabase();
    const readiness = await (
      options.assertReady ?? assertPostgresPluginPackagePromptApplicationReady
    )(database.pool);
    const repository = new PostgresModelInvocationRepository(database.pool);
    const pricing = new PostgresModelPriceCatalogReader(database.pool);
    const activeDatabase = database;
    let durableOutput:
      | PluginPackagePromptOutputCompletionCapability
      | undefined;
    const gateway = await bootstrapModelGatewayProfile({
      enabled: true,
      profile: 'cluster',
      loadStorage: async () => {
        storageOwnedByProfile = true;
        return Object.freeze({
          repository,
          pricing,
          close: () => activeDatabase.close(),
        });
      },
      loadProviders: options.loadProviders,
      ...(options.promptOutputKeys === undefined
        ? {}
        : {
            createSuccessfulCompletion: (coordinator) => {
              durableOutput =
                new PluginPackagePromptOutputCompletionCoordinator({
                  coordinator,
                  keys: options.promptOutputKeys!,
                  ...(options.now === undefined ? {} : { now: options.now }),
                });
              return durableOutput;
            },
          }),
      audit: options.audit,
      ...(options.confirmActive === undefined
        ? {}
        : { confirmActive: options.confirmActive }),
      ...(options.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrent }),
      ...(options.recoveryLimit === undefined
        ? {}
        : { recoveryLimit: options.recoveryLimit }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (gateway.status !== 'active') throw unavailable();
    const capability = gateway.capability;
    const createPromptExecutor = (
      guard?: PostgresPluginPackagePromptAdmissionMutationGuard,
    ) =>
      new PluginPackagePromptExecutor({
        admissions: new PostgresPluginPackagePromptAdmissionRepository(
          activeDatabase.pool,
          guard,
        ),
        invocations: repository,
        gateway: capability,
        ...(durableOutput === undefined ? {} : { durableOutput }),
      });
    const prompts = createPromptExecutor();
    const promptCatalog = new PostgresPluginPackagePromptCatalogService(
      activeDatabase.pool,
    );
    const promptExecutions = new PostgresPluginPackagePromptExecutionService(
      activeDatabase.pool,
      (guard) => createPromptExecutor(guard),
    );
    const promptExecutionInspections =
      new PostgresPluginPackagePromptExecutionInspectionRepository(
        activeDatabase.pool,
      );
    let promptOutputs: PluginPackagePromptOutputReadService | undefined;
    let promptExecutionOutputs:
      | PluginPackagePromptExecutionOutputReadService
      | undefined;
    if (options.promptOutputRead !== undefined) {
      const [
        { PostgresPluginPackagePromptOutputArtifactRepository },
        { PostgresPluginPackagePromptOutputRetentionRepository },
        { PluginPackagePromptOutputReadService },
        { PluginPackagePromptExecutionOutputReadService },
        { PostgresPluginPackagePromptExecutionOutputReferenceRepository },
      ] = await Promise.all([
        import(
          '../../prompt-output/storage/postgresPluginPackagePromptOutputArtifactRepository.js'
        ),
        import(
          '../../prompt-output/storage/postgresPluginPackagePromptOutputRetentionRepository.js'
        ),
        import('../../prompt-output/pluginPackagePromptOutputRead.js'),
        import('../../prompt-output/pluginPackagePromptExecutionOutputRead.js'),
        import(
          '../../prompt-output/storage/postgresPluginPackagePromptExecutionOutputReferenceRepository.js'
        ),
      ]);
      promptOutputs = new PluginPackagePromptOutputReadService({
        artifacts: new PostgresPluginPackagePromptOutputArtifactRepository(
          activeDatabase.pool,
        ),
        authorizer: options.promptOutputRead.authorizer,
        retention:
          options.promptOutputRead.retention ??
          new PostgresPluginPackagePromptOutputRetentionRepository(
            activeDatabase.pool,
          ),
        keys: options.promptOutputKeys!,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      promptExecutionOutputs =
        new PluginPackagePromptExecutionOutputReadService({
          references:
            new PostgresPluginPackagePromptExecutionOutputReferenceRepository(
              activeDatabase.pool,
            ),
          outputs: promptOutputs,
        });
    }
    return Object.freeze({
      status: 'active' as const,
      profile: 'cluster' as const,
      readiness,
      capability,
      prompts,
      promptCatalog,
      promptExecutions,
      promptExecutionInspections,
      ...(promptOutputs === undefined ? {} : { promptOutputs }),
      ...(promptExecutionOutputs === undefined
        ? {}
        : { promptExecutionOutputs }),
      stop: () => capability.stop(),
    });
  } catch (cause) {
    if (database && !storageOwnedByProfile) {
      try {
        await database.close();
      } catch {
        // Preserve the activation failure.
      }
    }
    throw cause instanceof
      PostgresPluginPackagePromptApplicationUnavailableError
      ? cause
      : unavailable(cause);
  }
}
