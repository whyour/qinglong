/** TLS 1.3 Worker credential management HTTP adapter boundary. */
import {
  CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_PATH,
  startClusterPluginPackageManagementHttp,
  type ClusterPluginPackageManagementHttpApplication,
  type ClusterPluginPackageManagementHttpLimits,
} from '../../management-support/pluginPackageManagementHttp';
import type { ClusterPluginPackageIdentityKeysetFile } from '../../management-support/pluginPackageIdentityKeyset';
import type { ClusterWorkerCredentialManagementTransport } from './workerCredentialManagementTransport';

export type ClusterWorkerCredentialManagementHttpLimits =
  ClusterPluginPackageManagementHttpLimits;

export type ClusterWorkerCredentialManagementHttpApplication =
  ClusterPluginPackageManagementHttpApplication;

export interface StartClusterWorkerCredentialManagementHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: Readonly<{
    readonly privateKey: Buffer;
    readonly certificate: Buffer;
    readonly clientCertificateAuthority: Buffer;
    readonly clientCertificateRevocationList: Buffer;
  }>;
  readonly transport: ClusterWorkerCredentialManagementTransport;
  readonly identities: ClusterPluginPackageIdentityKeysetFile;
  readonly limits?: ClusterWorkerCredentialManagementHttpLimits;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
  readonly onError?: (error: unknown) => void;
}

/**
 * Starts the Worker credential management endpoint on the shared Cluster Admin
 * TLS 1.3/OIDC boundary. The public manager process never receives credential
 * delivery or Kubernetes execution capabilities.
 */
export async function startClusterWorkerCredentialManagementHttp(
  options: StartClusterWorkerCredentialManagementHttpOptions,
): Promise<Readonly<ClusterWorkerCredentialManagementHttpApplication>> {
  return startClusterPluginPackageManagementHttp({
    ...options,
    managementPath: CLUSTER_WORKER_CREDENTIAL_MANAGEMENT_PATH,
  });
}
