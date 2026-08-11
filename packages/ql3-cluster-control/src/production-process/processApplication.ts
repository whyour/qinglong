import type {
  ClusterControlActivationAudit,
  ClusterControlStopResult,
} from '@qinglong/runtime-core';
import {
  loadClusterControlConfig,
  type ClusterControlEnvironment,
  type EnabledClusterControlConfig,
} from './config';
import {
  startProductionClusterControlApplication,
  type ProductionClusterControlApplicationOptions,
} from '../application-runtime/productionApplication';
import {
  ClusterControlDatabaseUnavailableError,
  type ClusterControlApplicationResult,
} from '../application-runtime/application';
import {
  loadClusterWorkerIngressConfig,
  type EnabledClusterWorkerIngressConfig,
} from '../worker-ingress/workerIngressConfig';
import type { ClusterWorkerArtifactBinding } from '../artifact/workerArtifactBinding';
import type { RemoteWorkerSecretValueProvider } from '@qinglong/runtime-core/remote-secret-delivery';

export type ClusterControlProcessSignal = 'SIGINT' | 'SIGTERM';

export interface ClusterControlProcessEvent {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-cluster-control';
  readonly level: 'info' | 'error';
  readonly event: string;
  readonly replicaId: string;
  readonly signal?: ClusterControlProcessSignal;
  readonly stopResult?: ClusterControlStopResult;
  readonly address?: Readonly<{ host: string; port: number }>;
  readonly activation?: ClusterControlActivationAudit;
  readonly diagnostic?: Readonly<{
    scope:
      | 'scheduler'
      | 'cancellation-convergence'
      | 'database'
      | 'worker-ingress';
    name: string;
    code?: string;
  }>;
}

export interface ClusterControlProcessSignalSource {
  subscribe(
    listener: (signal: ClusterControlProcessSignal) => void,
  ): () => void;
}

export type ProductionClusterControlStarter = (
  options: ProductionClusterControlApplicationOptions,
) => Promise<ClusterControlApplicationResult>;

export type ClusterWorkerArtifactBindingFactory = (
  config: EnabledClusterWorkerIngressConfig['artifact'],
) => Promise<Readonly<ClusterWorkerArtifactBinding>>;

export type ClusterWorkerSecretProviderFactory = (
  config: NonNullable<EnabledClusterWorkerIngressConfig['secret']>,
) => Promise<Readonly<RemoteWorkerSecretValueProvider>>;

export interface ProductionClusterControlProcessOptions {
  readonly environment: ClusterControlEnvironment;
  readonly signals: ClusterControlProcessSignalSource;
  readonly emit: (event: ClusterControlProcessEvent) => void | Promise<void>;
  readonly start?: ProductionClusterControlStarter;
  readonly createWorkerArtifactBinding?: ClusterWorkerArtifactBindingFactory;
  readonly createWorkerSecretProvider?: ClusterWorkerSecretProviderFactory;
  readonly workerSecretProvider?: RemoteWorkerSecretValueProvider;
}

export class ClusterControlProcessError extends Error {
  readonly code:
    | 'QL3_CLUSTER_CONTROL_PROCESS_CONFIG_INVALID'
    | 'QL3_CLUSTER_CONTROL_PROCESS_DISABLED';

  constructor(
    code: ClusterControlProcessError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ClusterControlProcessError';
    this.code = code;
  }
}

const REPLICA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function processConfiguration(environment: ClusterControlEnvironment): {
  readonly config: EnabledClusterControlConfig;
  readonly workerIngress?: EnabledClusterWorkerIngressConfig;
  readonly replicaId: string;
} {
  const config = loadClusterControlConfig(environment);
  if (!config.enabled) {
    throw new ClusterControlProcessError(
      'QL3_CLUSTER_CONTROL_PROCESS_DISABLED',
      'The cluster-control process requires an enabled cluster-control profile',
    );
  }
  const replicaId = environment.QL3_CLUSTER_REPLICA_ID;
  if (
    typeof replicaId !== 'string' ||
    !REPLICA_ID_PATTERN.test(replicaId)
  ) {
    throw new ClusterControlProcessError(
      'QL3_CLUSTER_CONTROL_PROCESS_CONFIG_INVALID',
      'QL3_CLUSTER_REPLICA_ID must be a stable safe identifier',
    );
  }
  const workerIngress = loadClusterWorkerIngressConfig(environment);
  return Object.freeze({
    config,
    replicaId,
    ...(workerIngress.enabled ? { workerIngress } : {}),
  });
}

