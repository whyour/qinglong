import { CLUSTER_RUN_CANCELLATION_SCHEMA } from '@qinglong/runtime-core/cluster-run-cancellation';

export const CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA =
  'qinglong/cluster-copilot-client-command@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-request@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-response@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-inspection-response@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-output-read-response@v1' as const;
export const CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA =
  'qinglong/cluster-copilot-failure-diagnosis-cancellation-response@v1' as const;

export type ClusterCopilotClientOperation =
  | 'diagnose'
  | 'inspect'
  | 'output'
  | 'cancel';

interface ClusterCopilotClientCommandBase {
  readonly schema: typeof CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA;
  readonly operation: ClusterCopilotClientOperation;
  readonly projectId: string;
  readonly sourceRunId: string;
  readonly requestId: string;
}

export type ClusterCopilotClientCommand =
  | (ClusterCopilotClientCommandBase &
      Readonly<{ readonly operation: 'diagnose'; readonly traceId: string }>)
  | (ClusterCopilotClientCommandBase &
      Readonly<{ readonly operation: 'inspect' | 'output' }>)
  | (ClusterCopilotClientCommandBase &
      Readonly<{ readonly operation: 'cancel'; readonly mutationId: string }>);

export interface ClusterCopilotClientPreparedRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly requestId: string;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly acceptedStatusCodes: readonly number[];
}

export class InvalidClusterCopilotClientCommandError extends TypeError {
  readonly code = 'QL3_CLUSTER_COPILOT_CLIENT_COMMAND_INVALID';

  constructor() {
    super('Cluster Copilot client command is invalid');
    this.name = 'InvalidClusterCopilotClientCommandError';
  }
}

export class InvalidClusterCopilotClientResponseError extends Error {
  readonly code = 'QL3_CLUSTER_COPILOT_CLIENT_RESPONSE_INVALID';

  constructor() {
    super('Cluster Copilot client response is invalid');
    this.name = 'InvalidClusterCopilotClientResponseError';
  }
}

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;
const DIGEST = /^[0-9a-f]{64}$/;
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
const FINISH_REASONS = new Set([
  'stop',
  'length',
  'content_filter',
  'tool_call',
  'unknown',
]);
const CANCELLATION_STATUSES = new Set([
  'accepted',
  'already_requested',
  'already_terminal',
]);
const CANCELLATION_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function invalidCommand(): never {
  throw new InvalidClusterCopilotClientCommandError();
}

function invalidResponse(): never {
  throw new InvalidClusterCopilotClientResponseError();
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidResponse();
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return invalidResponse();
  }
  return value as Record<string, unknown>;
}

function exactCommand(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCommand();
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return invalidCommand();
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY.test(value);
}

function runId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID.test(value);
}

export function normalizeClusterCopilotClientCommand(
  value: unknown,
): Readonly<ClusterCopilotClientCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCommand();
  }
  const candidate = value as Record<string, unknown>;
  const operation = candidate.operation;
  if (
    operation !== 'diagnose' &&
    operation !== 'inspect' &&
    operation !== 'output' &&
    operation !== 'cancel'
  ) {
    return invalidCommand();
  }
  const record = exactCommand(value, [
    'operation',
    'projectId',
    'requestId',
    'schema',
    'sourceRunId',
    ...(operation === 'diagnose' ? ['traceId'] : []),
    ...(operation === 'cancel' ? ['mutationId'] : []),
  ]);
  if (
    record.schema !== CLUSTER_COPILOT_CLIENT_COMMAND_SCHEMA ||
    !identity(record.projectId) ||
    !runId(record.sourceRunId) ||
    !identity(record.requestId) ||
    (operation === 'diagnose' && !identity(record.traceId)) ||
    (operation === 'cancel' && !identity(record.mutationId))
  ) {
    return invalidCommand();
  }
  return Object.freeze({ ...record }) as Readonly<ClusterCopilotClientCommand>;
}

function targetPath(command: Readonly<ClusterCopilotClientCommand>): string {
  const target = `/api/v3/projects/${encodeURIComponent(
    command.projectId,
  )}/runs/${encodeURIComponent(
    command.sourceRunId,
  )}/copilot/failure-diagnoses`;
  return command.operation === 'diagnose'
    ? target
    : `${target}/${encodeURIComponent(command.requestId)}`;
}

