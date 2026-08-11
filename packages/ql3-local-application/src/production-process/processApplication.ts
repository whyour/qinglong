import type { PluginPackageStageProvider } from '@qinglong/runtime-core/plugin-package-installation';
import type { PluginPackageLock } from '@qinglong/runtime-core/plugin-package-install';
import type { LocalAdoptedProfileAudit } from '@qinglong/local-admin/adopted-profile';
import type { LocalProfileStorageAudit } from '@qinglong/local-sqlite/profile';

import type {
  BootstrapLocalAiFeatureApplicationOptions,
  BootstrapLocalAiFeatureApplicationResult,
  LocalAiFeatureApplicationAudit,
  LocalAiFeatureDeploymentOptions,
} from '../application-runtime/aiFeatureApplication';
import type {
  LocalApplicationActivationAudit,
  LocalApplicationProductSurface,
  LocalApplicationStopResult,
} from '../application-runtime/contract';
import {
  loadLocalApplicationProcessConfig,
  type LocalApplicationProcessConfig,
} from './processConfig';
import { verifyLocalApplicationCutoverCommitment } from './cutoverCommitment';
import { recordLocalApplicationShutdownReceipt } from './shutdownReceipt';
import { recordLocalApplicationStartupReceipt } from './startupReceipt';

export type LocalApplicationProcessSignal = 'SIGINT' | 'SIGTERM';

export interface LocalApplicationProcessEvent {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-local-application';
  readonly level: 'info' | 'error';
  readonly event: string;
  readonly instanceId: string;
  readonly profile: LocalApplicationProcessConfig['profile'];
  readonly signal?: LocalApplicationProcessSignal;
  readonly stopResult?: LocalApplicationStopResult;
  readonly aiStatus?:
    | 'deployment_excluded'
    | 'schema_absent'
    | 'inactive'
    | 'active';
  readonly dependencyActivation?: Readonly<{
    scope: 'storage' | 'adoption';
    state: string;
  }>;
  readonly applicationActivation?: LocalApplicationActivationAudit;
  readonly aiActivation?: LocalAiFeatureApplicationAudit;
}

export interface LocalApplicationProcessSignalSource {
  subscribe(
    listener: (signal: LocalApplicationProcessSignal) => void,
  ): () => void;
}

export type LocalApplicationProductStarter = (
  options: BootstrapLocalAiFeatureApplicationOptions,
) => Promise<BootstrapLocalAiFeatureApplicationResult>;

type InstalledAiLoader = Extract<
  LocalAiFeatureDeploymentOptions,
  { deployment: 'installed' }
>['loadProviders'];

export interface ProductionLocalApplicationProcessOptions {
  readonly configFilePath: string;
  readonly signals: LocalApplicationProcessSignalSource;
  readonly emit: (
    event: Readonly<LocalApplicationProcessEvent>,
  ) => void | Promise<void>;
  readonly stageProvider?: PluginPackageStageProvider;
  readonly loadAiProviders?: InstalledAiLoader;
  readonly start?: LocalApplicationProductStarter;
  readonly productSurface?: LocalApplicationProductSurface;
  readonly now?: () => number;
}

export class LocalApplicationProcessError extends Error {
  readonly code:
    | 'QL3_LOCAL_APPLICATION_PROCESS_AI_PROVIDER_UNAVAILABLE'
    | 'QL3_LOCAL_APPLICATION_PROCESS_NOT_ACTIVE'
    | 'QL3_LOCAL_APPLICATION_PLUGIN_SOURCE_UNAVAILABLE';

  constructor(
    code: LocalApplicationProcessError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LocalApplicationProcessError';
    this.code = code;
  }
}

function event(
  config: Readonly<LocalApplicationProcessConfig>,
  values: Omit<
    LocalApplicationProcessEvent,
    'schemaVersion' | 'component' | 'instanceId' | 'profile'
  >,
): Readonly<LocalApplicationProcessEvent> {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-local-application',
    instanceId: config.instanceId,
    profile: config.profile,
    ...values,
  });
}

function unavailableStageProvider(): PluginPackageStageProvider {
  return Object.freeze({
    async stage() {
      throw new LocalApplicationProcessError(
        'QL3_LOCAL_APPLICATION_PLUGIN_SOURCE_UNAVAILABLE',
        'No Plugin Package recovery source is configured for this process',
      );
    },
  });
}