async function createWorkerArtifactBinding(
  config: EnabledClusterWorkerIngressConfig['artifact'],
): Promise<Readonly<ClusterWorkerArtifactBinding>> {
  const binding = await import('../artifact/workerArtifactBinding.js');
  return binding.createClusterWorkerArtifactBinding(config);
}

async function createWorkerSecretProvider(
  config: NonNullable<EnabledClusterWorkerIngressConfig['secret']>,
): Promise<Readonly<RemoteWorkerSecretValueProvider>> {
  if (config.provider !== 'mounted-files') {
    throw new TypeError('Cluster Worker Secret provider is unsupported');
  }
  const provider = await import('../remote-execution/mountedSecretProvider.js');
  return provider.createClusterMountedSecretProvider({
    rootDirectory: config.rootDirectory,
  });
}

function diagnosticFact(
  scope: ClusterControlProcessEvent['diagnostic'] extends infer T
    ? T extends { readonly scope: infer TScope }
      ? TScope
      : never
    : never,
  error: unknown,
): NonNullable<ClusterControlProcessEvent['diagnostic']> {
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  return Object.freeze({
    scope,
    name:
      typeof candidate?.name === 'string' && candidate.name.length <= 128
        ? candidate.name
        : 'Error',
    ...(typeof candidate?.code === 'string' && candidate.code.length <= 128
      ? { code: candidate.code }
      : {}),
  });
}

function event(
  replicaId: string,
  values: Omit<
    ClusterControlProcessEvent,
    'schemaVersion' | 'component' | 'replicaId'
  >,
): ClusterControlProcessEvent {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-cluster-control',
    replicaId,
    ...values,
  });
}

/**
 * Owns exactly one production cluster-control process. It installs signal
 * handling before startup, derives every lease owner from the stable replica
 * identity, and withdraws admission through the application stop contract.
 */
