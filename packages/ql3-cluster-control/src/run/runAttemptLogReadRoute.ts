import {
  InvalidRunAttemptLogReadError,
  RunAttemptLogReadService,
  RunAttemptLogReadUnavailableError,
  type RunAttemptLogRangeReader,
  type RunAttemptLogReadResult,
} from '@qinglong/runtime-core/run-attempt-log-read';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';

import type { ClusterControlAdmissionResponse } from '../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../transport/routeRegistry';

export const CLUSTER_CONTROL_RUN_ATTEMPT_LOG_READ_ROUTE = Object.freeze({
  method: 'GET' as const,
  path: '/api/v3/projects/{projectId}/runs/{runId}/attempts/{attemptId}/log',
  operationId: 'run.log.read',
  permission: 'artifact.read',
  projectParameter: 'projectId',
  allowedQuery: Object.freeze(['length', 'offset']),
});

const DEFAULT_READ_BYTES = 64 * 1024;
const MAXIMUM_READ_BYTES = 256 * 1024;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function parseQuery(
  query: Readonly<Record<string, readonly string[]>>,
): Readonly<{ offset: number; length: number }> {
  const offsetValues = query.offset;
  const lengthValues = query.length;
  if (
    (offsetValues !== undefined && offsetValues.length !== 1) ||
    (lengthValues !== undefined && lengthValues.length !== 1)
  ) {
    throw new TypeError();
  }
  const rawOffset = offsetValues?.[0];
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  const rawLength = lengthValues?.[0];
  const length =
    rawLength === undefined ? DEFAULT_READ_BYTES : Number(rawLength);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (rawOffset !== undefined && String(offset) !== rawOffset) ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAXIMUM_READ_BYTES ||
    (rawLength !== undefined && String(length) !== rawLength)
  ) {
    throw new TypeError();
  }
  return Object.freeze({ offset, length });
}

function validateQuery(
  query: Readonly<Record<string, readonly string[]>>,
): void {
  parseQuery(query);
}

function projection(
  result: Extract<RunAttemptLogReadResult, { readonly status: 'available' }>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: 'qinglong/run-attempt-log-read-result@v1',
    status: 'available',
    projectId: result.projectId,
    runId: result.runId,
    attemptId: result.attemptId,
    range: Object.freeze({
      start: result.start,
      endExclusive: result.endExclusive,
      totalBytes: result.totalBytes,
      ...(result.nextOffset === undefined
        ? {}
        : { nextOffset: result.nextOffset }),
    }),
    encoding: 'base64',
    content: Buffer.from(
      result.content.buffer,
      result.content.byteOffset,
      result.content.byteLength,
    ).toString('base64'),
    truncation: result.truncation,
  });
}

export function createClusterControlRunAttemptLogReadRoute(
  runs: Pick<RunRepositoryReader, 'findRunById' | 'findAttemptById'>,
  reader?: RunAttemptLogRangeReader,
): Readonly<ClusterControlRouteDefinition> {
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    typeof runs.findAttemptById !== 'function' ||
    (reader !== undefined && typeof reader.read !== 'function')
  ) {
    throw new TypeError(
      'Cluster-control Run Attempt log read dependencies are invalid',
    );
  }
  const service =
    reader === undefined
      ? undefined
      : new RunAttemptLogReadService(runs, reader, {
          executorType: 'remote_worker',
          artifactIdPattern: /^wlog-[a-f0-9]{30}$/,
          maximumReadBytes: MAXIMUM_READ_BYTES,
          activeMissingIsPending: true,
        });
  return Object.freeze({
    ...CLUSTER_CONTROL_RUN_ATTEMPT_LOG_READ_ROUTE,
    validateQuery,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      if (authorized.request.body !== null) {
        return response(400, { code: 'invalid_request_body' });
      }
      if (authorized.projectId === null || service === undefined) {
        return response(503, { code: 'artifact_unavailable' });
      }
      let range;
      try {
        range = parseQuery(authorized.request.query);
      } catch {
        return response(400, { code: 'invalid_run_log_read_query' });
      }
      try {
        const result = await service.read({
          projectId: authorized.projectId,
          runId: parameters.runId!,
          attemptId: parameters.attemptId!,
          range,
          signal: authorized.request.signal,
        });
        if (result.status === 'not_found') {
          return response(404, { code: 'artifact_not_found' });
        }
        if (result.status === 'pending') {
          return response(202, {
            schema: 'qinglong/run-attempt-log-read-result@v1',
            status: 'pending',
            projectId: result.projectId,
            runId: result.runId,
            attemptId: result.attemptId,
          });
        }
        if (result.status === 'missing') {
          return response(503, { code: 'artifact_unavailable' });
        }
        return response(200, projection(result));
      } catch (error) {
        if (error instanceof InvalidRunAttemptLogReadError) {
          return response(400, { code: 'invalid_run_log_read_request' });
        }
        if (error instanceof RunAttemptLogReadUnavailableError) {
          return response(503, { code: 'artifact_unavailable' });
        }
        return response(503, { code: 'artifact_unavailable' });
      }
    },
  });
}