export function prepareClusterCopilotClientRequest(
  command: Readonly<ClusterCopilotClientCommand>,
  readRequestId?: string,
): Readonly<ClusterCopilotClientPreparedRequest> {
  const normalized = normalizeClusterCopilotClientCommand(command);
  if (
    (normalized.operation === 'inspect' || normalized.operation === 'output') &&
    !identity(readRequestId)
  ) {
    return invalidCommand();
  }
  const target = targetPath(normalized);
  if (normalized.operation === 'diagnose') {
    return Object.freeze({
      method: 'POST',
      path: target,
      requestId: normalized.requestId,
      body: Object.freeze({
        schema: CLUSTER_COPILOT_FAILURE_DIAGNOSIS_REQUEST_SCHEMA,
        traceId: normalized.traceId,
      }),
      acceptedStatusCodes: Object.freeze([200, 201]),
    });
  }
  if (normalized.operation === 'cancel') {
    return Object.freeze({
      method: 'POST',
      path: `${target}/cancellation`,
      requestId: normalized.mutationId,
      body: Object.freeze({
        schema: CLUSTER_RUN_CANCELLATION_SCHEMA,
        mutationId: normalized.mutationId,
      }),
      acceptedStatusCodes: Object.freeze([200, 202]),
    });
  }
  return Object.freeze({
    method: 'GET',
    path: normalized.operation === 'output' ? `${target}/output` : target,
    requestId: readRequestId!,
    body: null,
    acceptedStatusCodes: Object.freeze([200]),
  });
}

function exactTarget(
  value: Record<string, unknown>,
  command: Readonly<ClusterCopilotClientCommand>,
): boolean {
  return (
    value.projectId === command.projectId &&
    value.sourceRunId === command.sourceRunId &&
    value.requestId === command.requestId
  );
}

function usage(
  value: unknown,
  settled: boolean,
): Readonly<Record<string, unknown>> {
  const hasCostMicros =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'costMicros');
  const record = exact(
    value,
    settled
      ? ['costMicros', 'currency', 'inputTokens', 'outputTokens', 'totalTokens']
      : [
          'inputTokens',
          'outputTokens',
          'totalTokens',
          ...(hasCostMicros ? ['costMicros'] : []),
        ],
  );
  if (
    !nonNegativeInteger(record.inputTokens) ||
    !nonNegativeInteger(record.outputTokens) ||
    !nonNegativeInteger(record.totalTokens) ||
    record.totalTokens !== record.inputTokens + record.outputTokens ||
    (settled &&
      !(
        (record.currency === null && record.costMicros === null) ||
        (record.currency === 'USD' && nonNegativeInteger(record.costMicros))
      )) ||
    (!settled &&
      record.costMicros !== undefined &&
      !nonNegativeInteger(record.costMicros))
  ) {
    return invalidResponse();
  }
  return Object.freeze({ ...record });
}

function diagnosisResponse(
  value: unknown,
  command: Extract<ClusterCopilotClientCommand, { readonly operation: 'diagnose' }>,
): Readonly<Record<string, unknown>> {
  const record = exact(value, [
    'diagnosisRunId',
    'outcome',
    'outputArtifact',
    'reason',
    'replayed',
    'requestId',
    'schema',
    'sourceRunId',
    'stage',
    'status',
  ]);
  if (
    record.schema !== CLUSTER_COPILOT_FAILURE_DIAGNOSIS_RESPONSE_SCHEMA ||
    record.requestId !== command.requestId ||
    record.sourceRunId !== command.sourceRunId ||
    !runId(record.diagnosisRunId) ||
    (record.status !== 'created' && record.status !== 'existing') ||
    record.replayed !== (record.status === 'existing') ||
    typeof record.outcome !== 'string' ||
    !OUTCOMES.has(record.outcome) ||
    typeof record.stage !== 'string' ||
    !STAGES.has(record.stage) ||
    (record.stage === 'model') !== (record.reason === null) ||
    (record.reason !== null &&
      (typeof record.reason !== 'string' || !REASONS.has(record.reason)))
  ) {
    return invalidResponse();
  }
  let outputArtifact: Readonly<Record<string, unknown>> | null = null;
  if (record.outputArtifact !== null) {
    const artifact = exact(record.outputArtifact, [
      'artifactDigest',
      'artifactId',
    ]);
    if (
      !identity(artifact.artifactId) ||
      typeof artifact.artifactDigest !== 'string' ||
      !DIGEST.test(artifact.artifactDigest) ||
      record.stage !== 'model' ||
      record.outcome !== 'succeeded'
    ) {
      return invalidResponse();
    }
    outputArtifact = Object.freeze({ ...artifact });
  } else if (record.stage === 'model' && record.outcome === 'succeeded') {
    return invalidResponse();
  }
  return Object.freeze({ ...record, outputArtifact });
}