function configuredStageProvider(
  config: Readonly<LocalApplicationProcessConfig>,
  options: ProductionLocalApplicationProcessOptions,
): PluginPackageStageProvider {
  if (options.stageProvider) return options.stageProvider;
  if (config.pluginPackages.recoverySource.mode === 'disabled') {
    return unavailableStageProvider();
  }
  const catalog = config.pluginPackages.recoverySource;
  return Object.freeze({
    async stage(lock: Readonly<PluginPackageLock>) {
      const { createLocalPluginPackageRecoveryCatalogStageProvider } =
        await import('./pluginPackageRecoveryCatalog.js');
      return createLocalPluginPackageRecoveryCatalogStageProvider({
        catalogRoot: catalog.catalogRoot,
        bundleRoot: catalog.bundleRoot,
        publisherTrustFilePath: catalog.publisherTrustFilePath,
        stagingRoot: config.pluginPackages.stagingRoot,
      }).stage(lock);
    },
  });
}

async function defaultStarter(
  options: BootstrapLocalAiFeatureApplicationOptions,
): Promise<BootstrapLocalAiFeatureApplicationResult> {
  const { bootstrapLocalAiFeatureApplication } = await import(
    '../application-runtime/aiFeatureApplication.js'
  );
  return bootstrapLocalAiFeatureApplication(options);
}

function aiOptions(
  config: Readonly<LocalApplicationProcessConfig>,
  options: ProductionLocalApplicationProcessOptions,
): LocalAiFeatureDeploymentOptions {
  const audit = (record: Readonly<LocalAiFeatureApplicationAudit>) =>
    options.emit(
      event(config, {
        level: record.state === 'failed' ? 'error' : 'info',
        event: 'ai_activation',
        aiActivation: Object.freeze({ ...record }),
      }),
    );
  if (config.ai.deployment === 'excluded') {
    return Object.freeze({
      deployment: 'excluded' as const,
      audit,
    });
  }
  if (typeof options.loadAiProviders !== 'function') {
    throw new LocalApplicationProcessError(
      'QL3_LOCAL_APPLICATION_PROCESS_AI_PROVIDER_UNAVAILABLE',
      'Installed AI deployment requires a provider authority loader',
    );
  }
  return Object.freeze({
    deployment: 'installed' as const,
    loadProviders: options.loadAiProviders,
    audit,
    ...(config.ai.maxConcurrent === undefined
      ? {}
      : { maxConcurrent: config.ai.maxConcurrent }),
    ...(config.ai.recoveryLimit === undefined
      ? {}
      : { recoveryLimit: config.ai.recoveryLimit }),
    ...(config.ai.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: config.ai.drainTimeoutMs }),
    ...(config.ai.drainPollMs === undefined
      ? {}
      : { drainPollMs: config.ai.drainPollMs }),
  });
}

/**
 * Owns one edge or standalone QingLong 3.0 process. Signal handling is
 * installed before storage startup. The first signal withdraws scheduler
 * admission, drains execution control, and finally releases the adoption
 * fence through the application stop contract.
 */
