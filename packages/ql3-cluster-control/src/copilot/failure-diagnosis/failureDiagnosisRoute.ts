// Cluster Copilot owns one bounded, Policy-fenced diagnosis admission route.
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';
import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-request@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-response@v1' as const;
export const CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_ROUTE = Object.freeze({
  method: 'POST' as const,
  path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses',
  operationId: 'copilot.failure_diagnosis.execute',
  permission: 'model.invoke',
  projectParameter: 'projectId',
});

export interface ClusterCopilotFailureDiagnosisCommand {
  readonly requestId: string;
  readonly traceId: string;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly principal: Readonly<SecurityPrincipal>;
}

interface ClusterCopilotFailureDiagnosisOutputReference {
  readonly artifactId: string;
  readonly artifactDigest: string;
}

export interface ClusterCopilotFailureDiagnosisCapability {
  execute(command: Readonly<ClusterCopilotFailureDiagnosisCommand>): Promise<
    Readonly<{
      readonly admissionStatus: 'created' | 'existing';
      readonly admission: Readonly<{
        readonly requestId: string;
        readonly runId: string;
        readonly sourceRunId: string;
      }>;
      readonly tool: Readonly<{ readonly outcome: string }> | null;
      readonly model: Readonly<{
        readonly outcome: string;
        readonly output: Readonly<ClusterCopilotFailureDiagnosisOutputReference> | null;
      }> | null;
      readonly terminalization: Readonly<{
        readonly stage: string;
        readonly reason: string;
        readonly outcome: string;
      }> | null;
      readonly terminalizationRequired: boolean;
    }>
  >;
}

class InvalidClusterCopilotFailureDiagnosisRequestError extends TypeError {}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OUTCOMES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const TERMINAL_STAGES = new Set(['tool', 'log', 'deadline', 'cancellation']);
const TERMINAL_REASONS = new Set([
  'tool_failed',
  'tool_timed_out',
  'log_not_found',
  'log_pending',
  'log_missing',
  'log_retired',
  'tool_budget_exhausted',
  'deadline_exceeded',
  'cancellation_requested',
]);

function invalid(): never {
  throw new InvalidClusterCopilotFailureDiagnosisRequestError();
}

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function parseBody(value: unknown): Readonly<{ traceId: string }> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join('\0') !== ['schema', 'traceId'].join('\0')
  ) {
    return invalid();
  }
  const body = value as Record<string, unknown>;
  if (
    body.schema !== CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA ||
    typeof body.traceId !== 'string' ||
    !ID_PATTERN.test(body.traceId)
  ) {
    return invalid();
  }
  return Object.freeze({ traceId: body.traceId });
}

function errorCode(error: unknown): string | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    typeof error.code !== 'string'
  ) {
    return null;
  }
  return error.code;
}

function executionError(error: unknown): ClusterControlAdmissionResponse {
  const code = errorCode(error);
  if (
    code === 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_CONFLICT' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_ADMISSION_CONFLICT' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_ADMISSION_NOT_ALLOWED' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_TOOL_EXECUTION_CONFLICT' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_CONFLICT' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_FINALIZATION_CONFLICT' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_MODEL_EXECUTION_IN_PROGRESS' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_MODEL_RESOLUTION_REQUIRED' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_PRE_MODEL_TERMINALIZATION_CONFLICT'
  ) {
    return response(409, { code: 'copilot_failure_diagnosis_conflict' });
  }
  if (
    code === 'TRUSTED_TOOL_EXECUTION_POLICY_DENIED' ||
    code === 'TRUSTED_TOOL_EXECUTION_APPROVAL_REQUIRED'
  ) {
    return response(403, { code: 'copilot_failure_diagnosis_forbidden' });
  }
  if (
    code === 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_BUSY' ||
    code === 'MODEL_GATEWAY_BUSY'
  ) {
    return response(429, {
      code: 'copilot_failure_diagnosis_capacity_exceeded',
    });
  }
  if (
    code === 'MODEL_POLICY_DENIED' ||
    code === 'MODEL_BUDGET_EXCEEDED' ||
    code === 'COPILOT_MODEL_EGRESS_DENIED' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_BUDGET_EXCEEDED'
  ) {
    return response(422, { code: 'copilot_failure_diagnosis_policy_rejected' });
  }
  if (
    code === 'MODEL_INVOCATION_DEADLINE_EXCEEDED' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_TOOL_EXECUTION_DEADLINE_EXCEEDED'
  ) {
    return response(504, {
      code: 'copilot_failure_diagnosis_deadline_exceeded',
    });
  }
  if (code === 'MODEL_INVOCATION_ABORTED') {
    return response(408, { code: 'copilot_failure_diagnosis_aborted' });
  }
  if (
    code === 'COPILOT_FAILURE_DIAGNOSIS_APPLICATION_INVALID' ||
    code === 'COPILOT_FAILURE_DIAGNOSIS_EXECUTION_PLAN_INVALID'
  ) {
    return response(400, { code: 'invalid_copilot_failure_diagnosis_request' });
  }
  return response(503, { code: 'copilot_failure_diagnosis_unavailable' });
}

