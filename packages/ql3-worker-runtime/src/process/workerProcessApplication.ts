// Worker Process owns configuration-to-runtime activation, signals, and shutdown.
import type { WorkerIngressHttpsCredentialProvider } from '../remote-execution/transport/workerIngressHttpsClient';
import {
  startProductionWorkerApplication,
  type ProductionWorkerApplicationEnabledOptions,
  type ProductionWorkerApplicationOptions,
} from '../application-runtime/productionWorkerApplication';
import {
  loadWorkerProcessConfig,
  type EnabledWorkerProcessConfig,
  type WorkerProcessEnvironment,
} from './workerProcessConfig';
import { createWorkerProcessCredentialProvider } from './workerProcessIdentity';
import type {
  ProductionWorkerCertificateRenewalLifecycle,
  ProductionWorkerHeadlessApplicationResult,
  ProductionWorkerHeadlessStopResult,
} from '../application-runtime/productionHeadlessApplication';

export type WorkerProcessSignal = 'SIGINT' | 'SIGTERM';

export interface WorkerProcessSignalSource {
  subscribe(listener: (signal: WorkerProcessSignal) => void): () => void;
}

export interface WorkerProcessEvent {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-worker';
  readonly level: 'info' | 'error';
  readonly event:
    | 'starting'
    | 'active'
    | 'shutdown_requested'
    | 'shutdown_deferred'
    | 'stopped'
    | 'runtime_diagnostic';
  readonly workerId?: string;
  readonly capacityProfile?: 'edge' | 'node';
  readonly signal?: WorkerProcessSignal;
  readonly stopResult?: ProductionWorkerHeadlessStopResult;
  readonly diagnostic?: Readonly<{
    readonly code:
      | 'tick_failed'
      | 'session_tick_failed'
      | 'certificate_renewal_failed'
      | 'certificate_unavailable'
      | 'recovery_required'
      | 'drain_failed'
      | 'disconnect_failed';
  }>;
}

export type WorkerProcessStarter = (
  options: ProductionWorkerApplicationOptions,
) => Promise<ProductionWorkerHeadlessApplicationResult>;

export type WorkerProcessCredentialFactory = (
  config: EnabledWorkerProcessConfig['identity'],
) => Promise<Readonly<WorkerIngressHttpsCredentialProvider>>;

export type WorkerProcessCertificateRenewalFactory = (
  config: EnabledWorkerProcessConfig,
  credentials: Readonly<WorkerIngressHttpsCredentialProvider>,
) => Promise<ProductionWorkerCertificateRenewalLifecycle | undefined>;

export interface ProductionWorkerProcessOptions {
  readonly environment: WorkerProcessEnvironment;
  readonly signals: WorkerProcessSignalSource;
  readonly emit: (event: WorkerProcessEvent) => void | Promise<void>;
  readonly start?: WorkerProcessStarter;
  readonly createCredentials?: WorkerProcessCredentialFactory;
  /** Deployment-owned CA adapter; omitted profiles keep zero renewal cost. */
  readonly createCertificateRenewal?: WorkerProcessCertificateRenewalFactory;
  readonly waitBeforeStopRetry?: () => Promise<void>;
}

export class WorkerProcessError extends Error {
  readonly code:
    | 'QL3_WORKER_PROCESS_DISABLED'
    | 'QL3_WORKER_PROCESS_ACTIVATION_FAILED';

  constructor(
    code: WorkerProcessError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkerProcessError';
    this.code = code;
  }
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_000));
}

function productionOptions(
  config: EnabledWorkerProcessConfig,
  credentials: Readonly<WorkerIngressHttpsCredentialProvider>,
  certificateRenewal: ProductionWorkerCertificateRenewalLifecycle | undefined,
  diagnostic: NonNullable<
    ProductionWorkerApplicationEnabledOptions['diagnostic']
  >,
): ProductionWorkerApplicationEnabledOptions {
  return Object.freeze({
    enabled: true,
    profile: 'worker',
    capacityProfile: config.capacityProfile,
    origin: config.origin,
    credentials,
    ...(certificateRenewal === undefined ? {} : { certificateRenewal }),
    workerId: config.workerId,
    capabilities: config.capabilities,
    maxConcurrentRuns: config.maxConcurrentRuns,
    storage: config.storage,
    cadenceMs: config.lifecycle.cadenceMs,
    leaseDurationMs: config.lifecycle.leaseDurationMs,
    heartbeatIntervalMs: config.lifecycle.heartbeatIntervalMs,
    drainTimeoutMs: config.lifecycle.drainTimeoutMs,
    drainPollMs: config.lifecycle.drainPollMs,
    requestTimeoutMs: config.lifecycle.requestTimeoutMs,
    maximumJournalEntries: config.lifecycle.maximumJournalEntries,
    maximumRecordsPerTick: config.lifecycle.maximumRecordsPerTick,
    maximumSupervisionRecordsPerTick:
      config.lifecycle.maximumSupervisionRecordsPerTick,
    ...(config.executor.launcherPath === undefined
      ? {}
      : {
          launcherPath: config.executor.launcherPath,
          expectedLauncherSha256: config.executor.expectedLauncherSha256!,
        }),
    diagnostic,
  });
}

