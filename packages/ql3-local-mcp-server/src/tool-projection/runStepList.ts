import {
  BoundedRunStepListProjectionUnavailableError,
  DEFAULT_BOUNDED_RUN_STEP_LIST_LIMIT,
  InvalidBoundedRunStepListProjectionError,
  MAX_BOUNDED_RUN_STEP_LIST_LIMIT,
  executeBoundedRunStepListProjection,
} from '@qinglong/runtime-core/bounded-run-step-list-projection';
import type { RunRepositoryReader } from '@qinglong/runtime-core/run-repository';
import {
  MAX_STEP_RUN_ATTEMPTS,
  STEP_RUN_KINDS,
  STEP_RUN_STATUSES,
  type StepRunRepository,
} from '@qinglong/runtime-core/step-run';
import {
  normalizeToolDefinition,
  type ToolJsonValue,
} from '@qinglong/runtime-core/tool-registry';

export const BUILTIN_RUN_STEP_LIST_TOOL = Object.freeze({
  name: 'qinglong.run.steps.list',
  version: '1.0.0',
});
export const BUILTIN_RUN_STEP_LIST_TIMEOUT_SECONDS = 5;
export const BUILTIN_RUN_STEP_LIST_DEFAULT_LIMIT =
  DEFAULT_BOUNDED_RUN_STEP_LIST_LIMIT;
export const BUILTIN_RUN_STEP_LIST_MAX_LIMIT = MAX_BOUNDED_RUN_STEP_LIST_LIMIT;

const MAX_INT = 2_147_483_647;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export const BUILTIN_RUN_STEP_LIST_TOOL_DEFINITION = normalizeToolDefinition({
  name: BUILTIN_RUN_STEP_LIST_TOOL.name,
  version: BUILTIN_RUN_STEP_LIST_TOOL.version,
  description: 'List bounded low-sensitive Steps for one Project-scoped Run',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', minLength: 1, maxLength: 128 },
      afterStepKey: { type: 'string', minLength: 1, maxLength: 128 },
      afterStepRunId: { type: 'string', minLength: 1, maxLength: 128 },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: BUILTIN_RUN_STEP_LIST_MAX_LIMIT,
      },
    },
    required: ['runId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      found: { type: 'boolean' },
      steps: {
        type: 'array',
        maxItems: BUILTIN_RUN_STEP_LIST_MAX_LIMIT,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
            parentStepRunId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            stepKey: { type: 'string', minLength: 1, maxLength: 128 },
            kind: {
              type: 'string',
              minLength: 1,
              maxLength: 32,
              enum: STEP_RUN_KINDS,
            },
            required: { type: 'boolean' },
            status: {
              type: 'string',
              minLength: 1,
              maxLength: 32,
              enum: STEP_RUN_STATUSES,
            },
            version: { type: 'integer', minimum: 1, maximum: MAX_INT },
            attemptCount: {
              type: 'integer',
              minimum: 0,
              maximum: MAX_STEP_RUN_ATTEMPTS,
            },
            readyAtMs: {
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
            resultCode: { type: 'string', minLength: 1, maxLength: 64 },
            createdAtMs: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            updatedAtMs: {
              type: 'integer',
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          required: [
            'id',
            'stepKey',
            'kind',
            'required',
            'status',
            'version',
            'attemptCount',
            'createdAtMs',
            'updatedAtMs',
          ],
          additionalProperties: false,
        },
      },
      hasMore: { type: 'boolean' },
      next: {
        type: 'object',
        properties: {
          stepKey: { type: 'string', minLength: 1, maxLength: 128 },
          stepRunId: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['stepKey', 'stepRunId'],
        additionalProperties: false,
      },
    },
    required: ['found', 'steps', 'hasMore'],
    additionalProperties: false,
  },
  effect: 'read',
  risk: 'low',
  requiredPermissions: ['run.read'],
  timeoutSeconds: BUILTIN_RUN_STEP_LIST_TIMEOUT_SECONDS,
});

export class InvalidBuiltInRunStepListToolError extends TypeError {
  readonly code = 'BUILTIN_RUN_STEP_LIST_TOOL_INVALID';