function projectResult(
  result: Awaited<
    ReturnType<ClusterCopilotFailureDiagnosisCapability['execute']>
  >,
  requestId: string,
  sourceRunId: string,
): ClusterControlAdmissionResponse {
  const model = result?.model;
  const terminalization = result?.terminalization;
  const outcome = model?.outcome ?? terminalization?.outcome;
  if (
    !result ||
    (result.admissionStatus !== 'created' &&
      result.admissionStatus !== 'existing') ||
    !result.admission ||
    result.admission.requestId !== requestId ||
    result.admission.sourceRunId !== sourceRunId ||
    !RUN_ID_PATTERN.test(result.admission.runId) ||
    result.terminalizationRequired !== false ||
    (model === null) === (terminalization === null) ||
    typeof outcome !== 'string' ||
    !OUTCOMES.has(outcome)
  ) {
    return response(503, { code: 'copilot_failure_diagnosis_unavailable' });
  }
  let stage: string;
  let reason: string | null;
  let outputArtifact: Readonly<ClusterCopilotFailureDiagnosisOutputReference> | null;
  if (model) {
    if (
      !OUTCOMES.has(model.outcome) ||
      (model.outcome === 'succeeded') !== (model.output !== null) ||
      (model.output !== null &&
        (!ID_PATTERN.test(model.output.artifactId) ||
          !DIGEST_PATTERN.test(model.output.artifactDigest)))
    ) {
      return response(503, { code: 'copilot_failure_diagnosis_unavailable' });
    }
    stage = 'model';
    reason = null;
    outputArtifact = model.output;
  } else {
    if (
      !terminalization ||
      !TERMINAL_STAGES.has(terminalization.stage) ||
      !TERMINAL_REASONS.has(terminalization.reason)
    ) {
      return response(503, { code: 'copilot_failure_diagnosis_unavailable' });
    }
    stage = terminalization.stage;
    reason = terminalization.reason;
    outputArtifact = null;
  }
  return response(result.admissionStatus === 'created' ? 201 : 200, {
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA,
    requestId,
    status: result.admissionStatus,
    replayed: result.admissionStatus === 'existing',
    sourceRunId,
    diagnosisRunId: result.admission.runId,
    outcome,
    stage,
    reason,
    outputArtifact:
      outputArtifact === null
        ? null
        : Object.freeze({
            artifactId: outputArtifact.artifactId,
            artifactDigest: outputArtifact.artifactDigest,
          }),
  });
}

export function createClusterControlCopilotFailureDiagnosisRoute(
  capability: ClusterCopilotFailureDiagnosisCapability,
): Readonly<ClusterControlRouteDefinition> {
  if (!capability || typeof capability.execute !== 'function') {
    throw new TypeError(
      'Cluster-control Copilot failure diagnosis capability is invalid',
    );
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      routeParameters: ClusterControlRouteParameters,
    ) {
      let body: Readonly<{ traceId: string }>;
      try {
        body = parseBody(authorized.request.body);
      } catch {
        return response(400, {
          code: 'invalid_copilot_failure_diagnosis_request',
        });
      }
      const projectId = authorized.projectId;
      const sourceRunId = routeParameters.runId;
      if (
        projectId === null ||
        typeof sourceRunId !== 'string' ||
        !RUN_ID_PATTERN.test(sourceRunId)
      ) {
        return response(503, { code: 'copilot_failure_diagnosis_unavailable' });
      }
      try {
        const result = await capability.execute({
          requestId: authorized.request.requestId,
          traceId: body.traceId,
          projectId,
          sourceRunId,
          principal: authorized.principal,
        });
        return projectResult(result, authorized.request.requestId, sourceRunId);
      } catch (error) {
        return executionError(error);
      }
    },
  });
}