export async function runProductionClusterControlProcess(
  options: ProductionClusterControlProcessOptions,
): Promise<ClusterControlStopResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    typeof options.emit !== 'function' ||
    typeof options.signals?.subscribe !== 'function'
  ) {
    throw new TypeError('Cluster-control process options are invalid');
  }
  const { config, replicaId, workerIngress } = processConfiguration(
    options.environment,
  );
  const start = options.start ?? startProductionClusterControlApplication;
  if (typeof start !== 'function') {
    throw new TypeError('Cluster-control process starter is invalid');
  }

  let resolveSignal:
    | ((signal: ClusterControlProcessSignal) => void)
    | undefined;
  const requestedSignal = new Promise<ClusterControlProcessSignal>((resolve) => {
    resolveSignal = resolve;
  });
  let acceptedSignal = false;
  const unsubscribe = options.signals.subscribe((signal) => {
    if (acceptedSignal) return;
    acceptedSignal = true;
    resolveSignal?.(signal);
  });

  let artifactBinding: Readonly<ClusterWorkerArtifactBinding> | undefined;
  let workerSecretProvider = options.workerSecretProvider;
  let application: ClusterControlApplicationResult | undefined;
  let applicationStopStarted = false;
  let primaryError: unknown;
  try {
    if (workerIngress) {
      const createBinding =
        options.createWorkerArtifactBinding ?? createWorkerArtifactBinding;
      if (typeof createBinding !== 'function') {
        throw new TypeError(
          'Cluster Worker Artifact binding factory is invalid',
        );
      }
      artifactBinding = await createBinding(workerIngress.artifact);
      if (
        workerIngress.secret !== undefined &&
        workerSecretProvider === undefined
      ) {
        const createProvider =
          options.createWorkerSecretProvider ?? createWorkerSecretProvider;
        if (typeof createProvider !== 'function') {
          throw new TypeError(
            'Cluster Worker Secret provider factory is invalid',
          );
        }
        workerSecretProvider = await createProvider(workerIngress.secret);
      }
      if (
        workerSecretProvider !== undefined &&
        typeof workerSecretProvider.resolve !== 'function'
      ) {
        throw new TypeError('Cluster Worker Secret provider is invalid');
      }
    }
    application = await start({
      config,
      recovery: { ownerId: replicaId },
      scheduler: {
        ownerId: replicaId,
        onDiagnostic(error) {
          void Promise.resolve(
            options.emit(
              event(replicaId, {
                level: 'error',
                event: 'runtime_diagnostic',
                diagnostic: diagnosticFact('scheduler', error),
              }),
            ),
          ).catch(() => undefined);
        },
      },
      cancellationConvergence: {
        onDiagnostic(error) {
          void Promise.resolve(
            options.emit(
              event(replicaId, {
                level: 'error',
                event: 'runtime_diagnostic',
                diagnostic: diagnosticFact(
                  'cancellation-convergence',
                  error,
                ),
              }),
            ),
          ).catch(() => undefined);
        },
      },
      ...(workerIngress === undefined
        ? {}
        : {
            workerIngress: {
              config: workerIngress,
              artifactStore: artifactBinding!.store,
              ...(workerSecretProvider === undefined
                ? {}
                : { secretProvider: workerSecretProvider }),
              onDiagnostic(error: unknown) {
                void Promise.resolve(
                  options.emit(
                    event(replicaId, {
                      level: 'error',
                      event: 'runtime_diagnostic',
                      diagnostic: diagnosticFact(
                        'worker-ingress',
                        error,
                      ),
                    }),
                  ),
                ).catch(() => undefined);
              },
            },
          }),
      audit(record) {
        return options.emit(
          event(replicaId, {
            level: record.state === 'failed' ? 'error' : 'info',
            event: 'activation',
            activation: Object.freeze({ ...record }),
          }),
        );
      },
    });
    if (application.status !== 'active') {
      throw new ClusterControlProcessError(
        'QL3_CLUSTER_CONTROL_PROCESS_DISABLED',
        'The cluster-control process did not activate',
      );
    }
    await options.emit(
      event(replicaId, {
        level: 'info',
        event: 'listening',
        address: application.address,
      }),
    );
    if (workerIngress) {
      await options.emit(
        event(replicaId, {
          level: 'info',
          event: 'worker_ingress_listening',
          address: Object.freeze({
            host: workerIngress.http.host ?? '0.0.0.0',
            port: workerIngress.http.port ?? 5801,
          }),
        }),
      );
    }
    const termination = await Promise.race([
      requestedSignal.then((signal) =>
        Object.freeze({ kind: 'signal' as const, signal }),
      ),
      application.unavailable.then((error) =>
        Object.freeze({ kind: 'database-unavailable' as const, error }),
      ),
    ]);
    if (termination.kind === 'database-unavailable') {
      await options.emit(
        event(replicaId, {
          level: 'error',
          event: 'database_unavailable',
          diagnostic: diagnosticFact('database', termination.error),
        }),
      );
      applicationStopStarted = true;
      const stopResult = await application.stop();
      await options.emit(
        event(replicaId, {
          level: stopResult === 'stopped' ? 'info' : 'error',
          event: 'stopped',
          stopResult,
        }),
      );
      throw new ClusterControlDatabaseUnavailableError();
    }
    const signal = termination.signal;
    await options.emit(
      event(replicaId, {
        level: 'info',
        event: 'shutdown_requested',
        signal,
      }),
    );
    applicationStopStarted = true;
    const stopResult = await application.stop();
    await options.emit(
      event(replicaId, {
        level: stopResult === 'stopped' ? 'info' : 'error',
        event: 'stopped',
        stopResult,
      }),
    );
    return stopResult;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    unsubscribe();
    resolveSignal = undefined;
    let cleanupError: unknown;
    if (
      application?.status === 'active' &&
      !applicationStopStarted
    ) {
      try {
        applicationStopStarted = true;
        await application.stop();
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      await artifactBinding?.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
}
