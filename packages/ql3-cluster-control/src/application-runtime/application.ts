import type {
  ClusterControlActivationAudit,
  ClusterControlActivationStack,
  ClusterControlReadinessEvidence,
  ClusterControlRuntimeActivationResult,
  ClusterControlStartupRecoverySummary,
  ClusterControlStopResult,
  DeploymentProfile,
  OpenPostgresDatabase,
} from '@qinglong/runtime-core';
import {
  bootstrapClusterControlRuntime,
  type ClusterControlAssemblyInput,
  type ClusterControlRecoveryRuntimeOptions,
  type ClusterRunCancellationConvergenceRuntimeOptions,
  type ClusterSchedulerRuntimeOptions,
  type ClusterWorkerRuntimeDependencies,
} from './clusterControlRuntime';
import { assertClusterControlApiCredentialPepper } from '../authentication/apiCredentialAuthenticator';
import {
  startClusterControlHttpSurface,
  type ClusterControlAdmissionPipeline,
  type ClusterControlHttpAddress,
  type ClusterControlHttpSurfaceOptions,
} from '../transport/httpSurface';
import type { ClusterControlAvailabilitySource } from '../database/availability';

export interface ClusterControlApplicationStack {
  reconcile(): Promise<ClusterControlStartupRecoverySummary>;
  startLifecycles(): Promise<boolean>;
  admission: ClusterControlAdmissionPipeline;
  stop(): Promise<ClusterControlStopResult>;
}

export interface ClusterControlApplicationOptions {
  readonly enabled?: boolean;
  readonly profile: DeploymentProfile;
  readonly apiCredentialPepper?: string;
  readonly recovery?: ClusterControlRecoveryRuntimeOptions;
  readonly scheduler?: ClusterSchedulerRuntimeOptions;
  readonly cancellationConvergence?: ClusterRunCancellationConvergenceRuntimeOptions;
  readonly workerRuntime?: ClusterWorkerRuntimeDependencies;
  readonly openDatabase: OpenPostgresDatabase;
  readonly availability: ClusterControlAvailabilitySource;
  readonly http: ClusterControlHttpSurfaceOptions;
  readonly create: (
    input: ClusterControlAssemblyInput,
  ) => ClusterControlApplicationStack;
  readonly audit: (
    record: ClusterControlActivationAudit,
  ) => void | Promise<void>;
}

export type ClusterControlApplicationResult =
  | { readonly status: 'disabled'; stop(): Promise<'stopped'> }
  | {
      readonly status: 'active';
      readonly address: ClusterControlHttpAddress;
      readonly evidence: ClusterControlReadinessEvidence;
      readonly recovery: ClusterControlStartupRecoverySummary;
      readonly unavailable: Promise<Error>;
      availabilityStatus(): 'ready' | 'unavailable' | 'stopped';
      stop(): Promise<ClusterControlStopResult>;
    };

export class ClusterControlDatabaseUnavailableError extends Error {
  readonly code = 'CLUSTER_CONTROL_DATABASE_UNAVAILABLE';

  constructor() {
    super('Cluster-control database became unavailable');
    this.name = 'ClusterControlDatabaseUnavailableError';
  }
}

function inactiveBootstrap(
  options: ClusterControlApplicationOptions,
): Promise<ClusterControlRuntimeActivationResult> {
  return bootstrapClusterControlRuntime({
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    profile: options.profile,
    ...(options.apiCredentialPepper === undefined
      ? {}
      : { apiCredentialPepper: options.apiCredentialPepper }),
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
    ...(options.cancellationConvergence === undefined
      ? {}
      : { cancellationConvergence: options.cancellationConvergence }),
    ...(options.workerRuntime === undefined
      ? {}
      : { workerRuntime: options.workerRuntime }),
    openDatabase: options.openDatabase,
    create() {
      throw new Error('Inactive cluster-control unexpectedly created a stack');
    },
    audit: options.audit,
  });
}

/**
 * Starts the cluster probe surface before database readiness, then installs the
 * /api/v3 admission handler only after recovery and lifecycles are safe. Stop
 * withdraws and drains admission before stack, Pool and listener shutdown.
 */