/**
 * Owns one production Worker process. Incomplete drain never releases the
 * application or returns success; it keeps the existing owner/Agent alive and
 * retries the same proof-bearing stop operation with a ref'ed shutdown wait.
 */
export async function runProductionWorkerProcess(
  options: ProductionWorkerProcessOptions,
): Promise<'stopped'> {
  if (
    !options ||
    typeof options !== 'object' ||
    typeof options.emit !== 'function' ||
    typeof options.signals?.subscribe !== 'function' ||
    (options.start !== undefined && typeof options.start !== 'function') ||
    (options.createCredentials !== undefined &&
      typeof options.createCredentials !== 'function') ||
    (options.createCertificateRenewal !== undefined &&
      typeof options.createCertificateRenewal !== 'function') ||
    (options.waitBeforeStopRetry !== undefined &&
      typeof options.waitBeforeStopRetry !== 'function')
  ) {
    throw new TypeError('Worker process options are invalid');
  }

  let resolveSignal: ((signal: WorkerProcessSignal) => void) | undefined;
  const requestedSignal = new Promise<WorkerProcessSignal>((resolve) => {
    resolveSignal = resolve;
  });
  let acceptedSignal = false;
  const unsubscribe = options.signals.subscribe((signal) => {
    if (acceptedSignal) return;
    acceptedSignal = true;
    resolveSignal?.(signal);
  });
  // A pending Promise does not keep Node's event loop alive. The Worker owns
  // the process until an OS shutdown signal arrives, so retain one inexpensive
  // referenced handle and release it with the rest of the signal authority.
  const lifecycleReference = setInterval(() => undefined, 2_147_483_647);
  const emit = (event: WorkerProcessEvent): void => {
    void Promise.resolve(options.emit(event)).catch(() => undefined);
  };

  try {
    const config = await loadWorkerProcessConfig(options.environment);
    if (!config.enabled) {
      throw new WorkerProcessError(
        'QL3_WORKER_PROCESS_DISABLED',
        'The Worker process requires an enabled worker profile',
      );
    }
    emit(
      Object.freeze({
        schemaVersion: 1,
        component: 'qinglong3-worker',
        level: 'info',
        event: 'starting',
        workerId: config.workerId,
        capacityProfile: config.capacityProfile,
      }),
    );
    const credentials = await (
      options.createCredentials ?? createWorkerProcessCredentialProvider
    )(config.identity);
    if (!credentials || typeof credentials.load !== 'function') {
      throw new WorkerProcessError(
        'QL3_WORKER_PROCESS_ACTIVATION_FAILED',
        'Worker credential provider is invalid',
      );
    }
    const certificateRenewal = await options.createCertificateRenewal?.(
      config,
      credentials,
    );
    if (
      certificateRenewal !== undefined &&
      typeof certificateRenewal.run !== 'function'
    ) {
      throw new WorkerProcessError(
        'QL3_WORKER_PROCESS_ACTIVATION_FAILED',
        'Worker certificate renewal lifecycle is invalid',
      );
    }
    const application = await (
      options.start ?? startProductionWorkerApplication
    )(
      productionOptions(config, credentials, certificateRenewal, (fact) => {
        emit(
          Object.freeze({
            schemaVersion: 1,
            component: 'qinglong3-worker',
            level: 'error',
            event: 'runtime_diagnostic',
            workerId: config.workerId,
            capacityProfile: config.capacityProfile,
            diagnostic: Object.freeze({ code: fact.code }),
          }),
        );
      }),
    );
    if (application.status !== 'active') {
      throw new WorkerProcessError(
        'QL3_WORKER_PROCESS_ACTIVATION_FAILED',
        'Worker application did not activate',
      );
    }
    emit(
      Object.freeze({
        schemaVersion: 1,
        component: 'qinglong3-worker',
        level: 'info',
        event: 'active',
        workerId: config.workerId,
        capacityProfile: config.capacityProfile,
      }),
    );

    const signal = await requestedSignal;
    emit(
      Object.freeze({
        schemaVersion: 1,
        component: 'qinglong3-worker',
        level: 'info',
        event: 'shutdown_requested',
        workerId: config.workerId,
        capacityProfile: config.capacityProfile,
        signal,
      }),
    );
    const waitBeforeRetry = options.waitBeforeStopRetry ?? delay;
    while (true) {
      let result: ProductionWorkerHeadlessStopResult;
      try {
        result = await application.stop();
      } catch {
        result = 'recovery_required';
      }
      if (result === 'stopped') {
        emit(
          Object.freeze({
            schemaVersion: 1,
            component: 'qinglong3-worker',
            level: 'info',
            event: 'stopped',
            workerId: config.workerId,
            capacityProfile: config.capacityProfile,
            stopResult: result,
          }),
        );
        return result;
      }
      emit(
        Object.freeze({
          schemaVersion: 1,
          component: 'qinglong3-worker',
          level: 'error',
          event: 'shutdown_deferred',
          workerId: config.workerId,
          capacityProfile: config.capacityProfile,
          stopResult: result,
        }),
      );
      await waitBeforeRetry();
    }
  } finally {
    clearInterval(lifecycleReference);
    unsubscribe();
    resolveSignal = undefined;
  }
}
