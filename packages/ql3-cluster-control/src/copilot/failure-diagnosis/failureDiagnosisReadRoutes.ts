// Cluster Copilot exposes separate low-sensitive status and protected output reads.
import type { SecurityPrincipal } from '@qinglong/runtime-core/security';

import type { ClusterControlAdmissionResponse } from '../../transport/httpSurface';
import type {
  ClusterControlAuthorizedOperationRequest,
  ClusterControlRouteDefinition,
  ClusterControlRouteParameters,
} from '../../transport/routeRegistry';

export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-inspection-response@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-output-read-response@v1' as const;

export const CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_ROUTE =
  Object.freeze({
    method: 'GET' as const,
    path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}',
    operationId: 'copilot.failure_diagnosis.read',
    permission: 'run.read',
    projectParameter: 'projectId',
  });

export const CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_ROUTE =
  Object.freeze({
    method: 'GET' as const,
    path: '/api/v3/projects/{projectId}/runs/{runId}/copilot/failure-diagnoses/{requestId}/output',
    operationId: 'copilot.failure_diagnosis.output.read',
    permission: 'artifact.read',
    projectParameter: 'projectId',
  });

interface ClusterCopilotFailureDiagnosisReadCommand {
  readonly principal: Readonly<SecurityPrincipal>;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly requestId: string;
}

export interface ClusterCopilotFailureDiagnosisInspectionCapability {
  inspect(
    command: Readonly<ClusterCopilotFailureDiagnosisReadCommand>,
  ): Promise<unknown>;
}

