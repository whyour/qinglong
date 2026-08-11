import {
  BoundedTaskReadProjectionUnavailableError,
  InvalidBoundedTaskReadProjectionError,
  executeBoundedTaskReadProjection,
} from '@qinglong/runtime-core/bounded-task-read-projection';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiTaskReadRequest {
  readonly projectId: string;
  readonly taskId: string;
}

export interface LocalApiTaskReadRoute {
  handle(request: Readonly<LocalApiTaskReadRequest>): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createLocalApiTaskReadRoute(
  tasks: Pick<TaskDefinitionSource, 'findCurrentTaskDefinition'>,
): Readonly<LocalApiTaskReadRoute> {
  if (!tasks || typeof tasks.findCurrentTaskDefinition !== 'function') {
    throw new TypeError('Local API Task read repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiTaskReadRequest>) {
      try {
        const projection = await executeBoundedTaskReadProjection(
          tasks,
          request.projectId,
          request.taskId,
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
