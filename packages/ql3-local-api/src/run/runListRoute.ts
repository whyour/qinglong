import {
  BoundedRunListProjectionUnavailableError,
  InvalidBoundedRunListProjectionError,
  executeBoundedRunListProjection,
  type BoundedRunListInput,
} from '@qinglong/runtime-core/bounded-run-list-projection';
import type { ProjectRunListReader } from '@qinglong/runtime-core/project-run-list';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiRunListRequest {
  readonly projectId: string;
  readonly input: Readonly<BoundedRunListInput>;
}

export interface LocalApiRunListRoute {
  handle(request: Readonly<LocalApiRunListRequest>): Promise<LocalApiResponse>;
}

function unavailable(): LocalApiResponse {
  return Object.freeze({
    statusCode: 503,
    body: Object.freeze({ code: 'run_list_unavailable' }),
  });
}

export function createLocalApiRunListRoute(
  runs: ProjectRunListReader,
): Readonly<LocalApiRunListRoute> {
  if (!runs || typeof runs.listRunsByProject !== 'function') {
    throw new TypeError('Local API Run list repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiRunListRequest>) {
      try {
        const result = await executeBoundedRunListProjection(
          runs,
          request.projectId,
          request.input,
        );
        return Object.freeze({
          statusCode: 200,
          body: Object.freeze({ ...result }),
        });
      } catch (error) {
        if (
          error instanceof InvalidBoundedRunListProjectionError ||
          error instanceof BoundedRunListProjectionUnavailableError
        ) {
          return unavailable();
        }
        throw error;
      }
    },
  });
}