export interface ClusterCopilotFailureDiagnosisOutputReadCapability {
  readOutput(
    command: Readonly<ClusterCopilotFailureDiagnosisReadCommand>,
  ): Promise<unknown>;
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_call',
  'unknown',
]);
const OUTCOMES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const STAGES = new Set(['model', 'tool', 'log', 'deadline', 'cancellation']);
const REASONS = new Set([
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

function response(
  statusCode: number,
  body: Readonly<Record<string, unknown>>,
): ClusterControlAdmissionResponse {
  return Object.freeze({ statusCode, body: Object.freeze(body) });
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [
    ...required,
    ...optional.filter((key) => key in record),
  ].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
    ? record
    : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function target(
  authorized: ClusterControlAuthorizedOperationRequest,
  parameters: ClusterControlRouteParameters,
): Readonly<ClusterCopilotFailureDiagnosisReadCommand> | null {
  if (
    authorized.request.body !== null ||
    authorized.projectId === null ||
    typeof parameters.runId !== 'string' ||
    !RUN_ID.test(parameters.runId) ||
    typeof parameters.requestId !== 'string' ||
    !IDENTITY.test(parameters.requestId)
  ) {
    return null;
  }
  return Object.freeze({
    principal: authorized.principal,
    projectId: authorized.projectId,
    sourceRunId: parameters.runId,
    requestId: parameters.requestId,
  });
}

function exactTarget(
  value: Record<string, unknown>,
  expected: Readonly<ClusterCopilotFailureDiagnosisReadCommand>,
): boolean {
  return (
    value.projectId === expected.projectId &&
    value.sourceRunId === expected.sourceRunId &&
    value.requestId === expected.requestId
  );
}

function notFound(
  value: unknown,
  expected: Readonly<ClusterCopilotFailureDiagnosisReadCommand>,
  schema: string,
): boolean {
  const candidate = exactRecord(value, [
    'projectId',
    'requestId',
    'schema',
    'sourceRunId',
    'status',
  ]);
  return (
    !!candidate &&
    candidate.schema === schema &&
    candidate.status === 'not_found' &&
    exactTarget(candidate, expected)
  );
}

function usageView(value: unknown): Readonly<Record<string, unknown>> | null {
  const usage = exactRecord(value, [
    'costMicros',
    'currency',
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ]);
  if (
    !usage ||
    !nonNegativeInteger(usage.inputTokens) ||
    !nonNegativeInteger(usage.outputTokens) ||
    !nonNegativeInteger(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    !(
      (usage.currency === null && usage.costMicros === null) ||
      (usage.currency === 'USD' && nonNegativeInteger(usage.costMicros))
    )
  ) {
    return null;
  }
  return Object.freeze({ ...usage });
}

function inspectionView(
  value: unknown,
  expected: Readonly<ClusterCopilotFailureDiagnosisReadCommand>,
): Readonly<Record<string, unknown>> | null {
  const candidate = exactRecord(value, [
    'admittedAtMs',
    'diagnosisRunId',
    'finalizedAtMs',
    'outcome',
    'outputAvailable',
    'projectId',
    'reason',
    'requestId',
    'schema',
    'sourceRunId',
    'stage',
    'status',
    'usage',
  ]);
  if (
    !candidate ||
    candidate.schema !==
      'qinglong/copilot-failure-diagnosis-inspection-result@v1' ||
    !exactTarget(candidate, expected) ||
    typeof candidate.diagnosisRunId !== 'string' ||
    !RUN_ID.test(candidate.diagnosisRunId) ||
    !nonNegativeInteger(candidate.admittedAtMs) ||
    typeof candidate.outputAvailable !== 'boolean'
  ) {
    return null;
  }
  if (candidate.status === 'running') {
    if (
      candidate.outcome !== null ||
      candidate.stage !== null ||
      candidate.reason !== null ||
      candidate.outputAvailable !== false ||
      candidate.finalizedAtMs !== null ||
      candidate.usage !== null
    ) {
      return null;
    }
  } else if (candidate.status === 'terminal') {
    if (
      typeof candidate.outcome !== 'string' ||
      !OUTCOMES.has(candidate.outcome) ||
      typeof candidate.stage !== 'string' ||
      !STAGES.has(candidate.stage) ||
      !nonNegativeInteger(candidate.finalizedAtMs) ||
      candidate.finalizedAtMs < candidate.admittedAtMs ||
      (candidate.stage === 'model') !== (candidate.reason === null) ||
      (candidate.reason !== null &&
        (typeof candidate.reason !== 'string' ||
          !REASONS.has(candidate.reason))) ||
      candidate.outputAvailable !==
        (candidate.stage === 'model' && candidate.outcome === 'succeeded')
    ) {
      return null;
    }
    if (candidate.usage !== null && !usageView(candidate.usage)) return null;
  } else {
    return null;
  }
  return Object.freeze({
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA,
    status: candidate.status,
    projectId: expected.projectId,
    sourceRunId: expected.sourceRunId,
    requestId: expected.requestId,
    diagnosisRunId: candidate.diagnosisRunId,
    outcome: candidate.outcome,
    stage: candidate.stage,
    reason: candidate.reason,
    outputAvailable: candidate.outputAvailable,
    admittedAtMs: candidate.admittedAtMs,
    finalizedAtMs: candidate.finalizedAtMs,
    usage: candidate.usage === null ? null : usageView(candidate.usage),
  });
}

function outputView(
  value: unknown,
  expected: Readonly<ClusterCopilotFailureDiagnosisReadCommand>,
): Readonly<Record<string, unknown>> | null {
  const candidate = exactRecord(value, [
    'diagnosisRunId',
    'projectId',
    'reference',
    'requestId',
    'result',
    'schema',
    'sourceRunId',
    'status',
  ]);
  const reference = candidate
    ? exactRecord(candidate.reference, [
        'artifactDigest',
        'artifactId',
        'contentDigest',
        'outputBytes',
        'sealedAtMs',
      ])
    : null;
  const result = candidate
    ? exactRecord(candidate.result, ['finishReason', 'text', 'usage'])
    : null;
  const usage = result
    ? exactRecord(
        result.usage,
        ['inputTokens', 'outputTokens', 'totalTokens'],
        ['costMicros'],
      )
    : null;
  if (
    !candidate ||
    !reference ||
    !result ||
    !usage ||
    candidate.schema !==
      'qinglong/copilot-failure-diagnosis-output-read-result@v1' ||
    candidate.status !== 'available' ||
    !exactTarget(candidate, expected) ||
    typeof candidate.diagnosisRunId !== 'string' ||
    !RUN_ID.test(candidate.diagnosisRunId) ||
    typeof reference.artifactId !== 'string' ||
    !IDENTITY.test(reference.artifactId) ||
    typeof reference.artifactDigest !== 'string' ||
    !DIGEST.test(reference.artifactDigest) ||
    typeof reference.contentDigest !== 'string' ||
    !DIGEST.test(reference.contentDigest) ||
    !nonNegativeInteger(reference.outputBytes) ||
    reference.outputBytes > 1024 * 1024 ||
    !nonNegativeInteger(reference.sealedAtMs) ||
    typeof result.text !== 'string' ||
    Buffer.byteLength(result.text, 'utf8') !== reference.outputBytes ||
    typeof result.finishReason !== 'string' ||
    !FINISH_REASONS.has(result.finishReason) ||
    !nonNegativeInteger(usage.inputTokens) ||
    !nonNegativeInteger(usage.outputTokens) ||
    !nonNegativeInteger(usage.totalTokens) ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    (usage.costMicros !== undefined && !nonNegativeInteger(usage.costMicros))
  ) {
    return null;
  }
  return Object.freeze({
    schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA,
    status: 'available',
    projectId: expected.projectId,
    sourceRunId: expected.sourceRunId,
    requestId: expected.requestId,
    diagnosisRunId: candidate.diagnosisRunId,
    reference: Object.freeze({ ...reference }),
    result: Object.freeze({
      text: result.text,
      finishReason: result.finishReason,
      usage: Object.freeze({ ...usage }),
    }),
  });
}

export function createClusterControlCopilotFailureDiagnosisInspectionRoute(
  capability: ClusterCopilotFailureDiagnosisInspectionCapability,
): Readonly<ClusterControlRouteDefinition> {
  if (!capability || typeof capability.inspect !== 'function') {
    throw new TypeError(
      'Cluster-control Copilot diagnosis inspection capability is invalid',
    );
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      const command = target(authorized, parameters);
      if (!command) {
        return response(400, {
          code: 'invalid_copilot_failure_diagnosis_read_request',
        });
      }
      try {
        const result = await capability.inspect(command);
        if (
          notFound(
            result,
            command,
            'qinglong/copilot-failure-diagnosis-inspection-result@v1',
          )
        ) {
          return response(404, { code: 'copilot_failure_diagnosis_not_found' });
        }
        const view = inspectionView(result, command);
        return view
          ? response(200, view)
          : response(503, {
              code: 'copilot_failure_diagnosis_read_unavailable',
            });
      } catch {
        return response(503, {
          code: 'copilot_failure_diagnosis_read_unavailable',
        });
      }
    },
  });
}

export function createClusterControlCopilotFailureDiagnosisOutputReadRoute(
  capability: ClusterCopilotFailureDiagnosisOutputReadCapability,
): Readonly<ClusterControlRouteDefinition> {
  if (!capability || typeof capability.readOutput !== 'function') {
    throw new TypeError(
      'Cluster-control Copilot diagnosis output read capability is invalid',
    );
  }
  return Object.freeze({
    ...CLUSTER_CONTROL_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_ROUTE,
    async handle(
      authorized: ClusterControlAuthorizedOperationRequest,
      parameters: ClusterControlRouteParameters,
    ) {
      const command = target(authorized, parameters);
      if (!command) {
        return response(400, {
          code: 'invalid_copilot_failure_diagnosis_output_read_request',
        });
      }
      try {
        const result = await capability.readOutput(command);
        if (
          notFound(
            result,
            command,
            'qinglong/copilot-failure-diagnosis-output-read-result@v1',
          )
        ) {
          return response(404, {
            code: 'copilot_failure_diagnosis_output_not_found',
          });
        }
        const view = outputView(result, command);
        return view
          ? response(200, view)
          : response(503, {
              code: 'copilot_failure_diagnosis_output_read_unavailable',
            });
      } catch {
        return response(503, {
          code: 'copilot_failure_diagnosis_output_read_unavailable',
        });
      }
    },
  });
}
