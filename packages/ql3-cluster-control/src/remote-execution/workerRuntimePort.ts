// Remote execution owns the least-privilege assembly of Worker-facing runtime capabilities.
import type { PostgresPool } from '@qinglong/runtime-core';
import type { RemoteWorkerSecretValueProvider } from '@qinglong/runtime-core/remote-secret-delivery';
import type { RunAttemptLogRangeReader } from '@qinglong/runtime-core/run-attempt-log-read';
import {
  PostgresClusterDispatchSource,
  PostgresRemoteRunActivationRepository,
  PostgresRemoteWorkerCompletionRepository,
  PostgresRemoteWorkerLeaseControlRepository,
  PostgresRemoteWorkerSecretDeliveryAuthorityRepository,
  PostgresRunDispatchLeaseRepository,
  PostgresTaskExecutionRevisionSource,
  PostgresWorkerSessionRepository,
} from '@qinglong/cluster-postgres/runtime';
import { ClusterRemoteWorkerOfferClaimService } from './remoteWorkerDispatcher';
import { ClusterRemoteRunActivationService } from './remoteRunActivationService';
import { ClusterRemoteWorkerSecretDeliveryService } from './remoteWorkerSecretDeliveryService';
import {
  ClusterRemoteWorkerArtifactService,
  ClusterRemoteWorkerCompletionService,
  type ClusterRemoteWorkerArtifactStore,
} from './remoteWorkerCompletionService';
import { ClusterRemoteWorkerLeaseControlService } from './remoteWorkerLeaseControlService';
import type { WorkerIngressPipelineOptions } from '../worker-ingress/workerIngressPipeline';

export interface ClusterWorkerRuntimeDependencies {
  readonly artifactStore: ClusterRemoteWorkerArtifactStore;
  readonly secretProvider?: RemoteWorkerSecretValueProvider;
}

/**
 * The in-process capability boundary from the runtime authority to the
 * Worker-facing transport. It exposes reviewed operations, never the runtime
 * Pool or mutation repositories.
 */
export interface ClusterWorkerRuntimePort {
  readonly offers: NonNullable<WorkerIngressPipelineOptions['offers']>;
  readonly activation: NonNullable<WorkerIngressPipelineOptions['activation']>;
  readonly secrets?: NonNullable<WorkerIngressPipelineOptions['secrets']>;
  readonly artifacts: NonNullable<WorkerIngressPipelineOptions['artifacts']>;
  readonly completion: NonNullable<WorkerIngressPipelineOptions['completion']>;
  readonly leaseControl: NonNullable<
    WorkerIngressPipelineOptions['leaseControl']
  >;
  readonly runAttemptLogRead?: RunAttemptLogRangeReader;
}

export function createClusterWorkerRuntimePort(
  pool: PostgresPool,
  dependencies: ClusterWorkerRuntimeDependencies,
): Readonly<ClusterWorkerRuntimePort> {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('Cluster Worker runtime Pool is invalid');
  }
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies)
  ) {
    throw new TypeError('Cluster Worker runtime dependencies are invalid');
  }

  const workerSessions = new PostgresWorkerSessionRepository(pool);
  const completionRepository = new PostgresRemoteWorkerCompletionRepository(
    pool,
  );
  const secretProvider = dependencies.secretProvider;
  const readLogRange = dependencies.artifactStore.readLogRange;
  return Object.freeze({
    offers: new ClusterRemoteWorkerOfferClaimService(
      new PostgresClusterDispatchSource(pool),
      workerSessions,
      new PostgresTaskExecutionRevisionSource(pool),
      new PostgresRunDispatchLeaseRepository(pool),
    ),
    activation: new ClusterRemoteRunActivationService(
      new PostgresRemoteRunActivationRepository(pool),
    ),
    ...(secretProvider === undefined
      ? {}
      : {
          secrets: new ClusterRemoteWorkerSecretDeliveryService(
            new PostgresRemoteWorkerSecretDeliveryAuthorityRepository(pool),
            secretProvider,
          ),
        }),
    artifacts: new ClusterRemoteWorkerArtifactService(
      completionRepository,
      dependencies.artifactStore,
    ),
    completion: new ClusterRemoteWorkerCompletionService(
      completionRepository,
      dependencies.artifactStore,
    ),
    leaseControl: new ClusterRemoteWorkerLeaseControlService(
      new PostgresRemoteWorkerLeaseControlRepository(pool),
    ),
    ...(readLogRange === undefined
      ? {}
      : {
          runAttemptLogRead: Object.freeze({
            read: readLogRange.bind(dependencies.artifactStore),
          }),
        }),
  });
}
