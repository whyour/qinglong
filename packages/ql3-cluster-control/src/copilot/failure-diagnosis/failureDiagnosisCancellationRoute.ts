// Cluster Copilot resolves an external request key before cancelling its Run.
import {
  CopilotFailureDiagnosisCancellationNotFoundError,
  CopilotFailureDiagnosisCancellationUnavailableError,
  InvalidCopilotFailureDiagnosisCancellationError,
  type CopilotFailureDiagnosisCancellationCommand,
} from '@qinglong/ai/failure-diagnosis-cancellation';
import {
  CLUSTER_RUN_CANCELLATION_SCHEMA,
  ClusterRunCancellationFenceRejectedError,
  ClusterRunCancellationNotFoundError,
  ClusterRunCancellationUnavailableError,
  InvalidClusterRunCancellationError,
  parseClusterRunCancellationRequestBody,
} from '@qinglong/runtime-core/cluster-run-cancellation';

import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-cancellation-response@v1' as const;

export const CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_ROUTE =
  Object.freeze({
    method: 'POST' as const,
    path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}/cancellation',
    operationId: 'copilot.failure_diagnosis.cancel',
    permission: 'run.stop',
    projectParameter: 'projectId',
  });

export interface ClusterCopilotFailureDiagnosisCancellationCapability {
  cancel(
    command: Readonly<CopilotFailureDiagnosisCancellationCommand>,
  ): Promise<unknown>;
}

export type ClusterCopilotFailureDiagnosisCancellationEventIdFactory =
  () => string;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const OUTCOMES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const STATUSES = new Set(['accepted', 'already_requested', 'already_terminal']);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
    ? record
    : null;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function projectResult(
  value: unknown,
  target: Readonly<{
    projectId: string;
    sourceRunId: string;
    requestId: string;
  }>,
): Readonly<Record<string, unknown>> | null {
  const candidate = exactRecord(value, [
    'cancelReason',
    'cancelRequestedAtMs',
    'convergence',
    'diagnosisRunId',
    'eventSequence',
    'outcome',
    'projectId',
    'requestId',
    'runStatus',
    'runVersion',
    'schema',
    'sourceRunId',
    'status',
  ]);
  if (
    !candidate ||
    candidate.schema !==
      'qinglong/copilot-failure-diagnosis-cancellation-result@v1' ||
    candidate.projectId !== target.projectId ||
    candidate.sourceRunId !== target.sourceRunId ||
    candidate.requestId !== target.requestId ||
    typeof candidate.diagnosisRunId !== 'string' ||
    !RUN_ID.test(candidate.diagnosisRunId) ||
    typeof candidate.status !== 'string' ||
    !STATUSES.has(candidate.status) ||
    !safeInteger(candidate.runVersion) ||
    !safeInteger(candidate.eventSequence) ||
    candidate.runVersion !== candidate.eventSequence ||
    !(
      (candidate.cancelRequestedAtMs === null &&
        candidate.cancelReason === null) ||
      (safeInteger(candidate.cancelRequestedAtMs) &&
        typeof candidate.cancelReason === 'string' &&
        CANCEL_REASONS.has(candidate.cancelReason))
    )
  ) {
    return null;
  }
  if (candidate.convergence === 'model_in_flight') {
    if (
      candidate.runStatus !== 'running' ||
      candidate.outcome !== null ||
      candidate.cancelRequestedAtMs === null
    ) {
      return null;
    }
  } else if (candidate.convergence === 'terminal') {
    if (
      typeof candidate.runStatus !== 'string' ||
      !OUTCOMES.has(candidate.runStatus) ||
      candidate.outcome !== candidate.runStatus
    ) {
      return null;
    }
  } else {
    return null;
  }
  return Object.freeze({
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA,
    status: candidate.status,
    convergence: candidate.convergence,
    projectId: target.projectId,
    sourceRunId: target.sourceRunId,
    requestId: target.requestId,
    diagnosisRunId: candidate.diagnosisRunId,
    runStatus: candidate.runStatus,
    outcome: candidate.outcome,
    runVersion: candidate.runVersion,
    eventSequence: candidate.eventSequence,
    cancelRequestedAtMs: candidate.cancelRequestedAtMs,
    cancelReason: candidate.cancelReason,
  });
}

export function createClusterControlCopilotFailureDiagnosisCancellationRoute(
  capability: ClusterCopilotFailureDiagnosisCancellationCapability,
  createEventId: ClusterCopilotFailureDiagnosisCancellationEventIdFactory,
): Readonly<ClusterControlRouteDefinition> {
  if (
    !capability ||
    typeof capability.cancel !== 'function' ||
    typeof createEventId !== 'function'
  ) {
    throw new TypeError(
      'Cluster-control Copilot failure diagnosis cancellation route is invalid',
    );
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      let body;
      try {
        body = parseClusterRunCancellationRequestBody(authorized.request.body);
      } catch (error) {
        return error instanceof InvalidClusterRunCancellationError
          ? response(400, {
              code: 'invalid_copilot_failure_diagnosis_cancellation_request',
              schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
            })
          : response(503, {
              code: 'copilot_failure_diagnosis_cancellation_unavailable',
            });
      }
      const projectId = authorized.projectId;
      const sourceRunId = parameters.runId;
      const requestId = parameters.requestId;
      if (
        projectId === null ||
        typeof sourceRunId !== 'string' ||
        !RUN_ID.test(sourceRunId) ||
        typeof requestId !== 'string' ||
        !IDENTITY.test(requestId) ||
        !authorized.policyFence ||
        authorized.policyFence.bindingVersion === null
      ) {
        return response(503, {
          code: 'copilot_failure_diagnosis_cancellation_unavailable',
        });
      }
      const target = Object.freeze({ projectId, sourceRunId, requestId });
      try {
        const result = await capability.cancel({
          ...target,
          mutationId: body.mutationId,
          eventId: createEventId(),
          subject: authorized.principal.subject,
          policyFence: authorized.policyFence,
        });
        const view = projectResult(result, target);
        if (!view) {
          return response(503, {
            code: 'copilot_failure_diagnosis_cancellation_unavailable',
          });
        }
        return response(view.status === 'accepted' ? 202 : 200, view);
      } catch (error) {
        if (
          error instanceof CopilotFailureDiagnosisCancellationNotFoundError ||
          error instanceof ClusterRunCancellationNotFoundError
        ) {
          return response(404, {
            code: 'copilot_failure_diagnosis_not_found',
          });
        }
        if (error instanceof ClusterRunCancellationFenceRejectedError) {
          return response(409, {
            code: 'copilot_failure_diagnosis_cancellation_fence_rejected',
            reason: error.reason,
          });
        }
        if (
          error instanceof InvalidCopilotFailureDiagnosisCancellationError ||
          error instanceof
            CopilotFailureDiagnosisCancellationUnavailableError ||
          error instanceof InvalidClusterRunCancellationError ||
          error instanceof ClusterRunCancellationUnavailableError
        ) {
          return response(503, {
            code: 'copilot_failure_diagnosis_cancellation_unavailable',
          });
        }
        return response(503, {
          code: 'copilot_failure_diagnosis_cancellation_unavailable',
        });
      }
    },
  });
}
