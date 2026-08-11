import {
  BoundedRunStepListProjectionUnavailableError,
  InvalidBoundedRunStepListProjectionError,
  executeBoundedRunStepListProjection,
} from '@qinglong/runtime-core/bounded-run-step-list-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import type { StepRunRepository } from '@qinglong/runtime-core/step-run';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_RUN_STEP_LIST_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/runs/{runId}/steps',
  operationId: 'run.steps.list',
  permission: 'run.read',
  projectParameter: 'projectId',
  allowedQuery: Object.freeze(['after_step_key', 'after_step_run_id', 'limit']),
});

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function parseQuery(query: Readonly<Record<string, readonly string[]>>) {
  const stepKeyValues = query.after_step_key;
  const stepRunIdValues = query.after_step_run_id;
  const limitValues = query.limit;
  if (
    (stepKeyValues !== undefined && stepKeyValues.length !== 1) ||
    (stepRunIdValues !== undefined && stepRunIdValues.length !== 1) ||
    (limitValues !== undefined && limitValues.length !== 1) ||
    (stepKeyValues === undefined) !== (stepRunIdValues === undefined)
  ) {
    throw new TypeError();
  }
  const stepKey = stepKeyValues?.[0];
  const stepRunId = stepRunIdValues?.[0];
  const rawLimit = limitValues?.[0];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    (stepKey !== undefined && !IDENTITY_PATTERN.test(stepKey)) ||
    (stepRunId !== undefined && !IDENTITY_PATTERN.test(stepRunId)) ||
    (rawLimit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 64 ||
        String(limit) !== rawLimit))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    ...(stepKey === undefined || stepRunId === undefined
      ? {}
      : { after: Object.freeze({ stepKey, stepRunId }) }),
  });
}

function validateRunStepListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): void {
  parseQuery(query);
}

export function createClusterControlRunStepListRoute(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  stepRuns: Pick<StepRunRepository, 'listByRun'>,
): Readonly<ClusterControlRouteDefinition> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !stepRuns ||
    typeof stepRuns.listByRun !== 'function'
  ) {
    throw new TypeError('Cluster-control Run Step list repository is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_RUN_STEP_LIST_ROUTE,
    validateQuery: validateRunStepListQuery,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (authorized.projectId === null) {
        return response(503, { code: 'run_step_list_unavailable' });
      }
      let input;
      try {
        input = parseQuery(authorized.request.query);
      } catch {
        return response(400, { code: 'invalid_run_step_list_query' });
      }
      try {
        const result = await executeBoundedRunStepListProjection(
          runs,
          stepRuns,
          authorized.projectId,
          parameters.runId!,
          input,
        );
        if (!result.found) {
          return response(404, { code: 'run_not_found' });
        }
        const { found: _found, ...page } = result;
        return response(200, { ...page });
      } catch (error) {
        if (
          error instanceof InvalidBoundedRunStepListProjectionError ||
          error instanceof BoundedRunStepListProjectionUnavailableError
        ) {
          return response(503, { code: 'run_step_list_unavailable' });
        }
        throw error;
      }
    },
  });
}
