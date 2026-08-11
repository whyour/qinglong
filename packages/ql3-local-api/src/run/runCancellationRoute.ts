import {
  RUN_CANCELLATION_SCHEMA,
  InvalidRunCancellationError,
  RunCancellationFenceRejectedError,
  RunCancellationNotFoundError,
  RunCancellationUnavailableError,
  createRunCancellationResponseBody,
  parseRunCancellationRequestBody,
  type RunCancellationRepository,
} from '@qinglong/runtime-core/run-cancellation';
import type {
  SecurityPolicyFence,
  SecurityPrincipal,
} from '@qinglong/runtime-core/security';

import type { LocalApiResponse } from '../transport/contract';

export interface LocalApiRunCancellationRequest {
  readonly projectId: string;
  readonly runId: string;
  readonly body: unknown | null;
  readonly principal: Readonly<SecurityPrincipal>;
  readonly policyFence: Readonly<SecurityPolicyFence> | null;
}

export interface LocalApiRunCancellationRoute {
  handle(
    request: Readonly<LocalApiRunCancellationRequest>,
  ): Promise<LocalApiResponse>;
}

export type LocalApiRunCancellationEventIdFactory = () => string;

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): LocalApiResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

export function createLocalApiRunCancellationRoute(
  repository: RunCancellationRepository,
  createEventId: LocalApiRunCancellationEventIdFactory,
): Readonly<LocalApiRunCancellationRoute> {
  if (
    !repository ||
    typeof repository.requestUserCancellation !== 'function' ||
    typeof createEventId !== 'function'
  ) {
    throw new TypeError('Local API Run cancellation route is invalid');
  }
  return Object.freeze({
    async handle(request: Readonly<LocalApiRunCancellationRequest>) {
      let body;
      try {
        body = parseRunCancellationRequestBody(request.body);
      } catch (error) {
        if (error instanceof InvalidRunCancellationError) {
          return response(400, {
            code: 'invalid_run_cancellation_request',
            schema: RUN_CANCELLATION_SCHEMA,
          });
        }
        return response(503, { code: 'run_cancellation_unavailable' });
      }
      if (!request.policyFence || request.policyFence.bindingVersion === null) {
        return response(503, { code: 'run_cancellation_unavailable' });
      }
      try {
        const result = await repository.requestUserCancellation({
          projectId: request.projectId,
          runId: request.runId,
          mutationId: body.mutationId,
          eventId: createEventId(),
          subject: request.principal.subject,
          policyFence: request.policyFence,
        });
        return response(
          result.status === 'accepted' ? 202 : 200,
          createRunCancellationResponseBody(result),
        );
      } catch (error) {
        if (error instanceof RunCancellationNotFoundError) {
          return response(404, { code: 'run_not_found' });
        }
        if (error instanceof RunCancellationFenceRejectedError) {
          return response(409, {
            code: 'run_cancellation_fence_rejected',
            reason: error.reason,
          });
        }
        if (
          error instanceof InvalidRunCancellationError ||
          error instanceof RunCancellationUnavailableError
        ) {
          return response(503, { code: 'run_cancellation_unavailable' });
        }
        return response(503, { code: 'run_cancellation_unavailable' });
      }
    },
  });
}
