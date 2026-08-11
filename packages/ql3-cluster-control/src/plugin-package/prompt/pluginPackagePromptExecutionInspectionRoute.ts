import { randomUUID } from 'node:crypto';

import {
  normalizeSecurityAuditRecord,
  type SecurityAuditRecord,
} from '@qinglong/runtime-core/security-audit';
import type {
  SecurityPolicyFence,
  SecuritySubject,
} from '@qinglong/runtime-core/security';

import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_CONTROL_PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_ROUTE =
  Object.freeze({
    method: 'GET' as const,
    path: '/api/v3/projects/{projectId}/packages/{packageName}/prompts/{promptId}/executions/{executionRequestId}',
    operationId: 'prompt.execution.read',
    permission: 'run.read',
    projectParameter: 'projectId',
  });

export interface ClusterPluginPackagePromptExecutionInspectionRouteOptions {
  readonly now?: () => number;
  readonly createEventId?: () => string;
}

export interface ClusterPluginPackagePromptExecutionInspectionCapability {
  inspectAuthorized(input: Readonly<{
    projectId: string;
    packageName: string;
    promptId: string;
    executionRequestId: string;
    actor: Readonly<SecuritySubject>;
    fence: Readonly<SecurityPolicyFence>;
    audit: Readonly<SecurityAuditRecord>;
  }>): Promise<Readonly<{ found: boolean }>>;
}

const PACKAGE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROMPT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function errorCode(error: unknown): string | null {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null;
}

/** Exact, content-free recovery read keyed by the caller-known requestId. */
export function createClusterControlPluginPackagePromptExecutionInspectionRoute(
  capability: ClusterPluginPackagePromptExecutionInspectionCapability,
  options: ClusterPluginPackagePromptExecutionInspectionRouteOptions = {},
): Readonly<ClusterControlRouteDefinition> {
  if (
    !capability ||
    typeof capability.inspectAuthorized !== 'function' ||
    (options.now !== undefined && typeof options.now !== 'function') ||
    (options.createEventId !== undefined &&
      typeof options.createEventId !== 'function')
  ) {
    throw new TypeError(
      'Cluster-control Prompt execution inspection capability is invalid',
    );
  }
  const now = options.now ?? Date.now;
  const createEventId = options.createEventId ?? randomUUID;
  return Object.freeze({
    ...CLUSTER_CONTROL_PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      const observedAtMs = now();
      const auditEventId = createEventId();
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (
        authorized.projectId === null ||
        typeof parameters.packageName !== 'string' ||
        !PACKAGE_NAME.test(parameters.packageName) ||
        typeof parameters.promptId !== 'string' ||
        !PROMPT_ID.test(parameters.promptId) ||
        typeof parameters.executionRequestId !== 'string' ||
        !IDENTITY.test(parameters.executionRequestId) ||
        !authorized.policyFence ||
        authorized.policyFence.bindingVersion === null ||
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        typeof auditEventId !== 'string' ||
        !UUID_V4.test(auditEventId)
      ) {
        return response(503, { code: 'prompt_execution_inspection_unavailable' });
      }
      try {
        const result = await capability.inspectAuthorized({
          projectId: authorized.projectId,
          packageName: parameters.packageName,
          promptId: parameters.promptId,
          executionRequestId: parameters.executionRequestId,
          actor: authorized.principal.subject,
          fence: {
            projectVersion: authorized.policyFence.projectVersion,
            bindingVersion: authorized.policyFence.bindingVersion,
          },
          audit: normalizeSecurityAuditRecord({
            eventId: auditEventId,
            requestId: authorized.request.requestId,
            operationId: 'prompt.execution.read',
            projectId: authorized.projectId,
            subject: authorized.principal.subject,
            authenticationId: authorized.principal.authenticationId,
            outcome: 'allowed',
            reasons: ['project_policy_allowed'],
            fence: authorized.policyFence,
            occurredAtMs: observedAtMs,
          }),
        });
        return result.found
          ? response(200, { ...result })
          : response(404, { code: 'prompt_execution_not_found' });
      } catch (error) {
        return errorCode(error) ===
          'PLUGIN_PACKAGE_PROMPT_EXECUTION_INSPECTION_AUTHORIZATION_FENCE_CONFLICT'
          ? response(409, { code: 'authorization_fence_conflict' })
          : response(503, {
              code: 'prompt_execution_inspection_unavailable',
            });
      }
    },
  });
}
