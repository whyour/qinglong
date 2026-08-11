import {
  BoundedTaskListProjectionUnavailableError,
  InvalidBoundedTaskListProjectionError,
  executeBoundedTaskListProjection,
  type BoundedTaskListInput,
} from '@qinglong/runtime-core/bounded-task-list-projection';
import type { TaskDefinitionSource } from '@qinglong/runtime-core/task-definition';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiTaskListRequest {
  readonly projectId: string;
  readonly input: Readonly<BoundedTaskListInput>;
}

export interface LocalApiTaskListRoute {
  handle(request: Readonly<LocalApiTaskListRequest>): Promise<LocalApiResponse>;
}

function unavailable(): LocalApiResponse {
  return Object.freeze({
    statusCode: 503,
    body: Object.freeze({ code: 'task_list_unavailable' }),
  });
}

export function createLocalApiTaskListRoute(
  tasks: Pick<TaskDefinitionSource, 'listTaskDefinitions'>,
): Readonly<LocalApiTaskListRoute> {
  if (!tasks || typeof tasks.listTaskDefinitions !== 'function') {
    throw new TypeError('Local API Task list repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiTaskListRequest>) {
      try {
        const result = await executeBoundedTaskListProjection(
          tasks,
          request.projectId,
          request.input,
        );
        return Object.freeze({
          statusCode: 200,
          body: Object.freeze({ ...result }),
        });
      } catch (error) {
        if (
          error instanceof InvalidBoundedTaskListProjectionError ||
          error instanceof BoundedTaskListProjectionUnavailableError
        ) {
          return unavailable();
        }
        throw error;
      }
    },
  });
}
