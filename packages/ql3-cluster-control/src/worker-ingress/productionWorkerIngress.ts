// Cluster Control Worker Ingress boundary; keep production PostgreSQL composition explicit.
import {
  assertPostgresWorkerIngressSchemaReady,
  PostgresSecurityAuditRepository,
  PostgresWorkerCredentialRepository,
  PostgresWorkerExecutionAttestationRepository,
  PostgresWorkerSessionRepository,
} from '@qinglong/cluster-postgres/worker-ingress';
import {
  startClusterWorkerIngressApplication,
  type ClusterWorkerIngressApplicationResult,
} from './workerIngressApplication';
import {
  createClusterWorkerIngressDatabaseOpener,
  createClusterWorkerIngressHttpOptions,
  type EnabledClusterWorkerIngressConfig,
} from './workerIngressConfig';
import {
  createWorkerCredentialAuthenticator,
} from './workerCredentialAuthenticator';
import {
  createWorkerIngressAdmissionPipeline,
} from './workerIngressPipeline';
import type { ClusterWorkerRuntimePort } from '../remote-execution/workerRuntimePort';

export interface ProductionClusterWorkerIngressOptions {
  readonly config: EnabledClusterWorkerIngressConfig;
  readonly runtime: ClusterWorkerRuntimePort;
  readonly onPoolError?: (error: Error) => void;
}

/**
 * Starts the reviewed Worker-facing listener. The worker-ingress Pool is used
 * only for authentication, Session, attestation and audit authority. Every
 * Run/Attempt/Lease mutation crosses the injected runtime capability port.
 */
export async function startProductionClusterWorkerIngress(
  options: ProductionClusterWorkerIngressOptions,
): Promise<ClusterWorkerIngressApplicationResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    !options.config?.enabled ||
    !options.runtime
  ) {
    throw new TypeError('Production Worker ingress options are invalid');
  }
  if (
    options.onPoolError !== undefined &&
    typeof options.onPoolError !== 'function'
  ) {
    throw new TypeError('Production Worker ingress Pool error sink is invalid');
  }
  const http = await createClusterWorkerIngressHttpOptions(options.config);
  const openDatabase = createClusterWorkerIngressDatabaseOpener(
    options.config,
    (error) => options.onPoolError?.(error),
  );
  return startClusterWorkerIngressApplication({
    enabled: true,
    profile: 'cluster-control',
    workerCredentialPepper:
      options.config.security.workerCredentialPepper,
    openDatabase,
    http,
    async create({ database, workerCredentialPepper }) {
      const report = await assertPostgresWorkerIngressSchemaReady(
        database.pool,
      );
      return Object.freeze({
        evidence: Object.freeze({
          contractName: report.contractName,
          contractVersion: report.contractVersion,
          serverMajor: report.serverMajor,
          migrationIds: Object.freeze([...report.migrationIds]),
        }),
        pipeline: createWorkerIngressAdmissionPipeline({
          authenticator: createWorkerCredentialAuthenticator(
            new PostgresWorkerCredentialRepository(database.pool),
            workerCredentialPepper,
          ),
          workers: new PostgresWorkerSessionRepository(database.pool),
          attestations: new PostgresWorkerExecutionAttestationRepository(
            database.pool,
          ),
          audit: new PostgresSecurityAuditRepository(database.pool),
          offers: options.runtime.offers,
          activation: options.runtime.activation,
          ...(options.runtime.secrets === undefined
            ? {}
            : { secrets: options.runtime.secrets }),
          artifacts: options.runtime.artifacts,
          completion: options.runtime.completion,
          leaseControl: options.runtime.leaseControl,
        }),
      });
    },
  });
}
