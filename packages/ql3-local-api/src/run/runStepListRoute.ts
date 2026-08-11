import {
  BoundedRunStepListProjectionUnavailableError,
  InvalidBoundedRunStepListProjectionError,
  executeBoundedRunStepListProjection,
  type BoundedRunStepListInput,
} from '@qinglong/runtime-core/bounded-run-step-list-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import type { StepRunRepository } from '@qinglong/runtime-core/step-run';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiRunStepListRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly input: Readonly<BoundedRunStepListInput>;
}

export interface LocalApiRunStepListRoute {
  handle(
    request: Readonly<LocalApiRunStepListRequest>,
  ): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createLocalApiRunStepListRoute(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  stepRuns: Pick<StepRunRepository, 'listByRun'>,
): Readonly<LocalApiRunStepListRoute> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !stepRuns ||
    typeof stepRuns.listByRun !== 'function'
  ) {
    throw new TypeError('Local API Run Step list repository is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiRunStepListRequest>) {
      try {
        const result = await executeBoundedRunStepListProjection(
          runs,
          stepRuns,
          request.projectId,
          request.runId,
          request.input,
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
