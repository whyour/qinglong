import {
  CLUSTER_AUTOMATION_MANAGEMENT_PATH,
  startClusterPluginPackageManagementHttp,
  type ClusterPluginPackageManagementHttpApplication,
  type StartClusterPluginPackageManagementHttpOptions,
} from '../management-support/pluginPackageManagementHttp';

export type ClusterAutomationManagementHttpApplication =
  ClusterPluginPackageManagementHttpApplication;

export type StartClusterAutomationManagementHttpOptions = Omit<
  StartClusterPluginPackageManagementHttpOptions,
  'managementPath'
>;

/** Starts the shared bounded OIDC/mTLS HTTPS adapter on the automation-only path. */
export function startClusterAutomationManagementHttp(
  options: StartClusterAutomationManagementHttpOptions,
): Promise<Readonly<ClusterAutomationManagementHttpApplication>> {
  return startClusterPluginPackageManagementHttp({
    ...options,
    managementPath: CLUSTER_AUTOMATION_MANAGEMENT_PATH,
  });
}
