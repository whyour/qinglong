import {
  BoundedRunReadProjectionUnavailableError,
  executeBoundedRunReadProjection,
} from '@qinglong/runtime-core/bounded-run-read-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiRunReadRequest {
  readonly projectId: string;
  readonly runId: string;
}

export interface LocalApiRunReadRoute {
  handle(request: Readonly<LocalApiRunReadRequest>): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createLocalApiRunReadRoute(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
): Readonly<LocalApiRunReadRoute> {
  if (!runs || typeof runs.findRunById !== 'function') {
    throw new TypeError('Local API Run read repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiRunReadRequest>) {
      try {
        const projection = await executeBoundedRunReadProjection(
          runs,
          request.projectId,
          request.runId,
        );
        if (projection.found !== true) {
          return response(404, { code: 'run_not_found' });
        }
        const { found: _found, ...view } = projection;
        return response(200, {
          run: Object.freeze({ projectId: request.projectId, ...view }),
        });
      } catch (error) {
        if (
          error instanceof BoundedRunReadProjectionUnavailableError ||
          error instanceof TypeError
        ) {
          return response(503, { code: 'run_query_unavailable' });
        }
        return response(503, { code: 'run_query_unavailable' });
      }
    },
  });
}
