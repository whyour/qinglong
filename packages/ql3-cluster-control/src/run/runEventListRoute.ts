import {
  BoundedRunEventListProjectionUnavailableError,
  InvalidBoundedRunEventListProjectionError,
  executeBoundedRunEventListProjection,
} from '@qinglong/runtime-core/bounded-run-event-list-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_RUN_EVENT_LIST_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/runs/{runId}/events',
  operationId: 'run.events.list',
  permission: 'run.read',
  projectParameter: 'projectId',
  allowedQuery: Object.freeze(['after_sequence', 'limit']),
});

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function parseQuery(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<{ afterSequence?: number; limit?: number }> {
  const afterValues = query.after_sequence;
  const limitValues = query.limit;
  if (
    (afterValues !== undefined && afterValues.length !== 1) ||
    (limitValues !== undefined && limitValues.length !== 1)
  ) {
    throw new TypeError();
  }
  const rawAfter = afterValues?.[0];
  const afterSequence = rawAfter === undefined ? undefined : Number(rawAfter);
  const rawLimit = limitValues?.[0];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    (rawAfter !== undefined &&
      (!Number.isSafeInteger(afterSequence) ||
        Number(afterSequence) < 0 ||
        Number(afterSequence) > 2_147_483_647 ||
        String(afterSequence) !== rawAfter)) ||
    (rawLimit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 64 ||
        String(limit) !== rawLimit))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(afterSequence === undefined ? {} : { afterSequence }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function validateRunEventListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): void {
  parseQuery(query);
}

export function createClusterControlRunEventListRoute(
  runs: Pick<RunRepositoryReader, 'findRunById' | 'listEvents'>,
): Readonly<ClusterControlRouteDefinition> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    typeof runs.listEvents !== 'function'
  ) {
    throw new TypeError('Cluster-control Run event list repository is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_RUN_EVENT_LIST_ROUTE,
    validateQuery: validateRunEventListQuery,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (authorized.projectId === null) {
        return response(503, { code: 'run_event_list_unavailable' });
      }
      let input;
      try {
        input = parseQuery(authorized.request.query);
      } catch {
        return response(400, { code: 'invalid_run_event_list_query' });
      }
      try {
        const result = await executeBoundedRunEventListProjection(
          runs,
          authorized.projectId,
          parameters.runId!,
          input,
        );
        if (!result.found) {
          return response(404, { code: 'run_not_found' });
        }
        const { found: _found, ...timeline } = result;
        return response(200, { ...timeline });
      } catch (error) {
        if (
          error instanceof InvalidBoundedRunEventListProjectionError ||
          error instanceof BoundedRunEventListProjectionUnavailableError
        ) {
          return response(503, { code: 'run_event_list_unavailable' });
        }
        throw error;
      }
    },
  });
}
