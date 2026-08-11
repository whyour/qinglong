// Run owns its Policy-fenced durable cancellation mutation route.
import {
  CLUSTER_RUN_CANCELLATION_SCHEMA,
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
  ClusterRunCancellationUnavailableError,
  InvalidClusterRunCancellationError,
  createClusterRunCancellationResponseBody,
  parseClusterRunCancellationRequestBody,
  type ClusterRunCancellationRepository,
} from '@qinglong/runtime-core/cluster-run-cancellation';
import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_RUN_CANCELLATION_ROUTE = Object.freeze({
  method: 'POST' as const,
  path: '/api/v3/projects/{projectId}/runs/{runId}/cancellation',
  operationId: 'run.cancel',
  permission: 'run.stop',
  projectParameter: 'projectId',
});

export type ClusterRunCancellationEventIdFactory = () => string;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

/**
 * Publishes a durable cancellation command. Authentication, authorization and
 * the first audit complete in admission; the repository revalidates the exact
 * policy fence in the same transaction that writes the Run intent and Event.
 */
export function createClusterControlRunCancellationRoute(
  repository: ClusterRunCancellationRepository,
  createEventId: ClusterRunCancellationEventIdFactory,
): Readonly<ClusterControlRouteDefinition> {
  if (
    !repository ||
    typeof repository.requestUserCancellation !== 'function' ||
    typeof createEventId !== 'function'
  ) {
    throw new TypeError('Cluster-control Run cancellation route is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_RUN_CANCELLATION_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      let body;
      try {
        body = parseClusterRunCancellationRequestBody(
          authorized.request.body,
        );
      } catch (error) {
        if (error instanceof InvalidClusterRunCancellationError) {
          return response(400, {
            code: 'invalid_run_cancellation_request',
            schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
          });
        }
        return response(503, { code: 'run_cancellation_unavailable' });
      }
      const projectId = authorized.projectId;
      const runId = parameters.runId;
      if (
        projectId === null ||
        typeof runId !== 'string' ||
        runId.length < 1 ||
        !authorized.policyFence ||
        authorized.policyFence.bindingVersion === null
      ) {
        return response(503, { code: 'run_cancellation_unavailable' });
      }
      try {
        const result = await repository.requestUserCancellation({
          projectId,
          runId,
          mutationId: body.mutationId,
          eventId: createEventId(),
          subject: authorized.principal.subject,
          policyFence: authorized.policyFence,
        });
        return response(
          result.status === 'accepted' ? 202 : 200,
          createClusterRunCancellationResponseBody(result),
        );
      } catch (error) {
        if (error instanceof ClusterRunCancellationNotFoundError) {
          return response(404, { code: 'run_not_found' });
        }
        if (error instanceof ClusterRunCancellationFenceRejectedError) {
          return response(409, {
            code: 'run_cancellation_fence_rejected',
            reason: error.reason,
          });
        }
        if (
          error instanceof InvalidClusterRunCancellationError ||
          error instanceof ClusterRunCancellationUnavailableError
        ) {
          return response(503, { code: 'run_cancellation_unavailable' });
        }
        return response(503, { code: 'run_cancellation_unavailable' });
      }
    },
  });
}