function inspectionResponse(
  value: unknown,
  command: Readonly<ClusterCopilotClientCommand>,
): Readonly<Record<string, unknown>> {
  const record = exact(value, [
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
    record.schema !==
      CLUSTER_COPILOT_FAILURE_DIAGNOSIS_INSPECTION_RESPONSE_SCHEMA ||
    !exactTarget(record, command) ||
    !runId(record.diagnosisRunId) ||
    !nonNegativeInteger(record.admittedAtMs) ||
    typeof record.outputAvailable !== 'boolean'
  ) {
    return invalidResponse();
  }
  if (record.status === 'running') {
    if (
      record.outcome !== null ||
      record.stage !== null ||
      record.reason !== null ||
      record.outputAvailable !== false ||
      record.finalizedAtMs !== null ||
      record.usage !== null
    ) {
      return invalidResponse();
    }
    return Object.freeze({ ...record });
  }
  if (
    record.status !== 'terminal' ||
    typeof record.outcome !== 'string' ||
    !OUTCOMES.has(record.outcome) ||
    typeof record.stage !== 'string' ||
    !STAGES.has(record.stage) ||
    !nonNegativeInteger(record.finalizedAtMs) ||
    record.finalizedAtMs < record.admittedAtMs ||
    (record.stage === 'model') !== (record.reason === null) ||
    (record.reason !== null &&
      (typeof record.reason !== 'string' || !REASONS.has(record.reason))) ||
    record.outputAvailable !==
      (record.stage === 'model' && record.outcome === 'succeeded')
  ) {
    return invalidResponse();
  }
  return Object.freeze({
    ...record,
    usage: record.usage === null ? null : usage(record.usage, true),
  });
}

function outputResponse(
  value: unknown,
  command: Readonly<ClusterCopilotClientCommand>,
): Readonly<Record<string, unknown>> {
  const record = exact(value, [
    'diagnosisRunId',
    'projectId',
    'reference',
    'requestId',
    'result',
    'schema',
    'sourceRunId',
    'status',
  ]);
  const reference = exact(record.reference, [
    'artifactDigest',
    'artifactId',
    'contentDigest',
    'outputBytes',
    'sealedAtMs',
  ]);
  const result = exact(record.result, ['finishReason', 'text', 'usage']);
  if (
    record.schema !==
      CLUSTER_COPILOT_FAILURE_DIAGNOSIS_OUTPUT_READ_RESPONSE_SCHEMA ||
    record.status !== 'available' ||
    !exactTarget(record, command) ||
    !runId(record.diagnosisRunId) ||
    !identity(reference.artifactId) ||
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
    !FINISH_REASONS.has(result.finishReason)
  ) {
    return invalidResponse();
  }
  return Object.freeze({
    ...record,
    reference: Object.freeze({ ...reference }),
    result: Object.freeze({
      ...result,
      usage: usage(result.usage, false),
    }),
  });
}

function cancellationResponse(
  value: unknown,
  command: Readonly<ClusterCopilotClientCommand>,
): Readonly<Record<string, unknown>> {
  const record = exact(value, [
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
    record.schema !==
      CLUSTER_COPILOT_FAILURE_DIAGNOSIS_CANCELLATION_RESPONSE_SCHEMA ||
    !exactTarget(record, command) ||
    !runId(record.diagnosisRunId) ||
    typeof record.status !== 'string' ||
    !CANCELLATION_STATUSES.has(record.status) ||
    !nonNegativeInteger(record.runVersion) ||
    !nonNegativeInteger(record.eventSequence) ||
    record.runVersion !== record.eventSequence ||
    !(
      (record.cancelRequestedAtMs === null && record.cancelReason === null) ||
      (nonNegativeInteger(record.cancelRequestedAtMs) &&
        typeof record.cancelReason === 'string' &&
        CANCELLATION_REASONS.has(record.cancelReason))
    )
  ) {
    return invalidResponse();
  }
  if (
    record.convergence === 'model_in_flight' &&
    (record.runStatus !== 'running' ||
      record.outcome !== null ||
      record.cancelRequestedAtMs === null)
  ) {
    return invalidResponse();
  }
  if (
    record.convergence === 'terminal' &&
    (typeof record.runStatus !== 'string' ||
      !OUTCOMES.has(record.runStatus) ||
      record.outcome !== record.runStatus)
  ) {
    return invalidResponse();
  }
  if (
    record.convergence !== 'model_in_flight' &&
    record.convergence !== 'terminal'
  ) {
    return invalidResponse();
  }
  return Object.freeze({ ...record });
}

export function validateClusterCopilotClientResponse(
  value: unknown,
  command: Readonly<ClusterCopilotClientCommand>,
): Readonly<Record<string, unknown>> {
  const normalized = normalizeClusterCopilotClientCommand(command);
  if (normalized.operation === 'diagnose') {
    return diagnosisResponse(value, normalized);
  }
  if (normalized.operation === 'inspect') {
    return inspectionResponse(value, normalized);
  }
  if (normalized.operation === 'output') {
    return outputResponse(value, normalized);
  }
  return cancellationResponse(value, normalized);
}
