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
import type {
  SecurityPolicyFence,
  SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiTaskStartRequest {
  readonly projectId: string;
  readonly taskId: string;
  readonly body: unknown | null;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence> | null;
}

export interface LocalApiTaskStartRoute {
  handle(request: Readonly<LocalApiTaskStartRequest>): Promise<LocalApiResponse>;
}

export type LocalApiTaskStartIdFactory = () => string;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createLocalApiTaskStartRoute(
  repository: TaskStartRepository,
  createId: LocalApiTaskStartIdFactory,
): Readonly<LocalApiTaskStartRoute> {
  if (
    !repository ||
    typeof repository.startTask !== 'function' ||
    typeof createId !== 'function'
  ) {
    throw new TypeError('Local API Task start route is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiTaskStartRequest>) {
      let body;
      try {
        body = parseTaskStartRequestBody(request.body);
      } catch (error) {
        if (error instanceof InvalidTaskStartError) {
          return response(400, {
            code: 'invalid_task_start_request',
            schema: TASK_START_SCHEMA,
          });
        }
        return response(503, { code: 'task_start_unavailable' });
      }
      if (!request.policyFence || request.policyFence.bindingVersion === null) {
        return response(503, { code: 'task_start_unavailable' });
      }
      try {
        const result = await repository.startTask({
          projectId: request.projectId,
          taskId: request.taskId,
          mutationId: body.mutationId,
          expectedRevision: body.expectedRevision,
          expectedContentDigest: body.expectedContentDigest,
          runId: createId(),
          attemptId: createId(),
          createdEventId: createId(),
          queuedEventId: createId(),
          subject: request.principal.subject,
          policyFence: request.policyFence,
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
