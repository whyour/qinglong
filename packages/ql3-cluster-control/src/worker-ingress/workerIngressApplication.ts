// Cluster Control Worker Ingress boundary; keep listener lifecycle authority explicit.
import type {
  ClusterControlReadinessEvidence,
  ClusterControlAdmissionDisposer,
  DeploymentProfile,
  OpenPostgresDatabase,
  PostgresDatabaseResource,
} from '@qinglong/runtime-core';
import { assertWorkerCredentialPepper } from '@qinglong/runtime-core/worker-credential-token';
import { MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES } from '@qinglong/runtime-core/remote-secret-delivery';
import {
  startClusterControlHttpSurface,
  type ClusterControlAdmissionPipeline,
  type ClusterControlHttpAddress,
  type ClusterControlHttpSurfaceOptions,
  type ClusterControlMutualTlsOptions,
} from '../transport/httpSurface';

export interface ClusterWorkerIngressAssemblyInput {
  readonly database: PostgresDatabaseResource;
  readonly workerCredentialPepper: string;
}

export interface ClusterWorkerIngressAssembly {
  readonly evidence: ClusterControlReadinessEvidence;
  readonly pipeline: ClusterControlAdmissionPipeline;
}

export interface ClusterWorkerIngressApplicationOptions {
  readonly enabled?: boolean;
  readonly profile: DeploymentProfile;
  readonly workerCredentialPepper?: string;
  readonly openDatabase: OpenPostgresDatabase;
  readonly http: ClusterControlHttpSurfaceOptions;
  readonly create: (
    input: ClusterWorkerIngressAssemblyInput,
  ) => ClusterWorkerIngressAssembly | Promise<ClusterWorkerIngressAssembly>;
}

export type ClusterWorkerIngressApplicationResult =
  | { readonly status: 'disabled'; stop(): Promise<'stopped'> }
  | {
      readonly status: 'active';
      readonly protocol: 'https';
      readonly transport: 'mutual-tls';
      readonly address: ClusterControlHttpAddress;
      readonly evidence: ClusterControlReadinessEvidence;
      reloadTransport(options: ClusterControlMutualTlsOptions): number;
      stop(): Promise<'stopped'>;
    };

/**
 * Separate Worker-facing composition root. It owns a dedicated listener and a
 * worker-ingress database resource. Storage readiness and repositories are
 * supplied by the outer composition root, so this transport layer cannot
 * acquire Project Policy, dispatch, recovery-claim or DDL authority itself.
 */
export async function startClusterWorkerIngressApplication(
  options: ClusterWorkerIngressApplicationOptions,
): Promise<ClusterWorkerIngressApplicationResult> {
  if (!(options.enabled ?? false)) {
    return Object.freeze({
      status: 'disabled',
      async stop() {
        return 'stopped' as const;
      },
    });
  }
  if (options.profile !== 'cluster-control') {
    throw new TypeError('Worker ingress requires cluster-control profile');
  }
  if (typeof options.create !== 'function') {
    throw new TypeError('Worker ingress assembly factory is required');
  }
  if (!options.http?.mutualTls) {
    throw new TypeError('Worker ingress requires mutual TLS');
  }
  assertWorkerCredentialPepper(options.workerCredentialPepper ?? '');
  const bodyLimit = options.http.maxBodyBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(bodyLimit) ||
    bodyLimit < 1024 ||
    bodyLimit > 64 * 1024
  ) {
    throw new RangeError(
      'Worker ingress body limit must be between 1 KiB and 64 KiB',
    );
  }

  let database: PostgresDatabaseResource | undefined;
  const http = await startClusterControlHttpSurface({
    ...options.http,
    maxBodyBytes: bodyLimit,
    maxResponseBytes: Math.min(
      options.http.maxResponseBytes ?? MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES,
      MAX_REMOTE_SECRET_DELIVERY_RESPONSE_BYTES,
    ),
    maxInFlightRequests: Math.min(options.http.maxInFlightRequests ?? 64, 256),
  });
  let disposeAdmission: ClusterControlAdmissionDisposer | undefined;
  try {
    database = await options.openDatabase();
    const assembly = await options.create({
      database,
      workerCredentialPepper: options.workerCredentialPepper!,
    });
    disposeAdmission = http.installAdmission(
      assembly.evidence,
      assembly.pipeline,
    );
    let stopPromise: Promise<'stopped'> | undefined;
    return Object.freeze({
      status: 'active' as const,
      protocol: 'https' as const,
      transport: 'mutual-tls' as const,
      address: http.address,
      evidence: assembly.evidence,
      reloadTransport(mutualTls: ClusterControlMutualTlsOptions) {
        return http.reloadMutualTls(mutualTls);
      },
      stop() {
        stopPromise ??= (async () => {
          let primary: unknown;
          try {
            await disposeAdmission?.();
          } catch (error) {
            primary = error;
          }
          try {
            await database?.close();
          } catch (error) {
            primary ??= error;
          }
          try {
            await http.close();
          } catch (error) {
            primary ??= error;
          }
          if (primary) throw primary;
          return 'stopped' as const;
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    try {
      await disposeAdmission?.();
    } catch {
      /* preserve root */
    }
    try {
      await database?.close();
    } catch {
      /* preserve root */
    }
    try {
      await http.close();
    } catch {
      /* preserve root */
    }
    throw error;
  }
}

export * from './workerCredentialAuthenticator';
export * from './workerIngressPipeline';
export * from '../remote-execution/remoteRunActivationService';
export * from '../remote-execution/remoteWorkerSecretDeliveryService';
export * from '../remote-execution/remoteWorkerCompletionService';
export * from '../remote-execution/remoteWorkerLeaseControlService';
