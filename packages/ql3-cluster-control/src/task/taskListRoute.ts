import {
  BoundedTaskListProjectionUnavailableError,
  InvalidBoundedTaskListProjectionError,
  executeBoundedTaskListProjection,
} from '@qinglong/runtime-core/bounded-task-list-projection';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_TASK_LIST_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/tasks',
  operationId: 'task.list',
  permission: 'task.read',
  projectParameter: 'projectId',
  allowedQuery: Object.freeze(['after_task_id', 'limit']),
});

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
  after?: Readonly<{ taskId: string }>;
}> {
  const limitValues = query.limit;
  const taskIdValues = query.after_task_id;
  if (
    (limitValues !== undefined && limitValues.length !== 1) ||
    (taskIdValues !== undefined && taskIdValues.length !== 1)
  ) {
    throw new TypeError();
  }
  const rawLimit = limitValues?.[0];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  const taskId = taskIdValues?.[0];
  if (
    (rawLimit !== undefined &&
      (!Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 64 ||
        String(limit) !== rawLimit)) ||
    (taskId !== undefined && !TASK_ID_PATTERN.test(taskId))
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    ...(taskId === undefined
      ? {}
      : { after: Object.freeze({ taskId }) }),
  });
}

function validateTaskListQuery(
  query: Readonly<Record<string, readonly string[]>>,
): void {
  parseQuery(query);
}

export function createClusterControlTaskListRoute(
  tasks: Pick<TaskDefinitionSource, 'listTaskDefinitions'>,
): Readonly<ClusterControlRouteDefinition> {
  if (!tasks || typeof tasks.listTaskDefinitions !== 'function') {
    throw new TypeError('Cluster-control Task list repository is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_TASK_LIST_ROUTE,
    validateQuery: validateTaskListQuery,
    async handle(authorized: ClusterControlAuthorizedOperationRequest) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (authorized.projectId === null) {
        return response(503, { code: 'task_list_unavailable' });
      }
      let input;
      try {
        input = parseQuery(authorized.request.query);
      } catch {
        return response(400, { code: 'invalid_task_list_query' });
      }
      try {
        const result = await executeBoundedTaskListProjection(
          tasks,
          authorized.projectId,
          input,
        );
        return response(200, { ...result });
      } catch (error) {
        if (
          error instanceof InvalidBoundedTaskListProjectionError ||
          error instanceof BoundedTaskListProjectionUnavailableError
        ) {
          return response(503, { code: 'task_list_unavailable' });
        }
        throw error;
      }
    },
  });
}

export * from './taskReadRoute';
export * from './taskStartRoute';
