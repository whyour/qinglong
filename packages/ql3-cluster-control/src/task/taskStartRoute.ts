import {
  TASK_START_SCHEMA,
  InvalidTaskStartError,
  TaskStartFenceRejectedError,
  TaskStartNotFoundError,
  TaskStartUnavailableError,
  createTaskStartResponseBody,
  parseTaskStartRequestBody,
  type TaskStartRepository,
} from '@qinglong/runtime-core/task-start';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_TASK_START_ROUTE = Object.freeze({
  method: 'POST' as const,
  path: '/api/v3/projects/{projectId}/tasks/{taskId}/runs',
  operationId: 'task.start',
  permission: 'run.start',
  projectParameter: 'projectId',
});

export type ClusterTaskStartIdFactory = () => string;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createClusterControlTaskStartRoute(
  repository: TaskStartRepository,
  createId: ClusterTaskStartIdFactory,
): Readonly<ClusterControlRouteDefinition> {
  if (
    !repository ||
    typeof repository.startTask !== 'function' ||
    typeof createId !== 'function'
  ) {
    throw new TypeError('Cluster-control Task start route is invalid');
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_TASK_START_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      let body;
      try {
        body = parseTaskStartRequestBody(authorized.request.body);
      } catch (error) {
        if (error instanceof InvalidTaskStartError) {
          return response(400, {
            code: 'invalid_task_start_request',
            schema: TASK_START_SCHEMA,
          });
        }
        return response(503, { code: 'task_start_unavailable' });
      }
      const projectId = authorized.projectId;
      const taskId = parameters.taskId;
      if (
        projectId === null ||
        typeof taskId !== 'string' ||
        taskId.length < 1 ||
        !authorized.policyFence ||
        authorized.policyFence.bindingVersion === null
      ) {
        return response(503, { code: 'task_start_unavailable' });
      }
      try {
        const result = await repository.startTask({
          projectId,
          taskId,
          mutationId: body.mutationId,
          expectedRevision: body.expectedRevision,
          expectedContentDigest: body.expectedContentDigest,
          runId: createId(),
          attemptId: createId(),
          createdEventId: createId(),
          queuedEventId: createId(),
          subject: authorized.principal.subject,
          policyFence: authorized.policyFence,
        });
        return response(
          result.status === 'accepted' ? 202 : 200,
          createTaskStartResponseBody(result),
        );
      } catch (error) {
        if (error instanceof TaskStartNotFoundError) {
          return response(404, { code: 'task_not_found' });
        }
        if (error instanceof TaskStartFenceRejectedError) {
          return response(409, {
            code: 'task_start_fence_rejected',
            reason: error.reason,
          });
        }
        if (
          error instanceof InvalidTaskStartError ||
          error instanceof TaskStartUnavailableError
        ) {
          return response(503, { code: 'task_start_unavailable' });
        }
        return response(503, { code: 'task_start_unavailable' });
      }
    },
  });
}