export async function startClusterControlApplication(
  options: ClusterControlApplicationOptions,
): Promise<ClusterControlApplicationResult> {
  const enabled = options.enabled ?? false;
  if (!enabled || options.profile !== 'cluster-control') {
    const inactive = await inactiveBootstrap(options);
    if (inactive.status !== 'disabled') {
      throw new Error('Inactive cluster-control unexpectedly became active');
    }
    return inactive;
  }

  assertClusterControlApiCredentialPepper(options.apiCredentialPepper ?? '');
  const apiCredentialPepper = options.apiCredentialPepper!;
  if (
    !options.availability ||
    typeof options.availability.subscribe !== 'function'
  ) {
    throw new TypeError('Cluster-control availability source is invalid');
  }

  const http = await startClusterControlHttpSurface(options.http);
  let activation: ClusterControlRuntimeActivationResult | undefined;
  let unavailableError: Error | undefined;
  let unavailableStopPromise: Promise<ClusterControlStopResult> | undefined;
  let availabilityStatus: 'ready' | 'unavailable' | 'stopped' = 'ready';
  let unsubscribeAvailability: (() => void) | undefined;
  let resolveUnavailable: ((error: Error) => void) | undefined;
  const unavailable = new Promise<Error>((resolve) => {
    resolveUnavailable = resolve;
  });
  const withdrawForUnavailable = (error: Error): Promise<void> => {
    unavailableError ??= error;
    availabilityStatus = 'unavailable';
    resolveUnavailable?.(unavailableError);
    resolveUnavailable = undefined;
    if (!activation || activation.status === 'disabled')
      return Promise.resolve();
    unavailableStopPromise ??= activation.stop();
    return unavailableStopPromise.then(
      () => undefined,
      () => undefined,
    );
  };
  try {
    unsubscribeAvailability = options.availability.subscribe(
      withdrawForUnavailable,
    );
    activation = await bootstrapClusterControlRuntime({
      enabled: true,
      profile: options.profile,
      apiCredentialPepper,
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      ...(options.scheduler === undefined
        ? {}
        : { scheduler: options.scheduler }),
      ...(options.cancellationConvergence === undefined
        ? {}
        : { cancellationConvergence: options.cancellationConvergence }),
      ...(options.workerRuntime === undefined
        ? {}
        : { workerRuntime: options.workerRuntime }),
      openDatabase: options.openDatabase,
      create(input): ClusterControlActivationStack {
        const application = options.create(input);
        if (
          !application ||
          typeof application !== 'object' ||
          !application.admission ||
          typeof application.admission.prepare !== 'function'
        ) {
          throw new TypeError(
            'Cluster-control application stack has no admission pipeline',
          );
        }
        return {
          reconcile: () => application.reconcile(),
          startLifecycles: () => application.startLifecycles(),
          installAdmission: () =>
            http.installAdmission(input.evidence, application.admission),
          stop: () => application.stop(),
        };
      },
      audit: options.audit,
    });
    if (activation.status === 'disabled') {
      unsubscribeAvailability();
      await http.close();
      return activation;
    }
    if (unavailableError) {
      await withdrawForUnavailable(unavailableError);
      throw new ClusterControlDatabaseUnavailableError();
    }
    const activeActivation = activation;

    let stopPromise: Promise<ClusterControlStopResult> | undefined;
    return {
      status: 'active',
      address: http.address,
      evidence: activeActivation.evidence,
      recovery: activeActivation.recovery,
      unavailable,
      availabilityStatus: () => availabilityStatus,
      stop() {
        if (stopPromise) return stopPromise;
        availabilityStatus = 'stopped';
        unsubscribeAvailability?.();
        unsubscribeAvailability = undefined;
        stopPromise = (async () => {
          let result: ClusterControlStopResult | undefined;
          let primaryError: unknown;
          try {
            result = await activeActivation.stop();
          } catch (error) {
            primaryError = error;
          }
          try {
            await http.close();
          } catch (error) {
            primaryError ??= error;
          }
          if (primaryError) throw primaryError;
          return result!;
        })();
        return stopPromise;
      },
    };
  } catch (error) {
    unsubscribeAvailability?.();
    try {
      await http.close();
    } catch {
      // Preserve the readiness/assembly/activation failure.
    }
    throw error;
  }
}
