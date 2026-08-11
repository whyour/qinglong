import { EXECUTION_ORIGINS, RUN_STATUSES } from '../../run/run';
import type { RunRepositoryReader } from '../../run/runRepository';
import {
  BoundedRunReadProjectionUnavailableError,
  executeBoundedRunReadProjection,
} from '../../run/projection/boundedRunReadProjection';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '../tool-registry/toolRegistry';

export const BUILTIN_RUN_READ_TOOL = Object.freeze({
  name: 'qinglong.run.get',
  version: '1.0.0',
});
export const BUILTIN_RUN_READ_TIMEOUT_SECONDS = 5;

const MAX_INT = 2_147_483_647;
const MIN_INT = -2_147_483_648;

export const BUILTIN_RUN_READ_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_RUN_READ_TOOL.name,
  version: BUILTIN_RUN_READ_TOOL.version,
  description: 'Read one low-sensitive Project-scoped Run projection',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', minLength: 1, maxLength: 128 },
    },
    required: ['runId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      id: { type: 'string', minLength: 1, maxLength: 128 },
      taskId: { type: 'string', minLength: 1, maxLength: 255 },
      taskRevision: { type: 'string', minLength: 1, maxLength: 255 },
      status: {
        type: 'string',
        maxLength: 32,
        enum: RUN_STATUSES,
      },
      version: { type: 'integer', minimum: 0, maximum: MAX_INT },
      eventSequence: { type: 'integer', minimum: 0, maximum: MAX_INT },
      priority: { type: 'integer', minimum: MIN_INT, maximum: MAX_INT },
      executionOrigin: {
        type: 'string',
        maxLength: 32,
        enum: EXECUTION_ORIGINS,
      },
      executionOwner: {
        type: 'string',
        maxLength: 16,
        enum: ['legacy', 'runtime'],
      },
      createdAtMs: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      queuedAtMs: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      startedAtMs: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      finishedAtMs: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    },
    required: ['found'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['run.read'],
  timeoutSeconds: BUILTIN_RUN_READ_TIMEOUT_SECONDS,
});

export class InvalidBuiltInRunReadToolError extends TypeError {
  readonly code = 'BUILTIN_RUN_READ_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Run read Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInRunReadToolError';
  }
}

export class BuiltInRunReadToolUnavailableError extends Error {
  readonly code = 'BUILTIN_RUN_READ_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Run read Tool is unavailable');
    this.name = 'BuiltInRunReadToolUnavailableError';
  }
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function invalid(message: string): never {
  throw new InvalidBuiltInRunReadToolError(message);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

export async function executeBuiltInRunReadTool(
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
    Reflect.ownKeys(inputRecord).length !== 1 ||
    !Object.hasOwn(inputRecord, 'runId') ||
    !boundedText(inputRecord.runId, 128)
  ) {
    return invalid('execution context or input is invalid');
  }
  const runId = inputRecord.runId;
  try {
    return await executeBoundedRunReadProjection(runs, projectId, runId);
  } catch (error) {
    if (!(error instanceof BoundedRunReadProjectionUnavailableError)) {
      return invalid('execution context or input is invalid');
    }
    throw new BuiltInRunReadToolUnavailableError();
  }
}
