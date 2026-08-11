import {
  InvalidRunAttemptLogReadError,
  RunAttemptLogReadUnavailableError,
  type RunAttemptLogReadRequest,
  type RunAttemptLogReadResult,
} from '@qinglong/runtime-core/run-attempt-log-read';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiRunAttemptLogReadCapability {
  read(
    request: Readonly<RunAttemptLogReadRequest>,
  ): Promise<RunAttemptLogReadResult>;
}

export interface LocalApiRunAttemptLogReadRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly offset: number;
  readonly length: number;
  readonly signal?: AbortSignal;
}

export interface LocalApiRunAttemptLogReadRoute {
  handle(
    request: Readonly<LocalApiRunAttemptLogReadRequest>,
  ): Promise<LocalApiResponse>;
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
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

export function createLocalApiRunAttemptLogReadRoute(
  capability: LocalApiRunAttemptLogReadCapability,
): Readonly<LocalApiRunAttemptLogReadRoute> {
  if (!capability || typeof capability.read !== 'function') {
    throw new TypeError('Local API Run Attempt log read capability is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiRunAttemptLogReadRequest>) {
      try {
        const result = await capability.read({
          projectId: request.projectId,
          runId: request.runId,
          attemptId: request.attemptId,
          range: Object.freeze({
            offset: request.offset,
            length: request.length,
          }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
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