  constructor(message: string) {
    super(`Built-in Run Step list Tool is invalid: ${message}`);
    this.name = 'InvalidBuiltInRunStepListToolError';
  }
}

export class BuiltInRunStepListToolUnavailableError extends Error {
  readonly code = 'BUILTIN_RUN_STEP_LIST_TOOL_UNAVAILABLE';

  constructor() {
    super('Built-in Run Step list Tool is unavailable');
    this.name = 'BuiltInRunStepListToolUnavailableError';
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function invalid(message: string): never {
  throw new InvalidBuiltInRunStepListToolError(message);
}

export async function executeBuiltInRunStepListTool(
  runs: Pick<RunRepositoryReader, 'findRunById'>,
  stepRuns: Pick<StepRunRepository, 'listByRun'>,
  projectId: string,
  input: ToolJsonValue,
): Promise<Readonly<Record<string, ToolJsonValue>>> {
  const value =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, ToolJsonValue>>)
      : null;
  const keys = value ? Reflect.ownKeys(value) : [];
  const afterStepKey = value?.afterStepKey;
  const afterStepRunId = value?.afterStepRunId;
  if (
    !runs ||
    typeof runs.findRunById !== 'function' ||
    !stepRuns ||
    typeof stepRuns.listByRun !== 'function' ||
    !boundedText(projectId, 128) ||
    !value ||
    keys.length < 1 ||
    keys.length > 4 ||
    keys.some(
      (key) =>
        key !== 'runId' &&
        key !== 'afterStepKey' &&
        key !== 'afterStepRunId' &&
        key !== 'limit',
    ) ||
    !Object.hasOwn(value, 'runId') ||
    !boundedText(value.runId, 128) ||
    (afterStepKey === undefined) !== (afterStepRunId === undefined) ||
    (afterStepKey !== undefined && !boundedText(afterStepKey, 128)) ||
    (afterStepRunId !== undefined && !boundedText(afterStepRunId, 128)) ||
    (value.limit !== undefined &&
      (!Number.isSafeInteger(value.limit) ||
        Number(value.limit) < 1 ||
        Number(value.limit) > BUILTIN_RUN_STEP_LIST_MAX_LIMIT))
  ) {
    return invalid('execution context or input is invalid');
  }
  try {
    const projection = await executeBoundedRunStepListProjection(
      runs,
      stepRuns,
      projectId,
      value.runId,
      {
        limit: Number(value.limit ?? BUILTIN_RUN_STEP_LIST_DEFAULT_LIMIT),
        ...(afterStepKey === undefined || afterStepRunId === undefined
          ? {}
          : { after: { stepKey: afterStepKey, stepRunId: afterStepRunId } }),
      },
    );
    return Object.freeze({
      found: projection.found,
      steps: Object.freeze(
        projection.steps.map((step) =>
          Object.freeze({
            id: step.id,
            ...(step.parentStepRunId === null
              ? {}
              : { parentStepRunId: step.parentStepRunId }),
            stepKey: step.stepKey,
            kind: step.kind,
            required: step.required,
            status: step.status,
            version: step.version,
            attemptCount: step.attemptCount,
            ...(step.readyAtMs === null ? {} : { readyAtMs: step.readyAtMs }),
            ...(step.startedAtMs === null
              ? {}
              : { startedAtMs: step.startedAtMs }),
            ...(step.finishedAtMs === null
              ? {}
              : { finishedAtMs: step.finishedAtMs }),
            ...(step.resultCode === null
              ? {}
              : { resultCode: step.resultCode }),
            createdAtMs: step.createdAtMs,
            updatedAtMs: step.updatedAtMs,
          }),
        ),
      ),
      hasMore: projection.hasMore,
      ...(projection.next === null ? {} : { next: projection.next }),
    });
  } catch (error) {
    if (error instanceof InvalidBoundedRunStepListProjectionError) {
      return invalid('execution context or input is invalid');
    }
    if (error instanceof BoundedRunStepListProjectionUnavailableError) {
      throw new BuiltInRunStepListToolUnavailableError();
    }
    throw new BuiltInRunStepListToolUnavailableError();
  }
}
