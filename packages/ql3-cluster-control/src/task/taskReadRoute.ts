import {
  BoundedTaskReadProjectionUnavailableError,
  InvalidBoundedTaskReadProjectionError,
  executeBoundedTaskReadProjection,
} from '@qinglong/runtime-core/bounded-task-read-projection';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_TASK_READ_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/tasks/{taskId}',
  operationId: 'task.get',
  permission: 'task.read',
  projectParameter: 'projectId',
});

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createClusterControlTaskReadRoute(
  tasks: Pick<TaskDefinitionSource, 'findCurrentTaskDefinition'>,
): Readonly<ClusterControlRouteDefinition> {
  if (!tasks || typeof tasks.findCurrentTaskDefinition !== 'function') {
    throw new TypeError('Cluster-control Task read repository is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_TASK_READ_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (authorized.projectId === null) {
        return response(503, { code: 'task_query_unavailable' });
      }
      try {
        const projection = await executeBoundedTaskReadProjection(
          tasks,
          authorized.projectId,
          parameters.taskId!,
        );
        if (projection.found !== true) {
          return response(404, { code: 'task_not_found' });
        }
        const { found: _found, ...task } = projection;
        return response(200, { task: Object.freeze(task) });
      } catch (error) {
        if (
          error instanceof InvalidBoundedTaskReadProjectionError ||
          error instanceof BoundedTaskReadProjectionUnavailableError
        ) {
          return response(503, { code: 'task_query_unavailable' });
        }
        throw error;
      }
    },
  });
}
