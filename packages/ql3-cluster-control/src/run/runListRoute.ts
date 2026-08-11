import {
  BoundedRunListProjectionUnavailableError,
  InvalidBoundedRunListProjectionError,
  executeBoundedRunListProjection,
} from '@qinglong/runtime-core/bounded-run-list-projection';
import type { ProjectRunListReader } from '@qinglong/runtime-core/project-run-list';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_RUN_LIST_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/runs',
  operationId: 'run.list',
  permission: 'run.read',
  projectParameter: 'projectId',
  allowedQuery: Object.freeze([
    'after_created_at_ms',
    'after_run_id',
    'limit',
  ]),
});

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function parseQuery(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<{
  limit?: number;
  after?: Readonly<{ createdAtMs: number; runId: string }>;
}> {
  const limitValues = query.limit;
  const createdAtValues = query.after_created_at_ms;
  const runIdValues = query.after_run_id;
  if (
    (limitValues !== undefined && limitValues.length !== 1) ||
    (createdAtValues !== undefined && createdAtValues.length !== 1) ||
    (runIdValues !== undefined && runIdValues.length !== 1) ||
    (createdAtValues === undefined) !== (runIdValues === undefined)
  ) {
    throw new TypeError();
  }
  const rawLimit = limitValues?.[0];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    rawLimit !== undefined &&
    (!Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 64 ||
      String(limit) !== rawLimit)
  ) {
    throw new TypeError();
  }
  const rawCreatedAtMs = createdAtValues?.[0];
  const runId = runIdValues?.[0];
  if (rawCreatedAtMs === undefined || runId === undefined) {
    return Object.freeze({ ...(limit === undefined ? {} : { limit }) });
  }
  const createdAtMs = Number(rawCreatedAtMs);
  if (
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    String(createdAtMs) !== rawCreatedAtMs ||
    !RUN_ID_PATTERN.test(runId)
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    after: Object.freeze({ createdAtMs, runId }),
  });
}

function validateRunListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): void {
  parseQuery(query);
}

export function createClusterControlRunListRoute(
  runs: ProjectRunListReader,
): Readonly<ClusterControlRouteDefinition> {
  if (!runs || typeof runs.listRunsByProject !== 'function') {
    throw new TypeError('Cluster-control Run list repository is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_RUN_LIST_ROUTE,
    validateQuery: validateRunListQuery,
    async handle(authorized: ClusterControlAuthorizedOperationRequest) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (authorized.projectId === null) {
        return response(503, { code: 'run_list_unavailable' });
      }
      let input;
      try {
        input = parseQuery(authorized.request.query);
      } catch {
        return response(400, { code: 'invalid_run_list_query' });
      }
      try {
        const result = await executeBoundedRunListProjection(
          runs,
          authorized.projectId,
          input,
        );
        return response(200, { ...result });
      } catch (error) {
        if (
          error instanceof InvalidBoundedRunListProjectionError ||
          error instanceof BoundedRunListProjectionUnavailableError
        ) {
          return response(503, { code: 'run_list_unavailable' });
        }
        throw error;
      }
    },
  });
}
