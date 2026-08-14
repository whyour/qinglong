import { EXECUTION_ORIGINS, RUN_STATUSES } from '../../run/run';
import type { RunRepositoryReader } from '../../run/runRepository';
import {
  BoundedRunReadProjectionUnavailableError,
  executeBoundedRunReadProjection,
  type BoundedRunReadProjection,
} from '../../run/projection/boundedRunReadProjection';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '../tool-registry/toolRegistry';

export const BUILTIN_RUN_COMPARE_TOOL = Object.freeze({
  name: 'qinglong.run.compare',
  version: '1.0.0',
});
export const BUILTIN_RUN_COMPARE_TIMEOUT_SECONDS = 5;

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
export const BUILTIN_RUN_COMPARABLE_FIELDS = Object.freeze([
  'taskId',
  'taskRevision',
  'status',
  'priority',
  'executionOrigin',
  'executionOwner',
] as const);

export const BUILTIN_RUN_PROJECTION_SCHEMA = Object.freeze({
  type: 'object' as const,
  properties: {
    found: { type: 'boolean' as const },
    id: { type: 'string' as const, minLength: 1, maxLength: 128 },
    taskId: { type: 'string' as const, minLength: 1, maxLength: 255 },
    taskRevision: { type: 'string' as const, minLength: 1, maxLength: 255 },
    status: {
      type: 'string' as const,
      maxLength: 32,
      enum: RUN_STATUSES,
    },
    version: { type: 'integer' as const, minimum: 0, maximum: MAX_INT },
    eventSequence: {
      type: 'integer' as const,
      minimum: 0,
      maximum: MAX_INT,
    },
    priority: {
      type: 'integer' as const,
      minimum: MIN_INT,
      maximum: MAX_INT,
    },
    executionOrigin: {
      type: 'string' as const,
      maxLength: 32,
      enum: EXECUTION_ORIGINS,
    },
    executionOwner: {
      type: 'string' as const,
      maxLength: 16,
      enum: ['legacy', 'runtime'] as const,
    },
    createdAtMs: {
      type: 'integer' as const,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    queuedAtMs: {
      type: 'integer' as const,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    startedAtMs: {
      type: 'integer' as const,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    finishedAtMs: {
      type: 'integer' as const,
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
  required: ['found'] as const,
  additionalProperties: false,
});

export const BUILTIN_RUN_COMPARE_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_RUN_COMPARE_TOOL.name,
  version: BUILTIN_RUN_COMPARE_TOOL.version,
  description:
    'Compare two low-sensitive Project-scoped Run projections using bounded point reads',
  inputSchema: {
    type: 'object',
    properties: {
      baselineRunId: { type: 'string', minLength: 1, maxLength: 128 },
      candidateRunId: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['baselineRunId', 'candidateRunId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      baseline: BUILTIN_RUN_PROJECTION_SCHEMA,
      candidate: BUILTIN_RUN_PROJECTION_SCHEMA,
      comparable: { type: 'boolean' },
      sameTask: { type: 'boolean' },
      sameTaskRevision: { type: 'boolean' },
      changedFields: {
        type: 'array',
        items: {
          type: 'string',
          maxLength: 32,
          enum: BUILTIN_RUN_COMPARABLE_FIELDS,
        },
        maxItems: BUILTIN_RUN_COMPARABLE_FIELDS.length,
      },
      queueDelayDeltaMs: {
        type: 'integer',
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      executionDurationDeltaMs: {
        type: 'integer',
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      totalDurationDeltaMs: {
        type: 'integer',
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      consistency: {
        type: 'string',
        maxLength: 32,
        enum: ['ordered_independent_point_reads'],
      },
    },
    required: [
      'baseline',
      'candidate',
      'comparable',
      'sameTask',
      'sameTaskRevision',
      'changedFields',
      'consistency',
    ],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['run.read'],
  timeoutSeconds: BUILTIN_RUN_COMPARE_TIMEOUT_SECONDS,
});

export class InvalidBuiltInRunCompareToolError extends TypeError {
  readonly code = 'BUILTIN_RUN_COMPARE_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Run compare Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInRunCompareToolError';
  }
}

export class BuiltInRunCompareToolUnavailableError extends Error {
  readonly code = 'BUILTIN_RUN_COMPARE_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Run compare Tool is unavailable');
    this.name = 'BuiltInRunCompareToolUnavailableError';
  }
}

function invalid(message: string): never {
  throw new InvalidBuiltInRunCompareToolError(message);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function timestampDelta(
  baselineStart: unknown,
  baselineEnd: unknown,
  candidateStart: unknown,
  candidateEnd: unknown,
): number | undefined {
  if (
    !Number.isSafeInteger(baselineStart) ||
    !Number.isSafeInteger(baselineEnd) ||
    !Number.isSafeInteger(candidateStart) ||
    !Number.isSafeInteger(candidateEnd)
  ) {
    return undefined;
  }
  if (
    Number(baselineEnd) < Number(baselineStart) ||
    Number(candidateEnd) < Number(candidateStart)
  ) {
    return undefined;
  }
  const baselineDuration = Number(baselineEnd) - Number(baselineStart);
  const candidateDuration = Number(candidateEnd) - Number(candidateStart);
  const delta = candidateDuration - baselineDuration;
  return Number.isSafeInteger(delta) ? delta : undefined;
}

export type BuiltInRunComparisonConsistency =
  | 'ordered_independent_point_reads'
  | 'bounded_task_window_then_ordered_point_reads';

export function compareBoundedRunProjections(
  baseline: BoundedRunReadProjection,
  candidate: BoundedRunReadProjection,
  consistency: BuiltInRunComparisonConsistency,
): Readonly<Record<string, ToolJsonValue>> {
  const comparable = baseline.found === true && candidate.found === true;
  const changedFields = Object.freeze(
    comparable
      ? BUILTIN_RUN_COMPARABLE_FIELDS.filter(
          (field) => baseline[field] !== candidate[field],
        )
      : [],
  );
  const queueDelayDeltaMs = comparable
    ? timestampDelta(
        baseline.createdAtMs,
        baseline.queuedAtMs,
        candidate.createdAtMs,
        candidate.queuedAtMs,
      )
    : undefined;
  const executionDurationDeltaMs = comparable
    ? timestampDelta(
        baseline.startedAtMs,
        baseline.finishedAtMs,
        candidate.startedAtMs,
        candidate.finishedAtMs,
      )
    : undefined;
  const totalDurationDeltaMs = comparable
    ? timestampDelta(
        baseline.createdAtMs,
        baseline.finishedAtMs,
        candidate.createdAtMs,
        candidate.finishedAtMs,
      )
    : undefined;
  return Object.freeze({
    baseline,
    candidate,
    comparable,
    sameTask: comparable && baseline.taskId === candidate.taskId,
    sameTaskRevision:
      comparable && baseline.taskRevision === candidate.taskRevision,
    changedFields,
    ...(queueDelayDeltaMs === undefined ? {} : { queueDelayDeltaMs }),
    ...(executionDurationDeltaMs === undefined
      ? {}
      : { executionDurationDeltaMs }),
    ...(totalDurationDeltaMs === undefined ? {} : { totalDurationDeltaMs }),
    consistency,
  });
}

export async function executeBuiltInRunCompareTool(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const inputRecord =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !boundedText(projectId, 128) ||
    !inputRecord ||
    Reflect.ownKeys(inputRecord).length !== 2 ||
    !boundedText(inputRecord.baselineRunId, 128) ||
    !boundedText(inputRecord.candidateRunId, 128) ||
    inputRecord.baselineRunId === inputRecord.candidateRunId
  ) {
    return invalid('execution context or input is invalid');
  }
  try {
    const baseline = await executeBoundedRunReadProjection(
      runs,
      projectId,
      inputRecord.baselineRunId,
    );
    const candidate = await executeBoundedRunReadProjection(
      runs,
      projectId,
      inputRecord.candidateRunId,
    );
    return compareBoundedRunProjections(
      baseline,
      candidate,
      'ordered_independent_point_reads',
    );
  } catch (error) {
    if (!(error instanceof BoundedRunReadProjectionUnavailableError)) {
      return invalid('execution context or input is invalid');
    }
    throw new BuiltInRunCompareToolUnavailableError();
  }
}