export async function runProductionLocalApplicationProcess(
  options: ProductionLocalApplicationProcessOptions,
): Promise<LocalApplicationStopResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    typeof options.configFilePath !== 'string' ||
    typeof options.emit !== 'function' ||
    typeof options.signals?.subscribe !== 'function' ||
    (options.stageProvider !== undefined &&
      typeof options.stageProvider?.stage !== 'function') ||
    (options.loadAiProviders !== undefined &&
      typeof options.loadAiProviders !== 'function') ||
    (options.start !== undefined && typeof options.start !== 'function') ||
    (options.productSurface !== undefined &&
      typeof options.productSurface?.start !== 'function') ||
    (options.now !== undefined && typeof options.now !== 'function')
  ) {
    throw new TypeError('Local application process options are invalid');
  }
  const config = loadLocalApplicationProcessConfig(options.configFilePath);
  verifyLocalApplicationCutoverCommitment(config);
  const selectedAi = aiOptions(config, options);
  const start = options.start ?? defaultStarter;
  const now = options.now ?? Date.now;
  const stageProvider = configuredStageProvider(config, options);

  let resolveSignal:
    | ((signal: LocalApplicationProcessSignal) => void)
    | undefined;
  const requestedSignal = new Promise<LocalApplicationProcessSignal>(
    (resolve) => {
      resolveSignal = resolve;
    },
  );
  let acceptedSignal = false;
  const unsubscribe = options.signals.subscribe((signal) => {
    if (acceptedSignal) return;
    acceptedSignal = true;
    resolveSignal?.(signal);
  });
  // Library lifecycles intentionally unref their timers so embedded callers
  // can exit. The executable composition root must keep one referenced handle
  // while it owns the process; this interval wakes at most once every ~24.8d.
  const keepAlive = setInterval(() => undefined, 2_147_483_647);

  try {
    // Give the host event loop one turn to arm OS-level signal delivery before
    // synchronous SQLite recovery can occupy the initial startup turn.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const application = await start({
      application: {
        enabled: true,
        profile: config.profile,
        ...(config.storage.mode === 'fresh'
          ? {
              storageMode: 'fresh' as const,
              databasePath: config.storage.databasePath,
            }
          : {
              storageMode: 'adopted' as const,
              sourcePath: config.storage.sourcePath,
              targetPath: config.storage.targetPath,
              recoveryPath: config.storage.recoveryPath,
              manifestPath: config.storage.manifestPath,
              activationPath: config.storage.activationPath,
              expectedActivationDigest: config.storage.expectedActivationDigest,
              adoptionAudit(record: Readonly<LocalAdoptedProfileAudit>) {
                return options.emit(
                  event(config, {
                    level: record.state === 'failed' ? 'error' : 'info',
                    event: 'dependency_activation',
                    dependencyActivation: Object.freeze({
                      scope: 'adoption' as const,
                      state: record.state,
                    }),
                  }),
                );
              },
            }),
        ...(config.storage.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: config.storage.busyTimeoutMs }),
        receiptRoot: config.runtime.receiptRoot,
        artifactRoot: config.runtime.artifactRoot,
        secretKeyringPath: config.runtime.secretKeyringPath,
        pluginPackages: {
          stageProvider,
          stagingRoot: config.pluginPackages.stagingRoot,
          activationRoot: config.pluginPackages.activationRoot,
          now,
          ...(config.pluginPackages.pageSize === undefined
            ? {}
            : { pageSize: config.pluginPackages.pageSize }),
          ...(config.pluginPackages.maxPages === undefined
            ? {}
            : { maxPages: config.pluginPackages.maxPages }),
          ...(config.pluginPackages.taskPublicationPageSize === undefined
            ? {}
            : {
                taskPublicationPageSize:
                  config.pluginPackages.taskPublicationPageSize,
              }),
          ...(config.pluginPackages.taskPublicationMaxPages === undefined
            ? {}
            : {
                taskPublicationMaxPages:
                  config.pluginPackages.taskPublicationMaxPages,
              }),
        },
        ...(options.productSurface === undefined
          ? {}
          : { productSurface: options.productSurface }),
        audit(record: Readonly<LocalProfileStorageAudit>) {
          return options.emit(
            event(config, {
              level: record.state === 'failed' ? 'error' : 'info',
              event: 'dependency_activation',
              dependencyActivation: Object.freeze({
                scope: 'storage' as const,
                state: record.state,
              }),
            }),
          );
        },
        applicationAudit(record) {
          return options.emit(
            event(config, {
              level: record.state === 'failed' ? 'error' : 'info',
              event: 'application_activation',
              applicationActivation: Object.freeze({ ...record }),
            }),
          );
        },
      },
      ai: selectedAi,
    });
    if (application.status !== 'active') {
      throw new LocalApplicationProcessError(
        'QL3_LOCAL_APPLICATION_PROCESS_NOT_ACTIVE',
        'The local application process did not activate',
      );
    }
    const startupReceipt = recordLocalApplicationStartupReceipt({
      configFilePath: options.configFilePath,
      instanceId: config.instanceId,
      profile: config.profile,
      aiStatus: application.ai.status,
    });
    await options.emit(
      event(config, {
        level: 'info',
        event: 'active',
        aiStatus: application.ai.status,
      }),
    );
    const signal = await requestedSignal;
    await options.emit(
      event(config, {
        level: 'info',
        event: 'shutdown_requested',
        signal,
      }),
    );
    const stopResult = await application.stop();
    if (stopResult === 'stopped' && startupReceipt !== undefined) {
      recordLocalApplicationShutdownReceipt({
        configFilePath: options.configFilePath,
        instanceId: config.instanceId,
        profile: config.profile,
        signal,
        startupReceiptDigest: startupReceipt.sha256,
      });
    }
    await options.emit(
      event(config, {
        level: stopResult === 'stopped' ? 'info' : 'error',
        event: 'stopped',
        stopResult,
      }),
    );
    return stopResult;
  } finally {
    clearInterval(keepAlive);
    unsubscribe();
    resolveSignal = undefined;
  }
}
