import {
  BoundedRunEventListProjectionUnavailableError,
  InvalidBoundedRunEventListProjectionError,
  executeBoundedRunEventListProjection,
  type BoundedRunEventListInput,
} from '@qinglong/runtime-core/bounded-run-event-list-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiRunEventListRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly input: Readonly<BoundedRunEventListInput>;
}

export interface LocalApiRunEventListRoute {
  handle(
    request: Readonly<LocalApiRunEventListRequest>,
  ): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createLocalApiRunEventListRoute(
  runs: Pick<RunRepositoryReader, 'findRunById' | 'listEvents'>,
): Readonly<LocalApiRunEventListRoute> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    typeof runs.listEvents !== 'function'
  ) {
    throw new TypeError('Local API Run event list repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiRunEventListRequest>) {
      try {
        const result = await executeBoundedRunEventListProjection(
          runs,
          request.projectId,
          request.runId,
          request.input,
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
