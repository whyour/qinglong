import {
  CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PATH,
  startClusterPluginPackageManagementHttp,
  type ClusterPluginPackageManagementHttpApplication,
  type StartClusterPluginPackageManagementHttpOptions,
} from '../management-support/pluginPackageManagementHttp';

export type ClusterModelProviderCredentialManagementHttpApplication =
  ClusterPluginPackageManagementHttpApplication;

export type StartClusterModelProviderCredentialManagementHttpOptions = Omit<
  StartClusterPluginPackageManagementHttpOptions,
  'managementPath'
>;

/** Starts the bounded OIDC/mTLS adapter on the provider-credential-only path. */
export function startClusterModelProviderCredentialManagementHttp(
  options: StartClusterModelProviderCredentialManagementHttpOptions,
): Promise<Readonly<ClusterModelProviderCredentialManagementHttpApplication>> {
  return startClusterPluginPackageManagementHttp({
    ...options,
    managementPath: CLUSTER_MODEL_PROVIDER_CREDENTIAL_MANAGEMENT_PATH,
  });
}
