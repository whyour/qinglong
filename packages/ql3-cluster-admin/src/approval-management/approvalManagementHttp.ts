import {
  CLUSTER_APPROVAL_MANAGEMENT_PATH,
  startClusterPluginPackageManagementHttp,
  type ClusterPluginPackageManagementHttpApplication,
  type StartClusterPluginPackageManagementHttpOptions,
} from '../management-support/pluginPackageManagementHttp';

export type ClusterApprovalManagementHttpApplication =
  ClusterPluginPackageManagementHttpApplication;

export type StartClusterApprovalManagementHttpOptions = Omit<
  StartClusterPluginPackageManagementHttpOptions,
  'managementPath'
>;

/** Starts the shared bounded OIDC/mTLS HTTPS adapter on the Approval-only path. */
export function startClusterApprovalManagementHttp(
  options: StartClusterApprovalManagementHttpOptions,
): Promise<Readonly<ClusterApprovalManagementHttpApplication>> {
  return startClusterPluginPackageManagementHttp({
    ...options,
    managementPath: CLUSTER_APPROVAL_MANAGEMENT_PATH,
  });
}
