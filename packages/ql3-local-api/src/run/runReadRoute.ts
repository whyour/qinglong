import {
  BoundedRunReadProjectionUnavailableError,
  executeBoundedRunReadProjection,
} from '@qinglong/runtime-core/bounded-run-read-projection';
import {
  RUN_ATTEMPT_STATUSES,
  type RunAttemptRecord,
} from '@qinglong/runtime-core/run';
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

function latestAttemptProjection(
  value: Readonly<RunAttemptRecord>,
  runId: string,
): Readonly<Record<string, boolean | string | number>> | null {
  const boundedText = (candidate: unknown, maximum: number) =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(candidate);
  const timestamp = (candidate: unknown) =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 0;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.runId !== runId ||
    !boundedText(value.id, 128) ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    value.attempt > 2_147_483_647 ||
    !RUN_ATTEMPT_STATUSES.includes(value.status) ||
    !timestamp(value.createdAtMs) ||
    (value.startedAtMs !== undefined && !timestamp(value.startedAtMs)) ||
    (value.finishedAtMs !== undefined && !timestamp(value.finishedAtMs)) ||
    (value.logArtifactId !== undefined &&
      !boundedText(value.logArtifactId, 128))
  ) {
    return null;
  }
  return Object.freeze({
    id: value.id,
    attempt: value.attempt,
    status: value.status,
    logAvailable: value.logArtifactId !== undefined,
    createdAtMs: value.createdAtMs,
    ...(value.startedAtMs === undefined
      ? {}
      : { startedAtMs: value.startedAtMs }),
    ...(value.finishedAtMs === undefined
      ? {}
      : { finishedAtMs: value.finishedAtMs }),
  });
}

export function createLocalApiRunReadRoute(
  runs: Pick<
    RunRepositoryReader,
    'findRunById' | 'findLatestAttemptByRunId'
  >,
): Readonly<LocalApiRunReadRoute> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    typeof runs.findLatestAttemptByRunId !== 'function'
  ) {
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
        const latestAttempt = await runs.findLatestAttemptByRunId(
          request.runId,
        );
        const attemptView = latestAttempt
          ? latestAttemptProjection(latestAttempt, request.runId)
          : null;
        if (latestAttempt && !attemptView) {
          throw new BoundedRunReadProjectionUnavailableError();
        }
        const { found: _found, ...view } = projection;
        return response(200, {
          run: Object.freeze({
            projectId: request.projectId,
            ...view,
            latestAttempt: attemptView,
          }),
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
