import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_PLUGIN_PACKAGE_PROMPT_CATALOG_RESPONSE_SCHEMA =
  'qinglong/plugin-package-prompt-catalog@v1' as const;

export interface ClusterPluginPackagePromptCatalogCapability {
  inspect(
    projectId: string,
    packageName: string,
  ): Promise<
    Readonly<{
      schema: typeof CLUSTER_PLUGIN_PACKAGE_PROMPT_CATALOG_RESPONSE_SCHEMA;
      projectId: string;
      packageName: string;
      found: boolean;
      publicationState: 'active' | 'withdrawn' | 'absent' | null;
      prompts: readonly Readonly<{
        id: string;
        name: string;
        description: string | null;
        parameters: readonly Readonly<{
          name: string;
          description: string | null;
          required: boolean;
        }>[];
      }>[];
    }>
  >;
}

const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createClusterControlPluginPackagePromptCatalogRoute(
  capability: ClusterPluginPackagePromptCatalogCapability,
): Readonly<ClusterControlRouteDefinition> {
  if (!capability || typeof capability.inspect !== 'function') {
    throw new TypeError('Cluster-control Prompt catalog capability is invalid');
  }
  return Object.freeze({
    method: 'GET' as const,
    path: '/api/v3/projects/{projectId}/packages/{packageName}/prompts',
    operationId: 'prompt.read',
    permission: 'model.invoke',
    projectParameter: 'projectId' as const,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      if (
        authorized.request.body !== null ||
        authorized.projectId === null ||
        typeof parameters.packageName !== 'string' ||
        !PACKAGE_NAME.test(parameters.packageName)
      ) {
        return response(400, { code: 'invalid_prompt_catalog_request' });
      }
      try {
        const result = await capability.inspect(
          authorized.projectId,
          parameters.packageName,
        );
        if (
          result.schema !==
            CLUSTER_PLUGIN_PACKAGE_PROMPT_CATALOG_RESPONSE_SCHEMA ||
          result.projectId !== authorized.projectId ||
          result.packageName !== parameters.packageName
        ) {
          return response(503, { code: 'prompt_catalog_unavailable' });
        }
        return response(200, result);
      } catch {
        return response(503, { code: 'prompt_catalog_unavailable' });
      }
    },
  });
}
