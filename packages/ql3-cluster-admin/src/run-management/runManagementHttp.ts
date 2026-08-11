import {
  CLUSTER_RUN_MANAGEMENT_PATH,
  startClusterPluginPackageManagementHttp,
  type ClusterPluginPackageManagementHttpApplication,
  type StartClusterPluginPackageManagementHttpOptions,
} from '../management-support/pluginPackageManagementHttp';

export type ClusterRunManagementHttpApplication =
  ClusterPluginPackageManagementHttpApplication;

export type StartClusterRunManagementHttpOptions = Omit<
  StartClusterPluginPackageManagementHttpOptions,
  'managementPath'
>;

/** Starts the shared bounded OIDC/mTLS HTTPS adapter on the Run-only path. */
export function startClusterRunManagementHttp(
  options: StartClusterRunManagementHttpOptions,
): Promise<Readonly<ClusterRunManagementHttpApplication>> {
  return startClusterPluginPackageManagementHttp({
    ...options,
    managementPath: CLUSTER_RUN_MANAGEMENT_PATH,
  });
}
